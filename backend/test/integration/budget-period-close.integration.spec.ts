import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsModule } from "@/transactions/transactions.module";
import { BudgetsModule } from "@/budgets/budgets.module";
import { BudgetsService } from "@/budgets/budgets.service";
import { BudgetPeriodService } from "@/budgets/budget-period.service";
import { Budget, BudgetType } from "@/budgets/entities/budget.entity";
import {
  BudgetCategory,
  RolloverType,
} from "@/budgets/entities/budget-category.entity";
import {
  BudgetPeriod,
  PeriodStatus,
} from "@/budgets/entities/budget-period.entity";
import { BudgetPeriodCategory } from "@/budgets/entities/budget-period-category.entity";
import {
  getCurrentMonthPeriodDates,
  getPreviousMonthPeriodDates,
} from "@/budgets/budget-date.utils";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { NotificationService } from "@/notification-center/notification.service";
import {
  NotificationSeverity,
  NotificationType,
} from "@/notification-center/entities/notification.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * Closing a budget period and the actuals it freezes, against PostgreSQL
 * (audit A26-M31, A26-M32, A26-L38, A26-L39).
 *
 * - The accounts excluded in the budget wizard (`config.excludedAccountIds`)
 *   are out of every actuals query: the live page and the period close.
 * - The close writes the rollover `computeRollover` computes from the line's
 *   rollover setting, which it can only read when the relation is loaded: the
 *   unit fixtures hydrate it by hand, so only a real read shows it missing.
 * - The next period follows the closed one, so a close in the middle of a
 *   month leaves exactly one OPEN period, the next month's.
 * - Two flex groups over 90 percent in one period are two alerts: the
 *   fingerprint index tells them apart by the group.
 */
