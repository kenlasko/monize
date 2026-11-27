import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import type { RateIndex } from "@/common/time-series/rate-index.util";
import { SplitKind } from "@/transactions/entities/split-kind.enum";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { ReportCurrencyService } from "@/built-in-reports/report-currency.service";
import { ReportsService } from "@/reports/reports.service";
import {
  CustomReport,
  DirectionFilter,
  GroupByType,
  MetricType,
  ReportCategoryType,
  ReportViewType,
  TimeframeType,
  SortDirection,
  TableColumn,
} from "@/reports/entities/custom-report.entity";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
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
 * The custom report engine against PostgreSQL (audit A26-M33, A26-L12).
 *
 * - A category's cost is its signed sum within the category: Groceries -100.00
 *   and a +30.00 refund is 70.00, the figure Spending by Category shows, never
 *   100.00 (the refund dropped) or 130.00 (the refund added).
 * - The text filter goes through the one search door, escaped once: `50%`
 *   is a literal, so it matches neither "50 Shop" nor "5000 Mart".
 */
describe("custom report: signed category sums and escaped search (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let reports: ReportsService;
  let userId: string;
  let accountId: string;
  let groceriesId: string;
  let salaryId: string;

  let rates: RateIndex = new Map();

  const START = "2026-03-01";
  const END = "2026-03-31";

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    dataSource = module.get(DataSource);
    const currency = new ReportCurrencyService(dataSource, {
      getRateIndex: async () => rates,
    } as never);
    reports = new ReportsService(
      dataSource,
      {} as never,
      { record: jest.fn() } as never,
      currency,
    );
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    rates = new Map();
    await cleanTables(dataSource, [
      "custom_reports",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    accountId = (
      await createTestAccount(dataSource, userId, {
        name: "Chequing",
        currencyCode: "USD",
      })
    ).id;
    groceriesId = (
      await createTestCategory(dataSource, userId, { name: "Groceries" })
    ).id;
    salaryId = (
      await createTestCategory(dataSource, userId, {
        name: "Salary",
        isIncome: true,
      })
    ).id;
  });

  function insertTransaction(
    overrides: Partial<Transaction>,
  ): Promise<Transaction> {
    return dataSource.manager.save(
      dataSource.manager.create(Transaction, {
        userId,
        accountId,
        transactionDate: "2026-03-10",
        amount: -100,
        currencyCode: "USD",
        status: TransactionStatus.UNRECONCILED,
        isSplit: false,
        isTransfer: false,
        ...overrides,
      } as Partial<Transaction>),
    );
  }

  async function saveReport(overrides: {
    includeTransfers?: boolean;
    groupBy?: GroupByType;
    direction?: DirectionFilter;
    categoryType?: ReportCategoryType;
    metric?: MetricType;
    filters?: CustomReport["filters"];
    startDate?: string;
    endDate?: string;
    sortBy?: TableColumn;
    sortDirection?: SortDirection;
  }) {
    return dataSource.manager.save(
      dataSource.manager.create(CustomReport, {
        userId,
        name: "Report",
        viewType: ReportViewType.TABLE,
        timeframeType: TimeframeType.CUSTOM,
        groupBy: overrides.groupBy ?? GroupByType.CATEGORY,
        filters: overrides.filters ?? {},
        config: {
          metric: overrides.metric ?? MetricType.TOTAL_AMOUNT,
          includeTransfers: overrides.includeTransfers ?? false,
          direction: overrides.direction ?? DirectionFilter.EXPENSES_ONLY,
          categoryType: overrides.categoryType,
          customStartDate: overrides.startDate ?? START,
          customEndDate: overrides.endDate ?? END,
          sortBy: overrides.sortBy,
          sortDirection: overrides.sortDirection,
        },
      } as Partial<CustomReport>),
    );
  }

  async function run(overrides: Parameters<typeof saveReport>[0]) {
    const report = await saveReport(overrides);
    return withUserContext(userId, () => reports.execute(userId, report.id));
  }

  async function insertGroceriesWithRefund(): Promise<void> {
    await insertTransaction({ categoryId: groceriesId, amount: -100 });
    await insertTransaction({
      categoryId: groceriesId,
      amount: 30,
      transactionDate: "2026-03-12",
    });
    await insertTransaction({ categoryId: salaryId, amount: 5000 });
  }

  it.each([false, true])(
    "keeps the same FX exclusions for every grouping, with split purchase = %s",
    async (splitPurchase) => {
      rates.set("EUR->USD", [{ date: "2026-01-10", rate: 1.2 }]);
      const euroAccount = await createTestAccount(dataSource, userId, {
        name: "Euros",
        currencyCode: "EUR",
      });
      await insertTransaction({ amount: -25, categoryId: groceriesId });
      const purchase = await insertTransaction({
        accountId: euroAccount.id,
        currencyCode: "EUR",
        categoryId: splitPurchase ? null : groceriesId,
        amount: splitPurchase ? -26 : -20,
        isSplit: splitPurchase,
        transactionDate: "2026-01-10",
      });
      if (splitPurchase) {
        // The second line has an independently complete currency part.
        await dataSource.getRepository(TransactionSplit).save([
          { transactionId: purchase.id, categoryId: groceriesId, amount: -20 },
          { transactionId: purchase.id, categoryId: salaryId, amount: -6 },
        ]);
      }
      const refund = await insertTransaction({
        accountId: euroAccount.id,
        currencyCode: "EUR",
        categoryId: groceriesId,
        amount: 10,
        transactionDate: "2026-12-20",
      });
      for (const [transactionId, name] of [
        [purchase.id, "Purchase"],
        [refund.id, "Refund"],
      ]) {
        const [tag] = await dataSource.query(
          "INSERT INTO tags (user_id, name) VALUES ($1,$2) RETURNING id",
          [userId, name],
        );
        await dataSource.query(
          "INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1,$2)",
          [transactionId, tag.id],
        );
      }

      for (const groupBy of Object.values(GroupByType)) {
        const result = await run({
          groupBy,
          direction: DirectionFilter.BOTH,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        const expected = splitPurchase ? -32.2 : -25;
        expect({ groupBy, ...result.summary }).toMatchObject({
          groupBy,
          total: null,
          knownTotal: expected,
        });
        expect(
          result.data.reduce((total, row) => total + Number(row.value), 0),
        ).toBeCloseTo(expected, 10);
        expect(result.missingCurrencies).toEqual(["EUR"]);
        expect(result.excludedCount).toBe(2);
      }
    },
  );

  it("nets a refund within its category for an expense report", async () => {
    await insertGroceriesWithRefund();

    const result = await run({ direction: DirectionFilter.EXPENSES_ONLY });

    expect(result.data).toEqual([
      expect.objectContaining({ id: groceriesId, value: -70 }),
    ]);
    expect(result.summary.total).toBe(-70);
  });

  it.each([
    [
      DirectionFilter.EXPENSES_ONLY,
      GroupByType.NONE,
      MetricType.NONE,
      "OUTGOING",
      "ALL",
    ],
    [
      DirectionFilter.INCOME_ONLY,
      GroupByType.NONE,
      MetricType.NONE,
      "INCOMING",
      "ALL",
    ],
    [
      DirectionFilter.EXPENSES_ONLY,
      GroupByType.CATEGORY,
      MetricType.TOTAL_AMOUNT,
      "BOTH",
      "EXPENSE",
    ],
    [
      DirectionFilter.INCOME_ONLY,
      GroupByType.NONE,
      MetricType.TOTAL_AMOUNT,
      "BOTH",
      "INCOME",
    ],
    [
      DirectionFilter.EXPENSES_ONLY,
      GroupByType.CATEGORY,
      MetricType.NONE,
      "BOTH",
      "EXPENSE",
    ],
    [DirectionFilter.BOTH, GroupByType.PAYEE, MetricType.COUNT, "BOTH", "ALL"],
  ] as const)(
    "reopens saved %s / %s / %s with independent %s and %s filters",
    async (direction, groupBy, metric, movement, categoryType) => {
      const saved = await saveReport({
        direction,
        groupBy,
        metric,
        filters: { accountIds: [accountId] },
      });
      for (let read = 0; read < 2; read++) {
        const report = await withUserContext(userId, () =>
          reports.findOne(userId, saved.id),
        );
        expect(report).toMatchObject({
          id: saved.id,
          groupBy,
          filters: saved.filters,
          config: { ...saved.config, direction: movement, categoryType },
        });
      }
    },
  );

  it("uses the database's category-grouped layout when a legacy client omits groupBy", async () => {
    const created = await withUserContext(userId, () =>
      reports.create(userId, {
        name: "Expenses",
        config: {
          metric: MetricType.NONE,
          direction: DirectionFilter.EXPENSES_ONLY,
        },
      }),
    );
    const stored = await dataSource.manager.findOneByOrFail(CustomReport, {
      id: created.id,
    });
    expect(stored).toMatchObject({
      groupBy: GroupByType.CATEGORY,
      config: {
        metric: MetricType.NONE,
        direction: DirectionFilter.BOTH,
        categoryType: ReportCategoryType.EXPENSE,
      },
    });
  });

  it("restores the historical defaults of a sparse saved report without changing its other filters", async () => {
    const report = await saveReport({ filters: { accountIds: [accountId] } });
    await dataSource
      .getRepository(CustomReport)
      .update(report.id, { config: {} });
    const reopened = await withUserContext(userId, () =>
      reports.findOne(userId, report.id),
    );
    expect(reopened.config).toEqual({
      metric: MetricType.TOTAL_AMOUNT,
      includeTransfers: false,
      direction: DirectionFilter.BOTH,
      categoryType: ReportCategoryType.EXPENSE,
    });
    expect(reopened.filters).toEqual({ accountIds: [accountId] });
  });

  it("keeps only uncategorized ordinary postings when the report includes transfers", async () => {
    const other = await createTestAccount(dataSource, userId, {
      name: "Savings",
      currencyCode: "USD",
    });
    const split = await insertTransaction({ isSplit: true, amount: -34 });
    await dataSource.manager.save(TransactionSplit, [
      { transactionId: split.id, categoryId: null, amount: -4 },
      {
        transactionId: split.id,
        kind: SplitKind.TRANSFER,
        categoryId: null,
        transferAccountId: other.id,
        amount: -10,
      },
      { transactionId: split.id, categoryId: groceriesId, amount: -20 },
    ]);
    await insertTransaction({ categoryId: null, amount: -8 });
    await insertTransaction({
      categoryId: null,
      amount: -50,
      isTransfer: true,
    });
    const result = await run({
      direction: DirectionFilter.OUTGOING,
      categoryType: ReportCategoryType.UNCATEGORIZED,
      groupBy: GroupByType.NONE,
      metric: MetricType.NONE,
      includeTransfers: true,
    });
    expect(
      result.data.map((row) => row.value).sort((a, b) => Number(a) - Number(b)),
    ).toEqual([-8, -4]);
    expect(result.summary.total).toBe(-12);
  });

  it("excludes a provisional incoming posting before converting an outgoing monthly total", async () => {
    await insertTransaction({
      categoryId: null,
      amount: 80,
      isTransfer: true,
      amountIsProvisional: true,
    });
    const options = {
      groupBy: GroupByType.MONTH,
      includeTransfers: true,
      metric: MetricType.TOTAL_AMOUNT,
    };
    const incoming = await run({
      ...options,
      direction: DirectionFilter.INCOMING,
    });
    expect(incoming.summary.total).toBe(80);
    expect(incoming.provisionalCount).toBe(1);
    const outgoing = await run({
      ...options,
      direction: DirectionFilter.OUTGOING,
    });
    expect(outgoing.data).toEqual([]);
    expect(outgoing.provisionalCount).toBe(0);
  });

  it("keeps the migrated population when changing the layout and saving again", async () => {
    const saved = await saveReport({
      direction: DirectionFilter.EXPENSES_ONLY,
      groupBy: GroupByType.CATEGORY,
      metric: MetricType.NONE,
      filters: { accountIds: [accountId] },
    });
    const expected = {
      ...saved.config,
      direction: DirectionFilter.BOTH,
      categoryType: "EXPENSE",
    };
    await withUserContext(userId, async () => {
      await reports.update(userId, saved.id, { groupBy: GroupByType.NONE });
      const reopened = await reports.findOne(userId, saved.id);
      expect(reopened).toMatchObject({
        groupBy: GroupByType.NONE,
        config: expected,
        filters: saved.filters,
      });
      await reports.update(userId, saved.id, { config: reopened.config });
    });
    const persisted = await dataSource.manager.findOneByOrFail(CustomReport, {
      id: saved.id,
    });
    expect(persisted.config).toEqual(expected);
  });

  it("selects different split postings for movement lists and classified totals", async () => {
    const mixed = await insertTransaction({ amount: 0, isSplit: true });
    await dataSource.manager.save(TransactionSplit, [
      { transactionId: mixed.id, categoryId: groceriesId, amount: -100 },
      { transactionId: mixed.id, categoryId: salaryId, amount: 100 },
    ]);
    await insertTransaction({ categoryId: groceriesId, amount: 30 });
    await insertTransaction({ categoryId: salaryId, amount: -150 });
    await insertTransaction({ categoryId: null, amount: -8 });
    const expense = await run({ direction: DirectionFilter.EXPENSES_ONLY });
    const income = await run({ direction: DirectionFilter.INCOME_ONLY });
    expect(expense.summary.total).toBe(-70);
    expect(income.summary.total).toBe(-50);
    const list = { groupBy: GroupByType.NONE, metric: MetricType.NONE };
    const outgoing = await run({
      ...list,
      direction: DirectionFilter.EXPENSES_ONLY,
    });
    const incoming = await run({
      ...list,
      direction: DirectionFilter.INCOME_ONLY,
    });
    expect(
      outgoing.data
        .map((row) => row.value)
        .sort((a, b) => Number(a) - Number(b)),
    ).toEqual([-150, -100, -8]);
    expect(
      incoming.data
        .map((row) => row.value)
        .sort((a, b) => Number(a) - Number(b)),
    ).toEqual([30, 100]);
  });

  it("reopens an existing Both / Total Amount configuration as a signed net", async () => {
    await insertGroceriesWithRefund();
    // This is the pre-change saved shape; there is no version field or re-save.
    const saved = await saveReport({
      direction: DirectionFilter.BOTH,
      sortBy: TableColumn.VALUE,
      sortDirection: SortDirection.ASC,
    });
    for (let read = 0; read < 2; read++) {
      const result = await withUserContext(userId, () =>
        reports.execute(userId, saved.id),
      );
      expect(result.data.map(({ id, value }) => [id, value])).toEqual([
        [groceriesId, -70],
        [salaryId, 5000],
      ]);
      expect(result.summary.total).toBe(4930);
    }
    expect(
      (await dataSource.manager.findOneByOrFail(CustomReport, { id: saved.id }))
        .config,
    ).toEqual(saved.config);
  });

  it.each([
    { amounts: [-700], expected: -700 },
    { amounts: [-100, 150], expected: 50 },
    { amounts: [100, -150], expected: -50 },
  ])(
    "totals the signed movements $amounts as $expected",
    async ({ amounts, expected }) => {
      const categoryId = amounts[0] > 0 ? salaryId : groceriesId;
      for (const amount of amounts)
        await insertTransaction({ categoryId, amount });
      for (const groupBy of [
        GroupByType.NONE,
        GroupByType.CATEGORY,
        GroupByType.MONTH,
      ]) {
        const result = await run({ groupBy, direction: DirectionFilter.BOTH });
        expect(result.summary.total).toBe(expected);
        expect(result.data[0].value).toBe(expected);
      }
    },
  );

  it("keeps both transactions and their signed months visible when a complete refund nets to zero", async () => {
    const debit = await insertTransaction({
      categoryId: groceriesId,
      amount: -100,
    });
    const credit = await insertTransaction({
      categoryId: groceriesId,
      amount: 100,
      transactionDate: "2026-04-10",
    });
    const execute = async (
      groupBy: GroupByType,
      metric = MetricType.TOTAL_AMOUNT,
    ) => {
      const report = await saveReport({
        groupBy,
        direction: DirectionFilter.BOTH,
        metric,
      });
      return withUserContext(userId, () =>
        reports.execute(userId, report.id, {
          timeframeType: TimeframeType.CUSTOM,
          startDate: START,
          endDate: "2026-04-30",
        }),
      );
    };
    const listed = await execute(GroupByType.NONE, MetricType.NONE);
    expect(listed.data.map(({ id, value }) => [id, value])).toEqual([
      [debit.id, -100],
      [credit.id, 100],
    ]);
    const category = await execute(GroupByType.CATEGORY);
    expect(category.data).toEqual([
      expect.objectContaining({ id: groceriesId, value: 0, count: 2 }),
    ]);
    const months = await execute(GroupByType.MONTH);
    expect(months.data.map(({ id, value }) => [id, value])).toEqual([
      ["2026-03", -100],
      ["2026-04", 100],
    ]);
    for (const result of [listed, category, months])
      expect(result.summary.total).toBe(0);
  });

  // Discussion #1978: one chronological list of both directions, each row
  // with its own sign, totalling the signed net of the rows.
  it("lists rows of both signs in date order, signed, for a BOTH list", async () => {
    await insertTransaction({
      categoryId: salaryId,
      amount: 5000,
      transactionDate: "2026-03-15",
    });
    await insertTransaction({ categoryId: groceriesId, amount: -100 });
    await insertTransaction({
      categoryId: groceriesId,
      amount: 30,
      transactionDate: "2026-03-12",
    });

    const result = await run({
      groupBy: GroupByType.NONE,
      metric: MetricType.NONE,
      direction: DirectionFilter.BOTH,
    });

    expect(result.data.map((d) => d.value)).toEqual([-100, 30, 5000]);
    expect(result.summary.total).toBe(4930);
  });

  it("nets within each category, never across two, when grouped by month", async () => {
    await insertGroceriesWithRefund();

    const result = await run({
      groupBy: GroupByType.MONTH,
      direction: DirectionFilter.EXPENSES_ONLY,
    });

    // Groceries nets to 70 of spending; Salary is income and is not netted
    // against it.
    expect(result.data).toEqual([
      expect.objectContaining({ id: "2026-03", value: -70 }),
    ]);
  });

  describe("text filter", () => {
    beforeEach(async () => {
      await insertTransaction({
        payeeName: "50 Shop",
        amount: -10,
        categoryId: groceriesId,
      });
      await insertTransaction({
        payeeName: "5000 Mart",
        amount: -20,
        categoryId: groceriesId,
      });
    });

    it("reads % in the legacy search text as a literal", async () => {
      const result = await run({
        groupBy: GroupByType.NONE,
        filters: { searchText: "50%" },
      });

      expect(result.data).toEqual([]);
    });

    it("reads % in a filter-group text condition as a literal", async () => {
      const result = await run({
        groupBy: GroupByType.NONE,
        filters: {
          filterGroups: [{ conditions: [{ field: "text", value: "50%" }] }],
        },
      });

      expect(result.data).toEqual([]);
    });

    it("still finds a plain substring", async () => {
      const result = await run({
        groupBy: GroupByType.NONE,
        filters: { searchText: "shop" },
      });

      expect(result.summary.total).toBe(-10);
    });
  });
});
