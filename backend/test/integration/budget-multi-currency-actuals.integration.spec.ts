import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsModule } from "@/transactions/transactions.module";
import { BudgetsModule } from "@/budgets/budgets.module";
import { BudgetsService } from "@/budgets/budgets.service";
import { Budget, BudgetType } from "@/budgets/entities/budget.entity";
import { BudgetCategory } from "@/budgets/entities/budget-category.entity";
import { getCurrentMonthPeriodDates } from "@/budgets/budget-date.utils";
import {
  queryCategorySpending,
  resolveCategorySpent,
  resolveCategorySpentOrNull,
} from "@/budgets/budget-spending.util";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { SplitKind } from "@/transactions/entities/split-kind.enum";
import { withScopedDb } from "@/common/db/scoped-db";
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
 * INV-FX-001 ("convert before summing") for a budget's actuals, against a real
 * PostgreSQL database. A CAD budget's Groceries line holds a CAD account's
 * -200.00 and a JPY account's -10,000 JPY: summed raw that is 10,200 (2,040%
 * used); converted at the JPY->CAD rate (0.009) it is 290.00, and with no rate
 * the line's spent is unknown and the pair is named (audit A26-S16-01).
 *
 * The rate is stored in the canonical orientation (CAD < JPY), so JPY->CAD is
 * read through the inverse of CAD->JPY 111.1111111111.
 */
