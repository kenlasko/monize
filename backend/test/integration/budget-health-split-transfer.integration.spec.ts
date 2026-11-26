import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsModule } from "@/transactions/transactions.module";
import { BudgetsModule } from "@/budgets/budgets.module";
import { BudgetHealthReportsService } from "@/budgets/budget-health-reports.service";
import { Budget, BudgetType } from "@/budgets/entities/budget.entity";
import { BudgetCategory } from "@/budgets/entities/budget-category.entity";
import { getCurrentMonthPeriodDates } from "@/budgets/budget-date.utils";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { SplitKind } from "@/transactions/entities/split-kind.enum";
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
 * Budget Health's savings-rate income fallback (a budget with no income line)
 * reads a split at line grain and leaves its transfer line out
 * (docs/specs/split-line-equivalence.md rules 1, 4 and 5): money arriving from
 * another account is not income, and a mixed-sign split is not netted.
 */
describe("budget health income fallback over splits (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let health: BudgetHealthReportsService;
  let userId: string;
  let chequingId: string;
  let savingsId: string;
  let salaryId: string;
  let groceriesId: string;
  let budgetId: string;

  const { periodStart } = getCurrentMonthPeriodDates();
  const today = new Date().toLocaleDateString("en-CA");

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule, BudgetsModule]);
    dataSource = module.get(DataSource);
    health = module.get(BudgetHealthReportsService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "transaction_splits",
      "transactions",
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
    savingsId = (
      await createTestAccount(dataSource, userId, { name: "Savings" })
    ).id;
    salaryId = (
      await createTestCategory(dataSource, userId, { name: "Salary" })
    ).id;
    groceriesId = (
      await createTestCategory(dataSource, userId, { name: "Groceries" })
    ).id;
    // Only an expense line: the budget has no income line, so income takes the
    // fallback read.
    budgetId = (
      await dataSource.manager.save(
        dataSource.manager.create(Budget, {
          userId,
          name: "Month",
          budgetType: BudgetType.MONTHLY,
          periodStart,
          currencyCode: "CAD",
          config: {},
        } as Partial<Budget>),
      )
    ).id;
    await dataSource.manager.save(
      dataSource.manager.create(BudgetCategory, {
        budgetId,
        categoryId: groceriesId,
        amount: 500,
        isIncome: false,
        isTransfer: false,
      } as Partial<BudgetCategory>),
    );
  });

  async function insertTransaction(
    overrides: Partial<Transaction>,
  ): Promise<Transaction> {
    return dataSource.manager.save(
      dataSource.manager.create(Transaction, {
        userId,
        accountId: chequingId,
        transactionDate: today,
        amount: 0,
        currencyCode: "CAD",
        status: TransactionStatus.UNRECONCILED,
        isSplit: false,
        isTransfer: false,
        ...overrides,
      } as Partial<Transaction>),
    );
  }

  async function insertCategoryLine(
    transactionId: string,
    categoryId: string,
    amount: number,
  ): Promise<void> {
    await dataSource.manager.save(
      dataSource.manager.create(TransactionSplit, {
        transactionId,
        categoryId,
        amount,
      } as Partial<TransactionSplit>),
    );
  }

  const income = async () => {
    const points = await withUserContext(userId, () =>
      health.getSavingsRate(userId, budgetId, 1),
    );
    return points[points.length - 1].income;
  };

  it("leaves a positive split transfer line out of income", async () => {
    const parent = await insertTransaction({ amount: 600, isSplit: true });
    const counterpart = await insertTransaction({
      accountId: savingsId,
      amount: -500,
      isTransfer: true,
    });
    await insertCategoryLine(parent.id, salaryId, 100);
    await dataSource.manager.save(
      dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        kind: SplitKind.TRANSFER,
        transferAccountId: savingsId,
        linkedTransactionId: counterpart.id,
        amount: 500,
      } as Partial<TransactionSplit>),
    );

    expect(await income()).toBe(100);
  });

  it("reads a mixed-sign split per line, not by its net", async () => {
    const parent = await insertTransaction({ amount: 40, isSplit: true });
    await insertCategoryLine(parent.id, groceriesId, -60);
    await insertCategoryLine(parent.id, salaryId, 100);

    expect(await income()).toBe(100);
  });

  it("leaves an embedded investment line out of income", async () => {
    // A SELL's cash side inside a chequing split is liquidated investment,
    // not income; at line grain it would otherwise count in full.
    const parent = await insertTransaction({ amount: 400, isSplit: true });
    await insertCategoryLine(parent.id, groceriesId, -100);
    await dataSource.manager.save(
      dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        kind: SplitKind.INVESTMENT,
        amount: 500,
      } as Partial<TransactionSplit>),
    );

    expect(await income()).toBe(0);
  });

  it("still counts a whole-row deposit", async () => {
    await insertTransaction({ amount: 250 });

    expect(await income()).toBe(250);
  });
});
