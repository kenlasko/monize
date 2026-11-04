import { Global, Module } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { AiModule } from "@/ai/ai.module";
import { AiReviewModule } from "@/ai-review/ai-review.module";
import { AiReviewWorkService } from "@/ai-review/ai-review-work.service";
import { ASSISTANT_CLAIM_KEY } from "@/ai-review/ai-review-work.types";
import { RECEIPT_MULTI_DOMAIN_PARSER_DRAFT_INSTRUCTION } from "@/email-receipts/parsers/parser-draft-instruction";
import { EmailReceiptParserToolsService } from "@/email-receipts/parsers/email-receipt-parser-tools.service";
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
import {
  ALLEGRO_PAY_COMPONENT_DEFINITION,
  ALLEGRO_PAY_CONTRACT_1,
  ALLEGRO_PAY_CONTRACT_2,
  ALLEGRO_PAY_PURCHASE_LINES,
  ALLEGRO_PAY_PURCHASE_SUBJECT,
  ALLEGRO_PAY_REPAYMENT_LINES,
  ALLEGRO_PAY_REPAYMENT_SUBJECT,
  ALLEGRO_PAY_SETTLEMENT_DEFINITION,
} from "@/email-receipts/parsing/fixtures/allegro-pay-mails";
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
 * Linked email receipts end to end (docs/specs/email-receipt-linked-receipts.md)
 * against a real PostgreSQL enforcing RLS: a purchase email is stored as a
 * component; the repayment email that names the bank transaction joins it, and
 * its proposal splits the transaction into the purchase's lines. The two
 * profiles and both emails are the synthetic Allegro Pay fixtures.
 */
