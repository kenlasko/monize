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
    expect(await read()).toMatchObject({
      data: [{ categoryId: groceries, total: -35 }],
      totalSpending: -35,
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
