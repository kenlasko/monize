import { DataSource } from "typeorm";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BudgetActivityReportsService } from "./budget-activity-reports.service";
import {
  CategorySpending,
  queryCategorySpendingBuckets,
} from "./budget-spending.util";
import { BudgetsService } from "./budgets.service";
import { Budget, BudgetType, BudgetStrategy } from "./entities/budget.entity";
import {
  BudgetCategory,
  RolloverType,
  CategoryGroup,
} from "./entities/budget-category.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("./budget-spending.util", () => ({
  ...jest.requireActual("./budget-spending.util"),
  queryCategorySpendingBuckets: jest.fn(),
}));

const mockedSpending = queryCategorySpendingBuckets as jest.MockedFunction<
  typeof queryCategorySpendingBuckets
>;

/** What `queryCategorySpendingBuckets` returns for the given buckets. */
const bucketed = (buckets: Record<string, CategorySpending>) => ({
  currency: "USD",
  buckets: new Map(Object.entries(buckets)),
});

/** One CategorySpending for the given net sums (expenses negative). */
function spending(
  categories: Record<string, number>,
  extra: {
    transfers?: Record<string, number>;
    incomplete?: string[];
  } = {},
): CategorySpending {
  return {
    spendingMap: new Map(Object.entries(categories)),
    transferSpendingMap: new Map(Object.entries(extra.transfers ?? {})),
    currency: "USD",
    incompleteCategoryIds: new Set(extra.incomplete ?? []),
    incompleteTransferAccountIds: new Set(),
    missingRatePairs: extra.incomplete ? ["JPY->USD"] : [],
  };
}