describe("budget actuals across currencies (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let budgets: BudgetsService;
  let userId: string;
  let cadAccountId: string;
  let jpyAccountId: string;
  let savingsId: string;
  let groceriesId: string;
  let diningId: string;
  let budget: Budget;
  let groceriesLine: BudgetCategory;
  let diningLine: BudgetCategory;
  let transferLine: BudgetCategory;

  // The service reads the current calendar month, so every row and rate is
  // dated inside it.
  const { periodStart, periodEnd } = getCurrentMonthPeriodDates();

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule, BudgetsModule]);
    dataSource = module.get(DataSource);
    budgets = module.get(BudgetsService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "transaction_splits",
      "transactions",
      "budget_period_categories",
      "budget_periods",
      "budget_categories",
      "budgets",
      "exchange_rates",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('CAD', 'Canadian Dollar', '$', 2, true),
              ('JPY', 'Japanese Yen', 'Y', 0, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    cadAccountId = (
      await createTestAccount(dataSource, userId, {
        name: "CAD Chequing",
        currencyCode: "CAD",
      })
    ).id;
    jpyAccountId = (
      await createTestAccount(dataSource, userId, {
        name: "JPY Chequing",
        currencyCode: "JPY",
      })
    ).id;
    savingsId = (
      await createTestAccount(dataSource, userId, {
        name: "CAD Savings",
        currencyCode: "CAD",
      })
    ).id;
    groceriesId = (
      await createTestCategory(dataSource, userId, { name: "Groceries" })
    ).id;
    diningId = (
      await createTestCategory(dataSource, userId, { name: "Dining" })
    ).id;

    budget = await dataSource.manager.save(
      dataSource.manager.create(Budget, {
        userId,
        name: "October",
        budgetType: BudgetType.MONTHLY,
        periodStart,
        currencyCode: "CAD",
        config: {},
      } as Partial<Budget>),
    );
    const line = (overrides: Partial<BudgetCategory>) =>
      dataSource.manager.save(
        dataSource.manager.create(BudgetCategory, {
          budgetId: budget.id,
          isIncome: false,
          isTransfer: false,
          ...overrides,
        } as Partial<BudgetCategory>),
      );
    groceriesLine = await line({ categoryId: groceriesId, amount: 500 });
    diningLine = await line({ categoryId: diningId, amount: 100 });
    transferLine = await line({
      categoryId: null,
      isTransfer: true,
      transferAccountId: savingsId,
      amount: 1000,
    });
  });

  function insertTransaction(
    overrides: Partial<Transaction>,
  ): Promise<Transaction> {
    return dataSource.manager.save(
      dataSource.manager.create(Transaction, {
        userId,
        accountId: cadAccountId,
        transactionDate: periodStart,
        amount: -200,
        currencyCode: "CAD",
        status: TransactionStatus.UNRECONCILED,
        isSplit: false,
        isTransfer: false,
        ...overrides,
      } as Partial<Transaction>),
    );
  }

  const insertCadAndJpyGroceries = async (): Promise<void> => {
    await insertTransaction({ categoryId: groceriesId, amount: -200 });
    await insertTransaction({
      accountId: jpyAccountId,
      currencyCode: "JPY",
      categoryId: groceriesId,
      amount: -10000,
    });
    // Dining is CAD only: complete whatever happens to the JPY rate.
    await insertTransaction({ categoryId: diningId, amount: -30 });
  };

  const insertRate = (): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
       VALUES ('CAD', 'JPY', $1::DATE, 111.1111111111, 'test')`,
      [periodStart],
    );

  function runQuery() {
    return withUserContext(userId, () =>
      withScopedDb(dataSource, (m) =>
        queryCategorySpending(
          m.getRepository(Transaction),
          m.getRepository(TransactionSplit),
          userId,
          [groceriesLine, diningLine, transferLine],
          periodStart,
          periodEnd,
        ),
      ),
    );
  }

  it("converts each currency to the budget currency before summing", async () => {
    await insertCadAndJpyGroceries();
    await insertRate();

    const spending = await runQuery();

    expect(spending.currency).toBe("CAD");
    expect(
      resolveCategorySpent(
        groceriesLine,
        spending.spendingMap,
        spending.transferSpendingMap,
      ),
    ).toBe(290);
    expect(resolveCategorySpentOrNull(groceriesLine, spending)).toBe(290);
    expect(resolveCategorySpentOrNull(diningLine, spending)).toBe(30);
    expect(spending.missingRatePairs).toEqual([]);
    expect(spending.incompleteCategoryIds.size).toBe(0);
  });

  it("converts a row at its own rate, as the reports do (INV-FX-002, issue #2130)", async () => {
    await insertTransaction({ categoryId: groceriesId, amount: -200 });
    // JPY 10,000 that settled from CAD 80 (125 JPY per CAD), on a day the
    // market said 111.11: CAD 80, not 90.
    await insertTransaction({
      accountId: jpyAccountId,
      currencyCode: "JPY",
      categoryId: groceriesId,
      amount: -10000,
      originalCurrencyCode: "CAD",
      originalAmount: -80,
      exchangeRate: 125,
    });
    // A second JPY row on the same day with no rate of its own: the market's.
    await insertTransaction({
      accountId: jpyAccountId,
      currencyCode: "JPY",
      categoryId: groceriesId,
      amount: -10000,
    });
    await insertRate();

    const spending = await runQuery();

    expect(resolveCategorySpentOrNull(groceriesLine, spending)).toBe(370);
    expect(spending.missingRatePairs).toEqual([]);
  });

  it("shows the converted figure on the budget summary", async () => {
    await insertCadAndJpyGroceries();
    await insertRate();

    const summary = await withUserContext(userId, () =>
      budgets.getSummary(userId, budget.id),
    );

    const groceries = summary.categoryBreakdown.find(
      (c) => c.categoryId === groceriesId,
    );
    expect(groceries?.spent).toBe(290);
    expect(groceries?.percentUsed).toBe(58);
  });

  it("withholds the line and names the pair when no rate exists", async () => {
    await insertCadAndJpyGroceries();

    const spending = await runQuery();

    expect(resolveCategorySpentOrNull(groceriesLine, spending)).toBeNull();
    expect(spending.missingRatePairs).toEqual(["JPY->CAD"]);
    expect(spending.incompleteCategoryIds.has(groceriesId)).toBe(true);
    // The known part only: never the 10,200 raw sum.
    expect(
      resolveCategorySpent(
        groceriesLine,
        spending.spendingMap,
        spending.transferSpendingMap,
      ),
    ).toBe(200);
    // A category with only CAD rows is complete.
    expect(spending.incompleteCategoryIds.has(diningId)).toBe(false);
    expect(resolveCategorySpentOrNull(diningLine, spending)).toBe(30);
  });

  it("converts a JPY split line and JPY outgoing transfers the same way", async () => {
    await insertRate();
    // Split parent in JPY: -1,000 JPY Groceries (9.00 CAD) and a -2,000 JPY
    // line to the CAD savings account (18.00 CAD).
    const counterpart = await insertTransaction({
      accountId: savingsId,
      amount: 2000,
      isTransfer: true,
    });
    const parent = await insertTransaction({
      accountId: jpyAccountId,
      currencyCode: "JPY",
      amount: -3000,
      isSplit: true,
    });
    await dataSource.manager.save([
      dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        categoryId: groceriesId,
        amount: -1000,
      } as Partial<TransactionSplit>),
      dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        // A transfer line is kind TRANSFER (chk_split_kind_exclusive).
        kind: SplitKind.TRANSFER,
        transferAccountId: savingsId,
        linkedTransactionId: counterpart.id,
        amount: -2000,
      } as Partial<TransactionSplit>),
    ]);
    // Whole-row transfer: -5,000 JPY out, 5,000 JPY worth of CAD in (45.00).
    const inbound = await insertTransaction({
      accountId: savingsId,
      amount: 45,
      isTransfer: true,
    });
    const outbound = await insertTransaction({
      accountId: jpyAccountId,
      currencyCode: "JPY",
      amount: -5000,
      isTransfer: true,
      linkedTransactionId: inbound.id,
    });
    inbound.linkedTransactionId = outbound.id;
    await dataSource.manager.save(inbound);

    const spending = await runQuery();

    expect(resolveCategorySpentOrNull(groceriesLine, spending)).toBe(9);
    expect(resolveCategorySpentOrNull(transferLine, spending)).toBe(63);
    expect(spending.missingRatePairs).toEqual([]);
  });

  it("marks a transfer destination unknown when the JPY rate is missing", async () => {
    const inbound = await insertTransaction({
      accountId: savingsId,
      amount: 45,
      isTransfer: true,
    });
    const outbound = await insertTransaction({
      accountId: jpyAccountId,
      currencyCode: "JPY",
      amount: -5000,
      isTransfer: true,
      linkedTransactionId: inbound.id,
    });
    inbound.linkedTransactionId = outbound.id;
    await dataSource.manager.save(inbound);

    const spending = await runQuery();

    expect(resolveCategorySpentOrNull(transferLine, spending)).toBeNull();
    expect(spending.incompleteTransferAccountIds.has(savingsId)).toBe(true);
    expect(spending.missingRatePairs).toEqual(["JPY->CAD"]);
  });
});
