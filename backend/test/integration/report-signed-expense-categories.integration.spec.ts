import { IncomeReportsService } from "@/built-in-reports/income-reports.service";
import { TaxRecurringReportsService } from "@/built-in-reports/tax-recurring-reports.service";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ReportCurrencyService } from "@/built-in-reports/report-currency.service";
import { SpendingReportsService } from "@/built-in-reports/spending-reports.service";
import { withUserContext } from "@/common/db/with-context";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

describe("signed expenses in Spending by Category (integration)", () => {
  const start = "2026-03-01";
  const end = "2026-03-31";
  let module: TestingModule;
  let db: DataSource;
  let tax: TaxRecurringReportsService;
  let income: IncomeReportsService;
  let reports: SpendingReportsService;
  let userId: string;
  let accountId: string;
  let groceries: string;
  let salary: string;

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    db = module.get(DataSource);
    const currency = new ReportCurrencyService(db, {
      getRateIndex: async () => new Map(),
    } as never);
    tax = new TaxRecurringReportsService(db, currency);
    income = new IncomeReportsService(db, currency);
    reports = new SpendingReportsService(db, currency);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(db)).id;
    accountId = (await createTestAccount(db, userId)).id;
    groceries = (await createTestCategory(db, userId, { name: "Groceries" }))
      .id;
    salary = (
      await createTestCategory(db, userId, { name: "Salary", isIncome: true })
    ).id;
  });

  async function post(amount: number, overrides: Partial<Transaction> = {}) {
    return db.manager.save(
      db.manager.create(Transaction, {
        userId,
        accountId,
        amount,
        categoryId: groceries,
        currencyCode: "USD",
        payeeName: "Co-op",
        transactionDate: "2026-03-10",
        ...overrides,
      }),
    );
  }

  function read(rollupToParent = true) {
    return withUserContext(userId, () =>
      reports.getSpendingByCategory(userId, start, end, { rollupToParent }),
    );
  }

  it.each([
    { refund: 30, expected: 70 },
    { refund: 100, expected: 0 },
    { refund: 150, expected: -50 },
  ])(
    "keeps the signed result of a 100 purchase and a $refund refund",
    async ({ refund, expected }) => {
      await post(-100);
      await post(refund);
      await post(500, { categoryId: salary });
      await post(600, { categoryId: null });
      const report = await read();
      expect(report).toMatchObject({
        data: [{ categoryId: groceries, total: expected }],
        totalSpending: expected,
        knownSpending: expected,
        excludedCount: 0,
      });
      expect(
        await withUserContext(userId, () =>
          reports.getSpendingByPayee(userId, start, end),
        ),
      ).toMatchObject({
        data: [{ payeeName: "Co-op", total: expected }],
        totalSpending: expected,
      });
      const trend = await withUserContext(userId, () =>
        reports.getMonthlySpendingTrend(userId, start, end),
      );
      expect(trend.data).toMatchObject([
        {
          month: "2026-03",
          totalSpending: expected,
          categories: [{ categoryId: groceries, total: expected }],
        },
      ]);
      expect(report.data[0].percentage).toEqual(expected > 0 ? 100 : undefined);
    },
  );

  it("retains the split refund when its purchase predates the window", async () => {
    await post(-100, { transactionDate: "2026-02-20" });
    const parent = await post(135, { categoryId: null, isSplit: true });
    await db.manager.save(TransactionSplit, [
      { transactionId: parent.id, categoryId: groceries, amount: 35 },
      { transactionId: parent.id, categoryId: salary, amount: 100 },
    ]);
    expect(
      await withUserContext(userId, () =>
        reports.getSpendingByPayee(userId, start, end),
      ),
    ).toMatchObject({
      data: [{ payeeName: "Co-op", total: -35 }],
      totalSpending: -35,
    });
    expect(await read()).toMatchObject({
      data: [{ categoryId: groceries, total: -35 }],
      totalSpending: -35,
    });
  });

  it.each([
    [100, 0],
    [150, -50],
  ])(
    "retains the source after reversing %i of 100 received",
    async (reversed, expected) => {
      await post(100, { categoryId: salary });
      await post(-reversed, { categoryId: salary });
      expect(
        await withUserContext(userId, () =>
          income.getIncomeBySource(userId, start, end),
        ),
      ).toMatchObject({
        totalIncome: expected,
        data: [{ categoryId: salary, total: expected, percentage: null }],
      });
    },
  );

  it.each([100, 150])(
    "keeps a %i refund or reversal in the assigned tax category",
    async (reversal) => {
      const medical = await createTestCategory(db, userId, { name: "Medical" });
      await post(100, { categoryId: salary });
      await post(-reversal, { categoryId: salary });
      const byPayee = () =>
        withUserContext(userId, () =>
          reports.getSpendingByPayee(userId, start, end),
        );
      expect(await read()).toMatchObject({ data: [], totalSpending: 0 });
      expect(await byPayee()).toMatchObject({ data: [], totalSpending: 0 });

      await post(-100, { categoryId: medical.id });
      await post(reversal, { categoryId: medical.id });
      await post(12, { categoryId: null });
      await post(-8, { categoryId: null });
      const net = 100 - reversal;
      const report = await withUserContext(userId, () =>
        tax.getTaxSummary(userId, 2026),
      );
      expect(report.incomeBySource).toEqual([
        { name: "Uncategorized", total: 12 },
        { name: "Salary", total: net },
      ]);
      expect(report.allExpenses).toEqual([
        { name: "Uncategorized", total: 8 },
        { name: "Medical", total: net },
      ]);
      expect(report.deductibleExpenses).toEqual([
        { name: "Medical", total: net },
      ]);
      expect(report.totals).toMatchObject({
        income: 12 + net,
        expenses: 8 + net,
        deductible: net,
      });
    },
  );

  it("classifies a split by its leaf before rolling up a legacy mixed-type tree", async () => {
    const medical = await createTestCategory(db, userId, {
      name: "Medical",
      parentId: salary,
    });
    const parent = await post(-50, { isSplit: true, categoryId: null });
    await db.manager.save(TransactionSplit, [
      { transactionId: parent.id, categoryId: medical.id, amount: -100 },
      { transactionId: parent.id, categoryId: salary, amount: 50 },
    ]);
    await post(150, { categoryId: medical.id });
    expect(await read()).toMatchObject({
      data: [{ categoryId: salary, total: -50 }],
      totalSpending: -50,
    });
    expect(
      await withUserContext(userId, () =>
        reports.getSpendingByPayee(userId, start, end),
      ),
    ).toMatchObject({
      data: [{ payeeName: "Co-op", total: -50 }],
      totalSpending: -50,
    });
    const report = await withUserContext(userId, () =>
      tax.getTaxSummary(userId, 2026),
    );
    expect(report.totals).toMatchObject({
      income: 50,
      expenses: -50,
      deductible: -50,
    });
  });

  it("uses direction for a legacy category with no type", async () => {
    await db.query("UPDATE categories SET is_income = NULL WHERE id = $1", [
      groceries,
    ]);
    await post(-100);
    await post(150);
    expect(await read()).toMatchObject({ data: [], totalSpending: 0 });
    expect(
      await withUserContext(userId, () =>
        reports.getSpendingByPayee(userId, start, end),
      ),
    ).toMatchObject({ data: [], totalSpending: 0 });
    expect(
      await withUserContext(userId, () => tax.getTaxSummary(userId, 2026)),
    ).toMatchObject({
      incomeBySource: [{ name: "Groceries", total: 50 }],
      allExpenses: [],
    });
  });

  it("reconciles expense subcategories and their parent across a net credit", async () => {
    const child = (
      await createTestCategory(db, userId, {
        name: "Produce",
        parentId: groceries,
      })
    ).id;
    await post(-20);
    await post(85, { categoryId: child });
    const detail = await read(false);
    expect(detail).toMatchObject({
      data: [
        { categoryId: groceries, total: 20 },
        { categoryId: child, total: -85 },
      ],
      totalSpending: -65,
    });
    expect(detail.data.every((row) => row.percentage === undefined)).toBe(true);
    expect(await read()).toMatchObject({
      data: [{ categoryId: groceries, total: -65 }],
      totalSpending: -65,
    });
  });
});
