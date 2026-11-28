import { ConflictException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { BudgetsModule } from "@/budgets/budgets.module";
import { BudgetsService } from "@/budgets/budgets.service";
import { BudgetType } from "@/budgets/entities/budget.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * Audit #2365 (c, d): undoing the creation of a budget deleted, through the
 * foreign-key cascade, the closed periods recorded since and the lines added
 * since; the redo then brought back a budget without them. The undo is refused
 * (409 UNDO_BUDGET_HAS_HISTORY) before any write while such rows exist, so a
 * redo only ever restores a budget that had none.
 */
describe("Undo of a budget creation (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let db: DataSource;
  let budgets: BudgetsService;
  let history: ActionHistoryService;
  let userId: string;
  let categoryId: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  beforeAll(async () => {
    module = await createIntegrationModule([BudgetsModule]);
    db = module.get(DataSource);
    budgets = module.get(BudgetsService);
    history = module.get(ActionHistoryService, { strict: false });
  });

  afterAll(async () => {
    await module.close();
  });

  beforeAll(async () => {
    // The suite's schema is synchronized from the entities, whose relations
    // carry no onDelete, so the budget's children block a delete here. The
    // real schema (database/schema.sql) cascades; match it so a delete
    // behaves as in production.
    await db.query(`
      DO $$ DECLARE r record; BEGIN
        FOR r IN SELECT conrelid::regclass AS t, conname FROM pg_constraint
                  WHERE contype = 'f' AND confrelid = 'budgets'::regclass AND confdeltype <> 'c'
        LOOP
          EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.t, r.conname);
          EXECUTE format('ALTER TABLE %s ADD FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE CASCADE', r.t);
        END LOOP;
      END $$`);
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "budget_buckets",
      "action_history",
      "budget_period_categories",
      "budget_periods",
      "budget_categories",
      "budgets",
      "categories",
      "users",
    ]);
    userId = (await createTestUserDirect(db)).id;
    categoryId = (await createTestCategory(db, userId, { name: "Groceries" }))
      .id;
  });

  async function createBudget() {
    const budget = await asUser(() =>
      budgets.create(userId, {
        name: "Household",
        budgetType: BudgetType.MONTHLY,
        periodStart: "2026-01-01",
        currencyCode: "USD",
      } as any),
    );
    await settlePendingHistoryWrites();
    return budget;
  }

  const count = async (table: string): Promise<number> =>
    Number((await db.query(`SELECT count(*)::int AS n FROM ${table}`))[0].n);

  async function expectRefusedAndIntact(rows: {
    lines: number;
    periods: number;
  }) {
    const refusal = await asUser(() => history.undo(userId)).catch((e) => e);

    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getResponse()).toMatchObject({
      errorCode: "UNDO_BUDGET_HAS_HISTORY",
    });
    expect(await count("budgets")).toBe(1);
    expect(await count("budget_categories")).toBe(rows.lines);
    expect(await count("budget_periods")).toBe(rows.periods);
  }

  const addLine = (budgetId: string) =>
    asUser(() =>
      budgets.addCategory(userId, budgetId, { categoryId, amount: 500 } as any),
    );

  const addPeriod = (budgetId: string, status: string) =>
    db.query(
      `INSERT INTO budget_periods (budget_id, period_start, period_end, status)
       VALUES ($1, '2026-01-01', '2026-01-31', $2)`,
      [budgetId, status],
    );

  it("refuses after a period was closed, and writes nothing", async () => {
    const budget = await createBudget();
    await addPeriod(budget.id, "CLOSED");
    await expectRefusedAndIntact({ lines: 0, periods: 1 });
  });

  it("refuses after a line was added later, and writes nothing", async () => {
    const budget = await createBudget();
    await addLine(budget.id);
    await expectRefusedAndIntact({ lines: 1, periods: 0 });
  });

  const addBucket = (budgetId: string) =>
    db.query(
      `INSERT INTO budget_buckets (budget_id, name, target_type, target_value)
       VALUES ($1, 'Needs', 'PERCENT', 50)`,
      [budgetId],
    );

  it("refuses after a bucket was added later, and writes nothing", async () => {
    const budget = await createBudget();
    await addBucket(budget.id);
    await expectRefusedAndIntact({ lines: 0, periods: 0 });
    expect(await count("budget_buckets")).toBe(1);
  });

  it("refuses with both a line and a closed period, and writes nothing", async () => {
    const budget = await createBudget();
    await addLine(budget.id);
    await addPeriod(budget.id, "CLOSED");
    await expectRefusedAndIntact({ lines: 1, periods: 1 });
  });

  it("undoes a budget that has nothing hanging on it, and the redo restores it", async () => {
    const budget = await createBudget();

    await asUser(() => history.undo(userId));
    expect(await count("budgets")).toBe(0);

    await asUser(() => history.redo(userId));
    const rows = await db.query(`SELECT id, name FROM budgets`);
    expect(rows).toEqual([{ id: budget.id, name: "Household" }]);
  });

  describe("a deleted budget", () => {
    async function deleteBudgetWithLinesAndBucket() {
      const budget = await createBudget();
      await addLine(budget.id);
      await addBucket(budget.id);
      await asUser(() => budgets.remove(userId, budget.id));
      await settlePendingHistoryWrites();
      expect(await count("budgets")).toBe(0);
      return budget;
    }

    it("is restored by the undo with its lines and buckets", async () => {
      const budget = await deleteBudgetWithLinesAndBucket();

      await asUser(() => history.undo(userId));

      const [row] = await db.query(
        `SELECT (SELECT count(*)::int FROM budget_categories WHERE budget_id = b.id) AS lines,
                (SELECT count(*)::int FROM budget_buckets WHERE budget_id = b.id) AS buckets
           FROM budgets b WHERE b.id = $1`,
        [budget.id],
      );
      expect(row).toEqual({ lines: 1, buckets: 1 });
    });

    it("is removed again by the redo, with the lines it restored", async () => {
      await deleteBudgetWithLinesAndBucket();
      await asUser(() => history.undo(userId));

      await asUser(() => history.redo(userId));

      expect(await count("budgets")).toBe(0);
      expect(await count("budget_categories")).toBe(0);
    });

    it("refuses the redo once a line or a period was added after the restore", async () => {
      const budget = await deleteBudgetWithLinesAndBucket();
      await asUser(() => history.undo(userId));
      await addPeriod(budget.id, "CLOSED");

      const refusal = await asUser(() => history.redo(userId)).catch((e) => e);

      expect(refusal).toBeInstanceOf(ConflictException);
      expect((refusal as ConflictException).getResponse()).toMatchObject({
        errorCode: "REDO_BUDGET_HAS_HISTORY",
      });
      expect(await count("budgets")).toBe(1);
      expect(await count("budget_categories")).toBe(1);
      expect(await count("budget_periods")).toBe(1);
    });

    it("refuses the redo after a restored line was edited", async () => {
      await deleteBudgetWithLinesAndBucket();
      await asUser(() => history.undo(userId));
      await db.query(`UPDATE budget_categories SET amount = 999`);

      const refusal = await asUser(() => history.redo(userId)).catch((e) => e);

      expect(refusal).toBeInstanceOf(ConflictException);
      expect((refusal as ConflictException).getResponse()).toMatchObject({
        errorCode: "REDO_BUDGET_HAS_HISTORY",
      });
      expect(await count("budgets")).toBe(1);
      expect(await count("budget_categories")).toBe(1);
    });

    it("restores the line's bucket link, and nulls a category and an account deleted since", async () => {
      const budget = await createBudget();
      const accountId = (await createTestAccount(db, userId)).id;
      await addBucket(budget.id);
      await addLine(budget.id);
      await db.query(
        `INSERT INTO budget_categories (budget_id, is_transfer, transfer_account_id, amount)
         VALUES ($1, true, $2, 100)`,
        [budget.id, accountId],
      );
      await db.query(
        `UPDATE budget_categories SET bucket_id = (SELECT id FROM budget_buckets)
          WHERE category_id IS NOT NULL`,
      );
      await asUser(() => budgets.remove(userId, budget.id));
      await settlePendingHistoryWrites();
      await db.query(`DELETE FROM categories WHERE id = $1`, [categoryId]);
      await db.query(`DELETE FROM accounts WHERE id = $1`, [accountId]);

      await asUser(() => history.undo(userId));

      const rows = await db.query(
        `SELECT category_id, transfer_account_id, bucket_id FROM budget_categories ORDER BY amount`,
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r: any) => r.category_id === null)).toBe(true);
      expect(rows.every((r: any) => r.transfer_account_id === null)).toBe(true);
      expect(rows.filter((r: any) => r.bucket_id !== null)).toHaveLength(1);

      // The nulls are the cascade's work, not an edit: the redo goes through.
      await asUser(() => history.redo(userId));
      expect(await count("budgets")).toBe(0);
    });
  });
});
