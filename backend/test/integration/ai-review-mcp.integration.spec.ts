import { Global, Module } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { AiModule } from "@/ai/ai.module";
import { AiActionsService } from "@/ai/actions/ai-actions.service";
import { AiReviewModule } from "@/ai-review/ai-review.module";
import { AiReviewQueueModule } from "@/ai-review/ai-review-queue.module";
import { AiReviewWorkService } from "@/ai-review/ai-review-work.service";
import { AiReviewRequestsService } from "@/ai-review/ai-review-requests.service";
import { EVENT_BUS } from "@/common/events/event-bus.interface";
import { MemoryEventBus } from "@/common/events/memory-event-bus";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import { CreateTransactionRuleDto } from "@/transaction-rules/dto/create-transaction-rule.dto";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";
import { TransactionSplitService } from "@/transactions/transaction-split.service";
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

/**
 * What the app's `@Global()` `EventBusModule` supplies to the relay, without it:
 * the in-process bus, which is what a `single` deployment binds.
 */
@Global()
@Module({
  providers: [{ provide: EVENT_BUS, useClass: MemoryEventBus }, MemoryEventBus],
  exports: [EVENT_BUS],
})
class TestEventBusModule {}

/**
 * The AI review queue over MCP and the assistant, against a real PostgreSQL
 * enforcing RLS (task R2, design 6.5).
 *
 * What a mocked manager cannot show: a proposal writes nothing to the ledger;
 * a second agent cannot answer a request it did not claim; the approval that
 * commits the edit marks the request applied in the SAME transaction (a
 * failure after the mark rolls the mark back, a dismissed request refuses the
 * edit with nothing written); and one user's queue is invisible to another.
 */
