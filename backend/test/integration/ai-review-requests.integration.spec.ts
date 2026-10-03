import { TestingModule } from "@nestjs/testing";
import { DataSource, EntityManager } from "typeorm";

import { AccountsService } from "@/accounts/accounts.service";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import { TransactionRulesApplierService } from "@/transaction-rules/transaction-rules-applier.service";
import { TransactionRulesRunService } from "@/transaction-rules/transaction-rules-run.service";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";
import { CreateTransactionRuleDto } from "@/transaction-rules/dto/create-transaction-rule.dto";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import { AiReviewModule } from "@/ai-review/ai-review.module";
import { AiReviewRequestsService } from "@/ai-review/ai-review-requests.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The AI review queue against a real PostgreSQL enforcing RLS (task R1, design
 * 6.5). What a mocked manager cannot show: the request shares the create's
 * transaction (a rollback drops it), the partial unique index dedupes a repeat
 * trigger, two concurrent claims never return one row, and one user's queue is
 * invisible to another.
 */
describe("AI review requests (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let rules: TransactionRulesService;
  let applier: TransactionRulesApplierService;
  let runService: TransactionRulesRunService;
  let queue: AiReviewRequestsService;
  let accounts: AccountsService;

  let aliceId: string;
  let bobId: string;
  let accountId: string;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);

  const reviewRule = (
    over: Partial<CreateTransactionRuleDto> = {},
  ): CreateTransactionRuleDto =>
    ({
      name: "Allegro",
      triggers: ["create", "import"],
      condition: { field: "payeeText", op: "contains", value: "allegro" },
      actions: [
        { type: "request_ai_review", instruction: "Split by the order items" },
      ],
      ...over,
    }) as CreateTransactionRuleDto;

  const dto = (over: Record<string, unknown> = {}) =>
    ({
      accountId,
      transactionDate: "2026-03-10",
      amount: -50,
      currencyCode: "USD",
      payeeName: "ALLEGRO 123",
      ...over,
    }) as never;

  const requests = async (): Promise<
    Array<{
      user_id: string;
      transaction_id: string;
      rule_id: string | null;
      status: string;
      instruction: string;
      kind: string;
    }>
  > =>
    db.query(
      `SELECT user_id, transaction_id, rule_id, status, instruction, kind
         FROM ai_review_requests ORDER BY created_at, id`,
    );

  /** Insert n pending requests for a user directly (the owner connection bypasses RLS). */
  async function seedPending(userId: string, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const [tx] = await db.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
         VALUES ($1, $2, '2026-03-10', -1, 'USD', 'UNRECONCILED') RETURNING id`,
        [userId, accountId],
      );
      const [row] = await db.query(
        `INSERT INTO ai_review_requests (user_id, transaction_id, instruction, created_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP + ($4 || ' seconds')::interval) RETURNING id`,
        [userId, tx.id, `look ${i}`, String(i)],
      );
      ids.push(row.id);
    }
    return ids;
  }

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([
      TransactionsModule,
      TransactionRulesModule,
      AiReviewModule,
    ]);
    module = harness.module;
    db = harness.owner;
    transactions = module.get(TransactionsService);
    rules = module.get(TransactionRulesService);
    applier = module.get(TransactionRulesApplierService);
    runService = module.get(TransactionRulesRunService);
    queue = module.get(AiReviewRequestsService);
    accounts = module.get(AccountsService, { strict: false });
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await harness.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "ai_review_requests",
      "email_receipts",
      "email_receipt_mailboxes",
      "transaction_rule_applications",
      "transaction_rules",
      "action_history",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
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
  });

  it("a request_ai_review rule queues one pending request in the create's transaction", async () => {
    const rule = await asAlice(() => rules.create(aliceId, reviewRule()));

    const created = await asAlice(() => transactions.create(aliceId, dto()));

    expect(await requests()).toEqual([
      {
        user_id: aliceId,
        transaction_id: created.id,
        rule_id: rule.id,
        status: "pending",
        instruction: "Split by the order items",
        kind: "transaction_review",
      },
    ]);
    // A review request is not a ledger change (INV-RULE-001).
    expect(Number(created.amount)).toBe(-50);
    const [{ current_balance }] = await db.query(
      `SELECT current_balance FROM accounts WHERE id = $1`,
      [accountId],
    );
    expect(Number(current_balance)).toBe(950);
  });

  it("does not queue for a row the rule does not match", async () => {
    await asAlice(() => rules.create(aliceId, reviewRule()));
    await asAlice(() =>
      transactions.create(aliceId, dto({ payeeName: "Somewhere else" })),
    );
    expect(await requests()).toEqual([]);
  });

  it("a second identical trigger on the same row does not duplicate the request", async () => {
    await asAlice(() => rules.create(aliceId, reviewRule()));
    const created = await asAlice(() => transactions.create(aliceId, dto()));
    expect(await requests()).toHaveLength(1);

    const again = await asAlice(() =>
      withScopedDb(harness.app, (m: EntityManager) =>
        applier.applyToNew(m, aliceId, [created.id], "import"),
      ),
    );

    expect(await requests()).toHaveLength(1);
    expect(again[0].effects.trace[0].applied).toEqual([
      { type: "request_ai_review", outcome: "already_queued" },
    ]);
  });

  it("a manual run queues on commit only, and a re-run does not duplicate", async () => {
    const rule = await asAlice(() =>
      rules.create(aliceId, reviewRule({ triggers: ["import"] })),
    );
    const [tx] = await db.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, payee_name, status)
       VALUES ($1, $2, '2026-03-11', -20, 'USD', 'ALLEGRO 9', 'UNRECONCILED') RETURNING id`,
      [aliceId, accountId],
    );
    const filters = { limit: 100 };

    const preview = await asAlice(() =>
      runService.previewRun(aliceId, rule.id, filters),
    );
    expect(preview.aiReviewRequests).toBe(1);
    expect(await requests()).toEqual([]);

    await asAlice(() =>
      runService.run(aliceId, rule.id, {
        ...filters,
        fingerprint: preview.fingerprint,
      }),
    );
    expect(await requests()).toHaveLength(1);
    expect((await requests())[0].transaction_id).toBe(tx.id);

    const second = await asAlice(() =>
      runService.previewRun(aliceId, rule.id, filters),
    );
    await asAlice(() =>
      runService.run(aliceId, rule.id, {
        ...filters,
        fingerprint: second.fingerprint,
      }),
    );
    expect(await requests()).toHaveLength(1);
  });

  it("queues a new request once the earlier one is closed", async () => {
    await asAlice(() => rules.create(aliceId, reviewRule()));
    const created = await asAlice(() => transactions.create(aliceId, dto()));
    await db.query(`UPDATE ai_review_requests SET status = 'rejected'`);

    await asAlice(() =>
      withScopedDb(harness.app, (m: EntityManager) =>
        applier.applyToNew(m, aliceId, [created.id], "import"),
      ),
    );

    expect((await requests()).map((r) => r.status)).toEqual([
      "rejected",
      "pending",
    ]);
  });

  it("a rollback of the create drops the request with the row", async () => {
    await asAlice(() => rules.create(aliceId, reviewRule()));
    jest
      .spyOn(accounts, "updateBalance")
      .mockRejectedValue(new Error("balance update failed"));

    await expect(
      asAlice(() => transactions.create(aliceId, dto())),
    ).rejects.toThrow("balance update failed");

    expect(await db.query(`SELECT 1 FROM transactions`)).toHaveLength(0);
    expect(await requests()).toEqual([]);
  });

  it("deleting the asking rule keeps the request, with no rule", async () => {
    const rule = await asAlice(() => rules.create(aliceId, reviewRule()));
    await asAlice(() => transactions.create(aliceId, dto()));

    await db.query(`DELETE FROM transaction_rules WHERE id = $1`, [rule.id]);

    const rows = await requests();
    expect(rows).toHaveLength(1);
    expect(rows[0].rule_id).toBeNull();
  });

  it("deleting the transaction deletes its request", async () => {
    await asAlice(() => rules.create(aliceId, reviewRule()));
    const created = await asAlice(() => transactions.create(aliceId, dto()));
    await db.query(`DELETE FROM transactions WHERE id = $1`, [created.id]);
    expect(await requests()).toEqual([]);
  });

  describe("claimNext", () => {
    it("claims the oldest pending request, once", async () => {
      const [first, second] = await seedPending(aliceId, 2);

      const claimed = await asAlice(() => queue.claimNext(aliceId, "agent-1"));
      expect(claimed).toMatchObject({
        id: first,
        status: "claimed",
        claimedBy: "agent-1",
      });
      expect(claimed?.claimedAt).toBeInstanceOf(Date);

      const next = await asAlice(() => queue.claimNext(aliceId, "agent-2"));
      expect(next?.id).toBe(second);
      expect(
        await asAlice(() => queue.claimNext(aliceId, "agent-3")),
      ).toBeNull();
    });

    it("does not claim an expired request", async () => {
      await seedPending(aliceId, 1);
      await db.query(
        `UPDATE ai_review_requests SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'`,
      );
      expect(
        await asAlice(() => queue.claimNext(aliceId, "agent-1")),
      ).toBeNull();
    });

    it("skips a row another open claim holds: two concurrent claims never return one row", async () => {
      const [only] = await seedPending(aliceId, 1);

      let releaseFirst!: () => void;
      const hold = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstHasClaimed!: () => void;
      const firstClaimed = new Promise<void>((resolve) => {
        firstHasClaimed = resolve;
      });

      // Transaction A claims and stays open, holding the row lock.
      const a = asAlice(() =>
        withScopedDb(harness.app, async () => {
          const claimed = await queue.claimNext(aliceId, "agent-a");
          firstHasClaimed();
          await hold;
          return claimed;
        }),
      );
      await firstClaimed;

      // Transaction B runs while A is uncommitted: it must not see the row.
      const b = await asAlice(() => queue.claimNext(aliceId, "agent-b"));
      expect(b).toBeNull();

      releaseFirst();
      expect((await a)?.id).toBe(only);
      const rows = await db.query(
        `SELECT claimed_by FROM ai_review_requests WHERE id = $1`,
        [only],
      );
      expect(rows[0].claimed_by).toBe("agent-a");
    });

    it("hands concurrent claimers distinct rows", async () => {
      const ids = await seedPending(aliceId, 3);

      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          asAlice(() => queue.claimNext(aliceId, `agent-${i}`)),
        ),
      );

      const claimedIds = results.flatMap((r) => (r ? [r.id] : []));
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
      expect(claimedIds.every((id) => ids.includes(id))).toBe(true);
      const rows = await db.query(
        `SELECT status, claimed_by FROM ai_review_requests WHERE status = 'claimed'`,
      );
      expect(rows).toHaveLength(claimedIds.length);
      expect(
        new Set(rows.map((r: { claimed_by: string }) => r.claimed_by)).size,
      ).toBe(rows.length);
    });
  });

  describe("listForUser and expireStale", () => {
    it("lists a user's requests oldest first, filtered by status", async () => {
      const [first, second] = await seedPending(aliceId, 2);
      await db.query(
        `UPDATE ai_review_requests SET status = 'applied' WHERE id = $1`,
        [first],
      );
      const all = await asAlice(() => queue.listForUser(aliceId));
      expect(all.map((r) => r.id)).toEqual([first, second]);
      const pending = await asAlice(() =>
        queue.listForUser(aliceId, { status: "pending" }),
      );
      expect(pending.map((r) => r.id)).toEqual([second]);
    });

    it("expireStale marks open requests past their life as expired and leaves the rest", async () => {
      const [old, fresh] = await seedPending(aliceId, 2);
      await db.query(
        `UPDATE ai_review_requests SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 day' WHERE id = $1`,
        [old],
      );
      expect(await asAlice(() => queue.expireStale())).toBe(1);
      const rows = await db.query(
        `SELECT id, status FROM ai_review_requests ORDER BY created_at`,
      );
      expect(rows).toEqual([
        { id: old, status: "expired" },
        { id: fresh, status: "pending" },
      ]);
    });
  });

  describe("row-level security", () => {
    it("another user cannot list, claim or expire a user's requests", async () => {
      await seedPending(aliceId, 2);

      const listed = await withUserContext(bobId, () =>
        queue.listForUser(aliceId),
      );
      expect(listed).toEqual([]);
      expect(
        await withUserContext(bobId, () => queue.claimNext(aliceId, "bob")),
      ).toBeNull();
      await db.query(
        `UPDATE ai_review_requests SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 day'`,
      );
      expect(await withUserContext(bobId, () => queue.expireStale())).toBe(0);
      expect((await requests()).map((r) => r.status)).toEqual([
        "pending",
        "pending",
      ]);
    });

    it("refuses to enqueue a row for another user (WITH CHECK)", async () => {
      const [tx] = await db.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
         VALUES ($1, $2, '2026-03-10', -1, 'USD', 'UNRECONCILED') RETURNING id`,
        [aliceId, accountId],
      );
      await expect(
        withUserContext(bobId, () =>
          withScopedDb(harness.app, (m: EntityManager) =>
            queue.enqueue(m, aliceId, [
              { transactionId: tx.id, ruleId: null, instruction: "sneaky" },
            ]),
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      expect(await requests()).toEqual([]);
    });

    it("each user's rules queue only their own requests", async () => {
      await createTestAccount(db, bobId, {
        name: "Bob's",
        currencyCode: "USD",
        openingBalance: 0,
        currentBalance: 0,
      });
      await asAlice(() => rules.create(aliceId, reviewRule()));
      await asAlice(() => transactions.create(aliceId, dto()));
      expect((await requests()).map((r) => r.user_id)).toEqual([aliceId]);
      expect(
        await withUserContext(bobId, () => queue.listForUser(bobId)),
      ).toEqual([]);
    });
  });
  describe("email_receipt requests", () => {
    let nextUid = 1000;
    async function seedReceipt(
      userId: string,
      uid = (nextUid += 1),
    ): Promise<string> {
      const existing = await db.query(
        `SELECT id FROM email_receipt_mailboxes WHERE user_id = $1`,
        [userId],
      );
      const mailboxId =
        existing[0]?.id ??
        (
          await db.query(
            `INSERT INTO email_receipt_mailboxes (user_id, host, username, password_enc)
             VALUES ($1, 'imap.example.com', 'receipts@example.com', 'ciphertext') RETURNING id`,
            [userId],
          )
        )[0].id;
      const [row] = await db.query(
        `INSERT INTO email_receipts
           (user_id, mailbox_id, uid_validity, uid, from_address, from_domain, subject, received_at, body_text)
         VALUES ($1, $2, 1, $3, 'orders@shop.example.com', 'shop.example.com', 'Order 1', '2026-03-10T08:00:00Z', 'Total 50')
         RETURNING id`,
        [userId, mailboxId, uid],
      );
      return row.id;
    }

    async function seedTransaction(userId = aliceId): Promise<string> {
      const [tx] = await db.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
         VALUES ($1, $2, '2026-03-10', -50, 'USD', 'UNRECONCILED') RETURNING id`,
        [userId, accountId],
      );
      return tx.id;
    }

    const enqueueClaimed = (
      userId: string,
      transactionId: string,
      emailReceiptId: string,
      claimedBy = "email-receipts",
    ) =>
      withUserContext(userId, () =>
        withScopedDb(harness.app, (m: EntityManager) =>
          queue.enqueueClaimed(m, userId, {
            transactionId,
            kind: "email_receipt",
            emailReceiptId,
            instruction: "Enrich this purchase from its order email",
            claimedBy,
          }),
        ),
      );

    const openCount = async (transactionId: string) =>
      Number(
        (
          await db.query(
            `SELECT COUNT(*)::int AS n FROM ai_review_requests
              WHERE transaction_id = $1 AND status IN ('pending', 'claimed', 'proposed')`,
            [transactionId],
          )
        )[0].n,
      );

    // The entity-built schema this suite runs on has no CHECK constraints (the
    // enumerated CHECKs are proven against the real schema.sql in
    // email-receipts-schema.integration.spec.ts); this only shows the kind is
    // written and read back.
    it("reads an email_receipt request back with its kind", async () => {
      const txId = await seedTransaction();
      await db.query(
        `INSERT INTO ai_review_requests (user_id, transaction_id, kind, instruction)
         VALUES ($1, $2, 'email_receipt', 'x')`,
        [aliceId, txId],
      );
      expect((await requests()).map((r) => r.kind)).toEqual(["email_receipt"]);
    });

    it("enqueueClaimed writes one request born claimed by its key, naming the email", async () => {
      const txId = await seedTransaction();
      const receiptId = await seedReceipt(aliceId);

      const created = await enqueueClaimed(aliceId, txId, receiptId);

      expect(created).toMatchObject({
        userId: aliceId,
        transactionId: txId,
        ruleId: null,
        kind: "email_receipt",
        status: "claimed",
        claimedBy: "email-receipts",
        emailReceiptId: receiptId,
      });
      expect(created?.claimedAt).toBeInstanceOf(Date);
      expect((await requests()).map((r) => r.kind)).toEqual(["email_receipt"]);
    });

    it("answers null, writing nothing, while an open request with no rule exists for the transaction", async () => {
      const txId = await seedTransaction();
      const first = await seedReceipt(aliceId, 1);
      const second = await seedReceipt(aliceId, 2);

      expect(await enqueueClaimed(aliceId, txId, first)).not.toBeNull();
      expect(await enqueueClaimed(aliceId, txId, second)).toBeNull();
      expect(await openCount(txId)).toBe(1);

      // A manual request (no rule) on the transaction conflicts the same way.
      const otherTx = await seedTransaction();
      await db.query(
        `INSERT INTO ai_review_requests (user_id, transaction_id, instruction) VALUES ($1, $2, 'manual')`,
        [aliceId, otherTx],
      );
      expect(await enqueueClaimed(aliceId, otherTx, first)).toBeNull();
      expect(await openCount(otherTx)).toBe(1);
    });

    it("queues again once the earlier request is closed or has expired, and for another transaction", async () => {
      const txId = await seedTransaction();
      const receiptId = await seedReceipt(aliceId);
      await enqueueClaimed(aliceId, txId, receiptId);

      await db.query(`UPDATE ai_review_requests SET status = 'rejected'`);
      expect(await enqueueClaimed(aliceId, txId, receiptId)).not.toBeNull();

      await db.query(
        `UPDATE ai_review_requests SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
          WHERE status = 'claimed'`,
      );
      expect(await enqueueClaimed(aliceId, txId, receiptId)).not.toBeNull();

      expect(
        await enqueueClaimed(aliceId, await seedTransaction(), receiptId),
      ).not.toBeNull();
    });

    it("is not blocked by a rule's request on the transaction, which is a different key", async () => {
      await asAlice(() => rules.create(aliceId, reviewRule()));
      const created = await asAlice(() => transactions.create(aliceId, dto()));
      const receiptId = await seedReceipt(aliceId);

      expect(
        await enqueueClaimed(aliceId, created.id, receiptId),
      ).not.toBeNull();
      expect(await openCount(created.id)).toBe(2);
    });

    it("two concurrent enqueues for one transaction queue exactly one request (the advisory lock, not the index)", async () => {
      const txId = await seedTransaction();
      const first = await seedReceipt(aliceId, 1);
      const second = await seedReceipt(aliceId, 2);

      const results = await Promise.all([
        enqueueClaimed(aliceId, txId, first, "email-receipts"),
        enqueueClaimed(aliceId, txId, second, "email-receipts-ai"),
      ]);

      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect(await openCount(txId)).toBe(1);
    });

    it("enqueuePendingForReceipt writes a pending, unclaimed request and shares the exclusion", async () => {
      const txId = await seedTransaction();
      const receiptId = await seedReceipt(aliceId);
      const enqueue = () =>
        asAlice(() =>
          withScopedDb(harness.app, (m: EntityManager) =>
            queue.enqueuePendingForReceipt(m, aliceId, {
              transactionId: txId,
              emailReceiptId: receiptId,
              instruction: "Ask the AI",
            }),
          ),
        );

      const created = await enqueue();

      expect(created).toMatchObject({
        status: "pending",
        claimedBy: null,
        claimedAt: null,
        kind: "email_receipt",
        emailReceiptId: receiptId,
      });
      expect(await enqueue()).toBeNull();
    });

    it("a rollback of the caller's transaction drops the request", async () => {
      const txId = await seedTransaction();
      const receiptId = await seedReceipt(aliceId);

      await expect(
        asAlice(() =>
          withScopedDb(harness.app, async (m: EntityManager) => {
            await queue.enqueueClaimed(m, aliceId, {
              transactionId: txId,
              kind: "email_receipt",
              emailReceiptId: receiptId,
              instruction: "x",
              claimedBy: "email-receipts",
            });
            throw new Error("later step failed");
          }),
        ),
      ).rejects.toThrow("later step failed");

      expect(await requests()).toEqual([]);
    });

    it("deleting the email keeps the request and clears its reference", async () => {
      const txId = await seedTransaction();
      const receiptId = await seedReceipt(aliceId);
      await enqueueClaimed(aliceId, txId, receiptId);

      await db.query(`DELETE FROM email_receipts WHERE id = $1`, [receiptId]);

      const [row] = await db.query(
        `SELECT email_receipt_id, status FROM ai_review_requests`,
      );
      expect(row).toEqual({ email_receipt_id: null, status: "claimed" });
    });

    it("refuses to enqueue for another user (WITH CHECK)", async () => {
      const txId = await seedTransaction();
      const receiptId = await seedReceipt(aliceId);

      await expect(
        withUserContext(bobId, () =>
          withScopedDb(harness.app, (m: EntityManager) =>
            queue.enqueueClaimed(m, aliceId, {
              transactionId: txId,
              kind: "email_receipt",
              emailReceiptId: receiptId,
              instruction: "sneaky",
              claimedBy: "email-receipts",
            }),
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      expect(await requests()).toEqual([]);
    });

    describe("claimById", () => {
      const pendingFor = async () => {
        const txId = await seedTransaction();
        const receiptId = await seedReceipt(aliceId);
        const created = await asAlice(() =>
          withScopedDb(harness.app, (m: EntityManager) =>
            queue.enqueuePendingForReceipt(m, aliceId, {
              transactionId: txId,
              emailReceiptId: receiptId,
              instruction: "Ask the AI",
            }),
          ),
        );
        return created!.id;
      };

      it("claims the named pending request for the caller, once", async () => {
        const other = (await seedPending(aliceId, 1))[0];
        const id = await pendingFor();

        const claimed = await asAlice(() =>
          queue.claimById(aliceId, id, "email-receipts-ai"),
        );

        expect(claimed).toMatchObject({
          id,
          status: "claimed",
          claimedBy: "email-receipts-ai",
        });
        expect(claimed?.claimedAt).toBeInstanceOf(Date);
        expect(
          await asAlice(() => queue.claimById(aliceId, id, "someone-else")),
        ).toBeNull();
        // It took the named one and not the oldest.
        const [untouched] = await db.query(
          `SELECT status FROM ai_review_requests WHERE id = $1`,
          [other],
        );
        expect(untouched.status).toBe("pending");
      });

      it("two concurrent claims of one request: exactly one wins", async () => {
        const id = await pendingFor();

        const results = await Promise.all([
          asAlice(() => queue.claimById(aliceId, id, "agent-a")),
          asAlice(() => queue.claimById(aliceId, id, "agent-b")),
        ]);

        expect(results.filter((r) => r !== null)).toHaveLength(1);
        const [row] = await db.query(
          `SELECT claimed_by FROM ai_review_requests WHERE id = $1`,
          [id],
        );
        expect(row.claimed_by).toBe(results.find((r) => r)?.claimedBy);
      });

      it("does not claim an expired, a non-pending or another user's request", async () => {
        const expired = await pendingFor();
        await db.query(
          `UPDATE ai_review_requests SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE id = $1`,
          [expired],
        );
        expect(
          await asAlice(() => queue.claimById(aliceId, expired, "k")),
        ).toBeNull();

        const proposed = await pendingFor();
        await db.query(
          `UPDATE ai_review_requests SET status = 'proposed' WHERE id = $1`,
          [proposed],
        );
        expect(
          await asAlice(() => queue.claimById(aliceId, proposed, "k")),
        ).toBeNull();

        const mine = await pendingFor();
        expect(
          await withUserContext(bobId, () =>
            queue.claimById(aliceId, mine, "bob"),
          ),
        ).toBeNull();
        expect(
          await withUserContext(bobId, () =>
            queue.claimById(bobId, mine, "bob"),
          ),
        ).toBeNull();
        const [row] = await db.query(
          `SELECT status FROM ai_review_requests WHERE id = $1`,
          [mine],
        );
        expect(row.status).toBe("pending");
      });
    });
  });
});
