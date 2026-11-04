import { Global, Module } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { AiActionsService } from "@/ai/actions/ai-actions.service";
import { AiModule } from "@/ai/ai.module";
import { AiService } from "@/ai/ai.service";
import { AiReviewModule } from "@/ai-review/ai-review.module";
import { AiReviewRequestsService } from "@/ai-review/ai-review-requests.service";
import { AiReviewWorkService } from "@/ai-review/ai-review-work.service";
import { ASSISTANT_CLAIM_KEY } from "@/ai-review/ai-review-work.types";
import { AiReviewQueueModule } from "@/ai-review/ai-review-queue.module";
import { EVENT_BUS } from "@/common/events/event-bus.interface";
import { MemoryEventBus } from "@/common/events/memory-event-bus";
import { JobClaimModule } from "@/common/jobs/job-claim.module";
import { withUserContext } from "@/common/db/with-context";
import { EncryptionService } from "@/common/encryption/encryption.service";
import { EmailReceiptsModule } from "@/email-receipts/email-receipts.module";
import {
  ImapMailboxClient,
  type FetchSinceResult,
} from "@/email-receipts/imap/imap-mailbox-client";
import { EmailReceiptAiService } from "@/email-receipts/ai/email-receipt-ai.service";
import { RECEIPT_AUTOMATIC_AI_INSTRUCTION } from "@/email-receipts/pipeline/receipt-instructions";
import { EmailReceiptParserToolsService } from "@/email-receipts/parsers/email-receipt-parser-tools.service";
import { EmailReceiptParsersService } from "@/email-receipts/parsers/email-receipt-parsers.service";
import { EmailReceiptPollService } from "@/email-receipts/poll/email-receipt-poll.service";
import { EmailReceiptsService } from "@/email-receipts/receipts/email-receipts.service";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
  createTestPayee,
} from "../helpers/test-factories";

/** The in-process event bus a `single` deployment binds, without the app's module. */
@Global()
@Module({
  providers: [{ provide: EVENT_BUS, useClass: MemoryEventBus }, MemoryEventBus],
  exports: [EVENT_BUS],
})
class TestEventBusModule {}

/**
 * Email receipts end to end against a real PostgreSQL enforcing RLS: what a mock
 * cannot show. A message read twice is stored once and the cursor sits at its
 * UID (INV-RECEIPT-002); an email is read by a real parser, matched to a real
 * transaction and proposed through the review queue as a signed card that writes
 * nothing; `confirm` then writes the splits and marks the request applied
 * (INV-RECEIPT-003); the opt-in auto-apply goes through the same `confirm`; and
 * another user sees none of it.
 *
 * Synthetic data only: example.com addresses and invented names.
 */
