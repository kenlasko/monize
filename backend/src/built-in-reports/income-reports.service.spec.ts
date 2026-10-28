jest.mock("../accruals/reporting-basis", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingBasisMockModule(),
);
jest.mock("../accruals/reporting-query", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingQueryMockModule(),
);
jest.mock("../accruals/reporting-basis.interceptor", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingInterceptorMockModule(),
);

import { DataSource } from "typeorm";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { IncomeReportsService } from "./income-reports.service";
import { ReportCurrencyService } from "./report-currency.service";
import { UNTAGGED_TAG_BUCKET_ID, IncomeExpenseTagBucket } from "./dto";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("IncomeReportsService", () => {
  let scopedManager: ManagerMock;
  let scopedDataSource: DataSourceMock;
  let service: IncomeReportsService;
  let transactionsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let userPreferenceRepository: Record<string, jest.Mock>;
  let exchangeRateService: Record<string, jest.Mock>;

  const mockUserId = "user-1";

  const mockIncomeCategory: Category = {
    id: "cat-income",
    userId: mockUserId,
    parentId: null,
    parent: null,
    children: [],
    name: "Salary",
    description: null,
    icon: null,
    color: "#5733FF",
    isIncome: true,
    autoSign: null,
    isSystem: false,
    createdAt: new Date("2025-01-03"),
  };

  const mockParentCategory: Category = {
    id: "cat-parent",
    userId: mockUserId,
    parentId: null,
    parent: null,
    children: [],
    name: "Employment",
    description: null,
    icon: null,
    color: "#FF5733",
    isIncome: true,
    autoSign: null,
    isSystem: false,
    createdAt: new Date("2025-01-01"),
  };

  const mockChildCategory: Category = {
    id: "cat-child",
    userId: mockUserId,
    parentId: "cat-parent",
    parent: null,
    children: [],
    name: "Bonuses",
    description: null,
    icon: null,
    color: "#33FF57",
    isIncome: true,
    autoSign: null,
    isSystem: false,
    createdAt: new Date("2025-01-02"),
  };

  const mockExchangeRates = [
    { fromCurrency: "EUR", toCurrency: "USD", rate: 1.1 },
    { fromCurrency: "GBP", toCurrency: "USD", rate: 1.27 },
    { fromCurrency: "USD", toCurrency: "CAD", rate: 1.36 },
  ];

  beforeEach(async () => {
    transactionsRepository = {
      query: jest.fn().mockResolvedValue([]),
    };

    categoriesRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    userPreferenceRepository = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "USD" }),
    };

    exchangeRateService = {
      getRateHistory: jest.fn().mockResolvedValue([]),
      getLatestRates: jest.fn().mockResolvedValue(mockExchangeRates),
    };

    ({ manager: scopedManager, dataSource: scopedDataSource } =
      createScopedDbMocks([
        [Transaction, transactionsRepository as never],
        [Category, categoriesRepository as never],
        [UserPreference, userPreferenceRepository as never],
      ]));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IncomeReportsService,
        ReportCurrencyService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        {
          provide: getRepositoryToken(Category),
          useValue: categoriesRepository,
        },
        {
          provide: getRepositoryToken(UserPreference),
          useValue: userPreferenceRepository,
        },
        {
          provide: ExchangeRateService,
          useValue: exchangeRateService,
        },
        { provide: DataSource, useValue: scopedDataSource },
      ],
    }).compile();

    service = module.get<IncomeReportsService>(IncomeReportsService);
  });

  // ---------------------------------------------------------------------------
  // getIncomeBySource
  // ---------------------------------------------------------------------------
  describe("getIncomeBySource", () => {
    it("returns empty data when no income transactions exist", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toEqual([]);
      expect(result.totalIncome).toBe(0);
    });

    it("sends no account predicate when accountIds is absent or empty", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getIncomeBySource(mockUserId, "2025-01-01", "2025-12-31");
      await service.getIncomeBySource(mockUserId, "2025-01-01", "2025-12-31", {
        accountIds: [],
      });

      for (const [sql, params] of scopedManager.query.mock.calls) {
        expect(sql).not.toContain("account_id = ANY");
        expect(params).toEqual([mockUserId, "2025-12-31", "2025-01-01"]);
      }
    });

    it("filters by accountIds with a parameterized uuid[] predicate and keeps every other predicate", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);
      const ids = ["a1b2c3d4-0000-4000-8000-000000000001"];

      await service.getIncomeBySource(mockUserId, "2025-01-01", "2025-12-31", {
        accountIds: ids,
      });

      const [sql, params] = scopedManager.query.mock.calls[0];
      expect(sql).toContain("AND t.account_id = ANY($4::uuid[])");
      expect(params).toEqual([mockUserId, "2025-12-31", "2025-01-01", ids]);
      expect(sql).toContain("(t.status IS NULL OR t.status != 'VOID')");
      expect(sql).toContain("t.is_transfer = false");
      expect(sql.indexOf("account_id = ANY")).toBeLessThan(
        sql.indexOf("GROUP BY"),
      );
    });

    it("numbers the account parameter $3 when there is no start date", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);
      const ids = ["a1b2c3d4-0000-4000-8000-000000000001"];

      await service.getIncomeBySource(mockUserId, undefined, "2025-12-31", {
        accountIds: ids,
      });

      const [sql, params] = scopedManager.query.mock.calls[0];
      expect(sql).toContain("AND t.account_id = ANY($3::uuid[])");
      expect(params).toEqual([mockUserId, "2025-12-31", ids]);
    });

    it("keeps subcategories separate with 'Parent: Child' name format", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-child", currency_code: "USD", total: "1000.00" },
        { category_id: "cat-parent", currency_code: "USD", total: "4000.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockParentCategory,
        mockChildCategory,
      ]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(2);
      const child = result.data.find((d) => d.categoryId === "cat-child");
      const parent = result.data.find((d) => d.categoryId === "cat-parent");
      expect(child).toBeDefined();
      expect(child!.categoryName).toBe("Employment: Bonuses");
      expect(child!.total).toBe(1000);
      expect(parent).toBeDefined();
      expect(parent!.categoryName).toBe("Employment");
      expect(parent!.total).toBe(4000);
      expect(result.totalIncome).toBe(5000);
    });

    it("skips uncategorized rows in JS (SQL already filters them out)", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: null, currency_code: "USD", total: "200.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toEqual([]);
      expect(result.totalIncome).toBe(0);
    });

    it("skips rows whose category_id is unknown", async () => {
      scopedManager.query.mockResolvedValue([
        {
          category_id: "nonexistent-id",
          currency_code: "USD",
          total: "300.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockIncomeCategory]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toEqual([]);
      expect(result.totalIncome).toBe(0);
    });

    it("converts income amounts from foreign currencies", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-income", currency_code: "GBP", total: "1000.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockIncomeCategory]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // GBP->USD rate is 1.27, so 1000 GBP = 1270 USD
      expect(result.data[0].total).toBe(1270);
    });

    it("limits results to top 15 sources", async () => {
      const rawResults = Array.from({ length: 20 }, (_, i) => ({
        category_id: `cat-inc-${i}`,
        currency_code: "USD",
        total: `${(20 - i) * 100}.00`,
      }));
      const categories: Category[] = Array.from({ length: 20 }, (_, i) => ({
        id: `cat-inc-${i}`,
        userId: mockUserId,
        parentId: null,
        parent: null,
        children: [],
        name: `Income Source ${i}`,
        description: null,
        icon: null,
        color: null,
        isIncome: true,
        autoSign: null,
        isSystem: false,
        createdAt: new Date(),
      }));
      scopedManager.query.mockResolvedValue(rawResults);
      categoriesRepository.find.mockResolvedValue(categories);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(15);
    });

    it("passes startDate parameter when provided", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getIncomeBySource(mockUserId, "2025-06-01", "2025-12-31");

      const queryCall = scopedManager.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31", "2025-06-01"]);
    });

    it("omits startDate filter when undefined", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getIncomeBySource(mockUserId, undefined, "2025-12-31");

      const queryCall = scopedManager.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31"]);
      expect(queryCall[0]).not.toContain("$3");
    });

    it("uses the subcategory's own color (does not roll up to parent)", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-child", currency_code: "USD", total: "500.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockParentCategory,
        mockChildCategory,
      ]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].categoryId).toBe("cat-child");
      expect(result.data[0].color).toBe("#33FF57");
    });

    it("merges multi-currency rows for the same subcategory", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-income", currency_code: "USD", total: "100.00" },
        { category_id: "cat-income", currency_code: "EUR", total: "200.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockIncomeCategory]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].categoryId).toBe("cat-income");
      // 100 USD + 200 EUR * 1.1 = 320
      expect(result.data[0].total).toBe(320);
    });

    it("filters by is_income = true in the SQL query (income categories only)", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getIncomeBySource(mockUserId, "2025-01-01", "2025-12-31");

      const sql = scopedManager.query.mock.calls[0][0];
      expect(sql).toContain("INNER JOIN categories c");
      expect(sql).toContain("c.is_income = true");
    });

    it("rounds totals to 2 decimal places", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-income", currency_code: "USD", total: "33.333" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockIncomeCategory]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].total).toBe(33.333);
    });

    it("filters out the asset value change category in the SQL query", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getIncomeBySource(mockUserId, "2025-01-01", "2025-12-31");

      const sql = scopedManager.query.mock.calls[0][0];
      expect(sql).toContain("NOT EXISTS");
      expect(sql).toContain("asset_category_id");
      expect(sql).toMatch(
        /ax\.asset_category_id\s*=\s*COALESCE\(ts\.category_id,\s*t\.category_id\)/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getIncomeBySource: a missing exchange rate is unknown, never 1:1 (INV-FX-001)
  // ---------------------------------------------------------------------------
  describe("getIncomeBySource with a currency that has no rate", () => {
    it("withholds the total, keeps the converted subtotal and names the currency", async () => {
      exchangeRateService.getLatestRates.mockResolvedValue([]);
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-income", currency_code: "USD", total: "50.00" },
        { category_id: "cat-parent", currency_code: "JPY", total: "100000" },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockIncomeCategory,
        mockParentCategory,
      ]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.totalIncome).toBeNull();
      expect(result.knownIncome).toBe(50);
      expect(result.currency).toBe("USD");
      expect(result.missingCurrencies).toEqual(["JPY"]);
      expect(result.excludedCount).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].total).toBe(50);
      expect(JSON.stringify(result)).not.toContain("100000");
    });

    it("answers zero, not null, when there is nothing to convert", async () => {
      scopedManager.query.mockResolvedValue([]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.totalIncome).toBe(0);
      expect(result.knownIncome).toBe(0);
      expect(result.missingCurrencies).toEqual([]);
      expect(result.excludedCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getIncomeVsExpenses
  // ---------------------------------------------------------------------------
  describe("getIncomeVsExpenses", () => {
    const row = (
      periodStart: string,
      income: string,
      expenses: string,
      currency = "USD",
    ) => ({
      period_start: periodStart,
      currency_code: currency,
      income,
      expenses,
    });

    it("returns a bar per month in the window when nothing happened", async () => {
      // A month with no rows earned and spent zero. That is a bar of height
      // zero, not a gap the chart closes up, so the window is enumerated and
      // the query's rows are placed into it.
      scopedManager.query.mockResolvedValue([]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-03-31",
      );

      expect(result.data.map((d) => d.period)).toEqual([
        "2025-01",
        "2025-02",
        "2025-03",
      ]);
      expect(result.data.every((d) => d.income === 0 && d.expenses === 0)).toBe(
        true,
      );
      expect(result.totals).toMatchObject({ income: 0, expenses: 0, net: 0 });
    });

    it("calculates income, expenses and net per bucket", async () => {
      scopedManager.query.mockResolvedValue([
        row("2025-01-01", "5000.00", "3000.00"),
        row("2025-02-01", "5000.00", "3500.00"),
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-02-28",
      );

      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toMatchObject({
        period: "2025-01",
        periodStart: "2025-01-01",
        periodEnd: "2025-01-31",
        income: 5000,
        expenses: 3000,
        net: 2000,
      });
      expect(result.totals).toMatchObject({
        income: 10000,
        expenses: 6500,
        net: 3500,
        knownIncome: 10000,
      });
      expect(result.currency).toBe("USD");
      expect(result.missingCurrencies).toEqual([]);
    });

    it("carries the dates a bar covers, so a drill-down needs no arithmetic", async () => {
      scopedManager.query.mockResolvedValue([]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-02-01",
        "2025-02-28",
      );

      expect(result.data[0].periodStart).toBe("2025-02-01");
      expect(result.data[0].periodEnd).toBe("2025-02-28");
    });

    it("merges multiple currency rows for the same bucket", async () => {
      // EUR->USD is 1.1 in the fixture rates.
      scopedManager.query.mockResolvedValue([
        row("2025-01-01", "1000.00", "500.00"),
        row("2025-01-01", "1000.00", "500.00", "EUR"),
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].income).toBe(2100);
      expect(result.data[0].expenses).toBe(1050);
    });

    it("withholds the totals and names the currency when a rate is missing", async () => {
      // JPY has no rate in the fixture. The report used to add raw yen to a
      // dollar bar, which is a wrong number rather than a missing one.
      scopedManager.query.mockResolvedValue([
        row("2025-01-01", "1000.00", "500.00"),
        row("2025-01-01", "300000.00", "100000.00", "JPY"),
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
      );

      expect(result.totals.income).toBeNull();
      expect(result.totals.expenses).toBeNull();
      expect(result.totals.net).toBeNull();
      expect(result.totals.knownIncome).toBe(1000);
      expect(result.totals.knownExpenses).toBe(500);
      expect(result.totals.knownNet).toBe(500);
      expect(result.data[0].income).toBe(1000);
      expect(result.missingCurrencies).toEqual(["JPY"]);
      expect(result.excludedCount).toBe(1);
    });

    it("handles negative net (expenses exceed income)", async () => {
      scopedManager.query.mockResolvedValue([
        row("2025-01-01", "1000.00", "1500.00"),
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
      );

      expect(result.data[0].net).toBe(-500);
      expect(result.totals.net).toBe(-500);
    });

    it("rounds every monetary value to money precision", async () => {
      // Money is decimal(20,4), so `roundMoney` keeps four places, not two.
      scopedManager.query.mockResolvedValue([
        row("2025-01-01", "1000.55555", "500.44444"),
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
      );

      expect(result.data[0].income).toBe(1000.5556);
      expect(result.data[0].expenses).toBe(500.4444);
    });

    it("passes startDate as a parameter when provided", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(mockUserId, "2025-06-01", "2025-06-30");

      const [sql, params] = scopedManager.query.mock.calls[0];
      expect(sql).toContain("t.transaction_date >= $3");
      expect(params[2]).toBe("2025-06-01");
    });

    it("omits the startDate filter when it is undefined", async () => {
      scopedManager.query.mockResolvedValue([
        row("2025-01-01", "100.00", "0.00"),
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        undefined,
        "2025-12-31",
      );

      const [sql] = scopedManager.query.mock.calls[0];
      expect(sql).not.toContain("transaction_date >=");
      // With no window there is nothing to enumerate, so the answer is the
      // buckets that actually had rows.
      expect(result.data.map((d) => d.period)).toEqual(["2025-01"]);
    });

    it("restricts the window to the requested accounts", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        {
          accountIds: ["acct-1", "acct-2"],
        },
      );

      const [sql, params] = scopedManager.query.mock.calls[0];
      expect(sql).toContain("t.account_id = ANY($4::uuid[])");
      expect(params[3]).toEqual(["acct-1", "acct-2"]);
    });

    it("adds no account filter for an empty selection", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        {
          accountIds: [],
        },
      );

      expect(scopedManager.query.mock.calls[0][0]).not.toContain(
        "account_id = ANY",
      );
    });

    it("buckets by week when asked, honouring the user's first day", async () => {
      // 2025-01-06 is a Monday. Asking for weeks starting Sunday shifts the
      // grouping, and the enumeration has to agree with it.
      scopedManager.query.mockResolvedValue([
        row("2025-01-05", "700.00", "200.00"),
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-05",
        "2025-01-18",
        { bucket: "week", weekStartsOn: 0 },
      );

      expect(result.data.map((d) => d.period)).toEqual([
        "2025-01-05",
        "2025-01-12",
      ]);
      expect(result.data[0]).toMatchObject({
        periodStart: "2025-01-05",
        periodEnd: "2025-01-11",
        income: 700,
      });
      // Sunday start: the offset that lands it on a Monday before truncation.
      const [sql, params] = scopedManager.query.mock.calls[0];
      expect(sql).toContain("date_trunc('week'");
      expect(params[2]).toBe(1);
      expect(sql).toContain("make_interval(days => $3::int)");
    });

    it("groups by month with no week shifting when the bucket is a month", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(mockUserId, "2025-01-01", "2025-01-31");

      const [sql, params] = scopedManager.query.mock.calls[0];
      expect(sql).toContain("date_trunc('month'");
      expect(sql).not.toContain("date_trunc('week'");
      // The week offset is not bound at all: PostgreSQL infers a parameter's
      // type from where it appears, so an unused one is a query that will not
      // even plan ("could not determine data type of parameter $3").
      expect(params).toEqual([mockUserId, "2025-01-31", "2025-01-01"]);
      expect(sql).not.toContain("make_interval");
    });
  });

  // ---------------------------------------------------------------------------
  // getIncomeVsExpenses -- tag-key breakdown (docs/specs/report-tag-key-breakdown.md)
  // ---------------------------------------------------------------------------
  describe("getIncomeVsExpenses tag-key breakdown", () => {
    const row = (
      periodStart: string,
      income: string,
      expenses: string,
      currency = "USD",
    ) => ({
      period_start: periodStart,
      currency_code: currency,
      income,
      expenses,
    });

    const valueRow = (
      periodStart: string,
      value: string | null,
      income: string,
      expenses: string,
      currency = "USD",
    ) => ({
      period_start: periodStart,
      currency_code: currency,
      value,
      income,
      expenses,
    });

    const flowRow = (
      value: string,
      inflow: string,
      outflow: string,
      currency = "USD",
      periodStart = "2025-01-01",
    ) => ({
      period_start: periodStart,
      value,
      currency_code: currency,
      inflow,
      outflow,
    });

    function bucketByValue(
      buckets: IncomeExpenseTagBucket[] | undefined,
      value: string,
    ) {
      const bucket = buckets?.find((b) => b.value === value);
      expect(bucket).toBeDefined();
      return bucket!;
    }

    // -- I1: opt-in is inert by default --------------------------------------

    it("adds no tagKey/buckets fields when tagKey is absent (I1 parity)", async () => {
      scopedManager.query.mockResolvedValue([
        row("2025-01-01", "1000.00", "400.00"),
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
      );

      expect(result).not.toHaveProperty("tagKey");
      expect(result).not.toHaveProperty("buckets");
      // Exactly one query -- the tag-key breakdown queries never ran.
      expect(scopedManager.query).toHaveBeenCalledTimes(1);
    });

    it("treats a blank tagKey the same as absent", async () => {
      scopedManager.query.mockResolvedValue([
        row("2025-01-01", "1000.00", "400.00"),
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        { tagKey: "   " },
      );

      expect(result).not.toHaveProperty("tagKey");
      expect(result).not.toHaveProperty("buckets");
      expect(scopedManager.query).toHaveBeenCalledTimes(1);
    });

    // -- B1-B4: value partition ------------------------------------------------

    it("partitions into value buckets plus a reserved untagged bucket; All stays the un-partitioned figure", async () => {
      scopedManager.query
        // All (unchanged base query)
        .mockResolvedValueOnce([row("2025-01-01", "1000.00", "0.00")])
        // Value/untagged breakdown -- a row tagged with BOTH household and
        // stall contributes to both (B1), so their sum can exceed All (B3).
        .mockResolvedValueOnce([
          valueRow("2025-01-01", "household", "700.00", "0.00"),
          valueRow("2025-01-01", "stall", "500.00", "0.00"),
          valueRow("2025-01-01", null, "300.00", "0.00"),
        ])
        // No tagged transfer legs in this fixture.
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        { tagKey: "scope" },
      );

      expect(result.tagKey).toBe("scope");
      // All: the base query's own answer, untouched by the value partition.
      expect(result.totals.income).toBe(1000);

      const household = bucketByValue(result.buckets, "household");
      expect(household.isUntagged).toBe(false);
      expect(household.totals.income).toBe(700);

      const stall = bucketByValue(result.buckets, "stall");
      expect(stall.totals.income).toBe(500);

      const untagged = bucketByValue(result.buckets, UNTAGGED_TAG_BUCKET_ID);
      expect(untagged.isUntagged).toBe(true);
      expect(untagged.totals.income).toBe(300);

      // B3: All is the reconciliation anchor, not the sum of the value
      // buckets, which double-count the multi-valued row.
      expect(household.totals.income! + stall.totals.income!).toBeGreaterThan(
        result.totals.income!,
      );
    });

    it("mirrors the split-tag and transaction-tag SQL shape, de-duped so a tag at both levels attributes once (B4, I7)", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        { tagKey: "scope" },
      );

      const valueSql = scopedManager.query.mock.calls[1][0];
      expect(valueSql).toContain("transaction_tags");
      expect(valueSql).toContain("transaction_split_tags");
      // UNION (not UNION ALL) de-dupes a value present at both levels; the
      // outer UNNEST fans a row out once per DISTINCT matching value, not per
      // matching tag, so two matching split tags are summed once.
      expect(valueSql).toMatch(/\bUNION\b(?!\s+ALL)/);
      expect(valueSql).toContain("ARRAY_AGG(DISTINCT");
      expect(valueSql).toContain("CROSS JOIN UNNEST");
    });

    // -- I2/I3, section 3.1/3.2: transfer visibility ---------------------------

    it("truth table 3.1: a self-transfer tagged on both legs adds nothing to income/expenses/net", async () => {
      scopedManager.query
        .mockResolvedValueOnce([]) // All: no categorized rows
        .mockResolvedValueOnce([]) // no categorized value rows either
        .mockResolvedValueOnce([
          flowRow("household", "1000.00", "1000.00"), // both legs tagged
        ])
        .mockResolvedValueOnce([]); // no split-leg transfers in this fixture

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        { tagKey: "scope" },
      );

      expect(result.totals.income).toBe(0);
      expect(result.totals.expenses).toBe(0);
      expect(result.totals.net).toBe(0);

      const household = bucketByValue(result.buckets, "household");
      expect(household.totals.income).toBe(0);
      expect(household.totals.expenses).toBe(0);
      expect(household.taggedInflows).toBe(1000);
      expect(household.taggedOutflows).toBe(1000);
    });

    it("truth table 3.2: income stays 100, never 200, when a salary is later moved through tagged transfers", async () => {
      scopedManager.query
        .mockResolvedValueOnce([row("2025-01-01", "100.00", "0.00")]) // the salary, categorized income
        .mockResolvedValueOnce([
          valueRow("2025-01-01", "household", "0.00", "0.00"),
        ])
        .mockResolvedValueOnce([
          // brokerage-side inflow leg, and the later withdrawal-into-checking leg
          flowRow("household", "100.00", "100.00"),
        ])
        .mockResolvedValueOnce([]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        { tagKey: "scope" },
      );

      expect(result.totals.income).toBe(100);

      const household = bucketByValue(result.buckets, "household");
      expect(household.totals.income).toBe(0);
      expect(household.taggedInflows).toBe(100);
      expect(household.taggedOutflows).toBe(100);
    });

    it("an untagged transfer appears nowhere (no flow row is emitted for it)", async () => {
      scopedManager.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([valueRow("2025-01-01", null, "0.00", "0.00")])
        // The untagged transfer leg produced NO row at all (CROSS JOIN UNNEST
        // of a NULL/empty tag-values array yields zero rows), unlike the
        // untagged categorized bucket above.
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        { tagKey: "scope" },
      );

      const untagged = bucketByValue(result.buckets, UNTAGGED_TAG_BUCKET_ID);
      expect(untagged.taggedInflows).toBe(0);
      expect(untagged.taggedOutflows).toBe(0);
    });

    // -- I6: VOID never contributes ---------------------------------------------

    it("keeps the VOID exclusion on both new queries", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        { tagKey: "scope" },
      );

      const valueSql = scopedManager.query.mock.calls[1][0];
      const wholeFlowSql = scopedManager.query.mock.calls[2][0];
      const splitFlowSql = scopedManager.query.mock.calls[3][0];
      expect(valueSql).toContain("t.status != 'VOID'");
      expect(wholeFlowSql).toContain("t.status != 'VOID'");
      expect(splitFlowSql).toContain("t.status != 'VOID'");
    });

    // -- I5: investment linkage exclusion (issue #1257) --------------------------

    it("keeps investmentExclusionSql on both new queries", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        { tagKey: "scope" },
      );

      const valueSql = scopedManager.query.mock.calls[1][0];
      const wholeFlowSql = scopedManager.query.mock.calls[2][0];
      const splitFlowSql = scopedManager.query.mock.calls[3][0];
      // The shared INVESTMENT_EXCLUSION (or its no-splits variant) constant,
      // which is what keeps a salary paid into an INVESTMENT-type cash sleeve
      // counted (issue #1257) while still excluding the brokerage-sleeve
      // register and the cash leg a trade generated.
      expect(valueSql).toContain("investment_transactions");
      expect(wholeFlowSql).toContain("investment_transactions");
      expect(splitFlowSql).toContain("investment_transactions");
      expect(valueSql).toContain("INVESTMENT_BROKERAGE");
      expect(wholeFlowSql).toContain("INVESTMENT_BROKERAGE");
      expect(splitFlowSql).toContain("INVESTMENT_BROKERAGE");
    });

    // -- I4: FX completeness per bucket -------------------------------------------

    it("blanks only the incomplete bucket's totals when one value's currency has no rate", async () => {
      scopedManager.query
        .mockResolvedValueOnce([]) // All
        .mockResolvedValueOnce([
          valueRow("2025-01-01", "household", "600.00", "0.00"), // USD, converts fine
          valueRow("2025-01-01", "stall", "300000.00", "0.00", "JPY"), // no JPY rate
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        { tagKey: "scope" },
      );

      const household = bucketByValue(result.buckets, "household");
      expect(household.totals.income).toBe(600);
      expect(household.missingCurrencies).toEqual([]);

      const stall = bucketByValue(result.buckets, "stall");
      expect(stall.totals.income).toBeNull();
      expect(stall.totals.knownIncome).toBe(0);
      expect(stall.missingCurrencies).toEqual(["JPY"]);
      expect(stall.excludedCount).toBe(1);
    });

    it("blanks a bucket's totals when only its tagged-flow currency has no rate", async () => {
      scopedManager.query
        .mockResolvedValueOnce([]) // All
        .mockResolvedValueOnce([
          valueRow("2025-01-01", "household", "600.00", "0.00"),
        ])
        .mockResolvedValueOnce([
          flowRow("household", "300000.00", "0.00", "JPY"), // no JPY rate
        ])
        .mockResolvedValueOnce([]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        { tagKey: "scope" },
      );

      const household = bucketByValue(result.buckets, "household");
      // The categorized income (600 USD) converted fine, but the bucket's
      // totals are still blanked: a missing rate anywhere in the bucket makes
      // its totals unknowable (I4), not just the figure that hit the gap.
      expect(household.totals.income).toBeNull();
      expect(household.totals.knownIncome).toBe(600);
      expect(household.missingCurrencies).toEqual(["JPY"]);
      expect(household.excludedCount).toBe(1);
      // The tagged flow itself is still disclosed as the known partial (0
      // here, since the only flow row was the excluded JPY one).
      expect(household.taggedInflows).toBe(0);
    });

    // -- window/account filters thread into the extra queries too ----------------

    it("threads accountIds and startDate into both extra queries", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        { tagKey: "scope", accountIds: ["acct-1"] },
      );

      const [, valueParams] = scopedManager.query.mock.calls[1];
      const [, wholeFlowParams] = scopedManager.query.mock.calls[2];
      const [, splitFlowParams] = scopedManager.query.mock.calls[3];
      expect(valueParams).toContain("2025-01-01");
      expect(valueParams).toContainEqual(["acct-1"]);
      expect(wholeFlowParams).toContain("2025-01-01");
      expect(wholeFlowParams).toContainEqual(["acct-1"]);
      expect(splitFlowParams).toContain("2025-01-01");
      expect(splitFlowParams).toContainEqual(["acct-1"]);
    });

    it("leaves out a transfer leg whose counterpart is also in accountIds, by the same parameter (spec 10.8)", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        { tagKey: "scope", accountIds: ["acct-1", "acct-2"] },
      );

      const [wholeSql, wholeParams] = scopedManager.query.mock.calls[2];
      const [splitSql, splitParams] = scopedManager.query.mock.calls[3];
      const wholeIdx = wholeParams.findIndex(
        (p: unknown) => Array.isArray(p) && p.length === 2,
      );
      const splitIdx = splitParams.findIndex(
        (p: unknown) => Array.isArray(p) && p.length === 2,
      );
      const norm = (sql: string) => sql.replace(/\s+/g, " ");

      expect(norm(wholeSql)).toContain(
        "LEFT JOIN transactions lt ON lt.id = t.linked_transaction_id",
      );
      expect(norm(wholeSql)).toContain(
        `AND (lt.id IS NULL OR NOT (lt.account_id = ANY($${wholeIdx + 1}::uuid[])))`,
      );
      expect(norm(splitSql)).toContain(
        `NOT (ts.transfer_account_id = ANY($${splitIdx + 1}::uuid[]))`,
      );
      // The array is bound once per query and reused by both predicates.
      expect(wholeParams.filter((p: unknown) => Array.isArray(p))).toHaveLength(
        1,
      );
      expect(splitParams.filter((p: unknown) => Array.isArray(p))).toHaveLength(
        1,
      );
    });

    it("emits no counterpart predicate without accountIds, so both legs count (spec 10.8)", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        { tagKey: "scope" },
      );

      const [wholeSql] = scopedManager.query.mock.calls[2];
      const [splitSql] = scopedManager.query.mock.calls[3];
      expect(wholeSql).not.toContain("linked_transaction_id");
      expect(wholeSql).not.toContain("lt.");
      expect(splitSql).not.toContain("NOT (ts.transfer_account_id");
    });

    it("bounds ONLY the flow queries by transferScopeAccountIds when accountIds is absent (spec 10.8.1)", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        { tagKey: "scope", transferScopeAccountIds: ["acct-1", "acct-2"] },
      );

      const [baseSql, baseParams] = scopedManager.query.mock.calls[0];
      const [valueSql, valueParams] = scopedManager.query.mock.calls[1];
      const [wholeSql, wholeParams] = scopedManager.query.mock.calls[2];
      const [splitSql, splitParams] = scopedManager.query.mock.calls[3];
      const norm = (sql: string) => sql.replace(/\s+/g, " ");
      const wholeIdx = wholeParams.findIndex((p: unknown) => Array.isArray(p));
      const splitIdx = splitParams.findIndex((p: unknown) => Array.isArray(p));

      // Income and expenses -- the All totals and the value buckets -- are
      // never narrowed by the boundary.
      expect(baseSql).not.toContain("t.account_id = ANY");
      expect(baseParams.some((p: unknown) => Array.isArray(p))).toBe(false);
      expect(valueSql).not.toContain("t.account_id = ANY");
      expect(valueParams.some((p: unknown) => Array.isArray(p))).toBe(false);

      // The flows read the boundary exactly as an explicit selection would.
      expect(wholeParams[wholeIdx]).toEqual(["acct-1", "acct-2"]);
      expect(norm(wholeSql)).toContain(
        "LEFT JOIN transactions lt ON lt.id = t.linked_transaction_id",
      );
      expect(norm(wholeSql)).toContain(
        `AND t.account_id = ANY($${wholeIdx + 1}::uuid[]) AND (lt.id IS NULL OR NOT (lt.account_id = ANY($${wholeIdx + 1}::uuid[])))`,
      );
      expect(splitParams[splitIdx]).toEqual(["acct-1", "acct-2"]);
      expect(norm(splitSql)).toContain(
        `AND t.account_id = ANY($${splitIdx + 1}::uuid[]) AND NOT (ts.transfer_account_id = ANY($${splitIdx + 1}::uuid[]))`,
      );
    });

    it("builds the same flow queries for transferScopeAccountIds as for the same accountIds (spec 10.8.1)", async () => {
      scopedManager.query.mockResolvedValue([]);
      const ids = ["acct-1", "acct-2"];

      await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        {
          tagKey: "scope",
          accountIds: ids,
        },
      );
      const explicit = scopedManager.query.mock.calls.slice(2, 4);
      scopedManager.query.mockClear();

      await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        {
          tagKey: "scope",
          transferScopeAccountIds: ids,
        },
      );
      const byDefault = scopedManager.query.mock.calls.slice(2, 4);

      expect(byDefault).toEqual(explicit);
    });

    it("lets a non-empty accountIds win over transferScopeAccountIds", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        {
          tagKey: "scope",
          accountIds: ["acct-1"],
          transferScopeAccountIds: ["acct-1", "acct-2"],
        },
      );

      for (const [, params] of scopedManager.query.mock.calls.slice(1, 4)) {
        expect(params).toContainEqual(["acct-1"]);
        expect(params).not.toContainEqual(["acct-1", "acct-2"]);
      }
    });

    it("treats an empty transferScopeAccountIds as no boundary (both legs count)", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        {
          tagKey: "scope",
          transferScopeAccountIds: [],
        },
      );

      const [wholeSql] = scopedManager.query.mock.calls[2];
      const [splitSql] = scopedManager.query.mock.calls[3];
      expect(wholeSql).not.toContain("linked_transaction_id");
      expect(splitSql).not.toContain("NOT (ts.transfer_account_id");
    });

    it("buckets by week and omits the startDate filter, on all three extra queries, when asked", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(mockUserId, undefined, "2025-01-31", {
        tagKey: "scope",
        bucket: "week",
      });

      const [valueSql, valueParams] = scopedManager.query.mock.calls[1];
      const [wholeFlowSql] = scopedManager.query.mock.calls[2];
      const [splitFlowSql] = scopedManager.query.mock.calls[3];

      expect(valueSql).toContain("date_trunc('week'");
      // Default weekStartsOn is Monday (1); weekTruncOffsetDays(1) === 0.
      expect(valueParams).toEqual([mockUserId, "2025-01-31", 0, "scope"]);
      for (const sql of [valueSql, wholeFlowSql, splitFlowSql]) {
        expect(sql).not.toContain("transaction_date >=");
      }
    });

    it("groups multiple rows for the same value across periods and currencies without losing any (no fan-out)", async () => {
      scopedManager.query
        .mockResolvedValueOnce([row("2025-01-01", "0.00", "0.00")])
        .mockResolvedValueOnce([
          valueRow("2025-01-01", "household", "100.00", "0.00"),
          valueRow("2025-02-01", "household", "200.00", "0.00"),
        ])
        .mockResolvedValueOnce([
          flowRow("household", "50.00", "0.00", "USD"),
          flowRow("household", "10.00", "0.00", "EUR"),
        ])
        .mockResolvedValueOnce([]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-02-28",
        { tagKey: "scope" },
      );

      const household = bucketByValue(result.buckets, "household");
      expect(household.totals.income).toBe(300);
      // EUR->USD is 1.1 in the fixture rates.
      expect(household.taggedInflows).toBe(50 + 10 * 1.1);
    });

    // -- per-period tagged flows (spec section 10) -------------------------------

    it("puts each transfer in its own period, with zero periods present, and the window totals are the sum of the periods", async () => {
      scopedManager.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          flowRow("household", "7066.00", "7066.00", "USD", "2025-01-01"),
          flowRow("household", "100.10", "0.00", "USD", "2025-03-01"),
        ])
        .mockResolvedValueOnce([
          flowRow("household", "0.20", "50.00", "USD", "2025-03-01"),
        ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-03-31",
        { tagKey: "scope" },
      );

      const household = bucketByValue(result.buckets, "household");
      expect(
        household.data.map((d) => [
          d.period,
          d.taggedInflows,
          d.taggedOutflows,
        ]),
      ).toEqual([
        ["2025-01", 7066, 7066],
        ["2025-02", 0, 0],
        ["2025-03", 100.3, 50],
      ]);
      expect(household.taggedInflows).toBe(7166.3);
      expect(household.taggedOutflows).toBe(7116);
      // Aligned with the All periods, and never folded into income/expenses/net.
      expect(household.data.map((d) => d.period)).toEqual(
        result.data.map((d) => d.period),
      );
      for (const d of household.data) {
        expect([d.income, d.expenses, d.net]).toEqual([0, 0, 0]);
      }
      // The untagged bucket still carries a zero-flow row per period.
      const untagged = bucketByValue(result.buckets, UNTAGGED_TAG_BUCKET_ID);
      expect(untagged.data.every((d) => d.taggedInflows === 0)).toBe(true);
      expect(untagged.data).toHaveLength(3);
      // The All series is untouched by flows (I2).
      expect(result.data[0]).not.toHaveProperty("taggedInflows");
    });

    it("keeps a period that only a tagged flow touched when the window has no start date", async () => {
      scopedManager.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          flowRow("household", "10.00", "0.00", "USD", "2025-02-01"),
        ])
        .mockResolvedValueOnce([]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        undefined,
        "2025-02-28",
        { tagKey: "scope" },
      );

      const household = bucketByValue(result.buckets, "household");
      expect(household.data.map((d) => d.period)).toEqual(["2025-02"]);
      expect(household.taggedInflows).toBe(10);
    });

    it("drops only the period whose flow has no rate, names the currency, and keeps the other periods", async () => {
      scopedManager.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          flowRow("household", "30.00", "0.00", "USD", "2025-01-01"),
          flowRow("household", "300000.00", "0.00", "JPY", "2025-02-01"),
        ])
        .mockResolvedValueOnce([]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-02-28",
        { tagKey: "scope" },
      );

      const household = bucketByValue(result.buckets, "household");
      expect(household.data.map((d) => d.taggedInflows)).toEqual([30, 0]);
      expect(household.taggedInflows).toBe(30);
      expect(household.missingCurrencies).toEqual(["JPY"]);
      expect(household.excludedCount).toBe(1);
      expect(household.totals.income).toBeNull();
    });

    it("groups the flow queries by the same period start as the value query, week offset included", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        {
          tagKey: "scope",
          bucket: "week",
          weekStartsOn: 0,
        },
      );

      for (const call of [2, 3]) {
        const [sql, params] = scopedManager.query.mock.calls[call];
        expect(sql).toContain("date_trunc('week'");
        expect(sql).toContain("GROUP BY tr.period_start, tv.value");
        expect(params.slice(0, 4)).toEqual([
          mockUserId,
          "2025-01-31",
          "scope",
          1,
        ]);
      }
      scopedManager.query.mockClear();
      await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        { tagKey: "scope" },
      );
      const [monthSql] = scopedManager.query.mock.calls[2];
      expect(monthSql).toContain("date_trunc('month'");
    });

    it("counts only the destination leg when accountIds excludes the investment side (truth table 10.1b)", async () => {
      // The database applies the account filter; the service must hand it to
      // both flow queries and report whatever comes back.
      scopedManager.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          flowRow("household", "7066.00", "0.00", "USD", "2025-01-01"),
        ])
        .mockResolvedValueOnce([]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-01-31",
        { tagKey: "scope", accountIds: ["checking-id"] },
      );

      for (const call of [1, 2, 3]) {
        const [sql, params] = scopedManager.query.mock.calls[call];
        expect(sql).toContain("t.account_id = ANY(");
        expect(params).toContainEqual(["checking-id"]);
      }
      const household = bucketByValue(result.buckets, "household");
      expect(household.taggedInflows).toBe(7066);
      expect(household.taggedOutflows).toBe(0);
      expect(result.totals.income).toBe(0);
      expect(result.totals.expenses).toBe(0);
      expect(result.totals.net).toBe(0);
    });
  });
});
