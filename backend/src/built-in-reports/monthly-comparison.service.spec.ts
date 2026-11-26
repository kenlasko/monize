import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { MonthlyComparisonService } from "./monthly-comparison.service";
import { SpendingReportsService } from "./spending-reports.service";
import { IncomeReportsService } from "./income-reports.service";
import { ReportCurrencyService } from "./report-currency.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { PortfolioService } from "../securities/portfolio.service";
import {
  PortfolioPeriodResult,
  PortfolioPeriodResultService,
} from "../net-worth/portfolio-period-result.service";
import { UserPreference } from "../users/entities/user-preference.entity";
import { FxAggregate } from "../common/fx-aggregate";
import { todayYMD } from "../common/date-utils";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";
import { reportPlacesMock } from "../test-helpers/report-rate-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const mockUserId = "user-1";
const mockMonth = "2026-01";

const mockIncomeVsExpensesCurrentResponse = {
  data: [{ period: "2026-01", income: 5000, expenses: 3000, net: 2000 }],
  totals: { income: 5000, expenses: 3000, net: 2000 },
};

const mockIncomeVsExpensesPreviousResponse = {
  data: [{ period: "2025-12", income: 4500, expenses: 3500, net: 1000 }],
  totals: { income: 4500, expenses: 3500, net: 1000 },
};

const mockCurrentSpending = {
  data: [
    {
      categoryId: "cat-1",
      categoryName: "Groceries",
      color: "#ff0000",
      total: 800,
    },
    {
      categoryId: "cat-2",
      categoryName: "Utilities",
      color: "#00ff00",
      total: 400,
    },
    {
      categoryId: "cat-3",
      categoryName: "Rent",
      color: "#0000ff",
      total: 1500,
    },
    {
      categoryId: "cat-4",
      categoryName: "Transport",
      color: "#ffff00",
      total: 200,
    },
    {
      categoryId: "cat-5",
      categoryName: "Entertainment",
      color: "#ff00ff",
      total: 100,
    },
  ],
  totalSpending: 3000,
  knownSpending: 3000,
};

const mockPreviousSpending = {
  data: [
    {
      categoryId: "cat-1",
      categoryName: "Groceries",
      color: "#ff0000",
      total: 700,
    },
    {
      categoryId: "cat-2",
      categoryName: "Utilities",
      color: "#00ff00",
      total: 350,
    },
    {
      categoryId: "cat-3",
      categoryName: "Rent",
      color: "#0000ff",
      total: 1500,
    },
    {
      categoryId: "cat-6",
      categoryName: "Insurance",
      color: "#aabbcc",
      total: 200,
    },
  ],
  totalSpending: 2750,
  knownSpending: 2750,
};

const completeMonth = {
  fxComplete: true,
  missingRatePairs: [] as string[],
  assetsFxComplete: true,
  liabilitiesFxComplete: true,
};

const mockNetWorthHistory = [
  {
    month: "2025-02-01",
    assets: 50000,
    liabilities: 10000,
    netWorth: 40000,
    ...completeMonth,
  },
  {
    month: "2025-03-01",
    assets: 51000,
    liabilities: 10000,
    netWorth: 41000,
    ...completeMonth,
  },
  {
    month: "2025-12-01",
    assets: 60000,
    liabilities: 10000,
    netWorth: 50000,
    ...completeMonth,
  },
  {
    month: "2026-01-01",
    assets: 62000,
    liabilities: 10000,
    netWorth: 52000,
    ...completeMonth,
  },
];

const mockTopMovers = [
  {
    securityId: "sec-1",
    symbol: "AAPL",
    name: "Apple Inc.",
    currentPrice: 195.5,
    previousPrice: 190.0,
    dailyChange: 5.5,
    dailyChangePercent: 2.89,
    marketValue: 19550,
  },
];

/** An aggregate of the given components, each already converted. */
const aggregateOf = (...components: number[]): FxAggregate => {
  const aggregate = new FxAggregate();
  for (const component of components) aggregate.addConverted(component);
  return aggregate;
};

/**
 * What `getIncomeVsExpensesWithAggregates` answers for a response: each
 * period's income and expenses as an aggregate of the figure it shows.
 */
const withIncomeAggregates = <
  T extends { data: { period: string; income: number; expenses: number }[] },
>(
  response: T,
) => ({
  response,
  periods: new Map(
    response.data.map((d) => [
      d.period,
      { income: aggregateOf(d.income), expenses: aggregateOf(d.expenses) },
    ]),
  ),
});

/**
 * One month whose exact income and expenses are the given components, its
 * figures read at CAD's two places as the report reads them (issue #2410).
 */
const incomeMonth = (
  period: string,
  income: number[],
  expenses: number[] = [],
) => {
  const aggregates = {
    income: aggregateOf(...income),
    expenses: aggregateOf(...expenses),
  };
  return {
    response: {
      data: [
        {
          period,
          income: aggregates.income.knownSubtotalAt(2),
          expenses: aggregates.expenses.knownSubtotalAt(2),
          net: FxAggregate.difference(
            aggregates.income,
            aggregates.expenses,
          ).knownSubtotalAt(2),
        },
      ],
    },
    periods: new Map([[period, aggregates]]),
  };
};

/**
 * What `getSpendingByCategoryWithAggregates` answers for a response: each
 * listed category's aggregate of the figure it shows.
 */
const withSpendingAggregates = <
  T extends { data: { categoryId: string | null; total: number }[] },
>(
  response: T,
) => ({
  response,
  categories: new Map(
    response.data.map((c) => [c.categoryId, aggregateOf(c.total)]),
  ),
});