describe("email receipts pipeline (integration)", () => {
  jest.setTimeout(180000);

  const PASSWORD = "app-password-for-tests";
  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let poller: EmailReceiptPollService;
  let receipts: EmailReceiptsService;
  let receiptAi: EmailReceiptAiService;
  let work: AiReviewWorkService;
  let parsers: EmailReceiptParsersService;
  let parserTools: EmailReceiptParserToolsService;
  let transactions: TransactionsService;
  let actions: AiActionsService;
  let imap: ImapMailboxClient;
  let encryption: EncryptionService;

  let aliceId: string;
  let bobId: string;
  let accountId: string;
  let booksId: string;
  let shippingId: string;
  let mailboxId: string;
  let txId: string;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);
  const asBob = <T>(fn: () => Promise<T>) => withUserContext(bobId, fn);

  const rfc822 = (uid: string, body?: string) =>
    Buffer.from(
      [
        "From: Shop <orders@shop.example.com>",
        "To: receipts@example.com",
        "Subject: Your order ABCD1234",
        "Date: Thu, 10 Sep 2026 10:00:00 +0000",
        `Message-ID: <m${uid}@shop.example.com>`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        body ??
          [
            "Order number: ABCD1234",
            "Items",
            "Widget 12.00",
            "Subtotal 12.00",
            "Shipping: 3.00",
            "Order total: 15.00",
          ].join("\r\n"),
        "",
      ].join("\r\n"),
    );

  const serverReturns = (uid: string, body?: string): FetchSinceResult => ({
    uidValidity: "1001",
    messages: [
      {
        uid,
        source: rfc822(uid, body),
        internalDate: new Date("2026-09-10T10:00:01Z"),
        size: 500,
      },
    ],
    skipped: [],
    highestUid: uid,
  });

  const pollAlice = () =>
    asAlice(() =>
      poller.pollMailbox(aliceId, mailboxId, { requireEnabled: true }),
    );

  const receiptRows = async () =>
    db.query(`SELECT * FROM email_receipts ORDER BY uid`);
  const requestRows = async () =>
    db.query(`SELECT * FROM ai_review_requests ORDER BY created_at`);
  const splitCount = async () =>
    Number(
      (
        await db.query(
          `SELECT COUNT(*)::int AS n FROM transaction_splits WHERE transaction_id = $1`,
          [txId],
        )
      )[0].n,
    );

  async function createMailbox(over: { autoApply?: boolean } = {}) {
    const [row] = await db.query(
      `INSERT INTO email_receipt_mailboxes
         (user_id, host, port, security, username, password_enc, enabled, ai_mode, auto_apply)
       VALUES ($1, '8.8.8.8', 993, 'tls', 'receipts@example.com', $2, true, 'off', $3)
       RETURNING id`,
      [aliceId, encryption.encrypt(PASSWORD), over.autoApply ?? false],
    );
    mailboxId = row.id;
  }

  async function createParser() {
    return asAlice(() =>
      parsers.create(aliceId, {
        name: "Shop",
        fromDomains: ["shop.example.com"],
        definition: {
          version: 2,
          orderId: ["Order number: {orderid}"],
          total: ["Order total: {amount}"],
          shipping: ["Shipping: {amount}"],
          items: {
            startAfter: "Items",
            stopAt: "Subtotal",
            patterns: ["{name} {amount}"],
          },
          defaultCategoryId: booksId,
          shippingCategoryId: shippingId,
        },
      } as never),
    );
  }

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "integration-test-secret";
    process.env.ENCRYPTION_KEY ??= "x".repeat(40);
    harness = await createEnforcedIntegrationModule([
      JobClaimModule,
      TransactionsModule,
      TransactionRulesModule,
      AiReviewModule,
      AiReviewQueueModule,
      AiModule,
      EmailReceiptsModule,
      TestEventBusModule,
    ]);
    module = harness.module;
    db = harness.owner;
    poller = module.get(EmailReceiptPollService);
    receipts = module.get(EmailReceiptsService);
    receiptAi = module.get(EmailReceiptAiService);
    work = module.get(AiReviewWorkService);
    parsers = module.get(EmailReceiptParsersService);
    parserTools = module.get(EmailReceiptParserToolsService);
    transactions = module.get(TransactionsService);
    actions = module.get(AiActionsService);
    imap = module.get(ImapMailboxClient);
    encryption = module.get(EncryptionService);
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await harness.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    // A poll a test does not feed fails at once, as it would against a closed
    // port. Unstubbed, it dials the fixture host 8.8.8.8:993 for real and
    // waits out IMAP_CONNECTION_TIMEOUT_MS (30s) before failing the same way.
    jest
      .spyOn(imap, "fetchSince")
      .mockRejectedValue(new Error("no IMAP fetch was stubbed for this poll"));
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "single_use_tokens",
      "job_claims",
      "ai_review_requests",
      "email_receipts",
      "email_receipt_parsers",
      "email_receipt_mailboxes",
      "action_history",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "payees",
      "categories",
      "accounts",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    bobId = (await createTestUserDirect(db, { firstName: "Bob" })).id;
    accountId = (
      await createTestAccount(db, aliceId, {
        name: "Checking",
        currencyCode: "USD",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    booksId = (await createTestCategory(db, aliceId, { name: "Books" })).id;
    shippingId = (await createTestCategory(db, aliceId, { name: "Shipping" }))
      .id;
    txId = (
      await asAlice(() =>
        transactions.create(aliceId, {
          accountId,
          transactionDate: "2026-09-11",
          amount: -15,
          currencyCode: "USD",
          description: "CARD PURCHASE ORDER ABCD1234",
        } as never),
      )
    ).id;
    await createMailbox();
  });

  it("the enforced harness really enforces: a query outside any identity sees no rows", async () => {
    await createParser();
    expect(await db.query(`SELECT 1 FROM email_receipt_parsers`)).toHaveLength(
      1,
    );
    expect(
      await harness.app.query(`SELECT 1 FROM email_receipt_parsers`),
    ).toHaveLength(0);
  });

  it("ingests the same UID twice into one row and leaves the cursor at it", async () => {
    jest
      .spyOn(imap, "fetchSince")
      .mockResolvedValueOnce(serverReturns("41"))
      // the next poll reads the same message again: a rewound cursor, a crash
      .mockResolvedValueOnce(serverReturns("41"));

    const first = await pollAlice();
    const second = await pollAlice();

    expect(first).toMatchObject({ ok: true, fetched: 1 });
    expect(second).toMatchObject({ ok: true, fetched: 0 });
    const rows = await receiptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      uid: "41",
      uid_validity: "1001",
      from_address: "orders@shop.example.com",
      from_domain: "shop.example.com",
      subject: "Your order ABCD1234",
    });
    expect(new Date(rows[0].received_at).toISOString()).toBe(
      "2026-09-10T10:00:00.000Z",
    );
    const [mailbox] = await db.query(
      `SELECT uid_validity, last_uid, last_error FROM email_receipt_mailboxes`,
    );
    expect(mailbox).toMatchObject({
      uid_validity: "1001",
      last_uid: "41",
      last_error: null,
    });
  });

  it("an email nobody parses waits as no_parser, and a read failure keeps the cursor and the error", async () => {
    jest.spyOn(imap, "fetchSince").mockResolvedValueOnce(serverReturns("41"));
    await pollAlice();
    expect((await receiptRows())[0].status).toBe("no_parser");

    jest
      .spyOn(imap, "fetchSince")
      .mockRejectedValueOnce(new Error(`login failed for ${PASSWORD}`));
    const outcome = await pollAlice();
    expect(outcome.ok).toBe(false);
    const [mailbox] = await db.query(
      `SELECT last_uid, last_error FROM email_receipt_mailboxes`,
    );
    expect(mailbox.last_uid).toBe("41");
    expect(mailbox.last_error).not.toContain(PASSWORD);
    expect(mailbox.last_error).not.toBeNull();
  });

  it("reads an email with a real parser, matches the transaction and proposes the split as a signed card; confirm writes it and marks the request applied", async () => {
    await createParser();
    jest.spyOn(imap, "fetchSince").mockResolvedValueOnce(serverReturns("41"));

    const outcome = await pollAlice();
    expect(outcome).toMatchObject({ ok: true, fetched: 1, processed: 1 });

    const [receipt] = await receiptRows();
    expect(receipt).toMatchObject({
      status: "review",
      transaction_id: txId,
      match_kind: "order_id",
    });
    expect(receipt.parsed).toMatchObject({
      orderId: "ABCD1234",
      total: 150000,
      complete: true,
    });
    const [request] = await requestRows();
    expect(request).toMatchObject({
      kind: "email_receipt",
      status: "proposed",
      claimed_by: "email-receipts",
      transaction_id: txId,
      email_receipt_id: receipt.id,
    });
    expect(receipt.ai_review_request_id).toBe(request.id);
    const card = request.proposal.action;
    expect(card.descriptor).toMatchObject({
      type: "update_transaction",
      transactionId: txId,
      aiReviewRequestId: request.id,
    });
    expect(typeof card.signature).toBe("string");
    expect(request.proposal.input.splits).toEqual([
      { categoryName: "Books", amount: -12, memo: "Widget" },
      { categoryName: "Shipping", amount: -3 },
    ]);
    // a proposal writes nothing to the ledger
    expect(await splitCount()).toBe(0);

    const [listed] = await asAlice(() => receipts.list(aliceId));
    expect(listed).toMatchObject({
      id: receipt.id,
      status: "review",
      displayState: "proposed",
      transaction: { id: txId, date: "2026-09-11", amount: -15 },
    });

    const result = await asAlice(() =>
      actions.confirm(aliceId, {
        actionId: card.actionId,
        signature: card.signature,
        descriptor: card.descriptor,
      }),
    );
    expect(result).toEqual({ type: "update_transaction", id: txId });
    expect(await splitCount()).toBe(2);
    const [tx] = await db.query(
      `SELECT amount, is_split FROM transactions WHERE id = $1`,
      [txId],
    );
    expect(Number(tx.amount)).toBe(-15);
    expect(tx.is_split).toBe(true);
    expect((await requestRows())[0].status).toBe("applied");
    const [account] = await db.query(
      `SELECT current_balance FROM accounts WHERE id = $1`,
      [accountId],
    );
    expect(Number(account.current_balance)).toBe(985);
    const [after] = await asAlice(() => receipts.list(aliceId));
    expect(after.displayState).toBe("applied");

    // what was applied is not proposed again, and is not reprocessed
    await expect(
      asAlice(() => receipts.reprocess(aliceId, receipt.id)),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("with auto-apply on, a complete parse of a certain match is applied through confirm with no person", async () => {
    await db.query(`UPDATE email_receipt_mailboxes SET auto_apply = true`);
    await createParser();
    jest.spyOn(imap, "fetchSince").mockResolvedValueOnce(serverReturns("41"));

    await pollAlice();

    expect(await splitCount()).toBe(2);
    const [request] = await requestRows();
    expect(request.status).toBe("applied");
    const [{ n }] = await db.query(
      `SELECT COUNT(*)::int AS n FROM single_use_tokens WHERE purpose = 'ai-action'`,
    );
    expect(n).toBe(1);
  });

  it("a total that does not equal the transaction is proposed as a description only, and never auto-applied", async () => {
    await db.query(`UPDATE email_receipt_mailboxes SET auto_apply = true`);
    await createParser();
    await db.query(`UPDATE transactions SET amount = -14 WHERE id = $1`, [
      txId,
    ]);
    jest.spyOn(imap, "fetchSince").mockResolvedValueOnce(serverReturns("41"));

    await pollAlice();

    const [receipt] = await receiptRows();
    expect(receipt).toMatchObject({
      status: "review",
      status_reason: "amount_differs",
    });
    const [request] = await requestRows();
    expect(request.status).toBe("proposed");
    expect(request.proposal.input.splits).toBeUndefined();
    expect(request.proposal.input.description).toContain("ABCD1234");
    expect(await splitCount()).toBe(0);
  });

  it("an open request somebody else raised for the transaction is review_conflict, and reprocess proposes once it closes", async () => {
    await createParser();
    await db.query(
      `INSERT INTO ai_review_requests (user_id, transaction_id, kind, instruction, status)
       VALUES ($1, $2, 'transaction_review', 'Look at this', 'pending')`,
      [aliceId, txId],
    );
    jest.spyOn(imap, "fetchSince").mockResolvedValueOnce(serverReturns("41"));

    await pollAlice();

    // the open request removes the transaction from the candidates
    const [waiting] = await receiptRows();
    expect(waiting.status).toBe("unmatched");

    await db.query(
      `UPDATE ai_review_requests SET status = 'rejected' WHERE kind = 'transaction_review'`,
    );
    // The rematch reads an unmatched email only while it is recent
    // (`REMATCH_DAYS` after `received_at`, against the database clock). The
    // fixture email arrived on 2026-09-10, which the calendar has since put
    // outside that window, so move this email and its transaction to the
    // clock together (the candidate window is anchored on the email's date):
    // the case is about the closed request, not about either window.
    await db.query(
      `UPDATE email_receipts SET received_at = CURRENT_TIMESTAMP - INTERVAL '1 day' WHERE id = $1`,
      [waiting.id],
    );
    await db.query(
      `UPDATE transactions SET transaction_date = CURRENT_DATE WHERE id = $1`,
      [txId],
    );
    await pollAlice();
    const [matched] = await receiptRows();
    expect(matched).toMatchObject({ status: "review", transaction_id: txId });
  });

  it("a person links the email to a transaction of their own; another user's is refused and nothing is written", async () => {
    const bobAccount = (
      await createTestAccount(db, bobId, {
        name: "Bob checking",
        currencyCode: "USD",
        openingBalance: 100,
        currentBalance: 100,
      })
    ).id;
    const [bobTx] = await db.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
       VALUES ($1, $2, '2026-09-11', -15, 'USD', 'UNRECONCILED') RETURNING id`,
      [bobId, bobAccount],
    );
    await createParser();
    jest
      .spyOn(imap, "fetchSince")
      .mockResolvedValueOnce(serverReturns("41", "Order total: 99.00"));
    await pollAlice();
    const [receipt] = await receiptRows();
    expect(receipt.status).toBe("unmatched");

    await expect(
      asAlice(() => receipts.link(aliceId, receipt.id, bobTx.id)),
    ).rejects.toMatchObject({ status: 404 });
    expect((await receiptRows())[0].status).toBe("unmatched");
    expect(await requestRows()).toHaveLength(0);

    const detail = await asAlice(() =>
      receipts.link(aliceId, receipt.id, txId),
    );
    expect(detail).toMatchObject({
      status: "review",
      matchKind: "manual",
      transaction: { id: txId },
    });
    expect((await requestRows())[0].status).toBe("proposed");
  });

  it("deleting an email dismisses its open request in the same transaction", async () => {
    await createParser();
    jest.spyOn(imap, "fetchSince").mockResolvedValueOnce(serverReturns("41"));
    await pollAlice();
    const [receipt] = await receiptRows();
    expect((await requestRows())[0].status).toBe("proposed");

    await asAlice(() => receipts.remove(aliceId, receipt.id));

    expect(await receiptRows()).toHaveLength(0);
    const [request] = await requestRows();
    expect(request.status).toBe("rejected");
    expect(request.email_receipt_id).toBeNull();
  });

  it("another user sees none of it and cannot act on it", async () => {
    await createParser();
    jest.spyOn(imap, "fetchSince").mockResolvedValueOnce(serverReturns("41"));
    await pollAlice();
    const [receipt] = await receiptRows();
    const [parser] = await db.query(`SELECT id FROM email_receipt_parsers`);

    expect(await asBob(() => receipts.list(bobId))).toEqual([]);
    expect(await asBob(() => parsers.list(bobId))).toEqual([]);
    await expect(
      asBob(() => receipts.get(bobId, receipt.id)),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      asBob(() => receipts.ignore(bobId, receipt.id)),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      asBob(() => receipts.remove(bobId, receipt.id)),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      asBob(() => receipts.reprocess(bobId, receipt.id)),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      asBob(() => parsers.get(bobId, parser.id)),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      asBob(() => parsers.remove(bobId, parser.id)),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      asBob(() =>
        parsers.test(bobId, {
          receiptId: receipt.id,
          definition: { version: 2, total: ["Order total: {amount}"] },
        } as never),
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(await receiptRows()).toHaveLength(1);
    expect(await db.query(`SELECT 1 FROM email_receipt_parsers`)).toHaveLength(
      1,
    );
    expect((await receiptRows())[0].status).toBe("review");
  });

  it("refuses a parser that names another user's category, writing nothing", async () => {
    const bobCategory = (await createTestCategory(db, bobId, { name: "Bob's" }))
      .id;
    await expect(
      asAlice(() =>
        parsers.create(aliceId, {
          name: "Shop",
          fromDomains: ["shop.example.com"],
          definition: {
            version: 2,
            total: ["Order total: {amount}"],
            defaultCategoryId: bobCategory,
          },
        } as never),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(await db.query(`SELECT 1 FROM email_receipt_parsers`)).toHaveLength(
      0,
    );
  });

  it("the parser's compare-and-swap refuses a stale edit with a 409 and keeps the stored one", async () => {
    const created = await createParser();
    const edited = await asAlice(() =>
      parsers.update(aliceId, created.id, {
        name: "Shop 2",
        expectedRevision: created.revision,
      } as never),
    );
    expect(edited.revision).toBe(created.revision + 1);
    await expect(
      asAlice(() =>
        parsers.update(aliceId, created.id, {
          name: "Shop 3",
          expectedRevision: created.revision,
        } as never),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const [row] = await db.query(`SELECT name FROM email_receipt_parsers`);
    expect(row.name).toBe("Shop 2");
  });

  it("a parser definition restored as {} is reported invalid, never a crash, and cannot be approved", async () => {
    await db.query(
      `INSERT INTO email_receipt_parsers (user_id, name, from_domains, status)
       VALUES ($1, 'Restored', ARRAY['shop.example.com'], 'draft')`,
      [aliceId],
    );
    const [view] = await asAlice(() => parsers.list(aliceId));
    expect(view).toMatchObject({ definitionValid: false, status: "draft" });
    await expect(
      asAlice(() => parsers.approve(aliceId, view.id)),
    ).rejects.toMatchObject({ status: 400 });
    // and an email from that sender is not read by a draft
    jest.spyOn(imap, "fetchSince").mockResolvedValueOnce(serverReturns("41"));
    await pollAlice();
    expect((await receiptRows())[0].status).toBe("no_parser");
  });
  describe("Recognize with AI (ask-ai)", () => {
    const unreadEmail = async () => {
      jest.spyOn(imap, "fetchSince").mockResolvedValueOnce(serverReturns("41"));
      await pollAlice();
      const [receipt] = await receiptRows();
      expect(receipt.status).toBe("no_parser");
      return receipt;
    };

    it("with a chosen transaction and no provider: a pending email_receipt request the inbox lists, the email in review, the transaction stored as manual", async () => {
      const receipt = await unreadEmail();
      const completeSpy = jest.spyOn(module.get(AiService), "complete");

      const result = await asAlice(() =>
        receiptAi.askAi(aliceId, receipt.id, txId),
      );

      expect(completeSpy).not.toHaveBeenCalled();
      const [request] = await requestRows();
      expect(result).toEqual({
        ok: true,
        requestId: request.id,
        transactionId: txId,
      });
      expect(request).toMatchObject({
        kind: "email_receipt",
        status: "pending",
        claimed_by: null,
        transaction_id: txId,
        email_receipt_id: receipt.id,
      });
      const [after] = await receiptRows();
      expect(after).toMatchObject({
        status: "review",
        transaction_id: txId,
        match_kind: "manual",
        ai_review_request_id: request.id,
      });

      const inbox = await asAlice(() => work.listInbox(aliceId));
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({
        id: request.id,
        kind: "email_receipt",
        status: "pending",
        emailReceipt: { id: receipt.id, subject: "Your order ABCD1234" },
      });
      const [listed] = await asAlice(() => receipts.list(aliceId));
      expect(listed.displayState).toBe("pending_ai");
      // a request asks; it writes nothing to the ledger
      expect(await splitCount()).toBe(0);
    });

    it("the poll's automatic AI step never takes a request the person made with Recognize with AI, but does take its own", async () => {
      await db.query(
        `UPDATE email_receipt_mailboxes SET ai_mode = 'automatic'`,
      );
      const receipt = await unreadEmail();
      const { requestId } = await asAlice(() =>
        receiptAi.askAi(aliceId, receipt.id, txId),
      );
      const complete = jest
        .spyOn(module.get(AiService), "complete")
        .mockRejectedValue(new Error("provider down"));

      // Only the ask-ai request is pending: nothing for the step to take.
      await expect(
        asAlice(() => receiptAi.runAutomaticStep(aliceId)),
      ).resolves.toMatchObject({ proposed: 0, failed: 0 });
      expect(complete).not.toHaveBeenCalled();
      let [request] = await requestRows();
      expect(request).toMatchObject({
        id: requestId,
        status: "pending",
        claimed_by: null,
        proposal: null,
      });

      // Control: a pending request the poll itself queued (its own instruction)
      // is taken by the same step, so the filter is what spared the first.
      await db.query(
        `UPDATE ai_review_requests SET instruction = $1 WHERE id = $2`,
        [RECEIPT_AUTOMATIC_AI_INSTRUCTION, requestId],
      );
      await expect(
        asAlice(() => receiptAi.runAutomaticStep(aliceId)),
      ).resolves.toMatchObject({ failed: 1 });
      expect(complete).toHaveBeenCalledTimes(1);
      [request] = await requestRows();
      expect(request.status).toBe("pending");
    });

    it("the assistant claims that request by id, reads the email, submits splits as a signed card, and confirming it applies the request", async () => {
      const receipt = await unreadEmail();
      const { requestId } = await asAlice(() =>
        receiptAi.askAi(aliceId, receipt.id, txId),
      );

      const claimed = await asAlice(() =>
        work.claim(aliceId, ASSISTANT_CLAIM_KEY, requestId),
      );
      expect(claimed.request).toMatchObject({
        id: requestId,
        status: "claimed",
        claimedByYou: true,
      });
      expect(claimed.emailReceipt?.text).toContain("Widget 12.00");
      // nobody else can take it any more, and an unknown id claims nothing
      await expect(
        asAlice(() => work.claim(aliceId, "an-mcp-client", requestId)),
      ).resolves.toEqual({ request: null });

      const submitted = await asAlice(() =>
        work.submit(aliceId, ASSISTANT_CLAIM_KEY, requestId, {
          splits: [
            { categoryName: "Books", amount: -12, memo: "Widget" },
            { categoryName: "Shipping", amount: -3 },
          ],
        }),
      );
      expect(submitted.action.descriptor).toMatchObject({
        type: "update_transaction",
        transactionId: txId,
        aiReviewRequestId: requestId,
      });
      expect((await requestRows())[0].status).toBe("proposed");
      expect(await splitCount()).toBe(0);

      await asAlice(() =>
        actions.confirm(aliceId, {
          actionId: submitted.action.actionId,
          signature: submitted.action.signature,
          descriptor: submitted.action.descriptor as never,
        }),
      );
      expect(await splitCount()).toBe(2);
      expect((await requestRows())[0].status).toBe("applied");
      const [after] = await asAlice(() => receipts.list(aliceId));
      expect(after.displayState).toBe("applied");
    });

    it("dismisses the email's own open request when asked again, queueing one", async () => {
      const receipt = await unreadEmail();
      const first = await asAlice(() =>
        receiptAi.askAi(aliceId, receipt.id, txId),
      );
      const second = await asAlice(() => receiptAi.askAi(aliceId, receipt.id));
      expect(second.requestId).not.toBe(first.requestId);
      const rows = await requestRows();
      expect(rows.map((r: { status: string }) => r.status)).toEqual([
        "rejected",
        "pending",
      ]);
    });

    it("refuses another user's transaction, a transfer and a void one, writing nothing", async () => {
      const receipt = await unreadEmail();
      const bobAccount = (
        await createTestAccount(db, bobId, {
          name: "Bob checking",
          currencyCode: "USD",
          openingBalance: 100,
          currentBalance: 100,
        })
      ).id;
      const [bobTx] = await db.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
         VALUES ($1, $2, '2026-09-11', -15, 'USD', 'UNRECONCILED') RETURNING id`,
        [bobId, bobAccount],
      );
      const [transfer] = await db.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status, is_transfer)
         VALUES ($1, $2, '2026-09-11', -15, 'USD', 'UNRECONCILED', true) RETURNING id`,
        [aliceId, accountId],
      );
      const [voided] = await db.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
         VALUES ($1, $2, '2026-09-11', -15, 'USD', 'VOID') RETURNING id`,
        [aliceId, accountId],
      );
      await expect(
        asAlice(() => receiptAi.askAi(aliceId, receipt.id, bobTx.id)),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        asAlice(() => receiptAi.askAi(aliceId, receipt.id, transfer.id)),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        asAlice(() => receiptAi.askAi(aliceId, receipt.id, voided.id)),
      ).rejects.toMatchObject({ status: 400 });
      // no transaction and none chosen
      await expect(
        asAlice(() => receiptAi.askAi(aliceId, receipt.id)),
      ).rejects.toMatchObject({ status: 400 });
      expect(await requestRows()).toHaveLength(0);
      expect((await receiptRows())[0]).toMatchObject({
        status: "no_parser",
        transaction_id: null,
      });
    });

    it("another open request on the transaction is a 409 that leaves the email as it was", async () => {
      const receipt = await unreadEmail();
      await db.query(
        `INSERT INTO ai_review_requests (user_id, transaction_id, kind, instruction, status)
         VALUES ($1, $2, 'transaction_review', 'Look at this', 'pending')`,
        [aliceId, txId],
      );
      await expect(
        asAlice(() => receiptAi.askAi(aliceId, receipt.id, txId)),
      ).rejects.toMatchObject({ status: 409 });
      expect((await receiptRows())[0]).toMatchObject({
        status: "no_parser",
        transaction_id: null,
      });
      expect(await requestRows()).toHaveLength(1);
    });
  });

  describe("an HTML part", () => {
    const multipart = (uid: string) =>
      Buffer.from(
        [
          "From: Shop <orders@shop.example.com>",
          "To: receipts@example.com",
          "Subject: Your order ABCD1234",
          "Date: Thu, 10 Sep 2026 10:00:00 +0000",
          `Message-ID: <h${uid}@shop.example.com>`,
          'Content-Type: multipart/alternative; boundary="B1"',
          "",
          "--B1",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Order total: 15.00",
          "--B1",
          "Content-Type: text/html; charset=utf-8",
          "",
          '<p>Order total: <b>15.00</b></p><img src="https://tracker.example/p.gif">',
          "--B1--",
          "",
        ].join("\r\n"),
      );

    it("is stored with the email, shown by the detail only, and never by the list", async () => {
      jest.spyOn(imap, "fetchSince").mockResolvedValueOnce({
        uidValidity: "1001",
        messages: [
          {
            uid: "41",
            source: multipart("41"),
            internalDate: new Date("2026-09-10T10:00:01Z"),
            size: 500,
          },
        ],
        skipped: [],
        highestUid: "41",
      });

      await pollAlice();

      const [row] = await receiptRows();
      expect(row.body_text).toContain("Order total: 15.00");
      expect(row.body_html).toContain("<b>15.00</b>");
      const [item] = await asAlice(() => receipts.list(aliceId));
      expect(item).not.toHaveProperty("bodyHtml");
      expect(item).not.toHaveProperty("bodyText");
      const detail = await asAlice(() => receipts.get(aliceId, row.id));
      expect(detail.bodyHtml).toContain("<b>15.00</b>");
      expect(detail.bodyText).toContain("Order total: 15.00");
      // another user never reads it
      await expect(
        asBob(() => receipts.get(bobId, row.id)),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("is null for a plain text email", async () => {
      jest.spyOn(imap, "fetchSince").mockResolvedValueOnce(serverReturns("41"));
      await pollAlice();
      const [row] = await receiptRows();
      expect(row.body_html).toBeNull();
      expect(
        (await asAlice(() => receipts.get(aliceId, row.id))).bodyHtml,
      ).toBeNull();
    });
  });

  describe("the sender domain filter", () => {
    let uid = 100;
    const insertReceipt = async (
      domain: string,
      status = "no_parser",
      userId = aliceId,
      box = mailboxId,
    ) => {
      uid += 1;
      await db.query(
        `INSERT INTO email_receipts
           (user_id, mailbox_id, uid_validity, uid, from_address, from_domain,
            subject, received_at, body_text, status)
         VALUES ($1, $2, 1001, $3, $4, $5, 'S', CURRENT_TIMESTAMP, 'x', $6)`,
        [userId, box, uid, `orders@${domain}`, domain, status],
      );
    };

    it("matches the domain exactly or as a sub-domain, never a look-alike, with % and _ taken literally, and combines with the status", async () => {
      await insertReceipt("shop.example.com");
      await insertReceipt("shop.example.com", "review");
      await insertReceipt("mail.shop.example.com");
      await insertReceipt("deep.mail.shop.example.com");
      await insertReceipt("notshop.example.com");
      await insertReceipt("shop.example.com.evil.org");
      await insertReceipt("shopXexample.com");
      await insertReceipt("other.example.org");
      const domains = (rows: { fromDomain: string }[]) =>
        rows.map((r) => r.fromDomain).sort();

      const all = await asAlice(() =>
        receipts.list(aliceId, { domain: "shop.example.com" }),
      );
      expect(domains(all)).toEqual([
        "deep.mail.shop.example.com",
        "mail.shop.example.com",
        "shop.example.com",
        "shop.example.com",
      ]);
      const reviewed = await asAlice(() =>
        receipts.list(aliceId, {
          domain: "shop.example.com",
          status: "review",
        }),
      );
      expect(domains(reviewed)).toEqual(["shop.example.com"]);
      // "_" and "%" are not wildcards: shop_example.com does not match shopXexample.com
      await insertReceipt("shop_example.com");
      const underscore = await asAlice(() =>
        receipts.list(aliceId, { domain: "shop_example.com" }),
      );
      expect(domains(underscore)).toEqual(["shop_example.com"]);
      expect(
        await asAlice(() =>
          receipts.list(aliceId, { domain: "sh%.example.com" }),
        ),
      ).toEqual([]);
    });

    it("counts the user's domains, most first then by name, and never another user's", async () => {
      await insertReceipt("b.example.com");
      await insertReceipt("a.example.com");
      await insertReceipt("a.example.com");
      await insertReceipt("c.example.com", "review");
      const [bobBox] = await db.query(
        `INSERT INTO email_receipt_mailboxes
           (user_id, host, port, security, username, password_enc, enabled, ai_mode, auto_apply)
         VALUES ($1, '8.8.8.8', 993, 'tls', 'bob@example.com', $2, false, 'off', false)
         RETURNING id`,
        [bobId, encryption.encrypt(PASSWORD)],
      );
      await insertReceipt("bobs.example.com", "no_parser", bobId, bobBox.id);
      expect(await asAlice(() => receipts.listDomains(aliceId))).toEqual([
        { domain: "a.example.com", count: 2, processable: 2 },
        { domain: "b.example.com", count: 1, processable: 1 },
        // a `review` email stands behind a proposal: bulk processing leaves it alone
        { domain: "c.example.com", count: 1, processable: 0 },
      ]);
      expect(await asBob(() => receipts.listDomains(bobId))).toEqual([
        { domain: "bobs.example.com", count: 1, processable: 1 },
      ]);
      expect(
        await asBob(() => receipts.list(bobId, { domain: "a.example.com" })),
      ).toEqual([]);
    });
  });

  describe("structured data and the lines source", () => {
    const ORDER_JSON_LD = JSON.stringify({
      "@context": "http://schema.org",
      "@type": "Order",
      merchant: { "@type": "Organization", name: "Example Shop" },
      orderNumber: "ABCD1234",
      priceCurrency: "USD",
      price: "15.00",
      acceptedOffer: [
        {
          "@type": "Offer",
          itemOffered: { "@type": "Product", name: "Widget" },
          price: "12.00",
          eligibleQuantity: { "@type": "QuantitativeValue", value: "1" },
        },
        {
          "@type": "Offer",
          itemOffered: { "@type": "Product", name: "Gadget" },
          price: "3.00",
        },
      ],
    });

    /** A multipart email: a text part that no pattern here reads, and the HTML part. */
    const withHtml = (
      uid: string,
      html: string,
      text = "Thank you for your order.",
    ) =>
      Buffer.from(
        [
          "From: Shop <orders@shop.example.com>",
          "To: receipts@example.com",
          "Subject: Your order ABCD1234",
          "Date: Thu, 10 Sep 2026 10:00:00 +0000",
          `Message-ID: <s${uid}@shop.example.com>`,
          'Content-Type: multipart/alternative; boundary="B2"',
          "",
          "--B2",
          "Content-Type: text/plain; charset=utf-8",
          "",
          text,
          "--B2",
          "Content-Type: text/html; charset=utf-8",
          "",
          html,
          "--B2--",
          "",
        ].join("\r\n"),
      );

    const ingest = async (html: string, text?: string) => {
      jest.spyOn(imap, "fetchSince").mockResolvedValueOnce({
        uidValidity: "1001",
        messages: [
          {
            uid: "41",
            source: withHtml("41", html, text),
            internalDate: new Date("2026-09-10T10:00:01Z"),
            size: 900,
          },
        ],
        skipped: [],
        highestUid: "41",
      });
      return pollAlice();
    };

    const jsonLdPage = (json = ORDER_JSON_LD) =>
      `<html><body><p>Thank you</p><script type="application/ld+json">${json}</script></body></html>`;

    it("reads the order from JSON-LD when no parser is set up for the domain: review, source schema_org, a split proposal, nothing created", async () => {
      await createTestPayee(db, aliceId, {
        name: "Example Shop",
        defaultCategoryId: booksId,
      });
      const payeesBefore = Number(
        (await db.query(`SELECT COUNT(*)::int AS n FROM payees`))[0].n,
      );

      const outcome = await ingest(jsonLdPage());
      expect(outcome).toMatchObject({ ok: true, fetched: 1, processed: 1 });

      const [row] = await receiptRows();
      expect(row).toMatchObject({
        status: "review",
        status_reason: "schema_org",
        parser_id: null,
        transaction_id: txId,
        match_kind: "order_id",
      });
      expect(row.parsed).toMatchObject({
        source: "schema_org",
        orderId: "ABCD1234",
        total: 150000,
        payee: "Example Shop",
        complete: true,
      });
      const [request] = await requestRows();
      expect(request).toMatchObject({
        kind: "email_receipt",
        status: "proposed",
      });
      expect(request.proposal).toBeTruthy();
      // The proposal wrote nothing to the ledger, and no payee was created.
      expect(await splitCount()).toBe(0);
      expect(
        Number((await db.query(`SELECT COUNT(*)::int AS n FROM payees`))[0].n),
      ).toBe(payeesBefore);

      // The detail shows the order found and the lines of both sources.
      const detail = await asAlice(() => receipts.get(aliceId, row.id));
      expect(detail.structuredOrder).toMatchObject({
        orderNumber: "ABCD1234",
        seller: "Example Shop",
        total: 150000,
      });
      expect(detail.structuredOrder?.items.map((i) => i.name)).toEqual([
        "Widget",
        "Gadget",
      ]);
      expect(detail.lines.html).toEqual(["Thank you"]);
      expect(detail.lines.text).toEqual(["Thank you for your order."]);
      expect(detail.parsed).toMatchObject({ source: "schema_org" });
    });

    it("with no payee for the seller the lines have no category: still review, description only, and the reason is named", async () => {
      await ingest(jsonLdPage());
      const [row] = await receiptRows();
      expect(row).toMatchObject({
        status: "review",
        status_reason: "items_uncategorized",
      });
      expect(row.parsed).toMatchObject({
        source: "schema_org",
        complete: false,
      });
      expect(
        Number((await db.query(`SELECT COUNT(*)::int AS n FROM payees`))[0].n),
      ).toBe(0);
    });

    it("an approved parser that reads a total wins over the markup", async () => {
      await createParser();
      await createTestPayee(db, aliceId, {
        name: "Example Shop",
        defaultCategoryId: booksId,
      });
      await ingest(
        jsonLdPage(ORDER_JSON_LD.replace('"price":"15.00"', '"price":"99.00"')),
        [
          "Order number: ABCD1234",
          "Items",
          "Widget 12.00",
          "Subtotal 12.00",
          "Shipping: 3.00",
          "Order total: 15.00",
        ].join("\r\n"),
      );
      const [row] = await receiptRows();
      expect(row.status).toBe("review");
      expect(row.parser_id).not.toBeNull();
      expect(row.status_reason).toBeNull();
      expect(row.parsed.source).toBeUndefined();
      expect(row.parsed.total).toBe(150000);
    });

    it("a parser with source html reads the HTML lines of a real stored email; a text email makes it parse_failed no_html", async () => {
      await asAlice(() =>
        parsers.create(aliceId, {
          name: "Shop HTML",
          fromDomains: ["shop.example.com"],
          definition: {
            version: 2,
            source: "html",
            orderId: [{ label: "Order number:", value: "{orderid}" }],
            total: [{ label: "Order total:", value: "{amount}" }],
            items: {
              startAfter: "Order number:",
              stopAt: "Order total:",
              record: [{ line: "{name}" }, { line: "{amount}" }],
            },
            defaultCategoryId: booksId,
          },
        } as never),
      );
      await ingest(
        "<table><tr><td>Order number:</td><td>ABCD1234</td></tr>" +
          "<tr><td>Wrapped product name</td><td>15.00</td></tr>" +
          "<tr><td>Order total:</td><td>15.00</td></tr></table>",
      );
      let [row] = await receiptRows();
      expect(row).toMatchObject({ status: "review", match_kind: "order_id" });
      expect(row.parsed).toMatchObject({
        orderId: "ABCD1234",
        total: 150000,
        complete: true,
        items: [{ name: "Wrapped product name", amount: 150000 }],
      });

      await db.query(`DELETE FROM email_receipts`);
      jest.spyOn(imap, "fetchSince").mockResolvedValueOnce({
        ...serverReturns("42"),
      });
      await pollAlice();
      [row] = await receiptRows();
      expect(row).toMatchObject({
        status: "parse_failed",
        status_reason: "no_html",
      });
      expect(row.parser_id).not.toBeNull();
      expect(row.parsed).toBeNull();
    });

    it("the REST test of a definition with source html reads the stored HTML", async () => {
      await ingest(
        "<table><tr><td>Order number:</td><td>ABCD1234</td></tr>" +
          "<tr><td>Order total:</td><td>15.00</td></tr></table>",
      );
      const [row] = await receiptRows();
      const result = await asAlice(() =>
        parsers.test(aliceId, {
          receiptId: row.id,
          definition: {
            version: 2,
            source: "html",
            orderId: [{ label: "Order number:", value: "{orderid}" }],
            total: [{ label: "Order total:", value: "{amount}" }],
          },
        } as never),
      );
      expect(result.outcome).toBe("read");
      expect(result.parsed).toMatchObject({
        orderId: "ABCD1234",
        total: 150000,
      });
      expect(result.match).toMatchObject({
        kind: "matched",
        transactionId: txId,
      });
      const viaTool = await asAlice(() =>
        parserTools.testDefinition(aliceId, {
          receiptIds: [row.id],
          definition: {
            version: 2,
            source: "html",
            total: [{ label: "Order total:", value: "{amount}" }],
          },
        }),
      );
      expect(viaTool.emails[0].parsed).toMatchObject({ total: 15 });
    });
  });

  describe("a forwarded order confirmation", () => {
    /** Forwarded from the user's own Gmail 31 days after the purchase. */
    const forwarded = (uid: string) =>
      Buffer.from(
        [
          "From: Alice Example <alice.example@gmail.example.com>",
          "To: receipts@example.com",
          "Subject: Fwd: Your order ABCD1234",
          "Date: Thu, 10 Sep 2026 10:00:00 +0000",
          `Message-ID: <f${uid}@gmail.example.com>`,
          "Content-Type: text/plain; charset=utf-8",
          "",
          "---------- Forwarded message ---------",
          "From: Example Shop <orders@shop.example.com>",
          "Date: Mon, Aug 10, 2026 at 10:15 AM",
          "Subject: Your order ABCD1234",
          "To: <alice.example@gmail.example.com>",
          "",
          "Order number: ABCD1234",
          "Items",
          "Widget 12.00",
          "Subtotal 12.00",
          "Shipping: 3.00",
          "Order total: 15.00",
          "",
        ].join("\r\n"),
      );
    const serverForwards = (uid: string): FetchSinceResult => ({
      uidValidity: "1001",
      messages: [
        {
          uid,
          source: forwarded(uid),
          internalDate: new Date("2026-09-10T10:00:01Z"),
          size: 600,
        },
      ],
      skipped: [],
      highestUid: uid,
    });
    let purchaseTxId: string;

    beforeEach(async () => {
      // The Gmail the forwards come from is Alice's own verified account email:
      // only the owner's forward is stored as the shop's (A26-H02;
      // email-receipts-forwarded-sender.integration.spec.ts has the others').
      await db.query(`UPDATE users SET email = $1 WHERE id = $2`, [
        "alice.example@gmail.example.com",
        aliceId,
      ]);
      // The bank charge of the PURCHASE day (Aug 12), a month before the forward.
      purchaseTxId = (
        await asAlice(() =>
          transactions.create(aliceId, {
            accountId,
            transactionDate: "2026-08-12",
            amount: -15,
            currencyCode: "USD",
            description: "CARD PURCHASE ORDER ABCD1234",
          } as never),
        )
      ).id;
    });

    it("is stored under the shop and the purchase day, read by the shop's parser and matched to the purchase-day transaction", async () => {
      await createParser();
      jest
        .spyOn(imap, "fetchSince")
        .mockResolvedValueOnce(serverForwards("41"));

      const outcome = await pollAlice();

      expect(outcome).toMatchObject({ ok: true, fetched: 1, processed: 1 });
      const [row] = await receiptRows();
      expect(row).toMatchObject({
        from_address: "orders@shop.example.com",
        from_domain: "shop.example.com",
        subject: "Your order ABCD1234",
        forwarded_by: "alice.example@gmail.example.com",
        // the parser of shop.example.com read it, not "gmail.example.com"
        status: "review",
        transaction_id: purchaseTxId,
        match_kind: "order_id",
      });
      expect(new Date(row.original_sent_at).toISOString()).toBe(
        "2026-08-10T10:15:00.000Z",
      );
      // the day the forward arrived is kept as it was
      expect(new Date(row.received_at).toISOString()).toBe(
        "2026-09-10T10:00:00.000Z",
      );
      const [item] = await asAlice(() => receipts.list(aliceId));
      expect(item).toMatchObject({
        forwardedBy: "alice.example@gmail.example.com",
        originalSentAt: "2026-08-10T10:15:00.000Z",
        effectiveDate: "2026-08-10T10:15:00.000Z",
        receivedAt: "2026-09-10T10:00:00.000Z",
        fromAddress: "orders@shop.example.com",
      });
    });

    it("would have matched nothing around the forward's own day: the window follows the purchase", async () => {
      // A transaction of the FORWARD's week and none of the purchase's.
      await db.query(`DELETE FROM transactions WHERE id = $1`, [purchaseTxId]);
      await createParser();
      jest
        .spyOn(imap, "fetchSince")
        .mockResolvedValueOnce(serverForwards("41"));

      await pollAlice();

      // txId (Sep 11) is outside Aug 7 to Aug 24
      expect((await receiptRows())[0]).toMatchObject({
        status: "unmatched",
        transaction_id: null,
      });
    });

    it("heals an email stored before forwards were understood, when it is reprocessed", async () => {
      await createParser();
      const [legacy] = await db.query(
        `INSERT INTO email_receipts
           (user_id, mailbox_id, uid_validity, uid, from_address, from_domain,
            subject, received_at, body_text, status)
         VALUES ($1, $2, 1001, 7, 'alice.example@gmail.example.com',
                 'gmail.example.com', 'Fwd: Your order ABCD1234',
                 '2026-09-10T10:00:00Z', $3, 'no_parser') RETURNING id`,
        [
          aliceId,
          mailboxId,
          [
            "---------- Forwarded message ---------",
            "From: Example Shop <orders@shop.example.com>",
            "Date: Mon, Aug 10, 2026 at 10:15 AM",
            "Subject: Your order ABCD1234",
            "",
            "Order number: ABCD1234",
            "Items",
            "Widget 12.00",
            "Subtotal 12.00",
            "Shipping: 3.00",
            "Order total: 15.00",
          ].join("\n"),
        ],
      );

      const detail = await asAlice(() =>
        receipts.reprocess(aliceId, legacy.id),
      );

      expect(detail).toMatchObject({
        status: "review",
        fromAddress: "orders@shop.example.com",
        fromDomain: "shop.example.com",
        subject: "Your order ABCD1234",
        forwardedBy: "alice.example@gmail.example.com",
        originalSentAt: "2026-08-10T10:15:00.000Z",
        effectiveDate: "2026-08-10T10:15:00.000Z",
      });
      // a second reprocess changes nothing about who forwarded it
      const again = await asAlice(() => receipts.reprocess(aliceId, legacy.id));
      expect(again).toMatchObject({
        forwardedBy: "alice.example@gmail.example.com",
        fromAddress: "orders@shop.example.com",
      });
    });
  });

  describe("choosing a transaction by hand, whatever its date", () => {
    it("links a transaction months away from the email, and still refuses another user's", async () => {
      await createParser();
      jest.spyOn(imap, "fetchSince").mockResolvedValueOnce(serverReturns("41"));
      await pollAlice();
      const [row] = await receiptRows();
      const farTx = (
        await asAlice(() =>
          transactions.create(aliceId, {
            accountId,
            transactionDate: "2026-02-03",
            amount: -15,
            currencyCode: "USD",
            description: "A purchase seven months before the email",
          } as never),
        )
      ).id;

      const linked = await asAlice(() => receipts.link(aliceId, row.id, farTx));

      expect(linked).toMatchObject({
        status: "review",
        matchKind: "manual",
        transaction: { id: farTx, date: "2026-02-03" },
      });
      const bobAccount = (
        await createTestAccount(db, bobId, {
          name: "Bob checking",
          currencyCode: "USD",
          openingBalance: 100,
          currentBalance: 100,
        })
      ).id;
      const [bobTx] = await db.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
         VALUES ($1, $2, '2026-09-11', -15, 'USD', 'UNRECONCILED') RETURNING id`,
        [bobId, bobAccount],
      );
      await expect(
        asAlice(() => receipts.link(aliceId, row.id, bobTx.id)),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("asks the AI about a transaction months away from the email", async () => {
      jest.spyOn(imap, "fetchSince").mockResolvedValueOnce(serverReturns("41"));
      await pollAlice();
      const [row] = await receiptRows();
      const farTx = (
        await asAlice(() =>
          transactions.create(aliceId, {
            accountId,
            transactionDate: "2026-01-05",
            amount: -15,
            currencyCode: "USD",
          } as never),
        )
      ).id;

      const asked = await asAlice(() =>
        receiptAi.askAi(aliceId, row.id, farTx),
      );

      expect(asked).toMatchObject({ ok: true, transactionId: farTx });
    });
  });

  describe("drafting a parser with AI through the chat", () => {
    const DEFINITION = {
      version: 2,
      orderId: ["Order number: {orderid}"],
      total: ["Order total: {amount}"],
      shipping: ["Shipping: {amount}"],
      items: {
        startAfter: "Items",
        stopAt: "Subtotal",
        patterns: ["{name} {amount}"],
      },
    };

    /** Two unread emails of one shop, stored by the poll. */
    async function twoShopEmails(): Promise<string[]> {
      jest.spyOn(imap, "fetchSince").mockResolvedValueOnce({
        uidValidity: "1001",
        messages: ["41", "42"].map((uid) => ({
          uid,
          source: rfc822(uid),
          internalDate: new Date("2026-09-10T10:00:01Z"),
          size: 500,
        })),
        skipped: [],
        highestUid: "42",
      });
      await pollAlice();
      return (await receiptRows()).map((r: { id: string }) => r.id);
    }

    it("queues one pending request; the assistant claims it by id, tests, saves a DRAFT, the user approves it and the request is applied", async () => {
      const [r1, r2] = await twoShopEmails();

      // 1. the receipts page queues the request; no provider is called
      const queued = await asAlice(() =>
        parsers.requestAiDraft(aliceId, [r1, r2]),
      );
      expect(queued.ok).toBe(true);
      let [request] = await requestRows();
      expect(request).toMatchObject({
        id: queued.requestId,
        kind: "email_parser_draft",
        status: "pending",
        transaction_id: null,
        rule_id: null,
        parser_domain: "shop.example.com",
        email_receipt_ids: [r1, r2],
      });

      // 2. the assistant claims it BY ID and is handed the emails, not a transaction
      const claimed = await asAlice(() =>
        work.claim(aliceId, ASSISTANT_CLAIM_KEY, queued.requestId),
      );
      expect(claimed.request).toMatchObject({
        id: queued.requestId,
        kind: "email_parser_draft",
        status: "claimed",
        claimedByYou: true,
        transactionId: null,
      });
      expect(claimed.transaction).toBeUndefined();
      expect(claimed.emailReceipts?.map((e) => e.id)).toEqual([r1, r2]);
      expect(claimed.emailReceipts?.[0].text).toContain("Order total: 15.00");
      // nobody else can take it any more
      await expect(
        asAlice(() => work.claim(aliceId, "an-mcp-client", queued.requestId)),
      ).resolves.toEqual({ request: null });

      // 3. test: reads, writes nothing
      const before = (await db.query(`SELECT 1 FROM email_receipt_parsers`))
        .length;
      const tested = await asAlice(() =>
        parserTools.testDefinition(aliceId, {
          definition: DEFINITION,
          receiptIds: [r1, r2],
        }),
      );
      expect(tested.valid).toBe(true);
      expect(tested.emails).toHaveLength(2);
      expect(tested.emails[0].parsed).toMatchObject({
        orderId: "ABCD1234",
        total: 15,
        shipping: 3,
      });
      // items have no category yet: the parse is honest about it
      expect(tested.emails[0].parsed).toMatchObject({
        complete: false,
        reason: "items_uncategorized",
      });
      expect(
        (await db.query(`SELECT 1 FROM email_receipt_parsers`)).length,
      ).toBe(before);

      // 4. save a draft, with the categories from the tool
      const categories = await asAlice(() =>
        parserTools.listCategories(aliceId),
      );
      expect(categories.categories.map((c) => c.id)).toEqual(
        expect.arrayContaining([booksId, shippingId]),
      );
      const saved = await asAlice(() =>
        parserTools.saveDraft(aliceId, ASSISTANT_CLAIM_KEY, {
          requestId: queued.requestId,
          name: "Example Shop",
          fromDomains: ["shop.example.com"],
          definition: {
            ...DEFINITION,
            defaultCategoryId: booksId,
            shippingCategoryId: shippingId,
          },
        }),
      );
      expect(saved).toMatchObject({ status: "draft", requestProposed: true });
      const [parserRow] = await db.query(
        `SELECT status, source, approved_at FROM email_receipt_parsers WHERE id = $1`,
        [saved.parserId],
      );
      expect(parserRow).toEqual({
        status: "draft",
        source: "ai",
        approved_at: null,
      });
      [request] = await requestRows();
      expect(request.status).toBe("proposed");
      expect(request.proposal).toMatchObject({ parserId: saved.parserId });

      // a draft reads nothing: reprocessing still finds no parser
      const stillNone = await asAlice(() => receipts.reprocess(aliceId, r1));
      expect(stillNone).toMatchObject({ status: "no_parser" });
      // and nothing touched the ledger
      expect(await splitCount()).toBe(0);

      // 5. the inbox shows it as a ready draft
      const [item] = await asAlice(() => work.listInbox(aliceId));
      expect(item).toMatchObject({
        id: queued.requestId,
        kind: "email_parser_draft",
        status: "proposed",
        transactionId: null,
        transaction: null,
        parserDraft: {
          domain: "shop.example.com",
          emailCount: 2,
          parserId: saved.parserId,
        },
      });

      // 6. the user approves the parser: the request is applied in the same transaction
      await asAlice(() => parsers.approve(aliceId, saved.parserId));
      [request] = await requestRows();
      expect(request.status).toBe("applied");
      const [approved] = await db.query(
        `SELECT status FROM email_receipt_parsers WHERE id = $1`,
        [saved.parserId],
      );
      expect(approved.status).toBe("approved");

      // 7. and now the parser reads the email
      const read = await asAlice(() => receipts.reprocess(aliceId, r1));
      expect(read).toMatchObject({
        status: "review",
        parserName: "Example Shop",
      });
    });

    it("deleting the draft dismisses the request that proposed it", async () => {
      const [r1] = await twoShopEmails();
      const { requestId } = await asAlice(() =>
        parsers.requestAiDraft(aliceId, [r1]),
      );
      await asAlice(() => work.claim(aliceId, ASSISTANT_CLAIM_KEY, requestId));
      const saved = await asAlice(() =>
        parserTools.saveDraft(aliceId, ASSISTANT_CLAIM_KEY, {
          requestId,
          name: "Example Shop",
          fromDomains: ["shop.example.com"],
          definition: DEFINITION,
        }),
      );

      await asAlice(() => parsers.remove(aliceId, saved.parserId));

      expect((await requestRows())[0].status).toBe("rejected");
    });

    it("refuses a draft for a request the caller did not claim, writing no parser", async () => {
      const [r1] = await twoShopEmails();
      const { requestId } = await asAlice(() =>
        parsers.requestAiDraft(aliceId, [r1]),
      );
      const save = (caller: string) =>
        asAlice(() =>
          parserTools.saveDraft(aliceId, caller, {
            requestId,
            name: "Example Shop",
            fromDomains: ["shop.example.com"],
            definition: DEFINITION,
          }),
        );

      // pending, nobody claimed it
      await expect(save(ASSISTANT_CLAIM_KEY)).rejects.toMatchObject({
        status: 409,
      });
      // claimed by the assistant, answered by another caller
      await asAlice(() => work.claim(aliceId, ASSISTANT_CLAIM_KEY, requestId));
      await expect(save("an-mcp-client")).rejects.toMatchObject({
        status: 409,
      });
      expect(
        await db.query(`SELECT 1 FROM email_receipt_parsers`),
      ).toHaveLength(0);
      expect((await requestRows())[0].status).toBe("claimed");
    });

    it("keeps one open request per sender: asking again replaces it", async () => {
      const [r1, r2] = await twoShopEmails();
      const first = await asAlice(() => parsers.requestAiDraft(aliceId, [r1]));
      const second = await asAlice(() =>
        parsers.requestAiDraft(aliceId, [r1, r2]),
      );

      expect(second.requestId).not.toBe(first.requestId);
      const rows = await requestRows();
      expect(rows.map((r: { status: string }) => r.status)).toEqual([
        "rejected",
        "pending",
      ]);
      expect(rows[1].email_receipt_ids).toEqual([r1, r2]);
      // the closed request can no longer be claimed
      await expect(
        asAlice(() =>
          work.claim(aliceId, ASSISTANT_CLAIM_KEY, first.requestId),
        ),
      ).resolves.toEqual({ request: null });
    });

    it("an expired request does not hold the slot", async () => {
      const [r1] = await twoShopEmails();
      const first = await asAlice(() => parsers.requestAiDraft(aliceId, [r1]));
      await db.query(
        `UPDATE ai_review_requests SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 hour' WHERE id = $1`,
        [first.requestId],
      );

      const second = await asAlice(() => parsers.requestAiDraft(aliceId, [r1]));

      const rows = await requestRows();
      expect(
        rows.find((r: { id: string }) => r.id === first.requestId).status,
      ).toBe("expired");
      expect(
        rows.find((r: { id: string }) => r.id === second.requestId).status,
      ).toBe("pending");
    });

    it("refuses another user's emails, a skipped one and an unknown one, queueing nothing", async () => {
      const [r1] = await twoShopEmails();
      await db.query(
        `INSERT INTO email_receipts
           (user_id, mailbox_id, uid_validity, uid, from_address, from_domain,
            subject, received_at, body_text, status, status_reason)
         VALUES ($1, $2, 1001, 90, '', '', '', '2026-09-10T10:00:00Z', '', 'skipped', 'too_large')`,
        [aliceId, mailboxId],
      );
      const [skipped] = await db.query(
        `SELECT id FROM email_receipts WHERE uid = 90`,
      );

      await expect(
        asBob(() => parsers.requestAiDraft(bobId, [r1])),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        asAlice(() => parsers.requestAiDraft(aliceId, [r1, skipped.id])),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        asAlice(() =>
          parsers.requestAiDraft(aliceId, [
            "00000000-0000-4000-8000-000000000999",
          ]),
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(await requestRows()).toHaveLength(0);
    });

    it("another user cannot claim it by id, save a draft for it, test on its emails or see it in the inbox", async () => {
      const [r1] = await twoShopEmails();
      const { requestId } = await asAlice(() =>
        parsers.requestAiDraft(aliceId, [r1]),
      );

      await expect(
        asBob(() => work.claim(bobId, ASSISTANT_CLAIM_KEY, requestId)),
      ).resolves.toEqual({ request: null });
      await expect(
        asBob(() =>
          parserTools.saveDraft(bobId, ASSISTANT_CLAIM_KEY, {
            requestId,
            name: "Stolen",
            fromDomains: ["shop.example.com"],
            definition: DEFINITION,
          }),
        ),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        asBob(() =>
          parserTools.testDefinition(bobId, {
            definition: DEFINITION,
            receiptIds: [r1],
          }),
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(await asBob(() => work.listInbox(bobId))).toEqual([]);
      expect((await requestRows())[0].status).toBe("pending");
    });

    it("the rest of the queue still works beside it: a transaction request is listed, claimed and expired with it", async () => {
      const [r1] = await twoShopEmails();
      const draft = await asAlice(() => parsers.requestAiDraft(aliceId, [r1]));
      const receipt = (await receiptRows())[0];
      await asAlice(() => receiptAi.askAi(aliceId, receipt.id, txId));

      const list = await asAlice(() => work.list(aliceId, ASSISTANT_CLAIM_KEY));
      expect(list.requests.map((r) => r.kind).sort()).toEqual([
        "email_parser_draft",
        "email_receipt",
      ]);
      // the inbox lists both without trouble, each in its own shape
      const inbox = await asAlice(() => work.listInbox(aliceId));
      expect(inbox).toHaveLength(2);
      expect(
        inbox.find((i) => i.id === draft.requestId)?.transaction,
      ).toBeNull();
      expect(
        inbox.find((i) => i.kind === "email_receipt")?.transaction?.id,
      ).toBe(txId);
      // the sweep treats them alike
      await db.query(
        `UPDATE ai_review_requests SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'`,
      );
      await asAlice(() => module.get(AiReviewRequestsService).expireStale());
      expect(
        (await requestRows()).map((r: { status: string }) => r.status),
      ).toEqual(["expired", "expired"]);
    });
  });
});
