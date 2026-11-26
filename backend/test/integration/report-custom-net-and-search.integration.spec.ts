import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ReportCurrencyService } from "@/built-in-reports/report-currency.service";
import { ReportsService } from "@/reports/reports.service";
import {
  CustomReport,
  DirectionFilter,
  GroupByType,
  MetricType,
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

  const START = "2026-03-01";
  const END = "2026-03-31";

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    dataSource = module.get(DataSource);
    // Every fixture is USD, so no rate is looked up: an empty list is honest.
    const currency = new ReportCurrencyService(dataSource, {
      getRateIndex: async () => new Map(),
    } as never);
    // `execute` uses neither the budgets service nor action history.
    reports = new ReportsService(
      dataSource,
      {} as never,
      {} as never,
      currency,
    );
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
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
    groupBy?: GroupByType;
    direction?: DirectionFilter;
    metric?: MetricType;
    filters?: CustomReport["filters"];
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
          includeTransfers: false,
          direction: overrides.direction ?? DirectionFilter.EXPENSES_ONLY,
          customStartDate: START,
          customEndDate: END,
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

  it("nets a refund within its category for an expense report", async () => {
    await insertGroceriesWithRefund();

    const result = await run({ direction: DirectionFilter.EXPENSES_ONLY });

    expect(result.data).toEqual([
      expect.objectContaining({ id: groceriesId, value: 70 }),
    ]);
    expect(result.summary.total).toBe(70);
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
      expect.objectContaining({ id: "2026-03", value: 70 }),
    ]);
  });

  describe("text filter", () => {
    beforeEach(async () => {
      await insertTransaction({ payeeName: "50 Shop", amount: -10 });
      await insertTransaction({ payeeName: "5000 Mart", amount: -20 });
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

      expect(result.summary.total).toBe(10);
    });
  });
});
