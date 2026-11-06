import { NotFoundException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import { Tag } from "@/tags/entities/tag.entity";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";
import { TransactionRulesRunService } from "@/transaction-rules/transaction-rules-run.service";
import { CreateTransactionRuleDto } from "@/transaction-rules/dto/create-transaction-rule.dto";
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

/**
 * Run a rule on existing transactions against a real PostgreSQL enforcing RLS
 * (design 3.6, invariants I3 and I6, task B8): the preview names what the
 * commit writes, a stale fingerprint refuses with nothing written, one undo
 * restores category, payee and tags of every changed row, a reconciled row is
 * left alone under the strict lock, and another user's rule is a 404.
 */
describe("Transaction rules manual run (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let rules: TransactionRulesService;
  let run: TransactionRulesRunService;
  let history: ActionHistoryService;

  let aliceId: string;
  let bobId: string;
  let checkingId: string;
  let savingsId: string;
  let bobAccountId: string;
  let groceriesId: string;
  let otherCategoryId: string;
  let foodTagId: string;
  let oldTagId: string;
  let shopPayeeId: string;
  let oldPayeeId: string;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);
  const asBob = <T>(fn: () => Promise<T>) => withUserContext(bobId, fn);

  const groceryRule = (over: Partial<CreateTransactionRuleDto> = {}) =>
    ({
      name: "Biedronka",
      triggers: ["create"],
      condition: { field: "payeeText", op: "contains", value: "biedronka" },
      actions: [
        { type: "set_category", categoryId: groceriesId },
        { type: "add_tags", tagIds: [foodTagId] },
      ],
      ...over,
    }) as CreateTransactionRuleDto;

  const create = (over: Record<string, unknown>) =>
    asAlice(() =>
      transactions.create(aliceId, {
        accountId: checkingId,
        transactionDate: "2026-03-10",
        amount: -50,
        currencyCode: "USD",
        payeeName: "BIEDRONKA 1",
        ...over,
      } as never),
    );

  const count = async (table: string): Promise<number> =>
    Number((await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n);
  // The setup's own creates leave undo entries; a run leaves one of its own kind.
  const runEntries = async (): Promise<number> =>
    Number(
      (
        await db.query(
          `SELECT COUNT(*)::int AS n FROM action_history WHERE entity_type = 'transaction_rule_run'`,
        )
      )[0].n,
    );
  const tagsOf = async (transactionId: string): Promise<string[]> =>
    (
      await db.query(
        `SELECT tag_id FROM transaction_tags WHERE transaction_id = $1 ORDER BY tag_id`,
        [transactionId],
      )
    ).map((r: { tag_id: string }) => r.tag_id);
  const rowOf = async (id: string) =>
    (
      await db.query(
        `SELECT category_id, payee_id, payee_name, status FROM transactions WHERE id = $1`,
        [id],
      )
    )[0];

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([
      TransactionsModule,
      TransactionRulesModule,
    ]);
    module = harness.module;
    db = harness.owner;
    transactions = module.get(TransactionsService);
    rules = module.get(TransactionRulesService);
    run = module.get(TransactionRulesRunService);
    history = module.get(ActionHistoryService, { strict: false });
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await harness.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "transaction_rule_applications",
      "transaction_rules",
      "transaction_tags",
      "tags",
      "action_history",
      "account_delegate_grants",
      "account_delegates",
      "user_preferences",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    bobId = (await createTestUserDirect(db, { firstName: "Bob" })).id;
    const account = (userId: string, name: string) =>
      createTestAccount(db, userId, {
        name,
        currencyCode: "USD",
        openingBalance: 1000,
        currentBalance: 1000,
      }).then((a) => a.id);
    checkingId = await account(aliceId, "Checking");
    savingsId = await account(aliceId, "Savings");
    bobAccountId = await account(bobId, "Bob Chequing");
    groceriesId = (await createTestCategory(db, aliceId, { name: "Groceries" }))
      .id;
    otherCategoryId = (await createTestCategory(db, aliceId, { name: "Other" }))
      .id;
    const tag = (name: string) =>
      db
        .getRepository(Tag)
        .save({ userId: aliceId, name })
        .then((t) => t.id);
    foodTagId = await tag("food");
    oldTagId = await tag("old");
    shopPayeeId = (await createTestPayee(db, aliceId, { name: "Biedronka" }))
      .id;
    oldPayeeId = (await createTestPayee(db, aliceId, { name: "Old payee" })).id;
  });

  it("the preview names exactly what the commit writes, and the trace says manual", async () => {
    const t1 = await create({ payeeName: "BIEDRONKA 1" });
    const t2 = await create({
      payeeName: "BIEDRONKA 2",
      transactionDate: "2026-03-11",
      categoryId: otherCategoryId,
    });
    const t3 = await create({ payeeName: "LIDL" });
    const rule = await asAlice(() => rules.create(aliceId, groceryRule()));

    const preview = await asAlice(() => run.previewRun(aliceId, rule.id, {}));

    // t1 fills the category and gets the tag; t2 keeps its category (onlyIfEmpty)
    // and only gets the tag; t3 does not match.
    expect(preview.scanned).toBe(3);
    expect(preview.truncated).toBe(false);
    expect(preview.matched.map((r) => r.transactionId).sort()).toEqual(
      [t1.id, t2.id].sort(),
    );
    const planned1 = preview.matched.find((r) => r.transactionId === t1.id);
    expect(planned1?.changes).toEqual({
      categoryId: { before: null, after: groceriesId },
      tagIds: { before: [], after: [foodTagId] },
    });
    expect(planned1).toEqual(
      expect.objectContaining({
        date: "2026-03-10",
        payeeName: "BIEDRONKA 1",
        amount: -50,
        currencyCode: "USD",
      }),
    );
    expect(
      preview.matched.find((r) => r.transactionId === t2.id)?.changes,
    ).toEqual({ tagIds: { before: [], after: [foodTagId] } });
    expect(preview.labels.categories[groceriesId]).toBe("Groceries");
    // A preview writes nothing.
    expect(await count("transaction_rule_applications")).toBe(0);
    expect(await count("transaction_tags")).toBe(0);
    expect(await runEntries()).toBe(0);

    const result = await asAlice(() =>
      run.run(aliceId, rule.id, { fingerprint: preview.fingerprint }),
    );

    expect(result.changed).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(result.historyId).toEqual(expect.any(String));
    expect((await rowOf(t1.id)).category_id).toBe(groceriesId);
    expect((await rowOf(t2.id)).category_id).toBe(otherCategoryId);
    expect(await tagsOf(t1.id)).toEqual([foodTagId]);
    expect(await tagsOf(t2.id)).toEqual([foodTagId]);
    expect(await tagsOf(t3.id)).toEqual([]);
    expect((await rowOf(t3.id)).category_id).toBeNull();

    // The trace equals the preview, row by row, with source "manual".
    const trace = await db.query(
      `SELECT transaction_id, source, changes FROM transaction_rule_applications`,
    );
    expect(trace).toHaveLength(2);
    for (const row of trace) {
      expect(row.source).toBe("manual");
      expect(row.changes).toEqual(
        preview.matched.find((r) => r.transactionId === row.transaction_id)
          ?.changes,
      );
    }
    // One history entry for the whole run.
    expect(await runEntries()).toBe(1);

    // Nothing left to do: a second preview plans no change.
    const again = await asAlice(() => run.previewRun(aliceId, rule.id, {}));
    expect(again.matched).toEqual([]);
  });

  it("a stale fingerprint refuses with 409 PREVIEW_CHANGED and writes nothing", async () => {
    const t1 = await create({});
    await create({ payeeName: "BIEDRONKA 2" });
    const rule = await asAlice(() => rules.create(aliceId, groceryRule()));
    const preview = await asAlice(() => run.previewRun(aliceId, rule.id, {}));

    // The world moves between the preview and the commit.
    await db.query(`UPDATE transactions SET category_id = $1 WHERE id = $2`, [
      otherCategoryId,
      t1.id,
    ]);

    await expect(
      asAlice(() =>
        run.run(aliceId, rule.id, { fingerprint: preview.fingerprint }),
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ errorCode: "PREVIEW_CHANGED" }),
    });
    expect(await count("transaction_rule_applications")).toBe(0);
    expect(await count("transaction_tags")).toBe(0);
    expect(await runEntries()).toBe(0);
    expect((await rowOf(t1.id)).category_id).toBe(otherCategoryId);

    // A rule edit changes the fingerprint too (its revision is part of it).
    const fresh = await asAlice(() => run.previewRun(aliceId, rule.id, {}));
    await asAlice(() =>
      rules.update(aliceId, rule.id, {
        revision: rule.revision,
        stopProcessing: true,
      }),
    );
    await expect(
      asAlice(() =>
        run.run(aliceId, rule.id, { fingerprint: fresh.fingerprint }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("transaction_rule_applications")).toBe(0);
  });

  it("undo restores category, payee, payee name and tags of every changed row; redo replays them", async () => {
    const t1 = await create({ payeeName: "BIEDRONKA 1" });
    const t2 = await create({
      payeeName: "BIEDRONKA 2",
      payeeId: oldPayeeId,
      categoryId: otherCategoryId,
      tagIds: [oldTagId],
    });
    const rule = await asAlice(() =>
      rules.create(
        aliceId,
        groceryRule({
          actions: [
            {
              type: "set_category",
              categoryId: groceriesId,
              onlyIfEmpty: false,
            },
            { type: "set_payee", payeeId: shopPayeeId, onlyIfEmpty: false },
            { type: "add_tags", tagIds: [foodTagId] },
            { type: "remove_tags", tagIds: [oldTagId] },
          ],
        } as never),
      ),
    );
    const before1 = await rowOf(t1.id);
    const before2 = await rowOf(t2.id);
    const preview = await asAlice(() => run.previewRun(aliceId, rule.id, {}));
    await asAlice(() =>
      run.run(aliceId, rule.id, { fingerprint: preview.fingerprint }),
    );

    expect(await rowOf(t2.id)).toEqual(
      expect.objectContaining({
        category_id: groceriesId,
        payee_id: shopPayeeId,
        payee_name: "Biedronka",
      }),
    );
    expect(await tagsOf(t2.id)).toEqual([foodTagId]);

    const undone = await asAlice(() => history.undo(aliceId));
    expect(undone.description).toContain("Undone");
    expect(await rowOf(t1.id)).toEqual(before1);
    expect(await rowOf(t2.id)).toEqual(before2);
    expect(await tagsOf(t1.id)).toEqual([]);
    expect(await tagsOf(t2.id)).toEqual([oldTagId]);

    await asAlice(() => history.redo(aliceId));
    expect((await rowOf(t1.id)).category_id).toBe(groceriesId);
    expect((await rowOf(t2.id)).payee_name).toBe("Biedronka");
    expect(await tagsOf(t2.id)).toEqual([foodTagId]);
  });

  it("skips a reconciled row under the strict lock and reports it; with the lock off it runs", async () => {
    const plain = await create({ payeeName: "BIEDRONKA 1" });
    const reconciled = await create({
      payeeName: "BIEDRONKA 2",
      transactionDate: "2026-03-09",
    });
    await db.query(
      `UPDATE transactions SET status = 'RECONCILED' WHERE id = $1`,
      [reconciled.id],
    );
    await db.query(
      `INSERT INTO user_preferences (user_id, lock_reconciled_transactions) VALUES ($1, true)`,
      [aliceId],
    );
    const rule = await asAlice(() => rules.create(aliceId, groceryRule()));

    const preview = await asAlice(() => run.previewRun(aliceId, rule.id, {}));
    expect(preview.matched.map((r) => r.transactionId)).toEqual([plain.id]);
    expect(preview.skipped).toEqual([
      { transactionId: reconciled.id, reason: "reconciled_locked" },
    ]);

    const result = await asAlice(() =>
      run.run(aliceId, rule.id, { fingerprint: preview.fingerprint }),
    );
    expect(result.changed).toBe(1);
    expect(result.skipped).toEqual(preview.skipped);
    expect(await tagsOf(reconciled.id)).toEqual([]);
    expect((await rowOf(reconciled.id)).category_id).toBeNull();
    expect(await tagsOf(plain.id)).toEqual([foodTagId]);

    // Turning the lock off changes the plan, so the old fingerprint no longer fits.
    await db.query(
      `UPDATE user_preferences SET lock_reconciled_transactions = false WHERE user_id = $1`,
      [aliceId],
    );
    await expect(
      asAlice(() =>
        run.run(aliceId, rule.id, { fingerprint: preview.fingerprint }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const open = await asAlice(() => run.previewRun(aliceId, rule.id, {}));
    expect(open.matched.map((r) => r.transactionId)).toEqual([reconciled.id]);
  });

  it("evaluates a same-owner transfer once and writes both legs, however the filter reaches it", async () => {
    const result = await asAlice(() =>
      transactions.createTransfer(aliceId, {
        fromAccountId: checkingId,
        toAccountId: savingsId,
        transactionDate: "2026-03-10",
        amount: 100,
        fromCurrencyCode: "USD",
      } as never),
    );
    const rule = await asAlice(() =>
      rules.create(
        aliceId,
        groceryRule({
          condition: { field: "type", op: "eq", value: "TRANSFER" },
          actions: [
            { type: "add_tags", tagIds: [foodTagId] },
            { type: "set_category", categoryId: groceriesId },
          ],
        } as never),
      ),
    );

    // Filtering on the destination account reaches only the incoming leg.
    const preview = await asAlice(() =>
      run.previewRun(aliceId, rule.id, { accountIds: [savingsId] }),
    );
    expect(preview.scanned).toBe(1);
    expect(preview.matched).toHaveLength(1);
    expect(preview.matched[0].transactionId).toBe(result.fromTransaction.id);
    expect(preview.skipped).toEqual([
      {
        transactionId: result.fromTransaction.id,
        reason: "transfer_leg_category",
      },
    ]);

    const done = await asAlice(() =>
      run.run(aliceId, rule.id, {
        accountIds: [savingsId],
        fingerprint: preview.fingerprint,
      }),
    );
    expect(done.changed).toBe(2);
    expect(await tagsOf(result.fromTransaction.id)).toEqual([foodTagId]);
    expect(await tagsOf(result.toTransaction.id)).toEqual([foodTagId]);
    expect((await rowOf(result.fromTransaction.id)).category_id).toBeNull();
    expect(await count("transaction_rule_applications")).toBe(2);
    // No balance moved.
    const balances = await db.query(
      `SELECT id, current_balance FROM accounts WHERE user_id = $1`,
      [aliceId],
    );
    expect(
      balances.find((b: { id: string }) => b.id === checkingId).current_balance,
    ).toBe("900.00000000");
  });

  it("a cross-owner transfer is evaluated on the caller's own leg only", async () => {
    const [{ id: delegationId }] = await db.query(
      `INSERT INTO account_delegates (owner_user_id, delegate_user_id, status)
       VALUES ($1, $2, 'active') RETURNING id`,
      [aliceId, bobId],
    );
    await db.query(
      `INSERT INTO account_delegate_grants
         (delegation_id, account_id, can_read, can_create, can_edit, can_delete)
       VALUES ($1, $2, true, true, false, false)`,
      [delegationId, checkingId],
    );
    const result = await asBob(() =>
      transactions.createTransfer(
        bobId,
        {
          fromAccountId: bobAccountId,
          toAccountId: checkingId,
          transactionDate: "2026-03-10",
          amount: 100,
          fromCurrencyCode: "USD",
        } as never,
        { effectiveUserId: bobId, realUserId: bobId },
      ),
    );
    const rule = await asAlice(() =>
      rules.create(
        aliceId,
        groceryRule({
          condition: { field: "type", op: "eq", value: "TRANSFER" },
          actions: [{ type: "add_tags", tagIds: [foodTagId] }],
        } as never),
      ),
    );

    const preview = await asAlice(() => run.previewRun(aliceId, rule.id, {}));
    expect(preview.matched.map((r) => r.transactionId)).toEqual([
      result.toTransaction.id,
    ]);
    await asAlice(() =>
      run.run(aliceId, rule.id, { fingerprint: preview.fingerprint }),
    );
    expect(await tagsOf(result.toTransaction.id)).toEqual([foodTagId]);
    expect(await tagsOf(result.fromTransaction.id)).toEqual([]);
  });

  it("the draft preview tests an unsaved rule, validates like a create and writes nothing", async () => {
    const t1 = await create({});
    await create({ payeeName: "LIDL" });

    const draft = await asAlice(() =>
      run.previewDraft(aliceId, {
        condition: groceryRule().condition,
        actions: groceryRule().actions,
        filters: { limit: 10 },
      }),
    );
    expect(draft.matched.map((r) => r.transactionId)).toEqual([t1.id]);
    expect(draft.scanned).toBe(2);

    await expect(
      asAlice(() =>
        run.previewDraft(aliceId, {
          condition: groceryRule().condition,
          actions: [
            {
              type: "set_category",
              categoryId: "f0000000-0000-4000-8000-00000000000f",
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(await count("transaction_rules")).toBe(0);
    expect(await count("transaction_rule_applications")).toBe(0);
    expect(await count("transaction_tags")).toBe(0);
    expect(await runEntries()).toBe(0);
  });

  it("bounds the scan: newest first, at most limit rows, truncated says so", async () => {
    const older = await create({ transactionDate: "2026-01-05" });
    const newer = await create({ transactionDate: "2026-03-05" });
    const rule = await asAlice(() => rules.create(aliceId, groceryRule()));

    const one = await asAlice(() =>
      run.previewRun(aliceId, rule.id, { limit: 1 }),
    );
    expect(one.scanned).toBe(1);
    expect(one.truncated).toBe(true);
    expect(one.matched.map((r) => r.transactionId)).toEqual([newer.id]);

    const ranged = await asAlice(() =>
      run.previewRun(aliceId, rule.id, {
        startDate: "2026-01-01",
        endDate: "2026-02-01",
      }),
    );
    expect(ranged.matched.map((r) => r.transactionId)).toEqual([older.id]);
    expect(ranged.truncated).toBe(false);
  });

  it("another user's rule is a 404 on every route, and their rules never see this user's rows", async () => {
    const t1 = await create({});
    const rule = await asAlice(() => rules.create(aliceId, groceryRule()));
    const preview = await asAlice(() => run.previewRun(aliceId, rule.id, {}));

    await expect(
      asBob(() => run.previewRun(bobId, rule.id, {})),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      asBob(() =>
        run.run(bobId, rule.id, { fingerprint: preview.fingerprint }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      asBob(() => run.applications(bobId, rule.id)),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await tagsOf(t1.id)).toEqual([]);
  });

  it("lists the latest applications of a rule with the row's date, payee and amount", async () => {
    const t1 = await create({ payeeName: "BIEDRONKA 1" });
    const rule = await asAlice(() => rules.create(aliceId, groceryRule()));
    const preview = await asAlice(() => run.previewRun(aliceId, rule.id, {}));
    await asAlice(() =>
      run.run(aliceId, rule.id, { fingerprint: preview.fingerprint }),
    );

    const applications = await asAlice(() =>
      run.applications(aliceId, rule.id, 5),
    );
    expect(applications).toHaveLength(1);
    expect(applications[0]).toEqual(
      expect.objectContaining({
        transactionId: t1.id,
        date: "2026-03-10",
        payeeName: "BIEDRONKA 1",
        amount: -50,
        source: "manual",
      }),
    );
    expect(applications[0].changes).toEqual({
      categoryId: { before: null, after: groceriesId },
      tagIds: { before: [], after: [foodTagId] },
    });
  });
});