describe("budget period close (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let budgets: BudgetsService;
  let periods: BudgetPeriodService;
  let notifications: NotificationService;
  let userId: string;
  let chequingId: string;
  let cardId: string;
  let groceriesId: string;
  let budget: Budget;
  let groceriesLine: BudgetCategory;

  const current = getCurrentMonthPeriodDates();
  const previous = getPreviousMonthPeriodDates();

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule, BudgetsModule]);
    dataSource = module.get(DataSource);
    budgets = module.get(BudgetsService);
    periods = module.get(BudgetPeriodService);
    notifications = module.get(NotificationService, { strict: false });
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "notifications",
      "transaction_splits",
      "transactions",
      "budget_period_categories",
      "budget_periods",
      "budget_categories",
      "budgets",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    userId = (await createTestUserDirect(dataSource)).id;
    chequingId = (
      await createTestAccount(dataSource, userId, { name: "Chequing" })
    ).id;
    cardId = (
      await createTestAccount(dataSource, userId, { name: "Business Card" })
    ).id;
    groceriesId = (
      await createTestCategory(dataSource, userId, { name: "Groceries" })
    ).id;

    budget = await dataSource.manager.save(
      dataSource.manager.create(Budget, {
        userId,
        name: "Household",
        budgetType: BudgetType.MONTHLY,
        periodStart: previous.periodStart,
        currencyCode: "USD",
        config: { excludedAccountIds: [cardId] },
      } as Partial<Budget>),
    );
    groceriesLine = await dataSource.manager.save(
      dataSource.manager.create(BudgetCategory, {
        budgetId: budget.id,
        categoryId: groceriesId,
        isIncome: false,
        isTransfer: false,
        amount: 500,
        rolloverType: RolloverType.MONTHLY,
      } as Partial<BudgetCategory>),
    );
  });

  function insertTransaction(
    overrides: Partial<Transaction>,
  ): Promise<Transaction> {
    return dataSource.manager.save(
      dataSource.manager.create(Transaction, {
        userId,
        accountId: chequingId,
        transactionDate: current.periodStart,
        amount: -200,
        currencyCode: "USD",
        status: TransactionStatus.UNRECONCILED,
        isSplit: false,
        isTransfer: false,
        categoryId: groceriesId,
        ...overrides,
      } as Partial<Transaction>),
    );
  }

  /** An OPEN period over `dates` whose Groceries line has 500 to spend. */
  async function openPeriod(dates: {
    periodStart: string;
    periodEnd: string;
  }): Promise<BudgetPeriod> {
    const period = await dataSource.manager.save(
      dataSource.manager.create(BudgetPeriod, {
        budgetId: budget.id,
        periodStart: dates.periodStart,
        periodEnd: dates.periodEnd,
        totalBudgeted: 500,
        status: PeriodStatus.OPEN,
      } as Partial<BudgetPeriod>),
    );
    await dataSource.manager.save(
      dataSource.manager.create(BudgetPeriodCategory, {
        budgetPeriodId: period.id,
        budgetCategoryId: groceriesLine.id,
        categoryId: groceriesId,
        budgetedAmount: 500,
        rolloverIn: 0,
        effectiveBudget: 500,
        actualAmount: 0,
        rolloverOut: 0,
      } as Partial<BudgetPeriodCategory>),
    );
    return period;
  }

  const periodRows = (): Promise<
    Array<{
      period_start: string;
      status: string;
      actual_amount: string;
      rollover_in: string;
      rollover_out: string;
      effective_budget: string;
    }>
  > =>
    dataSource.query(
      `SELECT TO_CHAR(p.period_start, 'YYYY-MM-DD') AS period_start, p.status,
              pc.actual_amount, pc.rollover_in, pc.rollover_out,
              pc.effective_budget
         FROM budget_periods p
         LEFT JOIN budget_period_categories pc ON pc.budget_period_id = p.id
        WHERE p.budget_id = $1
        ORDER BY p.period_start`,
      [budget.id],
    );

  it("leaves an excluded account's spending out of the live budget", async () => {
    await insertTransaction({ amount: -200 });
    await insertTransaction({ accountId: cardId, amount: -300 });

    const summary = await withUserContext(userId, () =>
      budgets.getSummary(userId, budget.id),
    );

    const groceries = summary.categoryBreakdown.find(
      (c) => c.categoryId === groceriesId,
    );
    expect(groceries?.spent).toBe(200);
  });

  it("carries the unused budget into the next period and freezes the actuals without the excluded account", async () => {
    await openPeriod(previous);
    await insertTransaction({
      transactionDate: previous.periodStart,
      amount: -200,
    });
    await insertTransaction({
      transactionDate: previous.periodStart,
      accountId: cardId,
      amount: -300,
    });

    await withUserContext(userId, () => periods.closePeriod(userId, budget.id));

    const [closed, next] = await periodRows();
    expect(closed.status).toBe(PeriodStatus.CLOSED);
    expect(closed.actual_amount).toBe("200.00000000");
    expect(closed.rollover_out).toBe("300.00000000");
    expect(next.period_start).toBe(current.periodStart);
    expect(next.status).toBe(PeriodStatus.OPEN);
    expect(next.rollover_in).toBe("300.00000000");
    expect(next.effective_budget).toBe("800.00000000");
  });

  it("opens the following month when a period is closed before it ends", async () => {
    await openPeriod(current);

    await withUserContext(userId, () => periods.closePeriod(userId, budget.id));

    const rows = await periodRows();
    const open = rows.filter((r) => r.status === PeriodStatus.OPEN);
    expect(open).toHaveLength(1);
    const [y, m] = current.periodEnd.split("-").map(Number);
    const following = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`;
    expect(open[0].period_start).toBe(following);
  });

  it("stores one flex-group warning per group in a period", async () => {
    const warn = (flexGroup: string) =>
      withUserContext(userId, () =>
        notifications.create(userId, {
          type: NotificationType.FLEX_GROUP_WARNING,
          severity: NotificationSeverity.WARNING,
          title: `Flex group "${flexGroup}" at 95%`,
          message: `The "${flexGroup}" flex group is at 95%.`,
          data: { flexGroup, percent: 95 },
          budgetId: budget.id,
          budgetCategoryId: null,
          periodStart: current.periodStart,
        }),
      );

    const fun = await warn("Fun");
    const dining = await warn("Dining");
    // The same group again is still the same alert.
    const funAgain = await warn("Fun");

    expect(fun).not.toBeNull();
    expect(dining).not.toBeNull();
    expect(funAgain).toBeNull();
    const rows: unknown[] = await dataSource.query(
      "SELECT 1 FROM notifications WHERE budget_id = $1 AND alert_type = $2",
      [budget.id, NotificationType.FLEX_GROUP_WARNING],
    );
    expect(rows).toHaveLength(2);
  });
});