describe("AI review requests over MCP (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let rules: TransactionRulesService;
  let work: AiReviewWorkService;
  let queue: AiReviewRequestsService;
  let actions: AiActionsService;

  let aliceId: string;
  let bobId: string;
  let accountId: string;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);
  const asBob = <T>(fn: () => Promise<T>) => withUserContext(bobId, fn);

  const AGENT_1 = "session-agent-1";
  const AGENT_2 = "session-agent-2";
  const lines = [
    { categoryName: "Books", amount: -30 },
    { categoryName: "Toys", amount: -20 },
  ];

  const reviewRule = (): CreateTransactionRuleDto =>
    ({
      name: "Allegro",
      triggers: ["create"],
      condition: { field: "payeeText", op: "contains", value: "allegro" },
      actions: [
        { type: "request_ai_review", instruction: "Split by the order items" },
      ],
    }) as CreateTransactionRuleDto;

  /** A rule-queued request on a new -50 purchase; returns both ids. */
  async function queued(): Promise<{ requestId: string; txId: string }> {
    const created = await asAlice(() =>
      transactions.create(aliceId, {
        accountId,
        transactionDate: "2026-03-10",
        amount: -50,
        currencyCode: "USD",
        payeeName: "ALLEGRO 123",
      } as never),
    );
    const [row] = await db.query(
      `SELECT id FROM ai_review_requests WHERE transaction_id = $1`,
      [created.id],
    );
    return { requestId: row.id, txId: created.id };
  }

  const requestRow = async (id: string) =>
    (
      await db.query(
        `SELECT status, claimed_by, proposal FROM ai_review_requests WHERE id = $1`,
        [id],
      )
    )[0];
  const splitCount = async (txId: string) =>
    Number(
      (
        await db.query(
          `SELECT COUNT(*)::int AS n FROM transaction_splits WHERE transaction_id = $1`,
          [txId],
        )
      )[0].n,
    );
  const txRow = async (txId: string) =>
    (
      await db.query(
        `SELECT amount, is_split, category_id FROM transactions WHERE id = $1`,
        [txId],
      )
    )[0];

  const confirmDto = (action: {
    actionId: string;
    signature: string;
    descriptor: unknown;
  }) => ({
    actionId: action.actionId,
    signature: action.signature,
    descriptor: action.descriptor as Record<string, unknown>,
  });

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "integration-test-secret";
    harness = await createEnforcedIntegrationModule([
      TransactionsModule,
      TransactionRulesModule,
      AiReviewModule,
      AiReviewQueueModule,
      AiModule,
      TestEventBusModule,
    ]);
    module = harness.module;
    db = harness.owner;
    transactions = module.get(TransactionsService);
    rules = module.get(TransactionRulesService);
    work = module.get(AiReviewWorkService);
    queue = module.get(AiReviewRequestsService);
    actions = module.get(AiActionsService);
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
      "ai_review_requests",
      "email_receipts",
      "email_receipt_mailboxes",
      "transaction_rule_applications",
      "transaction_rules",
      "action_history",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
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
    await createTestCategory(db, aliceId, { name: "Books" });
    await createTestCategory(db, aliceId, { name: "Toys" });
    await asAlice(() => rules.create(aliceId, reviewRule()));
  });

  it("enqueue via a rule -> claim -> submit (no ledger write) -> confirm: the transaction is split and the request applied", async () => {
    const { requestId, txId } = await queued();
    expect((await requestRow(requestId)).status).toBe("pending");

    // Claim: the request plus the transaction through the read path.
    const claim = await asAlice(() => work.claim(aliceId, AGENT_1));
    expect(claim.request).toMatchObject({
      id: requestId,
      status: "claimed",
      claimedByYou: true,
      instruction: "Split by the order items",
    });
    expect(claim.transaction).toEqual([
      expect.objectContaining({
        id: txId,
        amount: -50,
        accountName: "Checking",
      }),
    ]);

    // Submit: stored as a proposal, the ledger untouched.
    const before = await txRow(txId);
    const submitted = await asAlice(() =>
      work.submit(aliceId, AGENT_1, requestId, { splits: lines }),
    );
    expect(submitted.request.status).toBe("proposed");
    expect(submitted.action.descriptor).toMatchObject({
      type: "update_transaction",
      transactionId: txId,
      aiReviewRequestId: requestId,
    });
    const stored = await requestRow(requestId);
    expect(stored.status).toBe("proposed");
    expect(stored.proposal.action.actionId).toBe(submitted.action.actionId);
    expect(stored.proposal.input).toEqual({ splits: lines });
    expect(await txRow(txId)).toEqual(before);
    expect(await splitCount(txId)).toBe(0);

    // The inbox shows the proposal as a card rebuilt against the row as it is.
    const [item] = await asAlice(() => work.listInbox(aliceId));
    expect(item).toMatchObject({
      id: requestId,
      status: "proposed",
      ruleName: "Allegro",
      transaction: { id: txId, amount: -50, accountName: "Checking" },
    });
    expect("action" in item.proposal!).toBe(true);

    // Confirm through the existing path: the edit and `applied` together.
    const result = await asAlice(() =>
      actions.confirm(aliceId, confirmDto(submitted.action)),
    );
    expect(result).toEqual({ type: "update_transaction", id: txId });
    expect(await splitCount(txId)).toBe(2);
    expect(await txRow(txId)).toMatchObject({
      is_split: true,
      category_id: null,
    });
    expect(Number((await txRow(txId)).amount)).toBe(-50);
    expect((await requestRow(requestId)).status).toBe("applied");
    const [{ current_balance }] = await db.query(
      `SELECT current_balance FROM accounts WHERE id = $1`,
      [accountId],
    );
    expect(Number(current_balance)).toBe(950);
  });

  it("marks the request applied in the write's own transaction: a failure after the mark rolls it back", async () => {
    const { requestId, txId } = await queued();
    await asAlice(() => work.claim(aliceId, AGENT_1));
    const { action } = await asAlice(() =>
      work.submit(aliceId, AGENT_1, requestId, { splits: lines }),
    );

    // markApplied runs before the split rows are written, so a failure here
    // happens AFTER the request was marked inside the open transaction.
    jest
      .spyOn(module.get(TransactionSplitService), "createSplits")
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(
      asAlice(() => actions.confirm(aliceId, confirmDto(action))),
    ).rejects.toThrow("disk full");

    expect((await requestRow(requestId)).status).toBe("proposed");
    expect(await splitCount(txId)).toBe(0);
    expect((await txRow(txId)).is_split).toBe(false);

    // The claim on the descriptor was released, so the retry commits both.
    await asAlice(() => actions.confirm(aliceId, confirmDto(action)));
    expect((await requestRow(requestId)).status).toBe("applied");
    expect(await splitCount(txId)).toBe(2);
  });

  it("refuses the edit, writing nothing, when the request was dismissed after the card was built", async () => {
    const { requestId, txId } = await queued();
    await asAlice(() => work.claim(aliceId, AGENT_1));
    const { action } = await asAlice(() =>
      work.submit(aliceId, AGENT_1, requestId, { splits: lines }),
    );
    await asAlice(() => work.dismiss(aliceId, requestId));

    await expect(
      asAlice(() => actions.confirm(aliceId, confirmDto(action))),
    ).rejects.toMatchObject({ status: 409 });

    expect(await splitCount(txId)).toBe(0);
    expect((await txRow(txId)).is_split).toBe(false);
    expect((await requestRow(requestId)).status).toBe("rejected");
  });

  it("refuses category lines that do not add up, naming the difference, and stores nothing", async () => {
    const { requestId } = await queued();
    await asAlice(() => work.claim(aliceId, AGENT_1));

    await expect(
      asAlice(() =>
        work.submit(aliceId, AGENT_1, requestId, {
          splits: [
            { categoryName: "Books", amount: -30 },
            { categoryName: "Toys", amount: -17.5 },
          ],
        }),
      ),
    ).rejects.toThrow(/-2\.5 is not assigned/);

    const row = await requestRow(requestId);
    expect(row.status).toBe("claimed");
    expect(row.proposal).toBeNull();
  });

  it("does not let a second agent answer, release or close a request it did not claim", async () => {
    const { requestId, txId } = await queued();
    await asAlice(() => work.claim(aliceId, AGENT_1));

    await expect(
      asAlice(() =>
        work.submit(aliceId, AGENT_2, requestId, { splits: lines }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      asAlice(() => work.reject(aliceId, AGENT_2, requestId, "mine now", true)),
    ).rejects.toMatchObject({ status: 409 });
    // Nor the conditional UPDATEs themselves, when the read check is bypassed.
    expect(
      await asAlice(() =>
        queue.submitProposal(aliceId, requestId, AGENT_2, { x: 1 }),
      ),
    ).toBeNull();
    expect(
      await asAlice(() =>
        queue.release(aliceId, requestId, AGENT_2, { final: true, note: "x" }),
      ),
    ).toBeNull();
    // Agent 2 gets nothing from the queue while agent 1 holds the only request.
    expect(
      (await asAlice(() => work.claim(aliceId, AGENT_2))).request,
    ).toBeNull();

    const row = await requestRow(requestId);
    expect(row).toMatchObject({ status: "claimed", claimed_by: AGENT_1 });
    expect(row.proposal).toBeNull();
    expect(await splitCount(txId)).toBe(0);
  });

  it("returns a released request to the queue for another agent, or closes one that cannot be done", async () => {
    const { requestId } = await queued();
    await asAlice(() => work.claim(aliceId, AGENT_1));

    const back = await asAlice(() =>
      work.reject(aliceId, AGENT_1, requestId, "no order id", false),
    );
    expect(back.status).toBe("pending");
    expect(await requestRow(requestId)).toMatchObject({
      status: "pending",
      claimed_by: null,
    });

    const second = await asAlice(() => work.claim(aliceId, AGENT_2));
    expect(second.request).toMatchObject({
      id: requestId,
      claimedByYou: true,
      agentNote: { reason: "no order id" },
    });

    const closed = await asAlice(() =>
      work.reject(aliceId, AGENT_2, requestId, "not an order", true),
    );
    expect(closed.status).toBe("rejected");
    expect(
      (await asAlice(() => work.claim(aliceId, AGENT_1))).request,
    ).toBeNull();
  });

  it("gives two concurrent claims two different requests", async () => {
    const first = await queued();
    const secondTx = await queued();
    const [a, b] = await asAlice(() =>
      Promise.all([work.claim(aliceId, AGENT_1), work.claim(aliceId, AGENT_2)]),
    );
    const ids = [a.request?.id, b.request?.id].filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect([first.requestId, secondTx.requestId]).toEqual(
      expect.arrayContaining(ids as string[]),
    );
  });

  describe("row-level security", () => {
    it("hides one user's queue from another on every operation", async () => {
      const { requestId, txId } = await queued();

      // Bob sees nothing and can claim nothing.
      expect(
        (await asBob(() => work.claim(bobId, AGENT_2))).request,
      ).toBeNull();
      expect(await asBob(() => work.list(bobId, AGENT_2))).toMatchObject({
        requests: [],
        totalCount: 0,
      });
      expect(await asBob(() => work.listInbox(bobId))).toEqual([]);
      expect(await asBob(() => queue.getForUser(bobId, requestId))).toBeNull();

      // Alice claims and proposes; Bob cannot answer, dismiss or apply it.
      await asAlice(() => work.claim(aliceId, AGENT_1));
      await expect(
        asBob(() => work.submit(bobId, AGENT_1, requestId, { splits: lines })),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        asBob(() => work.dismiss(bobId, requestId)),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        asBob(() =>
          withScopedDb(harness.app, (m) =>
            queue.markApplied(m, bobId, requestId, txId),
          ),
        ),
      ).rejects.toMatchObject({ status: 409 });

      expect(await requestRow(requestId)).toMatchObject({
        status: "claimed",
        claimed_by: AGENT_1,
      });
    });
  });
  describe("a request raised for an email receipt", () => {
    const seedEmail = async (
      userId: string,
      text = "Books 30.00\nToys 20.00",
    ) => {
      const [mailbox] = await db.query(
        `INSERT INTO email_receipt_mailboxes (user_id, host, username, password_enc)
         VALUES ($1, 'imap.example.com', 'r@example.com', 'ciphertext') RETURNING id`,
        [userId],
      );
      const [receipt] = await db.query(
        `INSERT INTO email_receipts
           (user_id, mailbox_id, uid_validity, uid, from_address, from_domain, subject, received_at, body_text)
         VALUES ($1, $2, 1, 1, 'orders@shop.example.com', 'shop.example.com', 'Order 123', '2026-03-10T08:00:00Z', $3)
         RETURNING id`,
        [userId, mailbox.id, text],
      );
      return receipt.id as string;
    };
    const plainTx = async () =>
      (
        await asAlice(() =>
          transactions.create(aliceId, {
            accountId,
            transactionDate: "2026-03-10",
            amount: -50,
            currencyCode: "USD",
            payeeName: "SHOP ORDER",
          } as never),
        )
      ).id;

    it("is claimed with its email, proposed through the same submit, and applied by the same confirm", async () => {
      const txId = await plainTx();
      const emailId = await seedEmail(aliceId);
      const created = await asAlice(() =>
        withScopedDb(harness.app, (m) =>
          queue.enqueuePendingForReceipt(m, aliceId, {
            transactionId: txId,
            emailReceiptId: emailId,
            instruction: "Enrich this purchase from its order email",
          }),
        ),
      );

      const claim = await asAlice(() => work.claim(aliceId, AGENT_1));

      expect(claim.request).toMatchObject({
        id: created!.id,
        kind: "email_receipt",
        emailReceiptId: emailId,
        ruleId: null,
      });
      expect(claim.emailReceipt).toEqual({
        fromAddress: "orders@shop.example.com",
        subject: "Order 123",
        receivedAt: "2026-03-10T08:00:00.000Z",
        text: "Books 30.00\nToys 20.00",
      });
      expect(claim.transaction?.[0]).toMatchObject({ id: txId, amount: -50 });

      const submitted = await asAlice(() =>
        work.submit(aliceId, AGENT_1, created!.id, { splits: lines }),
      );
      expect(submitted.request.status).toBe("proposed");
      const [item] = await asAlice(() => work.listInbox(aliceId));
      expect(item).toMatchObject({
        kind: "email_receipt",
        ruleName: null,
        emailReceipt: {
          id: emailId,
          fromAddress: "orders@shop.example.com",
          subject: "Order 123",
        },
      });

      await asAlice(() =>
        actions.confirm(aliceId, confirmDto(submitted.action)),
      );
      expect((await requestRow(created!.id)).status).toBe("applied");
      expect(await splitCount(txId)).toBe(2);
    });

    it("cuts the email text to 20000 characters in a claim", async () => {
      const txId = await plainTx();
      const emailId = await seedEmail(aliceId, "x".repeat(50_000));
      await asAlice(() =>
        withScopedDb(harness.app, (m) =>
          queue.enqueueClaimed(m, aliceId, {
            transactionId: txId,
            kind: "email_receipt",
            emailReceiptId: emailId,
            instruction: "Enrich",
            claimedBy: "email-receipts",
          }),
        ),
      );
      await db.query(
        `UPDATE ai_review_requests SET status = 'pending', claimed_by = NULL, claimed_at = NULL`,
      );

      const claim = await asAlice(() => work.claim(aliceId, AGENT_1));

      expect(claim.emailReceipt?.text).toHaveLength(20_000);
    });

    it("never hands a claim another user's email", async () => {
      const txId = await plainTx();
      const bobsEmail = await seedEmail(bobId);
      // A row pointing at another user's email cannot be written through the
      // owner's identity's policy, so it is planted as the owner connection.
      await db.query(
        `INSERT INTO ai_review_requests (user_id, transaction_id, kind, instruction, email_receipt_id)
         VALUES ($1, $2, 'email_receipt', 'Enrich', $3)`,
        [aliceId, txId, bobsEmail],
      );

      const claim = await asAlice(() => work.claim(aliceId, AGENT_1));

      expect(claim.request?.kind).toBe("email_receipt");
      expect(claim).not.toHaveProperty("emailReceipt");
      expect(JSON.stringify(claim)).not.toContain("orders@shop.example.com");
    });
  });
});
