import { Global, Module } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

// The securities graph must be evaluated before anything that reaches
// HoldingsService (see holding-concurrent-trades.integration.spec.ts).
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { AiModule } from "@/ai/ai.module";
import { AiReviewModule } from "@/ai-review/ai-review.module";
import { AiReviewQueueModule } from "@/ai-review/ai-review-queue.module";
import { AiReviewWorkService } from "@/ai-review/ai-review-work.service";
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
import { EmailReceiptParsersService } from "@/email-receipts/parsers/email-receipt-parsers.service";
import { EmailReceiptPollService } from "@/email-receipts/poll/email-receipt-poll.service";
import { EmailReceiptsService } from "@/email-receipts/receipts/email-receipts.service";
import { ScheduledTransactionsService } from "@/scheduled-transactions/scheduled-transactions.service";
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
 * Who may make an email read as another sender's (A26-H02, INV-RECEIPT-008,
 * INV-RECEIPT-003). A "Forwarded message" header block is text the sender
 * wrote: it re-identifies the email only when the outer sender is the mailbox
 * owner (the mailbox login or the owner's verified account email), and an
 * email whose identity came from a forward never auto-applies, on the trade
 * path or the purchase path. Real poll, pipeline, card and confirm against a
 * PostgreSQL that enforces RLS.
 *
 * Numerical example of the finding: an outside sender pastes a block naming
 * the broker above "Type: Buy, Symbol: AAPL, Shares: 10, Total cost:
 * $2,000.00"; with auto-apply on, the cash account must stay at 10 000.00
 * (before the fix it moved to 8 000.00).
 *
 * Synthetic data only: example.com addresses and invented names.
 */
describe("email receipts: the forwarder is authenticated, not the pasted header (integration)", () => {
  jest.setTimeout(180000);

  const OWNER_ADDRESS = "alice.owner@example.com";
  const MAILBOX_LOGIN = "receipts@example.com";
  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let poller: EmailReceiptPollService;
  let receipts: EmailReceiptsService;
  let parsers: EmailReceiptParsersService;
  let work: AiReviewWorkService;
  let transactions: TransactionsService;
  let imap: ImapMailboxClient;
  let encryption: EncryptionService;

  let aliceId: string;
  let mailboxId: string;
  let brokerageId: string;
  let cashId: string;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);

  const TRADE_LINES = [
    "Your order has been filled",
    "Account: RRSP",
    "Type: Buy",
    "Symbol: AAPL",
    "Shares: 10",
    "Average price: $200.00",
    "Total cost: $2,000.00",
    "Time: September 9, 2026 12:04 EDT",
  ];
  const BROKER_BLOCK = [
    "---------- Forwarded message ---------",
    "From: Wealthsimple <notifications@wealthsimple.com>",
    "Date: Wed, Sep 9, 2026 at 12:05 PM",
    "Subject: Your order has been filled",
    "",
  ];

  /** An email from `from` whose text is the broker's template, with or without a pasted forward block. */
  const crafted = (
    uid: string,
    from: string,
    withBlock: boolean,
    lines: readonly string[] = TRADE_LINES,
  ) =>
    Buffer.from(
      [
        `From: ${from}`,
        `To: ${MAILBOX_LOGIN}`,
        "Subject: Fwd: Your order has been filled",
        "Date: Thu, 10 Sep 2026 10:00:00 +0000",
        `Message-ID: <c${uid}@mail.example.com>`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        ...(withBlock ? BROKER_BLOCK : []),
        ...lines,
        "",
      ].join("\r\n"),
    );

  const serverReturns = (uid: string, source: Buffer): FetchSinceResult => ({
    uidValidity: "1001",
    messages: [
      {
        uid,
        source,
        internalDate: new Date("2026-09-10T10:00:01Z"),
        size: source.length,
      },
    ],
    skipped: [],
    highestUid: uid,
  });

  async function pollWith(source: Buffer) {
    jest
      .spyOn(imap, "fetchSince")
      .mockResolvedValueOnce(serverReturns("41", source));
    await asAlice(() =>
      poller.pollMailbox(aliceId, mailboxId, { requireEnabled: true }),
    );
    const [receipt] = await db.query(
      `SELECT from_address, from_domain, forwarded_by, status, status_reason
         FROM email_receipts`,
    );
    const requests = await db.query(
      `SELECT kind, status FROM ai_review_requests ORDER BY created_at`,
    );
    const trades = await db.query(
      `SELECT action, quantity, total_amount FROM investment_transactions`,
    );
    const [cash] = await db.query(
      `SELECT current_balance FROM accounts WHERE id = $1`,
      [cashId],
    );
    return { receipt, requests, trades, cash };
  }

  async function createTradeProfile() {
    await asAlice(() =>
      parsers.create(aliceId, {
        name: "Wealthsimple",
        fromDomains: ["wealthsimple.com"],
        definition: {
          version: 2,
          requireLine: ["Your order has been filled"],
          trade: {
            account: ["Account: {account}"],
            action: ["Type: {action}"],
            symbol: ["Symbol: {symbol}"],
            quantity: ["Shares: {quantity}"],
            price: ["Average price: {amount}"],
            total: ["Total cost: {amount}"],
            date: ["Time: {date}"],
            accountRules: [{ match: "RRSP", accountId: brokerageId }],
          },
        },
      } as never),
    );
  }

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "integration-test-secret";
    process.env.ENCRYPTION_KEY ??= "x".repeat(40);
    harness = await createEnforcedIntegrationModule([
      SecuritiesModule,
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
    work = module.get(AiReviewWorkService);
    transactions = module.get(TransactionsService);
    imap = module.get(ImapMailboxClient);
    encryption = module.get(EncryptionService);
    // The harness stubs ScheduledTransactionsService with `{}`; the trade card
    // asks it whether the trade pays a scheduled occurrence. None does here.
    Object.assign(module.get(ScheduledTransactionsService), {
      findInvestmentOccurrenceForTrade: async () => null,
    });
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
      "investment_transactions",
      "holdings",
      "securities",
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
    aliceId = (
      await createTestUserDirect(db, {
        firstName: "Alice",
        email: OWNER_ADDRESS,
      })
    ).id;

    cashId = (
      await createTestAccount(db, aliceId, {
        name: "RRSP - Cash",
        currencyCode: "USD",
        openingBalance: 10000,
        currentBalance: 10000,
      })
    ).id;
    await db.manager.update(Account, cashId, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_CASH,
    });
    brokerageId = (
      await createTestAccount(db, aliceId, {
        name: "RRSP",
        currencyCode: "USD",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    await db.manager.update(Account, brokerageId, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      linkedAccountId: cashId,
    });
    await db.manager.update(Account, cashId, { linkedAccountId: brokerageId });
    await asAlice(() =>
      module.get(SecuritiesService).create(aliceId, {
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK",
        currencyCode: "USD",
      } as never),
    );

    const [mailbox] = await db.query(
      `INSERT INTO email_receipt_mailboxes
         (user_id, host, port, security, username, password_enc, enabled, ai_mode, auto_apply)
       VALUES ($1, '8.8.8.8', 993, 'tls', $2, $3, true, 'off', true)
       RETURNING id`,
      [aliceId, MAILBOX_LOGIN, encryption.encrypt("app-password-for-tests")],
    );
    mailboxId = mailbox.id;
    await createTradeProfile();
  });

  describe("the trade path", () => {
    it("control: the broker's own email (no forward) is booked by auto-apply, so the fixture can book", async () => {
      const r = await pollWith(
        crafted("41", "Wealthsimple <notifications@wealthsimple.com>", false),
      );
      expect(r.receipt).toMatchObject({
        from_domain: "wealthsimple.com",
        forwarded_by: null,
      });
      expect(r.requests).toEqual([{ kind: "email_trade", status: "applied" }]);
      expect(r.trades).toHaveLength(1);
      expect(Number(r.cash.current_balance)).toBe(8000);
    });

    it("an outside sender's pasted forward block chooses no profile and books nothing: cash stays at 10 000", async () => {
      const r = await pollWith(
        crafted("41", "Someone <someone@evil.example>", true),
      );
      // The money first: the finding's numerical example.
      expect(Number(r.cash.current_balance)).toBe(10000);
      expect(r.trades).toHaveLength(0);
      expect(r.requests).toHaveLength(0);
      expect(r.receipt).toMatchObject({
        from_address: "someone@evil.example",
        from_domain: "evil.example",
        forwarded_by: null,
        status: "no_parser",
      });
    });

    it("the owner's own forward from the mailbox login is read as the broker's and waits for a person", async () => {
      const r = await pollWith(crafted("41", `Alice <${MAILBOX_LOGIN}>`, true));
      expect(r.receipt).toMatchObject({
        from_domain: "wealthsimple.com",
        forwarded_by: MAILBOX_LOGIN,
        status: "review",
      });
      expect(r.requests).toEqual([{ kind: "email_trade", status: "proposed" }]);
      expect(r.trades).toHaveLength(0);
      expect(Number(r.cash.current_balance)).toBe(10000);
    });

    it("the owner's forward from their verified account email is re-identified too, and the inbox card names who forwarded it", async () => {
      const r = await pollWith(
        crafted("41", `Alice <${OWNER_ADDRESS.toUpperCase()}>`, true),
      );
      expect(r.receipt).toMatchObject({
        from_domain: "wealthsimple.com",
        // the stored From is lower-case (extractMailText)
        forwarded_by: OWNER_ADDRESS,
      });
      expect(r.requests).toEqual([{ kind: "email_trade", status: "proposed" }]);
      expect(r.trades).toHaveLength(0);

      const inbox = await asAlice(() => work.listInbox(aliceId));
      const card = inbox.find((item) => item.kind === "email_trade");
      expect(card?.emailReceipt).toMatchObject({
        fromAddress: "notifications@wealthsimple.com",
        forwardedBy: OWNER_ADDRESS,
      });
    });

    it("an unverified account email is not the owner's", async () => {
      await db.query(`UPDATE users SET email_verified = false WHERE id = $1`, [
        aliceId,
      ]);
      const r = await pollWith(crafted("41", `Alice <${OWNER_ADDRESS}>`, true));
      expect(r.receipt).toMatchObject({
        from_domain: "example.com",
        forwarded_by: null,
      });
      expect(r.trades).toHaveLength(0);
    });

    it("a row an outside sender's block re-identified before the fix is put back under that sender on reprocess", async () => {
      const [legacy] = await db.query(
        `INSERT INTO email_receipts
           (user_id, mailbox_id, uid_validity, uid, from_address, from_domain,
            subject, received_at, body_text, forwarded_by, status)
         VALUES ($1, $2, 1001, 7, 'notifications@wealthsimple.com',
                 'wealthsimple.com', 'Your order has been filled',
                 '2026-09-10T10:00:00Z', $3, 'someone@evil.example', 'pending')
         RETURNING id`,
        [aliceId, mailboxId, [...BROKER_BLOCK, ...TRADE_LINES].join("\n")],
      );

      const detail = await asAlice(() =>
        receipts.reprocess(aliceId, legacy.id),
      );

      expect(detail).toMatchObject({
        fromAddress: "someone@evil.example",
        fromDomain: "evil.example",
        forwardedBy: null,
        status: "no_parser",
      });
      expect(
        await db.query(`SELECT 1 FROM investment_transactions`),
      ).toHaveLength(0);
      const [cash] = await db.query(
        `SELECT current_balance FROM accounts WHERE id = $1`,
        [cashId],
      );
      expect(Number(cash.current_balance)).toBe(10000);
    });
  });

  describe("the purchase path", () => {
    let txId: string;

    beforeEach(async () => {
      const checking = await createTestAccount(db, aliceId, {
        name: "Checking",
        currencyCode: "USD",
        openingBalance: 1000,
        currentBalance: 1000,
      });
      txId = (
        await asAlice(() =>
          transactions.create(aliceId, {
            accountId: checking.id,
            transactionDate: "2026-09-09",
            amount: -15,
            currencyCode: "USD",
            description: "CARD PURCHASE ORDER ABCD1234",
          } as never),
        )
      ).id;
      const booksId = (await createTestCategory(db, aliceId, { name: "Books" }))
        .id;
      const shippingId = (
        await createTestCategory(db, aliceId, { name: "Shipping" })
      ).id;
      await asAlice(() =>
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
    });

    const SHOP_BLOCK = [
      "---------- Forwarded message ---------",
      "From: Example Shop <orders@shop.example.com>",
      "Date: Wed, Sep 9, 2026 at 10:15 AM",
      "Subject: Your order ABCD1234",
      "",
    ];
    const SHOP_LINES = [
      "Order number: ABCD1234",
      "Items",
      "Widget 12.00",
      "Subtotal 12.00",
      "Shipping: 3.00",
      "Order total: 15.00",
    ];

    const pollShop = async (from: string, withBlock: boolean) => {
      const source = Buffer.from(
        [
          `From: ${from}`,
          `To: ${MAILBOX_LOGIN}`,
          "Subject: Fwd: Your order ABCD1234",
          "Date: Thu, 10 Sep 2026 10:00:00 +0000",
          "Message-ID: <p41@mail.example.com>",
          "Content-Type: text/plain; charset=utf-8",
          "",
          ...(withBlock ? SHOP_BLOCK : []),
          ...SHOP_LINES,
          "",
        ].join("\r\n"),
      );
      jest
        .spyOn(imap, "fetchSince")
        .mockResolvedValueOnce(serverReturns("41", source));
      await asAlice(() =>
        poller.pollMailbox(aliceId, mailboxId, { requireEnabled: true }),
      );
      const [receipt] = await db.query(
        `SELECT from_domain, forwarded_by, status, transaction_id FROM email_receipts`,
      );
      const requests = await db.query(
        `SELECT kind, status FROM ai_review_requests ORDER BY created_at`,
      );
      const [tx] = await db.query(
        `SELECT description FROM transactions WHERE id = $1`,
        [txId],
      );
      return { receipt, requests, tx };
    };

    it("control: the shop's own email is auto-applied", async () => {
      const r = await pollShop("Example Shop <orders@shop.example.com>", false);
      expect(r.receipt).toMatchObject({
        from_domain: "shop.example.com",
        transaction_id: txId,
      });
      expect(r.requests).toEqual([
        { kind: "email_receipt", status: "applied" },
      ]);
    });

    it("an outside sender's pasted block is not the shop's: nothing is matched or applied", async () => {
      const r = await pollShop("Someone <someone@evil.example>", true);
      expect(r.receipt).toMatchObject({
        from_domain: "evil.example",
        forwarded_by: null,
        status: "no_parser",
        transaction_id: null,
      });
      expect(r.requests).toHaveLength(0);
      expect(r.tx.description).toBe("CARD PURCHASE ORDER ABCD1234");
    });

    it("the owner's forward is matched and proposed, never auto-applied", async () => {
      const r = await pollShop(`Alice <${MAILBOX_LOGIN}>`, true);
      expect(r.receipt).toMatchObject({
        from_domain: "shop.example.com",
        forwarded_by: MAILBOX_LOGIN,
        status: "review",
        transaction_id: txId,
      });
      expect(r.requests).toEqual([
        { kind: "email_receipt", status: "proposed" },
      ]);
      expect(r.tx.description).toBe("CARD PURCHASE ORDER ABCD1234");
    });
  });
});