/** One window whose categories' exact spends are the given components, read at two places. */
const spendingWindow = (categories: Record<string, number[]>) => {
  const aggregates = new Map(
    Object.entries(categories).map(([id, parts]) => [
      id,
      aggregateOf(...parts),
    ]),
  );
  const data = [...aggregates].map(([categoryId, aggregate]) => ({
    categoryId,
    categoryName: categoryId,
    color: null,
    total: aggregate.knownSubtotalAt(2),
  }));
  const knownSpending = FxAggregate.sum(aggregates.values()).knownSubtotalAt(2);
  return {
    response: { data, totalSpending: knownSpending, knownSpending },
    categories: aggregates,
  };
};

/** `getMonthlyNetWorthWithAggregates` for months whose net worth is exact. */
const withNetWorthAggregates = <T extends { netWorth: number }>(months: T[]) =>
  months.map((m) => ({ ...m, netWorthAggregate: aggregateOf(m.netWorth) }));

describe("MonthlyComparisonService", () => {
  let scopedManager: ManagerMock;
  let scopedDataSource: DataSourceMock;
  let service: MonthlyComparisonService;
  let mockSpendingReports: Record<string, jest.Mock>;
  let mockIncomeReports: Record<string, jest.Mock>;
  let mockCurrencyService: Record<string, jest.Mock>;
  let mockNetWorthService: Record<string, jest.Mock>;
  let mockPortfolioService: Record<string, jest.Mock>;
  let mockPeriodResultService: Record<string, jest.Mock>;
  let mockAccountsRepo: Record<string, jest.Mock>;
  let mockUserPreferenceRepo: Record<string, jest.Mock>;
  let mockDataSource: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockSpendingReports = {
      getSpendingByCategoryWithAggregates: jest.fn(),
    };
    mockIncomeReports = {
      getIncomeVsExpensesWithAggregates: jest.fn(),
    };
    mockCurrencyService = {
      getDefaultCurrency: jest.fn().mockResolvedValue("CAD"),
      getReportPlaces: reportPlacesMock(),
    };
    mockNetWorthService = {
      getMonthlyNetWorthWithAggregates: jest.fn(),
    };
    mockPortfolioService = {
      getMonthOverMonthMovers: jest.fn(),
    };
    mockPeriodResultService = {
      getPeriodResult: jest.fn(),
    };
    mockAccountsRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    // The generated notes are addressed to this user, so the service reads
    // their number-format preference to render the figures in it (issue #1316).
    mockUserPreferenceRepo = {
      findOne: jest.fn().mockResolvedValue({
        userId: mockUserId,
        numberFormat: "en-US",
        language: "en",
      }),
    };
    // The snapshot query now runs through the scoped transaction's manager;
    // the spec keeps asserting against this mock.
    mockDataSource = { query: jest.fn().mockResolvedValue([]) };

    ({ manager: scopedManager, dataSource: scopedDataSource } =
      createScopedDbMocks([
        [Account, mockAccountsRepo as never],
        [UserPreference, mockUserPreferenceRepo as never],
      ]));
    scopedManager.query.mockImplementation((sql: string, params?: unknown[]) =>
      mockDataSource.query(sql, params),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonthlyComparisonService,
        { provide: SpendingReportsService, useValue: mockSpendingReports },
        { provide: IncomeReportsService, useValue: mockIncomeReports },
        { provide: ReportCurrencyService, useValue: mockCurrencyService },
        { provide: NetWorthService, useValue: mockNetWorthService },
        { provide: PortfolioService, useValue: mockPortfolioService },
        {
          provide: PortfolioPeriodResultService,
          useValue: mockPeriodResultService,
        },
        { provide: getRepositoryToken(Account), useValue: mockAccountsRepo },
        { provide: DataSource, useValue: scopedDataSource },
      ],
    }).compile();

    service = module.get<MonthlyComparisonService>(MonthlyComparisonService);
  });

  describe("getMonthlyComparison()", () => {
    beforeEach(() => {
      mockIncomeReports.getIncomeVsExpensesWithAggregates
        .mockResolvedValueOnce(
          withIncomeAggregates(mockIncomeVsExpensesCurrentResponse),
        )
        .mockResolvedValueOnce(
          withIncomeAggregates(mockIncomeVsExpensesPreviousResponse),
        );
      mockSpendingReports.getSpendingByCategoryWithAggregates
        .mockResolvedValueOnce(withSpendingAggregates(mockCurrentSpending))
        .mockResolvedValueOnce(withSpendingAggregates(mockPreviousSpending));
      mockNetWorthService.getMonthlyNetWorthWithAggregates.mockResolvedValue(
        withNetWorthAggregates(mockNetWorthHistory),
      );
      mockPortfolioService.getMonthOverMonthMovers.mockResolvedValue(
        mockTopMovers,
      );
    });

    it("returns correct currentMonth and previousMonth strings", async () => {
      const result = await service.getMonthlyComparison(mockUserId, mockMonth);

      expect(result.currentMonth).toBe("2026-01");
      expect(result.previousMonth).toBe("2025-12");
    });

    it("returns correct month labels", async () => {
      const result = await service.getMonthlyComparison(mockUserId, mockMonth);

      expect(result.currentMonthLabel).toBe("January 2026");
      expect(result.previousMonthLabel).toBe("December 2025");
    });

    it("returns user's default currency", async () => {
      const result = await service.getMonthlyComparison(mockUserId, mockMonth);

      expect(result.currency).toBe("CAD");
      expect(mockCurrencyService.getDefaultCurrency).toHaveBeenCalledWith(
        mockUserId,
      );
    });

    it("computes income/expenses values and deltas correctly", async () => {
      const result = await service.getMonthlyComparison(mockUserId, mockMonth);

      const ie = result.incomeExpenses;
      expect(ie.currentIncome).toBe(5000);
      expect(ie.previousIncome).toBe(4500);
      expect(ie.incomeChange).toBe(500);
      expect(ie.incomeChangePercent).toBeCloseTo(11.11, 1);

      expect(ie.currentExpenses).toBe(3000);
      expect(ie.previousExpenses).toBe(3500);
      expect(ie.expensesChange).toBe(-500);
      expect(ie.expensesChangePercent).toBeCloseTo(-14.29, 1);

      expect(ie.currentSavings).toBe(2000);
      expect(ie.previousSavings).toBe(1000);
      expect(ie.savingsChange).toBe(1000);
      expect(ie.savingsChangePercent).toBe(100);
    });

    it("builds summary notes with explicit month names and currency symbols", async () => {
      const result = await service.getMonthlyComparison(mockUserId, mockMonth);

      expect(result.notes.savingsNote).toContain("January 2026");
      expect(result.notes.savingsNote).toContain("December 2025");
      expect(result.notes.savingsNote).toContain("more");
      // Should use currency symbol ($) via Intl.NumberFormat, not currency code
      expect(result.notes.savingsNote).toContain("$");

      expect(result.notes.incomeNote).toContain("January 2026");
      expect(result.notes.incomeNote).not.toContain("this month");
      expect(result.notes.incomeNote).toContain("$");
      expect(result.notes.incomeNote).toContain("more");
    });

    it("merges category spending from both months into comparison table", async () => {
      const result = await service.getMonthlyComparison(mockUserId, mockMonth);

      const comparison = result.expenses.comparison;
      // All unique categories: 6 (5 current + 1 only in previous: Insurance)
      expect(comparison.length).toBe(6);

      // Groceries present in both months
      const groceries = comparison.find((c) => c.categoryName === "Groceries");
      expect(groceries).toBeDefined();
      expect(groceries!.currentTotal).toBe(800);
      expect(groceries!.previousTotal).toBe(700);
      expect(groceries!.change).toBe(100);

      // Insurance only in previous month
      const insurance = comparison.find((c) => c.categoryName === "Insurance");
      expect(insurance).toBeDefined();
      expect(insurance!.currentTotal).toBe(0);
      expect(insurance!.previousTotal).toBe(200);

      // Transport only in current month
      const transport = comparison.find((c) => c.categoryName === "Transport");
      expect(transport).toBeDefined();
      expect(transport!.currentTotal).toBe(200);
      expect(transport!.previousTotal).toBe(0);
    });

    it("comparison table is sorted by currentTotal descending", async () => {
      const result = await service.getMonthlyComparison(mockUserId, mockMonth);

      const totals = result.expenses.comparison.map((c) => c.currentTotal);
      for (let i = 1; i < totals.length; i++) {
        expect(totals[i]).toBeLessThanOrEqual(totals[i - 1]);
      }
    });

    it("computes expense totals", async () => {
      const result = await service.getMonthlyComparison(mockUserId, mockMonth);

      expect(result.expenses.currentTotal).toBe(3000);
      expect(result.expenses.previousTotal).toBe(2750);
    });

    it("returns top 5 categories for each month", async () => {
      const result = await service.getMonthlyComparison(mockUserId, mockMonth);

      expect(result.topCategories.currentMonth.length).toBe(5);
      expect(result.topCategories.previousMonth.length).toBe(4); // only 4 categories in previous
    });

    it("builds net worth section with history and delta", async () => {
      const result = await service.getMonthlyComparison(mockUserId, mockMonth);

      expect(result.netWorth.monthlyHistory.length).toBe(4);
      expect(result.netWorth.currentNetWorth).toBe(52000);
      expect(result.netWorth.previousNetWorth).toBe(50000);
      expect(result.netWorth.netWorthChange).toBe(2000);
      expect(result.netWorth.netWorthChangePercent).toBe(4);
      expect(result.netWorth.knownCurrentNetWorth).toBe(52000);
      expect(result.netWorth.knownPreviousNetWorth).toBe(50000);
      expect(result.netWorth.fxComplete).toBe(true);
      expect(result.netWorth.missingRatePairs).toEqual([]);
      expect(result.netWorth.monthlyHistory[0]).toEqual({
        month: "2025-02-01",
        netWorth: 40000,
        fxComplete: true,
        missingRatePairs: [],
      });
    });

    it("withholds the net worth and its change when one compared month has no rate", async () => {
      mockNetWorthService.getMonthlyNetWorthWithAggregates.mockResolvedValue(
        withNetWorthAggregates([
          mockNetWorthHistory[2],
          {
            ...mockNetWorthHistory[3],
            fxComplete: false,
            missingRatePairs: ["ZZZ->USD"],
            assetsFxComplete: false,
          },
        ]),
      );

      const result = await service.getMonthlyComparison(mockUserId, mockMonth);

      expect(result.netWorth.currentNetWorth).toBeNull();
      expect(result.netWorth.knownCurrentNetWorth).toBe(52000);
      expect(result.netWorth.previousNetWorth).toBe(50000);
      expect(result.netWorth.knownPreviousNetWorth).toBe(50000);
      expect(result.netWorth.netWorthChange).toBeNull();
      expect(result.netWorth.netWorthChangePercent).toBeNull();
      expect(result.netWorth.fxComplete).toBe(false);
      expect(result.netWorth.missingRatePairs).toEqual(["ZZZ->USD"]);
      // The history point keeps its own flags.
      expect(result.netWorth.monthlyHistory[1]).toMatchObject({
        fxComplete: false,
        missingRatePairs: ["ZZZ->USD"],
      });
    });

    it("maps top movers correctly", async () => {
      const result = await service.getMonthlyComparison(mockUserId, mockMonth);

      expect(result.investments.topMovers.length).toBe(1);
      const mover = result.investments.topMovers[0];
      expect(mover.symbol).toBe("AAPL");
      expect(mover.change).toBe(5.5);
      expect(mover.changePercent).toBe(2.89);
    });

    it("fetches correct date ranges for income/expenses", async () => {
      await service.getMonthlyComparison(mockUserId, mockMonth);

      // Current month
      expect(
        mockIncomeReports.getIncomeVsExpensesWithAggregates,
      ).toHaveBeenCalledWith(mockUserId, "2026-01-01", "2026-01-31");
      // Previous month
      expect(
        mockIncomeReports.getIncomeVsExpensesWithAggregates,
      ).toHaveBeenCalledWith(mockUserId, "2025-12-01", "2025-12-31");
    });

    it("fetches spending with rollupToParent false", async () => {
      await service.getMonthlyComparison(mockUserId, mockMonth);

      expect(
        mockSpendingReports.getSpendingByCategoryWithAggregates,
      ).toHaveBeenCalledWith(mockUserId, "2026-01-01", "2026-01-31", {
        rollupToParent: false,
      });
      expect(
        mockSpendingReports.getSpendingByCategoryWithAggregates,
      ).toHaveBeenCalledWith(mockUserId, "2025-12-01", "2025-12-31", {
        rollupToParent: false,
      });
    });

    it("fetches month-over-month movers with both month-end dates", async () => {
      await service.getMonthlyComparison(mockUserId, mockMonth);

      expect(mockPortfolioService.getMonthOverMonthMovers).toHaveBeenCalledWith(
        mockUserId,
        "2026-01-31",
        "2025-12-31",
      );
    });

    it("fetches 12-month net worth history", async () => {
      await service.getMonthlyComparison(mockUserId, mockMonth);

      expect(
        mockNetWorthService.getMonthlyNetWorthWithAggregates,
      ).toHaveBeenCalledWith(
        mockUserId,
        "2025-01-01", // 13 months back from Jan 2026 (monthNum - 13)
        "2026-01-31",
      );
    });
  });

  describe("getMonthlyComparison() - figures rounded once (issues #2384, #2410)", () => {
    beforeEach(() => {
      mockNetWorthService.getMonthlyNetWorthWithAggregates.mockResolvedValue(
        withNetWorthAggregates([]),
      );
      mockPortfolioService.getMonthOverMonthMovers.mockResolvedValue([]);
    });

    it("reads a month's savings as its own net and its expense total as reported", async () => {
      // 1.2474 in and 0.0049896 out net 1.24, though the sides read 1.25
      // and 0.00; two 1.2474 categories total 2.49, though their rows read
      // 1.25 each.
      mockIncomeReports.getIncomeVsExpensesWithAggregates
        .mockResolvedValueOnce(incomeMonth("2026-01", [1.2474], [0.0049896]))
        .mockResolvedValueOnce(incomeMonth("2025-12", []));
      mockSpendingReports.getSpendingByCategoryWithAggregates
        .mockResolvedValueOnce(
          spendingWindow({ "cat-1": [1.2474], "cat-2": [1.2474] }),
        )
        .mockResolvedValueOnce(spendingWindow({}));

      const result = await service.getMonthlyComparison(mockUserId, "2026-01");

      expect(result.incomeExpenses.currentIncome).toBe(1.25);
      expect(result.incomeExpenses.currentExpenses).toBe(0);
      expect(result.incomeExpenses.currentSavings).toBe(1.24);
      expect(result.incomeExpenses.savingsChange).toBe(1.24);
      expect(result.expenses.currentTotal).toBe(2.49);
      expect(result.expenses.comparison.map((c) => c.currentTotal)).toEqual([
        1.25, 1.25,
      ]);
    });

    it("leaves no float residue in a change", async () => {
      // 5000.12 - 3000.57 is 1999.5499999999997 in doubles.
      mockIncomeReports.getIncomeVsExpensesWithAggregates
        .mockResolvedValueOnce(
          withIncomeAggregates({
            data: [
              {
                period: "2026-01",
                income: 5000.12,
                expenses: 0,
                net: 5000.12,
              },
            ],
            totals: { income: 5000.12, expenses: 0, net: 5000.12 },
          }),
        )
        .mockResolvedValueOnce(
          withIncomeAggregates({
            data: [
              {
                period: "2025-12",
                income: 3000.57,
                expenses: 0,
                net: 3000.57,
              },
            ],
            totals: { income: 3000.57, expenses: 0, net: 3000.57 },
          }),
        );
      mockSpendingReports.getSpendingByCategoryWithAggregates.mockResolvedValue(
        withSpendingAggregates({
          data: [],
          totalSpending: 0,
          knownSpending: 0,
        }),
      );

      const result = await service.getMonthlyComparison(mockUserId, "2026-01");

      expect(result.incomeExpenses.incomeChange).toBe(1999.55);
      expect(result.incomeExpenses.savingsChange).toBe(1999.55);
    });
  });

  describe("getMonthlyComparison() - each change from the two months' aggregates (issue #2407)", () => {
    // Exact figures of 100.005 and 50.004 read 100.01 and 50.00, so the
    // difference of the readings is 50.01; the exact change, 50.001, reads
    // 50.00.
    beforeEach(() => {
      mockNetWorthService.getMonthlyNetWorthWithAggregates.mockResolvedValue(
        [],
      );
      mockPortfolioService.getMonthOverMonthMovers.mockResolvedValue([]);
      mockSpendingReports.getSpendingByCategoryWithAggregates.mockResolvedValue(
        spendingWindow({}),
      );
    });

    it.each([
      {
        figure: "income",
        current: incomeMonth("2026-01", [100.005]),
        previous: incomeMonth("2025-12", [50.004]),
        shown: ["currentIncome", "previousIncome"],
        change: "incomeChange",
      },
      {
        figure: "expenses",
        current: incomeMonth("2026-01", [], [100.005]),
        previous: incomeMonth("2025-12", [], [50.004]),
        shown: ["currentExpenses", "previousExpenses"],
        change: "expensesChange",
      },
      {
        // 150.005 less 50 and 100.004 less 50: the savings themselves read
        // 100.01 and 50.00.
        figure: "savings",
        current: incomeMonth("2026-01", [150.005], [50]),
        previous: incomeMonth("2025-12", [100.004], [50]),
        shown: ["currentSavings", "previousSavings"],
        change: "savingsChange",
      },
    ] as const)(
      "reads the $figure change once from the exact change",
      async ({ current, previous, shown, change }) => {
        mockIncomeReports.getIncomeVsExpensesWithAggregates
          .mockResolvedValueOnce(current)
          .mockResolvedValueOnce(previous);

        const result = await service.getMonthlyComparison(
          mockUserId,
          "2026-01",
        );

        const ie = result.incomeExpenses;
        expect([ie[shown[0]], ie[shown[1]]]).toEqual([100.01, 50]);
        expect(ie[change]).toBe(50);
      },
    );

    it("reads a category's change once from the exact change", async () => {
      mockSpendingReports.getSpendingByCategoryWithAggregates
        .mockReset()
        .mockResolvedValueOnce(
          spendingWindow({ "cat-1": [100.005], "cat-2": [0.026] }),
        )
        .mockResolvedValueOnce(
          spendingWindow({
            "cat-1": [50.004],
            "cat-2": [0.014],
            "cat-3": [0.005],
          }),
        );
      mockIncomeReports.getIncomeVsExpensesWithAggregates.mockResolvedValue(
        incomeMonth("2026-01", []),
      );

      const result = await service.getMonthlyComparison(mockUserId, "2026-01");

      const byId = new Map(
        result.expenses.comparison.map((c) => [c.categoryId, c]),
      );
      expect(byId.get("cat-1")).toMatchObject({
        currentTotal: 100.01,
        previousTotal: 50,
        change: 50,
      });
      // 0.026 against 0.014 read 0.03 and 0.01: the readings make the change
      // 200%, the exact values 85.71% (rule 8).
      expect(byId.get("cat-2")).toMatchObject({
        currentTotal: 0.03,
        previousTotal: 0.01,
        change: 0.01,
        changePercent: 85.71,
      });
      // A category only the previous month listed fell by all of it.
      expect(byId.get("cat-3")).toMatchObject({
        currentTotal: 0,
        previousTotal: 0.01,
        change: -0.01,
        changePercent: -100,
      });
    });

    it.each([
      [-10, 90],
      [-42, 0],
    ])(
      "withholds category growth from a credit of %d to %d",
      async (previous, current) => {
        mockSpendingReports.getSpendingByCategoryWithAggregates
          .mockReset()
          .mockResolvedValueOnce(spendingWindow({ clothing: [current] }))
          .mockResolvedValueOnce(spendingWindow({ clothing: [previous] }));
        mockIncomeReports.getIncomeVsExpensesWithAggregates.mockResolvedValue(
          incomeMonth("2026-01", []),
        );
        const { expenses } = await service.getMonthlyComparison(
          mockUserId,
          "2026-01",
        );
        expect(expenses.comparison[0]).toMatchObject({
          previousTotal: previous,
          currentTotal: current,
          change: current - previous,
          changePercent: null,
        });
      },
    );

    it("preserves signed snapshots and withholds the change percentage for a new net credit", async () => {
      const previous = spendingWindow({ food: [10] });
      const current = spendingWindow({ refund: [-20], food: [60] });
      mockSpendingReports.getSpendingByCategoryWithAggregates
        .mockReset()
        .mockResolvedValueOnce({
          ...current,
          response: { ...current.response, netSpending: true },
        })
        .mockResolvedValueOnce({
          ...previous,
          response: {
            ...previous.response,
            netSpending: true,
            data: previous.response.data.map((row) => ({
              ...row,
              percentage: 100,
            })),
          },
        });
      mockIncomeReports.getIncomeVsExpensesWithAggregates.mockResolvedValue(
        incomeMonth("2026-01", []),
      );
      const { expenses } = await service.getMonthlyComparison(
        mockUserId,
        "2026-01",
      );
      expect(expenses.netSpending).toBe(true);
      expect(expenses.currentMonth).toEqual(current.response.data);
      expect(expenses.previousMonth[0].percentage).toBe(100);
      expect(expenses.currentTotal).toBe(40);
      expect(
        expenses.comparison.find((c) => c.categoryId === "refund"),
      ).toMatchObject({
        currentTotal: -20,
        previousTotal: 0,
        change: -20,
        changePercent: null,
      });
    });

    it("reads the net worth change once from the exact change", async () => {
      const month = (date: string, exact: number) => {
        const netWorthAggregate = aggregateOf(exact);
        return {
          month: date,
          assets: netWorthAggregate.knownSubtotalAt(2),
          liabilities: 0,
          netWorth: netWorthAggregate.knownSubtotalAt(2),
          netWorthAggregate,
          ...completeMonth,
        };
      };
      mockNetWorthService.getMonthlyNetWorthWithAggregates.mockResolvedValue([
        month("2025-12-01", 50.004),
        month("2026-01-01", 100.005),
      ]);
      mockIncomeReports.getIncomeVsExpensesWithAggregates.mockResolvedValue(
        incomeMonth("2026-01", []),
      );

      const result = await service.getMonthlyComparison(mockUserId, "2026-01");

      expect(result.netWorth.currentNetWorth).toBe(100.01);
      expect(result.netWorth.previousNetWorth).toBe(50);
      expect(result.netWorth.netWorthChange).toBe(50);
      // 50.001 of 50.004, from the unrounded values (rule 8).
      expect(result.netWorth.netWorthChangePercent).toBe(99.99);
    });

    it("works a percent change out from the unrounded values", async () => {
      // 0.026 against 0.014 read 0.03 and 0.01: 200% from the readings,
      // 85.71% exactly.
      mockIncomeReports.getIncomeVsExpensesWithAggregates
        .mockResolvedValueOnce(incomeMonth("2026-01", [0.026], [0.026]))
        .mockResolvedValueOnce(incomeMonth("2025-12", [0.014], [0.014]));

      const result = await service.getMonthlyComparison(mockUserId, "2026-01");

      expect(result.incomeExpenses.incomeChangePercent).toBe(85.71);
      expect(result.incomeExpenses.expensesChangePercent).toBe(85.71);
    });

    it("takes no percentage over a previous month that reads as nothing (issue #2410)", async () => {
      // 0.004 USD reads 0.00 and is no base, as compare_periods takes it: a
      // cent over it read as a 2,499,900% rise. 100 when the current month
      // reads as money, 0 when it reads as nothing too.
      mockIncomeReports.getIncomeVsExpensesWithAggregates
        .mockResolvedValueOnce(incomeMonth("2026-01", [100], [0.003]))
        .mockResolvedValueOnce(incomeMonth("2025-12", [0.004], [0.004]));

      const result = await service.getMonthlyComparison(mockUserId, "2026-01");

      expect(result.incomeExpenses.incomeChangePercent).toBe(100);
      expect(result.incomeExpenses.expensesChangePercent).toBe(0);
    });

    it("says less for a fall that reads as nothing, from the change's sign (issue #2410)", async () => {
      // Income 100.006 against 100.009: both read 100.01 and the change
      // -0.003 reads 0.00, but it is a fall, so the note says less.
      mockIncomeReports.getIncomeVsExpensesWithAggregates
        .mockResolvedValueOnce(incomeMonth("2026-01", [100.006], [0]))
        .mockResolvedValueOnce(incomeMonth("2025-12", [100.009], [0]));

      const result = await service.getMonthlyComparison(mockUserId, "2026-01");

      expect(result.incomeExpenses.incomeChange).toBe(0);
      expect(result.notes.incomeNote).toContain("less than");
      expect(result.notes.savingsNote).toContain("less than");
    });
  });

  describe("getMonthlyComparison() - edge cases", () => {
    it("handles zero values without division errors", async () => {
      mockIncomeReports.getIncomeVsExpensesWithAggregates
        .mockResolvedValueOnce(
          withIncomeAggregates({
            data: [{ period: "2026-01", income: 0, expenses: 0, net: 0 }],
            totals: { income: 0, expenses: 0, net: 0 },
          }),
        )
        .mockResolvedValueOnce(
          withIncomeAggregates({
            data: [{ period: "2025-12", income: 0, expenses: 0, net: 0 }],
            totals: { income: 0, expenses: 0, net: 0 },
          }),
        );
      mockSpendingReports.getSpendingByCategoryWithAggregates
        .mockResolvedValueOnce(
          withSpendingAggregates({
            data: [],
            totalSpending: 0,
            knownSpending: 0,
          }),
        )
        .mockResolvedValueOnce(
          withSpendingAggregates({
            data: [],
            totalSpending: 0,
            knownSpending: 0,
          }),
        );
      mockNetWorthService.getMonthlyNetWorthWithAggregates.mockResolvedValue(
        withNetWorthAggregates([]),
      );
      mockPortfolioService.getMonthOverMonthMovers.mockResolvedValue([]);

      const result = await service.getMonthlyComparison(mockUserId, "2026-01");

      expect(result.incomeExpenses.incomeChangePercent).toBe(0);
      expect(result.incomeExpenses.expensesChangePercent).toBe(0);
      expect(result.incomeExpenses.savingsChangePercent).toBe(0);
      expect(result.netWorth.netWorthChangePercent).toBe(0);
    });

    it("handles missing month data in income/expenses response", async () => {
      mockIncomeReports.getIncomeVsExpensesWithAggregates
        .mockResolvedValueOnce(
          withIncomeAggregates({
            data: [],
            totals: { income: 0, expenses: 0, net: 0 },
          }),
        )
        .mockResolvedValueOnce(
          withIncomeAggregates({
            data: [],
            totals: { income: 0, expenses: 0, net: 0 },
          }),
        );
      mockSpendingReports.getSpendingByCategoryWithAggregates
        .mockResolvedValueOnce(
          withSpendingAggregates({
            data: [],
            totalSpending: 0,
            knownSpending: 0,
          }),
        )
        .mockResolvedValueOnce(
          withSpendingAggregates({
            data: [],
            totalSpending: 0,
            knownSpending: 0,
          }),
        );
      mockNetWorthService.getMonthlyNetWorthWithAggregates.mockResolvedValue(
        withNetWorthAggregates([]),
      );
      mockPortfolioService.getMonthOverMonthMovers.mockResolvedValue([]);

      const result = await service.getMonthlyComparison(mockUserId, "2026-01");

      expect(result.incomeExpenses.currentIncome).toBe(0);
      expect(result.incomeExpenses.previousIncome).toBe(0);
    });

    it("handles previous month correctly when current is January", async () => {
      mockIncomeReports.getIncomeVsExpensesWithAggregates
        .mockResolvedValueOnce(
          withIncomeAggregates({
            data: [],
            totals: { income: 0, expenses: 0, net: 0 },
          }),
        )
        .mockResolvedValueOnce(
          withIncomeAggregates({
            data: [],
            totals: { income: 0, expenses: 0, net: 0 },
          }),
        );
      mockSpendingReports.getSpendingByCategoryWithAggregates
        .mockResolvedValueOnce(
          withSpendingAggregates({
            data: [],
            totalSpending: 0,
            knownSpending: 0,
          }),
        )
        .mockResolvedValueOnce(
          withSpendingAggregates({
            data: [],
            totalSpending: 0,
            knownSpending: 0,
          }),
        );
      mockNetWorthService.getMonthlyNetWorthWithAggregates.mockResolvedValue(
        withNetWorthAggregates([]),
      );
      mockPortfolioService.getMonthOverMonthMovers.mockResolvedValue([]);

      const result = await service.getMonthlyComparison(mockUserId, "2026-01");

      expect(result.previousMonth).toBe("2025-12");
      expect(result.previousMonthLabel).toContain("December");
      expect(result.previousMonthLabel).toContain("2025");
    });

    describe("investment performance", () => {
      const brokerage = (id: string, name: string) => ({
        id,
        userId: mockUserId,
        accountType: AccountType.INVESTMENT,
        accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
        isClosed: false,
        name,
      });

      // Only the fields the report reads; the rest of the payload is the
      // period service's own concern and has its own suite.
      const periodResult = (
        overrides: Partial<PortfolioPeriodResult> = {},
      ): PortfolioPeriodResult =>
        ({
          currency: "CAD",
          startDate: "2025-01-31",
          endDate: "2026-01-31",
          investedValueStart: 1000,
          investedValueEnd: 1100,
          investmentPnl: 100,
          investmentReturnPercent: 10,
          investedReasons: [],
          ...overrides,
        }) as PortfolioPeriodResult;

      beforeEach(() => {
        mockIncomeReports.getIncomeVsExpensesWithAggregates.mockResolvedValue(
          withIncomeAggregates({
            data: [],
            totals: { income: 0, expenses: 0, net: 0 },
          }),
        );
        mockSpendingReports.getSpendingByCategoryWithAggregates.mockResolvedValue(
          withSpendingAggregates({
            data: [],
            totalSpending: 0,
            knownSpending: 0,
          }),
        );
        mockNetWorthService.getMonthlyNetWorthWithAggregates.mockResolvedValue(
          withNetWorthAggregates([]),
        );
        mockPortfolioService.getMonthOverMonthMovers.mockResolvedValue([]);
      });

      it("reports the invested part's trailing-year return, not a ratio of month-end balances", async () => {
        // The defect: an account holding $500 of shares a year ago that was
        // then funded with $22,000 of purchases read (22500/500)^(12/12)-1 =
        // 4400% "annualized return". The purchases are capital, not earnings,
        // so the figure is the period service's time-weighted return.
        mockAccountsRepo.find.mockResolvedValue([
          brokerage("acc-1", "My RRSP - Brokerage"),
        ]);
        mockDataSource.query.mockResolvedValue([
          {
            account_id: "acc-1",
            month: "2025-01-01",
            balance: 0,
            market_value: 500,
            name: "My RRSP - Brokerage",
            account_sub_type: "INVESTMENT_BROKERAGE",
          },
          {
            account_id: "acc-1",
            month: "2026-01-01",
            balance: 0,
            market_value: 22500,
            name: "My RRSP - Brokerage",
            account_sub_type: "INVESTMENT_BROKERAGE",
          },
        ]);
        mockPeriodResultService.getPeriodResult.mockResolvedValue(
          periodResult({
            investedValueStart: 500,
            investedValueEnd: 22500,
            investmentPnl: 812.34567,
            investmentReturnPercent: 7.4567,
          }),
        );

        const result = await service.getMonthlyComparison(
          mockUserId,
          "2026-01",
        );

        expect(mockPeriodResultService.getPeriodResult).toHaveBeenCalledWith(
          mockUserId,
          {
            period: "1y",
            endDate: "2026-01-31",
            accountIds: ["acc-1"],
            displayCurrency: "CAD",
          },
        );
        expect(result.investments.accountPerformance).toEqual([
          {
            accountId: "acc-1",
            accountName: "My RRSP",
            currentValue: 22500,
            startValue: 500,
            investmentPnl: 812.35,
            returnPercent: 7.46,
            returnReasons: [],
            periodStart: "2025-01-31",
            periodEnd: "2026-01-31",
          },
        ]);
        // The month-end balance snapshots are no longer read at all.
        const sqls = mockDataSource.query.mock.calls.map((c) => String(c[0]));
        expect(
          sqls.some((sql) => sql.includes("monthly_account_balances")),
        ).toBe(false);
      });

      it("never measures past today when the report month is still running", async () => {
        const today = todayYMD();
        const nextYear = Number(today.slice(0, 4)) + 1;
        mockAccountsRepo.find.mockResolvedValue([brokerage("acc-1", "A")]);
        mockPeriodResultService.getPeriodResult.mockResolvedValue(
          periodResult(),
        );

        await service.getMonthlyComparison(mockUserId, `${nextYear}-06`);

        const [, opts] = mockPeriodResultService.getPeriodResult.mock.calls[0];
        expect(opts.endDate <= today).toBe(true);
      });

      it("carries a withheld return as null with the server's reasons, never as zero", async () => {
        mockAccountsRepo.find.mockResolvedValue([brokerage("acc-1", "A")]);
        mockPeriodResultService.getPeriodResult.mockResolvedValue(
          periodResult({
            investedValueEnd: null,
            investmentPnl: null,
            investmentReturnPercent: null,
            investedReasons: ["incompletePrices"],
          }),
        );

        const result = await service.getMonthlyComparison(
          mockUserId,
          "2026-01",
        );

        const [row] = result.investments.accountPerformance;
        expect(row.returnPercent).toBeNull();
        expect(row.currentValue).toBeNull();
        expect(row.investmentPnl).toBeNull();
        expect(row.returnReasons).toEqual(["incompletePrices"]);
      });

      it("leaves out an account with no history in the window or nothing ever held", async () => {
        mockAccountsRepo.find.mockResolvedValue([
          brokerage("acc-empty", "Empty"),
          brokerage("acc-new", "Not yet funded"),
          brokerage("acc-1", "Held"),
        ]);
        mockPeriodResultService.getPeriodResult.mockImplementation(
          (_userId: string, opts: { accountIds: string[] }) => {
            if (opts.accountIds[0] === "acc-empty") {
              return Promise.resolve(
                periodResult({
                  investedValueStart: null,
                  investedValueEnd: null,
                  investmentPnl: null,
                  investmentReturnPercent: null,
                  investedReasons: ["noValueSeries"],
                }),
              );
            }
            if (opts.accountIds[0] === "acc-new") {
              return Promise.resolve(
                periodResult({
                  investedValueStart: 0,
                  investedValueEnd: 0,
                  investmentPnl: 0,
                  investmentReturnPercent: 0,
                }),
              );
            }
            return Promise.resolve(periodResult());
          },
        );

        const result = await service.getMonthlyComparison(
          mockUserId,
          "2026-01",
        );

        expect(
          result.investments.accountPerformance.map((a) => a.accountId),
        ).toEqual(["acc-1"]);
      });

      it("sorts by value, largest first, with an unknown value last", async () => {
        mockAccountsRepo.find.mockResolvedValue([
          brokerage("acc-unknown", "Unknown"),
          brokerage("acc-small", "Small"),
          brokerage("acc-big", "Big"),
        ]);
        const values: Record<string, number | null> = {
          "acc-unknown": null,
          "acc-small": 100,
          "acc-big": 5000,
        };
        mockPeriodResultService.getPeriodResult.mockImplementation(
          (_userId: string, opts: { accountIds: string[] }) =>
            Promise.resolve(
              periodResult({ investedValueEnd: values[opts.accountIds[0]] }),
            ),
        );

        const result = await service.getMonthlyComparison(
          mockUserId,
          "2026-01",
        );

        expect(
          result.investments.accountPerformance.map((a) => a.accountId),
        ).toEqual(["acc-big", "acc-small", "acc-unknown"]);
      });

      it("does not measure a linked cash account on its own", async () => {
        mockAccountsRepo.find.mockResolvedValue([
          brokerage("acc-1", "A - Brokerage"),
          {
            ...brokerage("acc-cash", "A"),
            accountSubType: AccountSubType.INVESTMENT_CASH,
          },
        ]);
        mockPeriodResultService.getPeriodResult.mockResolvedValue(
          periodResult(),
        );

        await service.getMonthlyComparison(mockUserId, "2026-01");

        expect(mockPeriodResultService.getPeriodResult).toHaveBeenCalledTimes(
          1,
        );
        expect(
          mockPeriodResultService.getPeriodResult.mock.calls[0][1].accountIds,
        ).toEqual(["acc-1"]);
      });
    });

    it("percent change returns 100 when previous is 0 and current is non-zero", async () => {
      mockIncomeReports.getIncomeVsExpensesWithAggregates
        .mockResolvedValueOnce(
          withIncomeAggregates({
            data: [{ period: "2026-01", income: 1000, expenses: 0, net: 1000 }],
            totals: { income: 1000, expenses: 0, net: 1000 },
          }),
        )
        .mockResolvedValueOnce(
          withIncomeAggregates({
            data: [{ period: "2025-12", income: 0, expenses: 0, net: 0 }],
            totals: { income: 0, expenses: 0, net: 0 },
          }),
        );
      mockSpendingReports.getSpendingByCategoryWithAggregates
        .mockResolvedValueOnce(
          withSpendingAggregates({
            data: [],
            totalSpending: 0,
            knownSpending: 0,
          }),
        )
        .mockResolvedValueOnce(
          withSpendingAggregates({
            data: [],
            totalSpending: 0,
            knownSpending: 0,
          }),
        );
      mockNetWorthService.getMonthlyNetWorthWithAggregates.mockResolvedValue(
        withNetWorthAggregates([]),
      );
      mockPortfolioService.getMonthOverMonthMovers.mockResolvedValue([]);

      const result = await service.getMonthlyComparison(mockUserId, "2026-01");

      expect(result.incomeExpenses.incomeChangePercent).toBe(100);
    });
  });
});
