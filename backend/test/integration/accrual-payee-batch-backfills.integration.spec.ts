import { withScopedDb } from "@/common/db/scoped-db";
import { lockPayeeCategoryBatch } from "@/payees/payee-category-batch";
import { randomUUID } from "node:crypto";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionStatus } from "@/transactions/entities/transaction.entity";
import { PayeesService } from "@/payees/payees.service";
import {
  PayeeAutoMergeService,
  type ApplyAutoMergeGroup,
} from "@/payees/payee-auto-merge.service";
import { AccrualsService } from "@/accruals/accruals.service";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";
import {
  createEnforcedIntegrationModule,
  createTestUserDirect,
  cleanTables,
  type EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

describe("suggestion batch and automatic merge accrual backfills", () => {
  jest.setTimeout(180000);
  let h: EnforcedIntegrationHarness,
    transactions: TransactionsService,
    payees: PayeesService,
    auto: PayeeAutoMergeService,
    accruals: AccrualsService;
  let user: string, account: string, expense: string, income: string;
  const as = <T>(fn: () => Promise<T>) => withUserContext(user, fn);
  const payee = (name: string) => as(() => payees.create(user, { name }));
  async function source(
    payeeId: string,
    categoryId: string | null = null,
    split = false,
  ) {
    const tx = await as(() =>
      transactions.create(user, {
        accountId: account,
        currencyCode: "USD",
        transactionDate: "2026-06-15",
        amount: -1200.0001,
        payeeId,
        ...(split
          ? {
              splits: [
                { amount: -600, categoryId: expense },
                { amount: -600.0001, categoryId: expense },
              ],
            }
          : categoryId
            ? { categoryId }
            : {}),
      }),
    );
    await settlePendingHistoryWrites();
    return tx;
  }
  async function accrue(id: string, splitId?: string) {
    const input = {
      sourceTransactionId: id,
      sourceSplitId: splitId,
      preset: "NTM" as const,
      family: "expense" as const,
    };
    const p = await as(() => accruals.preview(user, input));
    await as(() =>
      accruals.save(user, {
        ...input,
        fingerprint: p.fingerprint,
        expectedScheduleId: p.expectedScheduleId,
        expectedRevision: p.expectedRevision,
      }),
    );
  }
  const state = async (id: string) =>
    (
      await h.owner.query(
        `SELECT s.id,s.revision,s.family,s.source_fingerprint AS fingerprint,
   (SELECT jsonb_agg(jsonb_build_array(a.recognition_date,a.amount::text) ORDER BY a.period_index)
    FROM accrual_allocations a WHERE a.schedule_id=s.id) AS allocations
   FROM accrual_schedules s WHERE s.source_transaction_id=$1 ORDER BY s.id`,
        [id],
      )
    )[0];
  const bank = async () =>
    (
      await h.owner.query(
        "SELECT current_balance::text AS amount FROM accounts WHERE id=$1",
        [account],
      )
    )[0].amount;
  const category = async (id: string) =>
    (
      await h.owner.query("SELECT category_id FROM transactions WHERE id=$1", [
        id,
      ])
    )[0].category_id;
  const snapshot = () =>
    h.owner.query(
      "SELECT id,name,default_category_id FROM payees WHERE user_id=$1 ORDER BY id",
      [user],
    );
  const assignments = (...ids: string[]) =>
    ids.map((payeeId) => ({
      payeeId,
      categoryId: income,
      backfillTransactions: true,
    }));
  const suggestionPreview = (rows: ReturnType<typeof assignments>) =>
    as(() => payees.previewCategorySuggestionsImpact(user, rows));
  const suggestions = (rows: ReturnType<typeof assignments>, token?: string) =>
    as(() => payees.applyCategorySuggestions(user, rows, token));
  const group = (
    canonical: string,
    ...sources: string[]
  ): ApplyAutoMergeGroup => ({
    canonicalPayeeId: canonical,
    sourcePayeeIds: sources,
    defaultCategoryId: income,
    backfillTransactions: true,
    canonicalName: "Merged office",
    alias: "*merged office*",
  });
  const mergePreview = (g: ApplyAutoMergeGroup) =>
    as(() => auto.previewCategoryImpact(user, g));
  const merge = (g: ApplyAutoMergeGroup) =>
    as(() => auto.applyAutoMerge(user, [g]));
  beforeAll(async () => {
    h = await createEnforcedIntegrationModule([TransactionsModule]);
    transactions = h.module.get(TransactionsService);
    payees = h.module.get(PayeesService);
    auto = h.module.get(PayeeAutoMergeService);
    accruals = new AccrualsService(h.app);
  });
  afterAll(async () => {
    await settlePendingHistoryWrites();
    if (h) await h.close();
  });
  beforeEach(async () => {
    await settlePendingHistoryWrites();
    await cleanTables(h.owner, [
      "transactions",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await h.owner.query(
      "INSERT INTO currencies(code,name,symbol,decimal_places) VALUES('USD','US Dollar','$',2) ON CONFLICT DO NOTHING",
    );
    user = (await createTestUserDirect(h.owner)).id;
    account = (
      await createTestAccount(h.owner, user, {
        name: "Both backfills",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    expense = randomUUID();
    income = randomUUID();
    await h.owner.query(
      "INSERT INTO categories(id,user_id,name,is_income) VALUES($1,$3,'Expense',false),($2,$3,'Income',true)",
      [expense, income, user],
    );
  });
  it("previews the entire suggestion batch and atomically applies only uncategorized ordinary sources", async () => {
    const first = await payee("First"),
      second = await payee("Second");
    const a = await source(first.id),
      b = await source(second.id),
      cash = await source(second.id),
      existing = await source(first.id, expense),
      split = await source(first.id, expense, true);
    await accrue(a.id);
    await accrue(b.id);
    await accrue(existing.id);
    const line = (
      await h.owner.query(
        "SELECT id FROM transaction_splits WHERE transaction_id=$1 ORDER BY id",
        [split.id],
      )
    )[0].id;
    await accrue(split.id, line);
    const before = [
      await state(a.id),
      await state(b.id),
      await state(existing.id),
      await state(split.id),
    ];
    const rows = assignments(first.id, second.id),
      p = await suggestionPreview(rows),
      balance = await bank(),
      original = await snapshot();
    expect(p.transactionIds.sort()).toEqual([a.id, b.id, cash.id].sort());
    expect(p.impacts).toHaveLength(2);
    await expect(suggestions(rows)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(original);
    expect(await suggestions(rows, p.fingerprint!)).toEqual({
      updated: 2,
      transactionsBackfilled: 3,
    });
    for (const [index, tx] of [a, b].entries()) {
      const after = await state(tx.id);
      expect(after).toMatchObject({
        id: before[index].id,
        revision: before[index].revision + 1,
        family: "income",
        allocations: before[index].allocations,
      });
    }
    expect(await state(existing.id)).toEqual(before[2]);
    expect(await state(split.id)).toEqual(before[3]);
    expect(await category(cash.id)).toBe(income);
    expect(await bank()).toBe(balance);
  });
  it("rejects altered assignments and drift in a cash-only member of an accrued suggestion batch", async () => {
    const first = await payee("First"),
      second = await payee("Second");
    const a = await source(first.id),
      cash = await source(second.id);
    await accrue(a.id);
    const rows = assignments(first.id, second.id),
      p = await suggestionPreview(rows),
      original = await snapshot();
    await expect(
      suggestions(
        [{ ...rows[0], backfillTransactions: false }, rows[1]],
        p.fingerprint!,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await h.owner.query(
      "UPDATE transactions SET description='changed cash' WHERE id=$1",
      [cash.id],
    );
    await expect(suggestions(rows, p.fingerprint!)).rejects.toMatchObject({
      status: 409,
    });
    expect(await snapshot()).toEqual(original);
    expect(await category(a.id)).toBeNull();
  });
  it("rolls back all suggestion defaults and source changes when a later schedule refresh fails", async () => {
    const first = await payee("First"),
      second = await payee("Second");
    const a = await source(first.id),
      b = await source(second.id);
    await accrue(a.id);
    await accrue(b.id);
    const rows = assignments(first.id, second.id),
      p = await suggestionPreview(rows);
    const original = await snapshot(),
      before = [await state(a.id), await state(b.id)],
      balance = await bank();
    await h.owner
      .query(`CREATE FUNCTION reject_both_backfill_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF NEW.family='income' THEN RAISE EXCEPTION 'required batch failure'; END IF; RETURN NEW; END $$`);
    await h.owner.query(
      "CREATE TRIGGER reject_both_backfill_refresh BEFORE UPDATE ON accrual_schedules FOR EACH ROW EXECUTE FUNCTION reject_both_backfill_refresh()",
    );
    try {
      await expect(suggestions(rows, p.fingerprint!)).rejects.toThrow();
      expect(await snapshot()).toEqual(original);
      expect(await state(a.id)).toEqual(before[0]);
      expect(await state(b.id)).toEqual(before[1]);
      expect(await category(a.id)).toBeNull();
      expect(await category(b.id)).toBeNull();
      expect(await bank()).toBe(balance);
    } finally {
      await h.owner.query(
        "DROP TRIGGER reject_both_backfill_refresh ON accrual_schedules",
      );
      await h.owner.query("DROP FUNCTION reject_both_backfill_refresh()");
    }
  });
  it("supports cash-only suggestions without tokens, skips missing payees, and refuses duplicate assignments", async () => {
    const p = await payee("Cash"),
      tx = await source(p.id),
      rows = assignments(p.id, randomUUID());
    expect((await suggestionPreview(rows)).fingerprint).toBeNull();
    expect(await suggestions(rows)).toEqual({
      updated: 1,
      transactionsBackfilled: 1,
    });
    expect(await category(tx.id)).toBe(income);
    await expect(suggestions([rows[0], rows[0]])).rejects.toMatchObject({
      status: 409,
    });
  });
  it("previews merged source and canonical backfills while preserving categorized and split components", async () => {
    const canonical = await payee("Canonical"),
      branch = await payee("Branch");
    const a = await source(canonical.id),
      b = await source(branch.id),
      existing = await source(branch.id, expense),
      split = await source(branch.id, expense, true);
    const line = (
      await h.owner.query(
        "SELECT id FROM transaction_splits WHERE transaction_id=$1 ORDER BY id",
        [split.id],
      )
    )[0].id;
    await accrue(a.id);
    await accrue(b.id);
    await accrue(existing.id);
    await accrue(split.id, line);
    const before = [
        await state(a.id),
        await state(b.id),
        await state(existing.id),
        await state(split.id),
      ],
      balance = await bank();
    const g = group(canonical.id, branch.id),
      p = await mergePreview(g),
      original = await snapshot();
    expect(p.transactionIds.sort()).toEqual([a.id, b.id].sort());
    expect((await merge(g)).failures).toHaveLength(1);
    expect(await snapshot()).toEqual(original);
    const result = await merge({
      ...g,
      accrualImpactFingerprint: p.fingerprint!,
    });
    expect(result.failures).toEqual([]);
    expect(result.transactionsBackfilled).toBe(2);
    for (const [index, tx] of [a, b, existing, split].entries()) {
      const after = await state(tx.id);
      expect(after.id).toBe(before[index].id);
      expect(after.allocations).toEqual(before[index].allocations);
      expect(after.family).toBe(index < 2 ? "income" : "expense");
      expect(
        (
          await h.owner.query("SELECT payee_id FROM transactions WHERE id=$1", [
            tx.id,
          ])
        )[0].payee_id,
      ).toBe(canonical.id);
    }
    expect(await snapshot()).toEqual([
      { id: canonical.id, name: "Merged office", default_category_id: income },
    ]);
    expect(await bank()).toBe(balance);
  });
  it("refuses stale merge commands and changes to a source payee before merging anything", async () => {
    const canonical = await payee("Canonical"),
      branch = await payee("Branch"),
      tx = await source(branch.id);
    await accrue(tx.id);
    const g = group(canonical.id, branch.id),
      p = await mergePreview(g),
      original = await snapshot();
    expect(
      (
        await merge({
          ...g,
          alias: "*different*",
          accrualImpactFingerprint: p.fingerprint!,
        })
      ).failures,
    ).toHaveLength(1);
    expect(await snapshot()).toEqual(original);
    await h.owner.query(
      "UPDATE payees SET notes='changed source' WHERE id=$1",
      [branch.id],
    );
    expect(
      (await merge({ ...g, accrualImpactFingerprint: p.fingerprint! }))
        .failures,
    ).toHaveLength(1);
    expect(await category(tx.id)).toBeNull();
    expect((await snapshot()).length).toBe(2);
  });
  it("rolls back merge deletion, aliases, rename and defaults if the later category refresh fails", async () => {
    const canonical = await payee("Canonical"),
      branch = await payee("Branch"),
      tx = await source(branch.id);
    await accrue(tx.id);
    const g = group(canonical.id, branch.id),
      p = await mergePreview(g),
      original = await snapshot(),
      before = await state(tx.id),
      balance = await bank();
    await h.owner
      .query(`CREATE FUNCTION reject_merge_family_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF NEW.family='income' THEN RAISE EXCEPTION 'required late merge failure'; END IF; RETURN NEW; END $$`);
    await h.owner.query(
      "CREATE TRIGGER reject_merge_family_refresh BEFORE UPDATE ON accrual_schedules FOR EACH ROW EXECUTE FUNCTION reject_merge_family_refresh()",
    );
    try {
      expect(
        (await merge({ ...g, accrualImpactFingerprint: p.fingerprint! }))
          .failures,
      ).toHaveLength(1);
      expect(await snapshot()).toEqual(original);
      expect(await state(tx.id)).toEqual(before);
      expect(await category(tx.id)).toBeNull();
      expect(
        (
          await h.owner.query("SELECT payee_id FROM transactions WHERE id=$1", [
            tx.id,
          ])
        )[0].payee_id,
      ).toBe(branch.id);
      expect(
        await h.owner.query("SELECT id FROM payee_aliases WHERE user_id=$1", [
          user,
        ]),
      ).toEqual([]);
      expect(await bank()).toBe(balance);
    } finally {
      await h.owner.query(
        "DROP TRIGGER reject_merge_family_refresh ON accrual_schedules",
      );
      await h.owner.query("DROP FUNCTION reject_merge_family_refresh()");
    }
  });
  it("retains per-group partial success when one accrued merge lacks confirmation and another is cash-only", async () => {
    const a = await payee("A"),
      b = await payee("B"),
      c = await payee("C"),
      d = await payee("D");
    const accrued = await source(b.id),
      cash = await source(d.id);
    await accrue(accrued.id);
    const result = await as(() =>
      auto.applyAutoMerge(user, [
        group(a.id, b.id),
        {
          ...group(c.id, d.id),
          canonicalName: "Other merged",
          alias: "*other merged*",
        },
      ]),
    );
    expect(result.groupsMerged).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(await category(accrued.id)).toBeNull();
    expect(await category(cash.id)).toBe(income);
    expect((await snapshot()).length).toBe(3);
  });
  it("serializes two confirmations of the same merge without duplicate source changes", async () => {
    const canonical = await payee("Canonical"),
      branch = await payee("Branch"),
      tx = await source(branch.id);
    await accrue(tx.id);
    const g = group(canonical.id, branch.id),
      p = await mergePreview(g),
      balance = await bank();
    const results = await Promise.all([
      merge({ ...g, accrualImpactFingerprint: p.fingerprint! }),
      merge({ ...g, accrualImpactFingerprint: p.fingerprint! }),
    ]);
    expect(results.reduce((sum, result) => sum + result.groupsMerged, 0)).toBe(
      1,
    );
    expect(
      results.reduce((sum, result) => sum + result.failures.length, 0),
    ).toBe(1);
    expect(await category(tx.id)).toBe(income);
    expect(await bank()).toBe(balance);
  });
  it("checks reconciled restrictions and category ownership before either workflow writes", async () => {
    const canonical = await payee("Canonical"),
      branch = await payee("Branch"),
      tx = await source(branch.id);
    await accrue(tx.id);
    await as(() =>
      transactions.updateStatus(user, tx.id, TransactionStatus.RECONCILED),
    );
    await h.owner.query(
      "INSERT INTO user_preferences(user_id,lock_reconciled_transactions) VALUES($1,true) ON CONFLICT(user_id) DO UPDATE SET lock_reconciled_transactions=true",
      [user],
    );
    const original = await snapshot();
    await expect(
      suggestionPreview(assignments(branch.id)),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      mergePreview(group(canonical.id, branch.id)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(original);
    const outsider = (await createTestUserDirect(h.owner)).id,
      foreign = randomUUID();
    await h.owner.query(
      "INSERT INTO categories(id,user_id,name,is_income) VALUES($1,$2,'Foreign',true)",
      [foreign, outsider],
    );
    await expect(
      mergePreview({
        ...group(canonical.id, branch.id),
        defaultCategoryId: foreign,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      suggestions([
        { payeeId: branch.id, categoryId: foreign, backfillTransactions: true },
      ]),
    ).rejects.toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(original);
  });
  it("refuses a source inserted after discovery but before payee locks close the set", async () => {
    const canonical = await payee("Canonical"),
      branch = await payee("Branch"),
      tx = await source(branch.id);
    await accrue(tx.id);
    const before = await state(tx.id),
      original = await snapshot(),
      balance = await bank();
    let inserted = false;
    await expect(
      as(() =>
        withScopedDb(h.app, async (m) => {
          const originalQuery = m.query.bind(m);
          const interleaved = new Proxy(m, {
            get(target, property) {
              if (property === "query")
                return async (sql: string, parameters?: unknown[]) => {
                  if (
                    !inserted &&
                    sql.includes("FROM payees p") &&
                    sql.includes("id=ANY")
                  ) {
                    inserted = true;
                    await h.owner.query(
                      "INSERT INTO transactions(id,user_id,account_id,payee_id,transaction_date,amount,currency_code) VALUES($1,$2,$3,$4,'2026-06-15',0,'USD')",
                      [randomUUID(), user, account, branch.id],
                    );
                  }
                  return originalQuery(sql, parameters);
                };
              return Reflect.get(target, property, target);
            },
          });
          return lockPayeeCategoryBatch(
            interleaved,
            user,
            [canonical.id, branch.id],
            [income],
          );
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(inserted).toBe(true);
    expect(await snapshot()).toEqual(original);
    expect(await state(tx.id)).toEqual(before);
    expect(await bank()).toBe(balance);
  });
});