describe("BudgetActivityReportsService", () => {
  let scopedDataSource: DataSourceMock;
  let service: BudgetActivityReportsService;
  let periodsRepository: Record<string, jest.Mock>;
  let transactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let budgetsService: Record<string, jest.Mock>;

  const mockCategory: Category = {
    id: "cat-1",
    userId: "user-1",
    parentId: null,
    parent: null,
    children: [],
    name: "Groceries",
    description: null,
    icon: null,
    color: null,
    isIncome: false,
    autoSign: null,
    isSystem: false,
    createdAt: new Date("2025-01-01"),
  };

  const mockCategory2: Category = {
    id: "cat-2",
    userId: "user-1",
    parentId: null,
    parent: null,
    children: [],
    name: "Dining",
    description: null,
    icon: null,
    color: null,
    isIncome: false,
    autoSign: null,
    isSystem: false,
    createdAt: new Date("2025-01-01"),
  };

  const mockBudgetCategory: BudgetCategory = {
    id: "bc-1",
    budgetId: "budget-1",
    budget: {} as Budget,
    categoryId: "cat-1",
    category: mockCategory,
    categoryGroup: CategoryGroup.NEED,
    transferAccountId: null,
    transferAccount: null,
    isTransfer: false,
    amount: 500,
    isIncome: false,
    rolloverType: RolloverType.NONE,
    rolloverCap: null,
    flexGroup: "Essentials",
    alertWarnPercent: 80,
    alertCriticalPercent: 95,
    notes: null,
    sortOrder: 0,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  const mockBudgetCategory2: BudgetCategory = {
    id: "bc-2",
    budgetId: "budget-1",
    budget: {} as Budget,
    categoryId: "cat-2",
    category: mockCategory2,
    categoryGroup: CategoryGroup.WANT,
    transferAccountId: null,
    transferAccount: null,
    isTransfer: false,
    amount: 300,
    isIncome: false,
    rolloverType: RolloverType.NONE,
    rolloverCap: null,
    flexGroup: "Fun Money",
    alertWarnPercent: 80,
    alertCriticalPercent: 95,
    notes: null,
    sortOrder: 1,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  const mockTransferCategory: BudgetCategory = {
    id: "bc-transfer",
    budgetId: "budget-1",
    budget: {} as Budget,
    categoryId: null,
    category: null,
    categoryGroup: null,
    transferAccountId: "acc-savings",
    transferAccount: null,
    isTransfer: true,
    amount: 200,
    isIncome: false,
    rolloverType: RolloverType.NONE,
    rolloverCap: null,
    flexGroup: null,
    alertWarnPercent: 80,
    alertCriticalPercent: 95,
    notes: null,
    sortOrder: 2,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  const mockIncomeCategory: BudgetCategory = {
    id: "bc-income",
    budgetId: "budget-1",
    budget: {} as Budget,
    categoryId: "cat-income",
    category: {
      ...mockCategory,
      id: "cat-income",
      name: "Salary",
      isIncome: true,
    },
    categoryGroup: null,
    transferAccountId: null,
    transferAccount: null,
    isTransfer: false,
    amount: 5000,
    isIncome: true,
    rolloverType: RolloverType.NONE,
    rolloverCap: null,
    flexGroup: null,
    alertWarnPercent: 80,
    alertCriticalPercent: 95,
    notes: null,
    sortOrder: 0,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  const mockBudget: Budget = {
    id: "budget-1",
    userId: "user-1",
    name: "February 2026",
    description: null,
    budgetType: BudgetType.MONTHLY,
    periodStart: "2026-02-01",
    periodEnd: null,
    baseIncome: 5000,
    incomeLinked: false,
    strategy: BudgetStrategy.FIXED,
    isActive: true,
    currencyCode: "USD",
    config: {},
    categories: [mockBudgetCategory, mockBudgetCategory2, mockIncomeCategory],
    periods: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  const createMockQueryBuilder = (overrides = {}) => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    getRawOne: jest.fn().mockResolvedValue({ total: "0" }),
    ...overrides,
  });

  beforeEach(async () => {
    mockedSpending.mockReset();
    mockedSpending.mockResolvedValue(bucketed({}));
    periodsRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };

    transactionsRepository = {
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    splitsRepository = {
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    budgetsService = {
      findOne: jest.fn().mockResolvedValue(mockBudget),
      getSummary: jest.fn().mockResolvedValue({
        budget: mockBudget,
        totalBudgeted: 800,
        totalSpent: 500,
        totalIncome: 5000,
        remaining: 300,
        percentUsed: 62.5,
        categoryBreakdown: [
          {
            budgetCategoryId: "bc-1",
            categoryId: "cat-1",
            categoryName: "Groceries",
            budgeted: 500,
            spent: 350,
            remaining: 150,
            percentUsed: 70,
            isIncome: false,
          },
          {
            budgetCategoryId: "bc-2",
            categoryId: "cat-2",
            categoryName: "Dining",
            budgeted: 300,
            spent: 150,
            remaining: 150,
            percentUsed: 50,
            isIncome: false,
          },
          {
            budgetCategoryId: "bc-income",
            categoryId: "cat-income",
            categoryName: "Salary",
            budgeted: 5000,
            spent: 5000,
            remaining: 0,
            percentUsed: 100,
            isIncome: true,
          },
        ],
      }),
    };

    ({ dataSource: scopedDataSource } = createScopedDbMocks([
      [BudgetPeriod, periodsRepository as never],
      [Transaction, transactionsRepository as never],
      [TransactionSplit, splitsRepository as never],
    ]));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BudgetActivityReportsService,
        {
          provide: getRepositoryToken(BudgetPeriod),
          useValue: periodsRepository,
        },
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        {
          provide: getRepositoryToken(TransactionSplit),
          useValue: splitsRepository,
        },
        {
          provide: BudgetsService,
          useValue: budgetsService,
        },
        { provide: DataSource, useValue: scopedDataSource },
      ],
    }).compile();

    service = module.get<BudgetActivityReportsService>(
      BudgetActivityReportsService,
    );
  });

  describe("getDailySpending", () => {
    const openPeriod: Partial<BudgetPeriod> = {
      id: "p-1",
      budgetId: "budget-1",
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
      status: PeriodStatus.OPEN,
    };

    it("sums the budget page's net spending per day over the open period", async () => {
      periodsRepository.findOne.mockResolvedValueOnce(openPeriod);
      mockedSpending.mockResolvedValue(
        bucketed({
          "2026-02-05": spending({ "cat-1": -50 }),
          "2026-02-10": spending({ "cat-1": -60.25, "cat-2": -15.25 }),
        }),
      );

      const result = await service.getDailySpending("user-1", "budget-1");

      expect(result).toEqual([
        { date: "2026-02-05", amount: 50, valuationComplete: true },
        { date: "2026-02-10", amount: 75.5, valuationComplete: true },
      ]);
      expect(periodsRepository.findOne).toHaveBeenCalledWith({
        where: { budgetId: "budget-1", status: PeriodStatus.OPEN },
      });
      // One query over the whole period, bucketed by day, over the budget's
      // expense lines.
      expect(mockedSpending).toHaveBeenCalledTimes(1);
      const first = mockedSpending.mock.calls[0];
      expect(first[4]).toBe("2026-02-01");
      expect(first[5]).toBe("2026-02-28");
      expect((first[6] as (d: string) => string)("2026-02-05")).toBe(
        "2026-02-05",
      );
      expect((first[3] as BudgetCategory[]).map((bc) => bc.id)).toEqual([
        "bc-1",
        "bc-2",
      ]);
    });

    it("nets a refund inside the day's own category", async () => {
      periodsRepository.findOne.mockResolvedValueOnce(openPeriod);
      // Net of -100 and +30 in one category is -70; the +40 category nets -40.
      mockedSpending.mockResolvedValue(
        bucketed({ "2026-02-03": spending({ "cat-1": -70, "cat-2": 40 }) }),
      );

      const result = await service.getDailySpending("user-1", "budget-1");

      expect(result).toEqual([
        { date: "2026-02-03", amount: 30, valuationComplete: true },
      ]);
    });

    it("reports a refund day as negative so the days sum to the period net", async () => {
      periodsRepository.findOne.mockResolvedValueOnce(openPeriod);
      mockedSpending.mockResolvedValue(
        bucketed({
          "2026-02-03": spending({ "cat-1": -100 }),
          "2026-02-10": spending({ "cat-1": 40 }),
        }),
      );

      const result = await service.getDailySpending("user-1", "budget-1");

      expect(result.map((d) => d.amount)).toEqual([100, -40]);
      expect(result.reduce((s, d) => s + d.amount, 0)).toBe(60);
    });

    it("marks a day incomplete when a row had no rate, keeping what converted", async () => {
      periodsRepository.findOne.mockResolvedValueOnce(openPeriod);
      mockedSpending.mockResolvedValue(
        bucketed({
          "2026-02-03": spending({ "cat-1": -20 }, { incomplete: ["cat-2"] }),
        }),
      );

      const result = await service.getDailySpending("user-1", "budget-1");

      expect(result).toEqual([
        { date: "2026-02-03", amount: 20, valuationComplete: false },
      ]);
    });

    it("should fall back to budget periodStart when no open period exists", async () => {
      mockedSpending.mockResolvedValue(bucketed({}));

      await service.getDailySpending("user-1", "budget-1");

      expect(mockedSpending.mock.calls[0][4]).toBe("2026-02-01");
      expect(mockedSpending.mock.calls[0][5]).toBe("2026-02-28");
    });

    it("includes transfer lines through the transfer spending map", async () => {
      periodsRepository.findOne.mockResolvedValueOnce(openPeriod);
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [mockTransferCategory],
      });
      mockedSpending.mockResolvedValue(
        bucketed({
          "2026-02-07": spending({}, { transfers: { "acc-savings": 200 } }),
        }),
      );

      const result = await service.getDailySpending("user-1", "budget-1");

      expect(result).toEqual([
        { date: "2026-02-07", amount: 200, valuationComplete: true },
      ]);
    });

    it("should return empty array when no expense categories exist", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [mockIncomeCategory],
      });

      const result = await service.getDailySpending("user-1", "budget-1");

      expect(result).toEqual([]);
      expect(mockedSpending).not.toHaveBeenCalled();
    });

    it("should handle budget with no categories array", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: undefined,
      });

      const result = await service.getDailySpending("user-1", "budget-1");

      expect(result).toEqual([]);
    });

    it("should handle empty query results", async () => {
      mockedSpending.mockResolvedValue(bucketed({}));

      const result = await service.getDailySpending("user-1", "budget-1");

      expect(result).toEqual([]);
    });
  });

  describe("getFlexGroupStatus", () => {
    it("should group categories by flex group and compute totals", async () => {
      const result = await service.getFlexGroupStatus("user-1", "budget-1");

      expect(result).toHaveLength(2);
      // Should be sorted by percentUsed descending
      const essentials = result.find((r) => r.groupName === "Essentials");
      const funMoney = result.find((r) => r.groupName === "Fun Money");

      expect(essentials).toBeDefined();
      expect(essentials!.totalBudgeted).toBe(500);
      expect(essentials!.totalSpent).toBe(350);
      expect(essentials!.remaining).toBe(150);
      expect(essentials!.percentUsed).toBe(70);
      expect(essentials!.categories).toHaveLength(1);

      expect(funMoney).toBeDefined();
      expect(funMoney!.totalBudgeted).toBe(300);
      expect(funMoney!.totalSpent).toBe(150);
      expect(funMoney!.remaining).toBe(150);
      expect(funMoney!.percentUsed).toBe(50);
    });

    it("should skip income categories", async () => {
      const result = await service.getFlexGroupStatus("user-1", "budget-1");

      const groupNames = result.map((r) => r.groupName);
      // Income category (Salary) has no flexGroup so it should not appear
      expect(groupNames).not.toContain("Salary");
    });

    it("should skip categories without a flex group", async () => {
      budgetsService.getSummary.mockResolvedValueOnce({
        budget: {
          ...mockBudget,
          categories: [
            { ...mockBudgetCategory, flexGroup: null },
            mockIncomeCategory,
          ],
        },
        totalBudgeted: 500,
        totalSpent: 350,
        totalIncome: 5000,
        remaining: 150,
        percentUsed: 70,
        categoryBreakdown: [
          {
            budgetCategoryId: "bc-1",
            categoryId: "cat-1",
            categoryName: "Groceries",
            budgeted: 500,
            spent: 350,
            remaining: 150,
            percentUsed: 70,
            isIncome: false,
          },
        ],
      });

      const result = await service.getFlexGroupStatus("user-1", "budget-1");

      expect(result).toHaveLength(0);
    });

    it("should handle zero budgeted amount without division error", async () => {
      budgetsService.getSummary.mockResolvedValueOnce({
        budget: {
          ...mockBudget,
          categories: [{ ...mockBudgetCategory, amount: 0 }],
        },
        totalBudgeted: 0,
        totalSpent: 0,
        totalIncome: 5000,
        remaining: 0,
        percentUsed: 0,
        categoryBreakdown: [
          {
            budgetCategoryId: "bc-1",
            categoryId: "cat-1",
            categoryName: "Groceries",
            budgeted: 0,
            spent: 0,
            remaining: 0,
            percentUsed: 0,
            isIncome: false,
          },
        ],
      });

      const result = await service.getFlexGroupStatus("user-1", "budget-1");

      expect(result).toHaveLength(1);
      expect(result[0].percentUsed).toBe(0);
    });

    it("should sort results by percentUsed descending", async () => {
      const result = await service.getFlexGroupStatus("user-1", "budget-1");

      // Essentials: 70%, Fun Money: 50% -- Essentials should be first
      expect(result[0].groupName).toBe("Essentials");
      expect(result[1].groupName).toBe("Fun Money");
    });

    it("should return empty array when no categories have flex groups", async () => {
      budgetsService.getSummary.mockResolvedValueOnce({
        budget: {
          ...mockBudget,
          categories: [mockIncomeCategory],
        },
        totalBudgeted: 0,
        totalSpent: 0,
        totalIncome: 5000,
        remaining: 0,
        percentUsed: 0,
        categoryBreakdown: [
          {
            budgetCategoryId: "bc-income",
            categoryId: "cat-income",
            categoryName: "Salary",
            budgeted: 5000,
            spent: 5000,
            remaining: 0,
            percentUsed: 100,
            isIncome: true,
          },
        ],
      });

      const result = await service.getFlexGroupStatus("user-1", "budget-1");

      expect(result).toEqual([]);
    });
  });

  describe("getSeasonalPatterns", () => {
    // The sweep runs the 12 complete months before this one, so each calendar
    // month is answered once.
    const byMonth = (
      perMonth: Record<number, Record<string, number>>,
      extra: { incomplete?: string[] } = {},
    ) => {
      const now = new Date();
      const buckets: Record<string, CategorySpending> = {};
      for (let back = 12; back >= 1; back--) {
        const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
        const month = d.getMonth() + 1;
        const key = `${d.getFullYear()}-${String(month).padStart(2, "0")}`;
        buckets[key] = spending(perMonth[month] ?? {}, extra);
      }
      return bucketed(buckets);
    };

    it("sweeps 12 complete months, each calendar month once", async () => {
      mockedSpending.mockResolvedValue(byMonth({}));

      await service.getSeasonalPatterns("user-1", "budget-1");

      // One query over the 12 months, bucketed by month; it ends before the
      // current month.
      expect(mockedSpending).toHaveBeenCalledTimes(1);
      const [start, end] = [
        mockedSpending.mock.calls[0][4] as string,
        mockedSpending.mock.calls[0][5] as string,
      ];
      const now = new Date();
      const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      expect(start.slice(0, 7) < end.slice(0, 7)).toBe(true);
      expect(end.slice(0, 7) < current).toBe(true);
      expect(
        (mockedSpending.mock.calls[0][6] as (d: string) => string)(
          "2026-03-14",
        ),
      ).toBe("2026-03");
    });

    it("should return empty array when no expense categories exist", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [mockIncomeCategory],
      });

      const result = await service.getSeasonalPatterns("user-1", "budget-1");

      expect(result).toEqual([]);
    });

    it("should compute seasonal patterns from the budget page's net spending", async () => {
      mockedSpending.mockResolvedValue(
        byMonth({
          6: { "cat-1": -800 },
          7: { "cat-1": -200 },
          12: { "cat-1": -900 },
        }),
      );

      const result = await service.getSeasonalPatterns("user-1", "budget-1");

      expect(result).toHaveLength(1);
      const cat = result[0];
      expect(cat.categoryId).toBe("cat-1");
      expect(cat.categoryName).toBe("Groceries");
      expect(cat.monthlyAverages).toHaveLength(12);
      expect(cat.monthlyAverages[5].average).toBe(800);
      expect(cat.monthlyAverages[11].average).toBe(900);
      expect(cat.typicalMonthlySpend).toBe(633.3333);
      expect(cat.valuationComplete).toBe(true);
    });

    it("nets a refund inside the month instead of counting the gross debit", async () => {
      // 100 spent and 30 refunded arrives as a net -70.
      mockedSpending.mockResolvedValue(byMonth({ 3: { "cat-1": -70 } }));

      const result = await service.getSeasonalPatterns("user-1", "budget-1");

      expect(result[0].monthlyAverages[2].average).toBe(70);
    });

    it("flags a category with an unconvertible row as incomplete", async () => {
      mockedSpending.mockResolvedValue(
        byMonth({ 3: { "cat-1": -70 } }, { incomplete: ["cat-1"] }),
      );

      const result = await service.getSeasonalPatterns("user-1", "budget-1");

      expect(result).toHaveLength(1);
      expect(result[0].valuationComplete).toBe(false);
    });

    it("should use parent name when category has a parent", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [
          {
            ...mockBudgetCategory,
            category: {
              ...mockCategory,
              parent: { ...mockCategory, id: "cat-p", name: "Food" },
            },
          },
        ],
      });
      mockedSpending.mockResolvedValue(byMonth({ 3: { "cat-1": -70 } }));

      const result = await service.getSeasonalPatterns("user-1", "budget-1");

      expect(result[0].categoryName).toBe("Food: Groceries");
    });

    it("should handle all zero spending", async () => {
      mockedSpending.mockResolvedValue(bucketed({}));

      const result = await service.getSeasonalPatterns("user-1", "budget-1");

      expect(result).toEqual([]);
    });
  });
});