describe("linked email receipts (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let poller: EmailReceiptPollService;
  let receipts: EmailReceiptsService;
  let parsers: EmailReceiptParsersService;
  let parserTools: EmailReceiptParserToolsService;
  let work: AiReviewWorkService;
  let transactions: TransactionsService;
  let imap: ImapMailboxClient;
  let encryption: EncryptionService;

  let aliceId: string;
  let accountId: string;
  let goodsId: string;
  let shippingId: string;
  let mailboxId: string;
  let txId: string;
  let nextUid = 40;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);

  const serverReturns = (
    from: string,
    subject: string,
    date: string,
    lines: string[],
  ): FetchSinceResult => {
    const uid = String(++nextUid);
    return {
      uidValidity: "1001",
      messages: [
        {
          uid,
          source: Buffer.from(
            [
              `From: Sender <noreply@${from}>`,
              "To: receipts@example.com",
              `Subject: ${subject}`,
              `Date: ${date}`,
              `Message-ID: <m${uid}@${from}>`,
              "Content-Type: text/plain; charset=utf-8",
              "",
              lines.join("\r\n"),
              "",
            ].join("\r\n"),
          ),
          internalDate: new Date(date),
          size: 800,
        },
      ],
      skipped: [],
      highestUid: uid,
    };
  };

  const poll = async (mail: FetchSinceResult) => {
    jest.spyOn(imap, "fetchSince").mockResolvedValueOnce(mail);
    await asAlice(() =>
      poller.pollMailbox(aliceId, mailboxId, { requireEnabled: true }),
    );
  };

  const purchaseMail = () =>
    serverReturns(
      "shop.example.com",
      ALLEGRO_PAY_PURCHASE_SUBJECT,
      "Mon, 15 Dec 2025 10:00:00 +0000",
      ALLEGRO_PAY_PURCHASE_LINES,
    );
  const repaymentMail = () =>
    serverReturns(
      "pay.example.com",
      ALLEGRO_PAY_REPAYMENT_SUBJECT,
      "Sat, 10 Jan 2026 10:00:00 +0000",
      ALLEGRO_PAY_REPAYMENT_LINES,
    );

  const receiptBy = async (domain: string) =>
    (
      await db.query(`SELECT * FROM email_receipts WHERE from_domain = $1`, [
        domain,
      ])
    )[0];
  const linkRows = () =>
    db.query(
      `SELECT part_index, link_value, part_amount, component_receipt_id, outcome
         FROM email_receipt_links ORDER BY part_index`,
    );

  const createProfiles = async () => {
    const component = await asAlice(() =>
      parsers.create(aliceId, {
        name: "Shop purchases",
        fromDomains: ["shop.example.com"],
        definition: {
          ...ALLEGRO_PAY_COMPONENT_DEFINITION,
          defaultCategoryId: goodsId,
          shippingCategoryId: shippingId,
          tag: "Allegro",
        },
      } as never),
    );
    await asAlice(() =>
      parsers.create(aliceId, {
        name: "Repayments",
        fromDomains: ["pay.example.com"],
        definition: {
          ...ALLEGRO_PAY_SETTLEMENT_DEFINITION,
          defaultCategoryId: goodsId,
        },
      } as never),
    );
    return component;
  };

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
    parsers = module.get(EmailReceiptParsersService);
    parserTools = module.get(EmailReceiptParserToolsService);
    work = module.get(AiReviewWorkService);
    transactions = module.get(TransactionsService);
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
      "email_receipt_links",
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
    accountId = (
      await createTestAccount(db, aliceId, {
        name: "Checking",
        currencyCode: "USD",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    goodsId = (await createTestCategory(db, aliceId, { name: "Goods" })).id;
    shippingId = (await createTestCategory(db, aliceId, { name: "Shipping" }))
      .id;
    txId = (
      await asAlice(() =>
        transactions.create(aliceId, {
          accountId,
          transactionDate: "2026-01-10",
          amount: -272.89,
          currencyCode: "USD",
          description: "ALLEGRO PAY SPLATA",
        } as never),
      )
    ).id;
    const [mailbox] = await db.query(
      `INSERT INTO email_receipt_mailboxes
         (user_id, host, port, security, username, password_enc, enabled, ai_mode, auto_apply)
       VALUES ($1, '8.8.8.8', 993, 'tls', 'receipts@example.com', $2, true, 'off', false)
       RETURNING id`,
      [aliceId, encryption.encrypt("app-password-for-tests")],
    );
    mailboxId = mailbox.id;
  });

  const requests = () =>
    db.query(`SELECT * FROM ai_review_requests ORDER BY created_at`);

  it("stores a purchase as a component, then proposes the repayment's transaction split into the purchase's lines", async () => {
    await createProfiles();

    await poll(purchaseMail());
    const component = await receiptBy("shop.example.com");
    expect(component).toMatchObject({
      status: "component",
      status_reason: "awaiting_settlement",
      link_key: ALLEGRO_PAY_CONTRACT_2,
      transaction_id: null,
      ai_review_request_id: null,
    });
    expect(await requests()).toHaveLength(0);

    await poll(repaymentMail());
    const settlement = await receiptBy("pay.example.com");
    expect(settlement).toMatchObject({
      status: "review",
      status_reason: "partially_linked",
      transaction_id: txId,
      link_key: null,
    });
    const [request] = await requests();
    expect(request).toMatchObject({
      kind: "email_receipt",
      status: "proposed",
      transaction_id: txId,
      email_receipt_id: settlement.id,
    });
    const splits = request.proposal.input.splits as { amount: number }[];
    expect(splits.map((s) => s.amount)).toEqual([-109.89, -140, -10, -13]);
    expect(Math.round(splits.reduce((sum, s) => sum + s.amount * 100, 0))).toBe(
      -27289,
    );
    expect(request.proposal.input.tagNames).toEqual(["Allegro"]);

    const links = await linkRows();
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({
      part_index: 0,
      link_value: ALLEGRO_PAY_CONTRACT_1,
      outcome: "not_found",
      component_receipt_id: null,
    });
    expect(Number(links[0].part_amount)).toBe(109.89);
    expect(links[1]).toMatchObject({
      part_index: 1,
      link_value: ALLEGRO_PAY_CONTRACT_2,
      outcome: "joined",
      component_receipt_id: component.id,
    });
    expect(Number(links[1].part_amount)).toBe(163);

    // the component keeps its status and now says it is used up
    expect(await receiptBy("shop.example.com")).toMatchObject({
      status: "component",
      status_reason: "settled",
    });

    // ignoring the settlement leaves it no link rows, so it takes nothing
    await asAlice(() => receipts.ignore(aliceId, settlement.id));
    expect(await linkRows()).toHaveLength(0);
  });

  it("reads a repayment with no component stored as the single email would: one line per part", async () => {
    await createProfiles();

    await poll(repaymentMail());

    const settlement = await receiptBy("pay.example.com");
    expect(settlement).toMatchObject({
      status: "review",
      status_reason: "partially_linked",
      transaction_id: txId,
    });
    const [request] = await requests();
    expect(
      (request.proposal.input.splits as { amount: number }[]).map(
        (s) => s.amount,
      ),
    ).toEqual([-109.89, -163]);
    expect((await linkRows()).map((l) => l.outcome)).toEqual([
      "not_found",
      "not_found",
    ]);
  });

  it("is a review_conflict, enriched_by_other, when an unrelated email already enriched the transaction", async () => {
    await createProfiles();
    await poll(
      serverReturns(
        "other.example.org",
        "Unrelated",
        "Fri, 09 Jan 2026 10:00:00 +0000",
        ["Hello"],
      ),
    );
    const unrelated = await receiptBy("other.example.org");
    await db.query(
      `INSERT INTO ai_review_requests
         (user_id, transaction_id, kind, instruction, status, email_receipt_id)
       VALUES ($1, $2, 'email_receipt', 'x', 'applied', $3)`,
      [aliceId, txId, unrelated.id],
    );

    await poll(repaymentMail());

    const settlement = await receiptBy("pay.example.com");
    expect(settlement).toMatchObject({
      status: "review_conflict",
      status_reason: "enriched_by_other",
      transaction_id: null,
      candidate_transaction_ids: [txId],
      ai_review_request_id: null,
    });
    expect(await requests()).toHaveLength(1);
    expect(await linkRows()).toHaveLength(2);
  });

  it("proposes over a transaction that the component it joins had enriched", async () => {
    await createProfiles();
    await poll(purchaseMail());
    const component = await receiptBy("shop.example.com");
    await db.query(
      `INSERT INTO ai_review_requests
         (user_id, transaction_id, kind, instruction, status, email_receipt_id)
       VALUES ($1, $2, 'email_receipt', 'x', 'applied', $3)`,
      [aliceId, txId, component.id],
    );

    await poll(repaymentMail());

    const settlement = await receiptBy("pay.example.com");
    expect(settlement).toMatchObject({
      status: "review",
      transaction_id: txId,
    });
    const proposed = (await requests()).filter((r) => r.status === "proposed");
    expect(proposed).toHaveLength(1);
    expect(proposed[0].email_receipt_id).toBe(settlement.id);
  });

  describe("the parser test and the receipt detail (spec 10)", () => {
    const settlementDefinition = () => ({
      ...ALLEGRO_PAY_SETTLEMENT_DEFINITION,
      defaultCategoryId: goodsId,
    });
    const sumUnits = (items: { amount: number }[]) =>
      items.reduce((sum, item) => sum + item.amount, 0);

    it("tests a settlement email with the pipeline's own join: links per part and the joined lines", async () => {
      await createProfiles();
      await poll(purchaseMail());
      await poll(repaymentMail());
      const component = await receiptBy("shop.example.com");
      const settlement = await receiptBy("pay.example.com");

      const run = await asAlice(() =>
        parsers.test(aliceId, {
          definition: settlementDefinition(),
          receiptId: settlement.id,
        } as never),
      );

      expect(run.component).toBeUndefined();
      expect(run.links).toEqual([
        {
          partIndex: 0,
          link: ALLEGRO_PAY_CONTRACT_1,
          component: null,
          partAmount: 1098900,
          componentNet: null,
          taken: null,
          outcome: "not_found",
          several: 0,
        },
        {
          partIndex: 1,
          link: ALLEGRO_PAY_CONTRACT_2,
          component: {
            id: component.id,
            subject: ALLEGRO_PAY_PURCHASE_SUBJECT,
            effectiveDate: "2025-12-15",
            profileName: "Shop purchases",
            source: "stored",
          },
          partAmount: 1630000,
          componentNet: 1630000,
          taken: 0,
          outcome: "joined",
          several: 1,
        },
      ]);
      // The same joined lines the pipeline stored and proposed.
      const stored = settlement.parsed.items as { amount: number }[];
      expect(run.parsed.items.map((item) => item.amount)).toEqual(
        stored.map((item) => item.amount),
      );
      expect(sumUnits(run.parsed.items)).toBe(2728900);
      expect(run.parsed.links?.map((l) => l.outcome)).toEqual(
        (settlement.parsed.links as { outcome: string }[]).map(
          (l) => l.outcome,
        ),
      );
      // Reads only: the stored rows are as they were.
      expect((await linkRows()).map((l) => l.outcome)).toEqual([
        "not_found",
        "joined",
      ]);
    });

    it("tests a draft settlement definition, not the stored profile", async () => {
      await createProfiles();
      await poll(purchaseMail());
      await poll(repaymentMail());
      const settlement = await receiptBy("pay.example.com");

      const run = await asAlice(() =>
        parsers.test(aliceId, {
          definition: {
            ...settlementDefinition(),
            link: { fromDomains: ["nobody.example.net"] },
          },
          receiptId: settlement.id,
        } as never),
      );

      expect(run.links?.map((l) => l.outcome)).toEqual([
        "not_found",
        "not_found",
      ]);
    });

    it("tests a component email: outcome component, its link key and the settlements waiting for it", async () => {
      await createProfiles();
      await poll(purchaseMail());
      await poll(repaymentMail());
      const component = await receiptBy("shop.example.com");
      const settlement = await receiptBy("pay.example.com");
      // The link row of the part waits for its component again.
      await db.query(
        `UPDATE email_receipt_links
            SET component_receipt_id = NULL, outcome = 'not_found'
          WHERE link_value = $1`,
        [ALLEGRO_PAY_CONTRACT_2],
      );

      const run = await asAlice(() =>
        parsers.test(aliceId, {
          definition: {
            ...ALLEGRO_PAY_COMPONENT_DEFINITION,
            defaultCategoryId: goodsId,
            shippingCategoryId: shippingId,
          },
          receiptId: component.id,
        } as never),
      );

      expect(run.component).toEqual({
        linkKey: ALLEGRO_PAY_CONTRACT_2,
        waitingSettlements: [
          {
            id: settlement.id,
            subject: ALLEGRO_PAY_REPAYMENT_SUBJECT,
            effectiveDate: "2026-01-10",
          },
        ],
      });
      expect(run.match).toEqual({
        kind: "unmatched",
        considered: 0,
        attempts: [],
      });
      expect(run.candidateCount).toBe(0);
      expect(run.links).toBeUndefined();
      expect(run.trace.linkKey).not.toBeNull();
    });

    it("shows the components of a settlement and the settlements of a component in the detail", async () => {
      await createProfiles();
      await poll(purchaseMail());
      await poll(repaymentMail());
      const component = await receiptBy("shop.example.com");
      const settlement = await receiptBy("pay.example.com");

      const settlementDetail = await asAlice(() =>
        receipts.get(aliceId, settlement.id),
      );
      expect(settlementDetail.linkKey).toBeNull();
      expect(settlementDetail.linkedComponents).toEqual([
        {
          partIndex: 1,
          receiptId: component.id,
          subject: ALLEGRO_PAY_PURCHASE_SUBJECT,
          effectiveDate: "2025-12-15T10:00:00.000Z",
        },
      ]);
      expect(settlementDetail.linkedSettlements).toEqual([]);
      expect(settlementDetail.enrichedBy).toBeNull();

      const componentDetail = await asAlice(() =>
        receipts.get(aliceId, component.id),
      );
      expect(componentDetail.linkKey).toBe(ALLEGRO_PAY_CONTRACT_2);
      expect(componentDetail.linkedComponents).toEqual([]);
      expect(componentDetail.linkedSettlements).toEqual([
        {
          receiptId: settlement.id,
          subject: ALLEGRO_PAY_REPAYMENT_SUBJECT,
          effectiveDate: "2026-01-10T10:00:00.000Z",
          partAmount: 163,
          outcome: "joined",
          transactionId: txId,
        },
      ]);
      const listed = await asAlice(() => receipts.list(aliceId, {}));
      expect(listed.find((r) => r.id === component.id)?.linkKey).toBe(
        ALLEGRO_PAY_CONTRACT_2,
      );
    });

    it("names the email that enriched the transaction of an enriched_by_other conflict", async () => {
      await createProfiles();
      await poll(
        serverReturns(
          "other.example.org",
          "Unrelated",
          "Fri, 09 Jan 2026 10:00:00 +0000",
          ["Hello"],
        ),
      );
      const unrelated = await receiptBy("other.example.org");
      await db.query(
        `INSERT INTO ai_review_requests
           (user_id, transaction_id, kind, instruction, status, email_receipt_id)
         VALUES ($1, $2, 'email_receipt', 'x', 'applied', $3)`,
        [aliceId, txId, unrelated.id],
      );
      await poll(repaymentMail());
      const settlement = await receiptBy("pay.example.com");

      const detail = await asAlice(() => receipts.get(aliceId, settlement.id));

      expect(detail.status).toBe("review_conflict");
      expect(detail.enrichedBy).toEqual({
        receiptId: unrelated.id,
        subject: "Unrelated",
      });
    });
  });

  /** The purchase for contract 1 (the one the repayment pays first): an item of 100,00 and shipping 9,89. */
  const FIRST_PURCHASE_LINES = [
    "Dziękujemy za zamówienie",
    "Pozycje zamówienia",
    "Klocki drewniane zestaw",
    "100,00 zł",
    "Koszt dostawy",
    "9,89 zł",
    "Razem do zapłaty",
    "109,89 zł",
    "Forma płatności",
    "Allegro Pay",
    "Umowa Allegro Pay",
    `${ALLEGRO_PAY_CONTRACT_1} (umowa w załączniku)`,
    "Tytuł przelewu",
    `Allegro Pay ${ALLEGRO_PAY_CONTRACT_1}`,
  ];
  const firstPurchaseMail = () =>
    serverReturns(
      "shop.example.com",
      ALLEGRO_PAY_PURCHASE_SUBJECT,
      "Fri, 12 Dec 2025 10:00:00 +0000",
      FIRST_PURCHASE_LINES,
    );

  const splitAmounts = (request: { proposal: { input: unknown } }) =>
    (request.proposal.input as { splits: { amount: number }[] }).splits.map(
      (split) => split.amount,
    );
  const sumCents = (amounts: number[]) =>
    Math.round(amounts.reduce((sum, amount) => sum + amount * 100, 0));

  describe("a component that arrives after its settlement (spec 8)", () => {
    it("reprocesses a settlement that waits with an open card: a new card with both purchases' lines", async () => {
      await createProfiles();
      await poll(purchaseMail());
      await poll(repaymentMail());
      const settlement = await receiptBy("pay.example.com");
      const [first] = await requests();
      expect(splitAmounts(first)).toEqual([-109.89, -140, -10, -13]);

      await poll(firstPurchaseMail());

      const first2 = (await requests()).find((r) => r.id === first.id);
      expect(first2?.status).toBe("rejected");
      const proposed = (await requests()).filter(
        (r) => r.status === "proposed",
      );
      expect(proposed).toHaveLength(1);
      expect(proposed[0]).toMatchObject({
        transaction_id: txId,
        email_receipt_id: settlement.id,
      });
      const amounts = splitAmounts(proposed[0]);
      expect(amounts).toEqual([-100, -9.89, -140, -10, -13]);
      expect(sumCents(amounts)).toBe(-27289);
      expect(await receiptBy("pay.example.com")).toMatchObject({
        status: "review",
        status_reason: null,
        ai_review_request_id: proposed[0].id,
      });
      const links = await linkRows();
      expect(links.map((l) => l.outcome)).toEqual(["joined", "joined"]);
      expect(links.every((l) => l.component_receipt_id !== null)).toBe(true);
    });

    it("proposes a re-join card on the same transaction when the first card was applied, and leaves the applied request applied", async () => {
      await createProfiles();
      await poll(purchaseMail());
      await poll(repaymentMail());
      const [first] = await requests();
      await db.query(
        `UPDATE ai_review_requests SET status = 'applied' WHERE id = $1`,
        [first.id],
      );

      await poll(firstPurchaseMail());

      const all = await requests();
      expect(all.find((r) => r.id === first.id)?.status).toBe("applied");
      const proposed = all.filter((r) => r.status === "proposed");
      expect(proposed).toHaveLength(1);
      expect(proposed[0].transaction_id).toBe(txId);
      const amounts = splitAmounts(proposed[0]);
      expect(amounts).toEqual([-100, -9.89, -140, -10, -13]);
      expect(sumCents(amounts)).toBe(-27289);
      expect(await receiptBy("pay.example.com")).toMatchObject({
        status: "review",
        transaction_id: txId,
        ai_review_request_id: proposed[0].id,
      });
      expect((await linkRows()).map((l) => l.outcome)).toEqual([
        "joined",
        "joined",
      ]);
    });

    it("writes nothing for an applied settlement when the component that arrives joins no missing part", async () => {
      await createProfiles();
      await poll(repaymentMail());
      const [first] = await requests();
      await db.query(
        `UPDATE ai_review_requests SET status = 'applied' WHERE id = $1`,
        [first.id],
      );
      // a purchase for a contract the repayment does not name
      await poll(
        serverReturns(
          "shop.example.com",
          ALLEGRO_PAY_PURCHASE_SUBJECT,
          "Fri, 12 Dec 2025 10:00:00 +0000",
          ALLEGRO_PAY_PURCHASE_LINES.map((line) =>
            line.replace(ALLEGRO_PAY_CONTRACT_2, "1999999999"),
          ),
        ),
      );
      const all = await requests();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id: first.id, status: "applied" });
      expect((await linkRows()).map((l) => l.outcome)).toEqual([
        "not_found",
        "not_found",
      ]);
    });
  });

  it("gives a component back its awaiting_settlement reason when the settlement that used it is deleted", async () => {
    await createProfiles();
    await poll(purchaseMail());
    await poll(repaymentMail());
    const settlement = await receiptBy("pay.example.com");
    expect(await receiptBy("shop.example.com")).toMatchObject({
      status: "component",
      status_reason: "settled",
    });

    await asAlice(() => receipts.remove(aliceId, settlement.id));

    expect(await receiptBy("shop.example.com")).toMatchObject({
      status: "component",
      status_reason: "awaiting_settlement",
    });
    expect(await linkRows()).toHaveLength(0);
  });

  it("reads an applied purchase email as a component once its profile is one, then lets the repayment take the transaction over", async () => {
    // The old, standalone purchase profile: no role, no link key.
    const {
      role: _role,
      linkKey: _linkKey,
      ...standalone
    } = ALLEGRO_PAY_COMPONENT_DEFINITION;
    const profile = await asAlice(() =>
      parsers.create(aliceId, {
        name: "Shop purchases",
        fromDomains: ["shop.example.com"],
        definition: {
          ...standalone,
          defaultCategoryId: goodsId,
          shippingCategoryId: shippingId,
        },
      } as never),
    );
    await asAlice(() =>
      parsers.create(aliceId, {
        name: "Repayments",
        fromDomains: ["pay.example.com"],
        definition: {
          ...ALLEGRO_PAY_SETTLEMENT_DEFINITION,
          defaultCategoryId: goodsId,
        },
      } as never),
    );
    await poll(purchaseMail());
    const purchase = await receiptBy("shop.example.com");
    // Standalone: the purchase email found no transaction of its own (163,00).
    expect(purchase.status).not.toBe("component");
    await asAlice(() => receipts.link(aliceId, purchase.id, txId));
    const linked = await receiptBy("shop.example.com");
    expect(linked).toMatchObject({ status: "review", transaction_id: txId });
    await db.query(
      `UPDATE ai_review_requests SET status = 'applied' WHERE id = $1`,
      [linked.ai_review_request_id],
    );

    // The profile becomes a component.
    await db.query(
      `UPDATE email_receipt_parsers SET definition = $2::jsonb, updated_at = now() WHERE id = $1`,
      [
        profile.id,
        JSON.stringify({
          ...ALLEGRO_PAY_COMPONENT_DEFINITION,
          defaultCategoryId: goodsId,
          shippingCategoryId: shippingId,
        }),
      ],
    );
    const counts = await asAlice(() => parsers.list(aliceId));
    expect(
      counts.find((view) => view.id === profile.id)?.reprocessableCount,
    ).toBe(1);

    // A default process-batch reads it again, as a component.
    const run = await asAlice(() => receipts.processBatch(aliceId, {}));
    expect(run).toMatchObject({ processed: 1, failed: 0, remaining: 0 });
    expect(await receiptBy("shop.example.com")).toMatchObject({
      status: "component",
      status_reason: "awaiting_settlement",
      link_key: ALLEGRO_PAY_CONTRACT_2,
      transaction_id: txId,
      ai_review_request_id: linked.ai_review_request_id,
    });
    const [appliedRequest] = await requests();
    expect(appliedRequest).toMatchObject({ status: "applied" });

    // The repayment takes the transaction over: a new card, not review_conflict.
    await poll(repaymentMail());
    const settlement = await receiptBy("pay.example.com");
    expect(settlement).toMatchObject({
      status: "review",
      transaction_id: txId,
    });
    const proposed = (await requests()).filter((r) => r.status === "proposed");
    expect(proposed).toHaveLength(1);
    expect(proposed[0].email_receipt_id).toBe(settlement.id);
    expect(sumCents(splitAmounts(proposed[0]))).toBe(-27289);
  });

  it("leaves an applied review email that no component profile covers out of a default process-batch", async () => {
    await createProfiles();
    await poll(repaymentMail());
    const [first] = await requests();
    await db.query(
      `UPDATE ai_review_requests SET status = 'applied' WHERE id = $1`,
      [first.id],
    );
    const run = await asAlice(() => receipts.processBatch(aliceId, {}));
    expect(run).toMatchObject({ processed: 0, remaining: 0 });
    expect((await receiptBy("pay.example.com")).status).toBe("review");
  });

  describe("drafting a component and its settlement with AI (spec 10a)", () => {
    const componentDefinition = () => ({
      ...ALLEGRO_PAY_COMPONENT_DEFINITION,
      defaultCategoryId: goodsId,
      shippingCategoryId: shippingId,
    });
    const settlementDefinition = () => ({
      ...ALLEGRO_PAY_SETTLEMENT_DEFINITION,
      defaultCategoryId: goodsId,
    });
    const draftRequests = () =>
      db.query(
        `SELECT status, parser_domain, proposal, instruction
           FROM ai_review_requests WHERE kind = 'email_parser_draft'`,
      );
    const parserStatus = async (id: string) =>
      (
        await db.query(
          `SELECT status FROM email_receipt_parsers WHERE id = $1`,
          [id],
        )
      )[0]?.status;

    /** Both emails stored with no profile at all: the state a draft request starts from. */
    const claimedRequest = async () => {
      await poll(purchaseMail());
      await poll(repaymentMail());
      const shop = await receiptBy("shop.example.com");
      const pay = await receiptBy("pay.example.com");
      const { requestId } = await asAlice(() =>
        parsers.requestAiDraft(aliceId, [shop.id, pay.id]),
      );
      await asAlice(() => work.claim(aliceId, ASSISTANT_CLAIM_KEY, requestId));
      return { requestId, shop, pay };
    };
    const save = (
      requestId: string,
      name: string,
      domain: string,
      definition: unknown,
    ) =>
      asAlice(() =>
        parserTools.saveDraft(aliceId, ASSISTANT_CLAIM_KEY, {
          requestId,
          name,
          fromDomains: [domain],
          definition,
        }),
      );

    it("files a two-domain request with the multi-sender instruction, and tests the settlement against the unsaved component", async () => {
      const { requestId, pay } = await claimedRequest();
      const [request] = await draftRequests();
      expect(request).toMatchObject({
        status: "claimed",
        instruction: RECEIPT_MULTI_DOMAIN_PARSER_DRAFT_INSTRUCTION,
      });

      const tested = await asAlice(() =>
        parserTools.testDefinition(aliceId, {
          definition: settlementDefinition(),
          receiptIds: [pay.id],
          componentDrafts: [
            {
              definition: componentDefinition(),
              fromDomains: ["shop.example.com"],
            },
          ],
        }),
      );

      expect(tested.valid).toBe(true);
      const [email] = tested.emails;
      expect(email.links?.map((l) => l.outcome)).toEqual([
        "not_found",
        "joined",
      ]);
      expect(email.links?.[1].component).toMatchObject({
        source: "draft",
        effectiveDate: "2025-12-15",
      });
      expect(email.links?.[1]).toMatchObject({
        partAmount: 163,
        componentNet: 163,
      });
      // 109.89 (the part) + 140 + 10 + 13 (the draft component's lines)
      expect(
        Math.round(
          email.parsed.items.reduce((sum, item) => sum + item.amount * 100, 0),
        ),
      ).toBe(27289);
      // Reads only: no parser, no stored component, no link row, request unchanged.
      expect(
        await db.query(`SELECT 1 FROM email_receipt_parsers`),
      ).toHaveLength(0);
      expect(await linkRows()).toHaveLength(0);
      expect((await receiptBy("shop.example.com")).status).not.toBe(
        "component",
      );
      expect((await draftRequests())[0].status).toBe("claimed");
      expect(requestId).toBeDefined();
    });

    it("refuses a component draft beside a definition that is not a settlement, as a result and as a 400", async () => {
      const { shop } = await claimedRequest();
      const draft = {
        definition: componentDefinition(),
        fromDomains: ["shop.example.com"],
      };

      const tool = await asAlice(() =>
        parserTools.testDefinition(aliceId, {
          definition: componentDefinition(),
          receiptIds: [shop.id],
          componentDrafts: [draft],
        }),
      );
      expect(tool).toMatchObject({
        valid: false,
        errors: [
          {
            path: "componentDrafts",
            code: "component_draft_requires_settlement",
          },
        ],
      });
      await expect(
        asAlice(() =>
          parsers.test(aliceId, {
            definition: componentDefinition(),
            receiptId: shop.id,
            componentDrafts: [draft],
          } as never),
        ),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("lets a draft reading replace the stored component of the same email, in the REST test too", async () => {
      await createProfiles();
      await poll(purchaseMail());
      await poll(repaymentMail());
      const pay = await receiptBy("pay.example.com");

      const run = await asAlice(() =>
        parsers.test(aliceId, {
          definition: settlementDefinition(),
          receiptId: pay.id,
          componentDrafts: [
            {
              definition: componentDefinition(),
              fromDomains: ["shop.example.com"],
            },
          ],
        } as never),
      );

      expect(run.links?.[1]).toMatchObject({
        outcome: "joined",
        several: 1,
        component: { source: "draft" },
      });
    });

    it("takes one draft per sender, proposed after the first, applied only when both are approved", async () => {
      const { requestId } = await claimedRequest();

      const component = await save(
        requestId,
        "Shop purchases",
        "shop.example.com",
        componentDefinition(),
      );
      let [request] = await draftRequests();
      expect(request.status).toBe("proposed");
      expect(request.proposal).toMatchObject({
        parserId: component.parserId,
        parserIds: [component.parserId],
      });

      // a draft for a sender the request does not hold is refused, writing nothing
      await expect(
        save(requestId, "Other", "other.example.net", componentDefinition()),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await db.query(`SELECT 1 FROM email_receipt_parsers`),
      ).toHaveLength(1);

      const settlement = await save(
        requestId,
        "Repayments",
        "pay.example.com",
        settlementDefinition(),
      );
      expect(settlement.parserId).not.toBe(component.parserId);
      [request] = await draftRequests();
      expect(request.status).toBe("proposed");
      expect(request.proposal).toMatchObject({
        parserId: component.parserId,
        parserIds: [component.parserId, settlement.parserId],
      });

      // saving for a sender that has a draft updates it
      const again = await save(
        requestId,
        "Repayments 2",
        "pay.example.com",
        settlementDefinition(),
      );
      expect(again).toMatchObject({
        parserId: settlement.parserId,
        revision: 2,
      });
      expect(
        await db.query(`SELECT 1 FROM email_receipt_parsers`),
      ).toHaveLength(2);
      [request] = await draftRequests();
      expect(request.proposal.parserIds).toEqual([
        component.parserId,
        settlement.parserId,
      ]);

      // the inbox lists both
      const [item] = await asAlice(() => work.listInbox(aliceId));
      expect(item.parserDraft).toMatchObject({
        parserId: component.parserId,
        parserIds: [component.parserId, settlement.parserId],
      });

      await asAlice(() => parsers.approve(aliceId, component.parserId));
      expect((await draftRequests())[0].status).toBe("proposed");
      await asAlice(() => parsers.approve(aliceId, settlement.parserId));
      expect((await draftRequests())[0].status).toBe("applied");
      expect(await parserStatus(settlement.parserId)).toBe("approved");
    });

    it("is dismissed only when none of its drafts exists any more", async () => {
      const { requestId } = await claimedRequest();
      const component = await save(
        requestId,
        "Shop purchases",
        "shop.example.com",
        componentDefinition(),
      );
      const settlement = await save(
        requestId,
        "Repayments",
        "pay.example.com",
        settlementDefinition(),
      );

      await asAlice(() => parsers.remove(aliceId, component.parserId));
      expect((await draftRequests())[0].status).toBe("proposed");
      await asAlice(() => parsers.remove(aliceId, settlement.parserId));
      expect((await draftRequests())[0].status).toBe("rejected");
    });

    it("stays proposed when one draft is approved and the other deleted", async () => {
      const { requestId } = await claimedRequest();
      const component = await save(
        requestId,
        "Shop purchases",
        "shop.example.com",
        componentDefinition(),
      );
      const settlement = await save(
        requestId,
        "Repayments",
        "pay.example.com",
        settlementDefinition(),
      );

      await asAlice(() => parsers.remove(aliceId, settlement.parserId));
      await asAlice(() => parsers.approve(aliceId, component.parserId));

      expect((await draftRequests())[0].status).toBe("proposed");
    });

    it("keeps a one-sender request at one draft: a second save is refused as before", async () => {
      await poll(purchaseMail());
      const shop = await receiptBy("shop.example.com");
      const { requestId } = await asAlice(() =>
        parsers.requestAiDraft(aliceId, [shop.id]),
      );
      await asAlice(() => work.claim(aliceId, ASSISTANT_CLAIM_KEY, requestId));
      await save(
        requestId,
        "Shop purchases",
        "shop.example.com",
        componentDefinition(),
      );

      await expect(
        save(requestId, "Again", "shop.example.com", componentDefinition()),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("refuses a selection of six domains, or six emails of one, writing nothing", async () => {
      let uid = 900;
      const stored = async (domain: string) => {
        const [row] = await db.query(
          `INSERT INTO email_receipts
             (user_id, mailbox_id, uid_validity, uid, from_address, from_domain,
              subject, received_at, body_text, status)
           VALUES ($1, $2, 1001, $3, $4, $5, 'x', NOW(), 'x', 'no_parser')
           RETURNING id`,
          [aliceId, mailboxId, ++uid, `a@${domain}`, domain],
        );
        return row.id as string;
      };
      const sixDomains: string[] = [];
      for (let d = 1; d <= 6; d += 1) {
        sixDomains.push(await stored(`d${d}.example.com`));
      }
      await expect(
        asAlice(() => parsers.requestAiDraft(aliceId, sixDomains)),
      ).rejects.toMatchObject({ status: 400 });

      const sixOfOne: string[] = [];
      for (let n = 1; n <= 6; n += 1) {
        sixOfOne.push(await stored("one.example.com"));
      }
      await expect(
        asAlice(() => parsers.requestAiDraft(aliceId, sixOfOne)),
      ).rejects.toMatchObject({ status: 400 });
      expect(await draftRequests()).toHaveLength(0);

      // five domains of five emails each (25) are taken
      const full: string[] = [];
      for (let d = 1; d <= 5; d += 1) {
        for (let n = 1; n <= 5; n += 1)
          full.push(await stored(`f${d}.example.com`));
      }
      await asAlice(() => parsers.requestAiDraft(aliceId, full));
      const [request] = await draftRequests();
      expect(request.instruction).toBe(
        RECEIPT_MULTI_DOMAIN_PARSER_DRAFT_INSTRUCTION,
      );
    });
  });
});
