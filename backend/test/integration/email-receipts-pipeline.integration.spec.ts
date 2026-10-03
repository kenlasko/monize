import { Global, Module } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { AiActionsService } from "@/ai/actions/ai-actions.service";
import { AiModule } from "@/ai/ai.module";
import { AiService } from "@/ai/ai.service";
import { AiReviewModule } from "@/ai-review/ai-review.module";
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
import { RECEIPT_AUTOMATIC_AI_INSTRUCTION } from "@/email-receipts/pipeline/email-receipt-pipeline.service";
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
          version: 1,
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
          definition: { version: 1, total: ["Order total: {amount}"] },
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
            version: 1,
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
});
