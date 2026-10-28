import { randomUUID } from "node:crypto";
import { withScopedDb } from "@/common/db/scoped-db";
import { prepareCategoryMutation } from "@/categories/category-mutation";
import { TransactionStatus } from "@/transactions/entities/transaction.entity";
import { createAccrualTaxonomyFixture } from "../helpers/accrual-taxonomy-fixture";

describe("reviewed category hierarchy and reassignment accrual maintenance", () => {
  jest.setTimeout(180000);
  let f: Awaited<ReturnType<typeof createAccrualTaxonomyFixture>>;
  beforeAll(async () => {
    f = await createAccrualTaxonomyFixture();
  });
  beforeEach(async () => {
    await f.reset();
  });
  afterAll(async () => {
    if (f) await f.close();
  });
  const updatePreview = (
    id: string,
    dto: { isIncome?: boolean; parentId?: string | null; name?: string },
  ) => f.as(() => f.categories.previewCategoryUpdate(f.user, id, dto));
  const reassignPreview = (id: string, target: string | null) =>
    f.as(() => f.categories.previewCategoryReassignment(f.user, id, target));
  const reassign = (id: string, target: string | null, token?: string) =>
    f.as(() => f.categories.reassignTransactions(f.user, id, target, token));
  const sourceCategory = async (id: string) =>
    (
      await f.h.owner.query(
        "SELECT category_id FROM transactions WHERE id=$1",
        [id],
      )
    )[0].category_id;
  it("previews and refreshes the whole classified subtree while retaining unrelated split schedules", async () => {
    const a = await f.source(),
      b = await f.source({ categoryId: f.child }),
      split = await f.source({ splitCategories: [f.grandchild, f.other] });
    await f.accrue(a.tx.id);
    await f.accrue(b.tx.id);
    await f.accrue(split.tx.id, split.lines[0].id);
    await f.accrue(split.tx.id, split.lines[1].id);
    const original = await f.graph(),
      balance = await f.bank(),
      before = [
        await f.states(a.tx.id),
        await f.states(b.tx.id),
        await f.states(split.tx.id),
      ];
    const p = await updatePreview(f.root, { isIncome: true });
    expect(p.changedCategoryIds.sort()).toEqual(
      [f.root, f.child, f.grandchild].sort(),
    );
    await expect(
      f.as(() => f.categories.update(f.user, f.root, { isIncome: true })),
    ).rejects.toMatchObject({ status: 409 });
    expect(await f.graph()).toEqual(original);
    await f.as(() =>
      f.categories.update(f.user, f.root, {
        isIncome: true,
        accrualImpactFingerprint: p.fingerprint!,
      }),
    );
    for (const [index, tx] of [a, b].entries()) {
      const after = await f.states(tx.tx.id);
      expect(after[0]).toMatchObject({
        id: before[index][0].id,
        revision: before[index][0].revision + 1,
        family: "income",
        allocations: before[index][0].allocations,
      });
    }
    const after = await f.states(split.tx.id);
    for (const line of after) {
      const prior = before[2].find((row: { id: string }) => row.id === line.id);
      expect(line.allocations).toEqual(prior.allocations);
      expect(line.family).toBe(
        line.splitId === split.lines[0].id ? "income" : "expense",
      );
    }
    expect(await f.bank()).toBe(balance);
  });
  it("inherits a new parent's classification throughout the moved subtree", async () => {
    const a = await f.source({ categoryId: f.child }),
      b = await f.source({ categoryId: f.grandchild });
    await f.accrue(a.tx.id);
    await f.accrue(b.tx.id);
    const dto = { parentId: f.income, isIncome: false },
      p = await updatePreview(f.child, dto),
      balance = await f.bank();
    expect(p.isIncome).toBe(true);
    await f.as(() =>
      f.categories.update(f.user, f.child, {
        ...dto,
        accrualImpactFingerprint: p.fingerprint!,
      }),
    );
    expect(
      (await f.graph()).find((row: { id: string }) => row.id === f.child),
    ).toMatchObject({ parentId: f.income, isIncome: true });
    expect(
      (await f.graph()).find((row: { id: string }) => row.id === f.grandchild)
        .isIncome,
    ).toBe(true);
    expect((await f.states(a.tx.id))[0].family).toBe("income");
    expect((await f.states(b.tx.id))[0].family).toBe("income");
    expect(await f.bank()).toBe(balance);
  });
  it("rejects altered payloads and a hierarchy changed since preview", async () => {
    const a = await f.source();
    await f.accrue(a.tx.id);
    const p = await updatePreview(f.root, { isIncome: true }),
      before = await f.states(a.tx.id);
    await expect(
      f.as(() =>
        f.categories.update(f.user, f.root, {
          isIncome: true,
          name: "Altered",
          accrualImpactFingerprint: p.fingerprint!,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await f.h.owner.query(
      "UPDATE categories SET name='Renamed child' WHERE id=$1",
      [f.child],
    );
    await expect(
      f.as(() =>
        f.categories.update(f.user, f.root, {
          isIncome: true,
          accrualImpactFingerprint: p.fingerprint!,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await f.states(a.tx.id)).toEqual(before);
  });
  it("reassigns ordinary and split components plus scheduled references with exact retained schedules", async () => {
    const a = await f.source(),
      cash = await f.source(),
      split = await f.source({ splitCategories: [f.root, f.other] });
    await f.accrue(a.tx.id);
    await f.accrue(split.tx.id, split.lines[0].id);
    await f.accrue(split.tx.id, split.lines[1].id);
    const schedule = await f.scheduled(),
      before = [await f.states(a.tx.id), await f.states(split.tx.id)],
      balance = await f.bank();
    const p = await reassignPreview(f.root, f.income);
    await expect(reassign(f.root, f.income)).rejects.toMatchObject({
      status: 409,
    });
    await reassign(f.root, f.income, p.fingerprint!);
    expect(await sourceCategory(a.tx.id)).toBe(f.income);
    expect(await sourceCategory(cash.tx.id)).toBe(f.income);
    const after = await f.states(split.tx.id);
    for (const line of after) {
      const prior = before[1].find((row: { id: string }) => row.id === line.id);
      expect(line.allocations).toEqual(prior.allocations);
      expect(line.family).toBe(
        line.splitId === split.lines[0].id ? "income" : "expense",
      );
    }
    expect((await f.states(a.tx.id))[0]).toMatchObject({
      id: before[0][0].id,
      family: "income",
      allocations: before[0][0].allocations,
    });
    expect(
      (
        await f.h.owner.query(
          "SELECT category_id FROM scheduled_transactions WHERE id=$1",
          [schedule.id],
        )
      )[0].category_id,
    ).toBe(f.income);
    expect(
      (
        await f.h.owner.query(
          "SELECT category_id FROM scheduled_transaction_splits WHERE id=$1",
          [schedule.lineId],
        )
      )[0].category_id,
    ).toBe(f.income);
    expect(await f.bank()).toBe(balance);
  });
  it("uncategorizes a reviewed source without deleting its schedule or losing its chosen family", async () => {
    const a = await f.source();
    await f.accrue(a.tx.id);
    const before = (await f.states(a.tx.id))[0],
      p = await reassignPreview(f.root, null);
    await reassign(f.root, null, p.fingerprint!);
    expect(await sourceCategory(a.tx.id)).toBeNull();
    expect((await f.states(a.tx.id))[0]).toMatchObject({
      id: before.id,
      family: "expense",
      allocations: before.allocations,
    });
  });
  it("rolls category hierarchy and every schedule back when classification maintenance fails", async () => {
    const a = await f.source({ categoryId: f.grandchild });
    await f.accrue(a.tx.id);
    const before = await f.states(a.tx.id),
      graph = await f.graph(),
      p = await updatePreview(f.root, {
        isIncome: true,
        name: "Must roll back",
      });
    await f.h.owner
      .query(`CREATE FUNCTION reject_category_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN RAISE EXCEPTION 'required family failure'; END $$`);
    await f.h.owner.query(
      "CREATE TRIGGER reject_category_mutation BEFORE UPDATE ON accrual_schedules FOR EACH ROW EXECUTE FUNCTION reject_category_mutation()",
    );
    try {
      await expect(
        f.as(() =>
          f.categories.update(f.user, f.root, {
            isIncome: true,
            name: "Must roll back",
            accrualImpactFingerprint: p.fingerprint!,
          }),
        ),
      ).rejects.toThrow();
      expect(await f.graph()).toEqual(graph);
      expect(await f.states(a.tx.id)).toEqual(before);
    } finally {
      await f.h.owner.query(
        "DROP TRIGGER reject_category_mutation ON accrual_schedules",
      );
      await f.h.owner.query("DROP FUNCTION reject_category_mutation()");
    }
  });
  it("rolls source and scheduled reassignments back when a later accrual refresh fails", async () => {
    const a = await f.source();
    await f.accrue(a.tx.id);
    const scheduled = await f.scheduled();
    const before = await f.states(a.tx.id),
      p = await reassignPreview(f.root, f.income);
    await f.h.owner
      .query(`CREATE FUNCTION reject_category_reassignment() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN RAISE EXCEPTION 'required reassignment failure'; END $$`);
    await f.h.owner.query(
      "CREATE TRIGGER reject_category_reassignment BEFORE UPDATE ON accrual_schedules FOR EACH ROW EXECUTE FUNCTION reject_category_reassignment()",
    );
    try {
      await expect(
        reassign(f.root, f.income, p.fingerprint!),
      ).rejects.toThrow();
      expect(await sourceCategory(a.tx.id)).toBe(f.root);
      expect(await f.states(a.tx.id)).toEqual(before);
      expect(
        (
          await f.h.owner.query(
            "SELECT category_id FROM scheduled_transactions WHERE id=$1",
            [scheduled.id],
          )
        )[0].category_id,
      ).toBe(f.root);
    } finally {
      await f.h.owner.query(
        "DROP TRIGGER reject_category_reassignment ON accrual_schedules",
      );
      await f.h.owner.query("DROP FUNCTION reject_category_reassignment()");
    }
  });
  it("keeps referenced category deletion protected and permits the existing reassign-then-delete flow", async () => {
    const a = await f.source({ categoryId: f.other });
    await f.accrue(a.tx.id);
    const before = (await f.states(a.tx.id))[0];
    await f.h.owner.query(
      "UPDATE payees SET default_category_id=$1 WHERE id=$2",
      [f.other, f.payee],
    );
    await expect(
      f.as(() => f.categories.remove(f.user, f.other)),
    ).rejects.toMatchObject({ status: 400 });
    const p = await reassignPreview(f.other, f.income);
    await reassign(f.other, f.income, p.fingerprint!);
    await f.as(() => f.categories.remove(f.user, f.other));
    expect((await f.states(a.tx.id))[0]).toMatchObject({
      id: before.id,
      family: "income",
      allocations: before.allocations,
    });
    expect(
      (
        await f.h.owner.query(
          "SELECT default_category_id FROM payees WHERE id=$1",
          [f.payee],
        )
      )[0].default_category_id,
    ).toBeNull();
  });
  it("protects system categories, child-bearing categories and scheduled references", async () => {
    await expect(
      f.as(() => f.categories.remove(f.user, f.root)),
    ).rejects.toMatchObject({ status: 400 });
    await f.h.owner.query("UPDATE categories SET is_system=true WHERE id=$1", [
      f.other,
    ]);
    await expect(
      updatePreview(f.other, { isIncome: true }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.as(() => f.categories.remove(f.user, f.other)),
    ).rejects.toMatchObject({ status: 400 });
    await f.scheduled(f.income);
    await expect(
      f.as(() => f.categories.remove(f.user, f.income)),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("checks strict reconciliation and foreign targets before changing classification or assignments", async () => {
    const a = await f.source();
    await f.accrue(a.tx.id);
    await f.as(() =>
      f.transactions.updateStatus(
        f.user,
        a.tx.id,
        TransactionStatus.RECONCILED,
      ),
    );
    await f.h.owner.query(
      "INSERT INTO user_preferences(user_id,lock_reconciled_transactions) VALUES($1,true) ON CONFLICT(user_id) DO UPDATE SET lock_reconciled_transactions=true",
      [f.user],
    );
    await expect(
      updatePreview(f.root, { isIncome: true }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(reassignPreview(f.root, f.income)).rejects.toMatchObject({
      status: 409,
    });
    await expect(reassignPreview(f.root, randomUUID())).rejects.toMatchObject({
      status: 404,
    });
    expect(await sourceCategory(a.tx.id)).toBe(f.root);
  });
  it("refuses a new source committed between discovery and category locking", async () => {
    const a = await f.source();
    await f.accrue(a.tx.id);
    const before = await f.states(a.tx.id),
      graph = await f.graph();
    let inserted = false;
    await expect(
      f.as(() =>
        withScopedDb(f.h.app, async (m) => {
          const originalQuery = m.query.bind(m);
          const interleaved = new Proxy(m, {
            get(target, property) {
              if (property === "query")
                return async (sql: string, parameters?: unknown[]) => {
                  if (
                    !inserted &&
                    sql.includes("FROM categories c") &&
                    sql.includes("FOR UPDATE OF c")
                  ) {
                    inserted = true;
                    await f.h.owner.query(
                      "INSERT INTO transactions(id,user_id,account_id,category_id,transaction_date,amount,currency_code) VALUES($1,$2,$3,$4,'2026-06-15',0,'USD')",
                      [randomUUID(), f.user, f.account, f.root],
                    );
                  }
                  return originalQuery(sql, parameters);
                };
              return Reflect.get(target, property, target);
            },
          });
          return prepareCategoryMutation(interleaved, f.user, f.root, {
            operation: "update",
            dto: { isIncome: true },
          });
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(inserted).toBe(true);
    expect(await f.graph()).toEqual(graph);
    expect(await f.states(a.tx.id)).toEqual(before);
  });
  it("allows only one of two simultaneous classification confirmations", async () => {
    const a = await f.source();
    await f.accrue(a.tx.id);
    const before = (await f.states(a.tx.id))[0],
      p = await updatePreview(f.root, { isIncome: true });
    const command = {
      isIncome: true,
      accrualImpactFingerprint: p.fingerprint!,
    };
    const results = await Promise.allSettled([
      f.as(() => f.categories.update(f.user, f.root, command)),
      f.as(() => f.categories.update(f.user, f.root, command)),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((row) => row.status === "rejected")).toHaveLength(1);
    expect((await f.states(a.tx.id))[0]).toMatchObject({
      id: before.id,
      revision: before.revision + 1,
      family: "income",
    });
  });
});
