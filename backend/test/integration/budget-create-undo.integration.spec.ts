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
import { createTestCategory } from "../helpers/test-factories";

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

  beforeEach(async () => {
    await cleanTables(db, [
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

  it("refuses while the budget has a closed period or a line, and writes nothing", async () => {
    const budget = await createBudget();
    await asUser(() =>
      budgets.addCategory(userId, budget.id, {
        categoryId,
        amount: 500,
      } as any),
    );
    await db.query(
      `INSERT INTO budget_periods (budget_id, period_start, period_end, status)
       VALUES ($1, '2026-01-01', '2026-01-31', 'CLOSED')`,
      [budget.id],
    );

    const refusal = await asUser(() => history.undo(userId)).catch((e) => e);

    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getResponse()).toMatchObject({
      errorCode: "UNDO_BUDGET_HAS_HISTORY",
    });
    expect(await count("budgets")).toBe(1);
    expect(await count("budget_categories")).toBe(1);
    expect(await count("budget_periods")).toBe(1);
  });

  it("undoes a budget that has nothing hanging on it, and the redo restores it", async () => {
    const budget = await createBudget();

    await asUser(() => history.undo(userId));
    expect(await count("budgets")).toBe(0);

    await asUser(() => history.redo(userId));
    const rows = await db.query(`SELECT id, name FROM budgets`);
    expect(rows).toEqual([{ id: budget.id, name: "Household" }]);
  });
});
