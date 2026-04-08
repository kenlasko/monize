import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BudgetReportsService } from "./budget-reports.service";
import { BudgetTrendReportsService } from "./budget-trend-reports.service";
import { BudgetHealthReportsService } from "./budget-health-reports.service";
import { BudgetActivityReportsService } from "./budget-activity-reports.service";
import { BudgetsService } from "./budgets.service";
import { Budget, BudgetType, BudgetStrategy } from "./entities/budget.entity";
import {
  BudgetCategory,
  RolloverType,
  CategoryGroup,
} from "./entities/budget-category.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { BudgetPeriodCategory } from "./entities/budget-period-category.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";

describe("BudgetReportsService", () => {
  let service: BudgetReportsService;
  let periodsRepository: Record<string, jest.Mock>;
  let periodCategoriesRepository: Record<string, jest.Mock>;
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
    periodsRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };

    periodCategoriesRepository = {
      find: jest.fn().mockResolvedValue([]),
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BudgetTrendReportsService,
        BudgetHealthReportsService,
        BudgetActivityReportsService,
        BudgetReportsService,
        {
          provide: getRepositoryToken(BudgetPeriod),
          useValue: periodsRepository,
        },
        {
          provide: getRepositoryToken(BudgetPeriodCategory),
          useValue: periodCategoriesRepository,
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
      ],
    }).compile();

    service = module.get<BudgetReportsService>(BudgetReportsService);
  });

  describe("getTrend", () => {
    it("should return trend data from closed periods", async () => {
      const closedPeriods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2025-12-01",
          periodEnd: "2025-12-31",
          totalBudgeted: 800,
          actualExpenses: 750,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
        },
        {
          id: "p-2",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          totalBudgeted: 800,
          actualExpenses: 820,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(closedPeriods);
      periodsRepository.findOne.mockResolvedValueOnce(null);

      const result = await service.getTrend("user-1", "budget-1", 6);

      expect(result).toHaveLength(2);
      expect(result[0].month).toBe("Dec 2025");
      expect(result[0].budgeted).toBe(800);
      expect(result[0].actual).toBe(750);
      expect(result[0].variance).toBe(-50);
      expect(result[1].month).toBe("Jan 2026");
      expect(result[1].actual).toBe(820);
      expect(result[1].variance).toBe(20);
    });

    it("should include current open period in trend", async () => {
      const closedPeriods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          totalBudgeted: 800,
          actualExpenses: 700,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
        },
      ];

      const openPeriod: Partial<BudgetPeriod> = {
        id: "p-2",
        budgetId: "budget-1",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
        totalBudgeted: 800,
        status: PeriodStatus.OPEN,
      };

      periodsRepository.find.mockResolvedValueOnce(closedPeriods);
      periodsRepository.findOne.mockResolvedValueOnce(openPeriod);

      const directQb = createMockQueryBuilder({
        getRawOne: jest.fn().mockResolvedValue({ total: "-400" }),
      });
      const splitQb = createMockQueryBuilder({
        getRawOne: jest.fn().mockResolvedValue({ total: "-50" }),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(directQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getTrend("user-1", "budget-1", 6);

      expect(result).toHaveLength(2);
      expect(result[1].month).toBe("Feb 2026");
      expect(result[1].actual).toBe(450);
      expect(result[1].budgeted).toBe(800);
    });

    it("should fall back to live transactions when no closed periods exist", async () => {
      periodsRepository.find.mockResolvedValueOnce([]);
      periodsRepository.findOne.mockResolvedValueOnce(null);

      const result = await service.getTrend("user-1", "budget-1", 3);

      expect(result).toHaveLength(3);
      expect(budgetsService.findOne).toHaveBeenCalledWith("user-1", "budget-1");
    });

    it("should return empty array when no categories and no periods", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [],
      });
      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getTrend("user-1", "budget-1", 6);

      expect(result).toEqual([]);
    });

    it("should handle zero budgeted amount without division error", async () => {
      const closedPeriods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          totalBudgeted: 0,
          actualExpenses: 100,
          actualIncome: 0,
          status: PeriodStatus.CLOSED,
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(closedPeriods);
      periodsRepository.findOne.mockResolvedValueOnce(null);

      const result = await service.getTrend("user-1", "budget-1", 6);

      expect(result[0].percentUsed).toBe(0);
    });
  });

  describe("getCategoryTrend", () => {
    it("should return category-level trend data", async () => {
      const mockPeriodCat: Partial<BudgetPeriodCategory> = {
        id: "bpc-1",
        budgetPeriodId: "p-1",
        budgetCategoryId: "bc-1",
        categoryId: "cat-1",
        budgetedAmount: 500,
        actualAmount: 420,
        effectiveBudget: 500,
        rolloverIn: 0,
        rolloverOut: 0,
        budgetCategory: mockBudgetCategory,
        category: mockCategory,
      };

      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          status: PeriodStatus.CLOSED,
          periodCategories: [mockPeriodCat as BudgetPeriodCategory],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      const result = await service.getCategoryTrend("user-1", "budget-1", 6);

      expect(result).toHaveLength(1);
      expect(result[0].categoryId).toBe("cat-1");
      expect(result[0].categoryName).toBe("Groceries");
      expect(result[0].data).toHaveLength(1);
      expect(result[0].data[0].budgeted).toBe(500);
      expect(result[0].data[0].actual).toBe(420);
      expect(result[0].data[0].variance).toBe(-80);
    });

    it("should filter by specific category IDs", async () => {
      const mockPc1: Partial<BudgetPeriodCategory> = {
        id: "bpc-1",
        categoryId: "cat-1",
        budgetedAmount: 500,
        actualAmount: 420,
        budgetCategory: mockBudgetCategory,
        category: mockCategory,
      };

      const mockPc2: Partial<BudgetPeriodCategory> = {
        id: "bpc-2",
        categoryId: "cat-2",
        budgetedAmount: 300,
        actualAmount: 250,
        budgetCategory: mockBudgetCategory2,
        category: mockCategory2,
      };

      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          status: PeriodStatus.CLOSED,
          periodCategories: [
            mockPc1 as BudgetPeriodCategory,
            mockPc2 as BudgetPeriodCategory,
          ],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      const result = await service.getCategoryTrend("user-1", "budget-1", 6, [
        "cat-1",
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].categoryId).toBe("cat-1");
    });

    it("should skip income categories", async () => {
      const incomeCategory: BudgetCategory = {
        ...mockBudgetCategory,
        id: "bc-income",
        isIncome: true,
      };

      const mockPc: Partial<BudgetPeriodCategory> = {
        id: "bpc-inc",
        categoryId: "cat-income",
        budgetedAmount: 5000,
        actualAmount: 5000,
        budgetCategory: incomeCategory,
        category: { ...mockCategory, id: "cat-income", isIncome: true },
      };

      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          status: PeriodStatus.CLOSED,
          periodCategories: [mockPc as BudgetPeriodCategory],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      const result = await service.getCategoryTrend("user-1", "budget-1", 6);

      expect(result).toHaveLength(0);
    });

    it("should compute live actuals for open periods", async () => {
      const mockPc: Partial<BudgetPeriodCategory> = {
        id: "bpc-1",
        categoryId: "cat-1",
        budgetedAmount: 500,
        actualAmount: 0,
        budgetCategory: mockBudgetCategory,
        category: mockCategory,
      };

      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-02-01",
          periodEnd: "2026-02-28",
          status: PeriodStatus.OPEN,
          periodCategories: [mockPc as BudgetPeriodCategory],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      const directQb = createMockQueryBuilder({
        getRawOne: jest.fn().mockResolvedValue({ total: "-300" }),
      });
      const splitQb = createMockQueryBuilder({
        getRawOne: jest.fn().mockResolvedValue({ total: "-25" }),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(directQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getCategoryTrend("user-1", "budget-1", 6);

      expect(result).toHaveLength(1);
      expect(result[0].data[0].actual).toBe(325);
    });

    it("should handle null categoryId entries", async () => {
      const mockPc: Partial<BudgetPeriodCategory> = {
        id: "bpc-null",
        categoryId: null,
        budgetedAmount: 100,
        actualAmount: 50,
        budgetCategory: mockBudgetCategory,
        category: null,
      };

      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          status: PeriodStatus.CLOSED,
          periodCategories: [mockPc as BudgetPeriodCategory],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      const result = await service.getCategoryTrend("user-1", "budget-1", 6);

      expect(result).toHaveLength(0);
    });
  });

  describe("getHealthScore", () => {
    it("should calculate health score for typical budget", async () => {
      const result = await service.getHealthScore("user-1", "budget-1");

      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.label).toBeDefined();
      expect(result.breakdown).toBeDefined();
      expect(result.categoryScores).toHaveLength(2);
    });

    it("should return high score when all categories are under budget", async () => {
      budgetsService.getSummary.mockResolvedValueOnce({
        budget: mockBudget,
        totalBudgeted: 800,
        totalSpent: 300,
        totalIncome: 5000,
        remaining: 500,
        percentUsed: 37.5,
        categoryBreakdown: [
          {
            budgetCategoryId: "bc-1",
            categoryId: "cat-1",
            categoryName: "Groceries",
            budgeted: 500,
            spent: 200,
            remaining: 300,
            percentUsed: 40,
            isIncome: false,
          },
          {
            budgetCategoryId: "bc-2",
            categoryId: "cat-2",
            categoryName: "Dining",
            budgeted: 300,
            spent: 100,
            remaining: 200,
            percentUsed: 33.33,
            isIncome: false,
          },
        ],
      });

      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getHealthScore("user-1", "budget-1");

      expect(result.score).toBeGreaterThanOrEqual(90);
      expect(result.label).toBe("Excellent");
      expect(result.breakdown.overBudgetDeductions).toBe(0);
      expect(result.breakdown.underBudgetBonus).toBeGreaterThan(0);
    });

    it("should deduct points for over-budget categories", async () => {
      budgetsService.getSummary.mockResolvedValueOnce({
        budget: mockBudget,
        totalBudgeted: 800,
        totalSpent: 1100,
        totalIncome: 5000,
        remaining: -300,
        percentUsed: 137.5,
        categoryBreakdown: [
          {
            budgetCategoryId: "bc-1",
            categoryId: "cat-1",
            categoryName: "Groceries",
            budgeted: 500,
            spent: 700,
            remaining: -200,
            percentUsed: 140,
            isIncome: false,
          },
          {
            budgetCategoryId: "bc-2",
            categoryId: "cat-2",
            categoryName: "Dining",
            budgeted: 300,
            spent: 400,
            remaining: -100,
            percentUsed: 133.33,
            isIncome: false,
          },
        ],
      });

      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getHealthScore("user-1", "budget-1");

      expect(result.score).toBeLessThan(80);
      expect(result.breakdown.overBudgetDeductions).toBeGreaterThan(0);
    });

    it("should apply extra penalty for essential (NEED) categories over budget", async () => {
      budgetsService.getSummary.mockResolvedValueOnce({
        budget: mockBudget,
        totalBudgeted: 500,
        totalSpent: 650,
        totalIncome: 5000,
        remaining: -150,
        percentUsed: 130,
        categoryBreakdown: [
          {
            budgetCategoryId: "bc-1",
            categoryId: "cat-1",
            categoryName: "Groceries",
            budgeted: 500,
            spent: 650,
            remaining: -150,
            percentUsed: 130,
            isIncome: false,
          },
        ],
      });

      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getHealthScore("user-1", "budget-1");

      expect(result.breakdown.essentialWeightPenalty).toBeGreaterThan(0);
    });

    it("should add trend bonus when improving month over month", async () => {
      periodsRepository.find.mockResolvedValueOnce([
        {
          id: "p-2",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          totalBudgeted: 800,
          actualExpenses: 600,
          status: PeriodStatus.CLOSED,
        },
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2025-12-01",
          totalBudgeted: 800,
          actualExpenses: 900,
          status: PeriodStatus.CLOSED,
        },
      ]);

      const result = await service.getHealthScore("user-1", "budget-1");

      expect(result.breakdown.trendBonus).toBeGreaterThan(0);
    });

    it("should exclude income categories from scoring", async () => {
      const result = await service.getHealthScore("user-1", "budget-1");

      const incomeScored = result.categoryScores.find(
        (c) => c.categoryName === "Salary",
      );
      expect(incomeScored).toBeUndefined();
    });

    it("should return score labels correctly", async () => {
      // Score 90+
      budgetsService.getSummary.mockResolvedValueOnce({
        budget: mockBudget,
        totalBudgeted: 800,
        totalSpent: 100,
        totalIncome: 5000,
        remaining: 700,
        percentUsed: 12.5,
        categoryBreakdown: [
          {
            budgetCategoryId: "bc-1",
            categoryId: "cat-1",
            categoryName: "Groceries",
            budgeted: 500,
            spent: 50,
            remaining: 450,
            percentUsed: 10,
            isIncome: false,
          },
        ],
      });

      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getHealthScore("user-1", "budget-1");

      expect(["Excellent", "Good", "Needs Attention", "Off Track"]).toContain(
        result.label,
      );
    });

    it("should skip zero-budgeted categories", async () => {
      budgetsService.getSummary.mockResolvedValueOnce({
        budget: mockBudget,
        totalBudgeted: 0,
        totalSpent: 0,
        totalIncome: 0,
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

      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getHealthScore("user-1", "budget-1");

      expect(result.score).toBe(100);
      expect(result.categoryScores).toHaveLength(0);
    });

    it("should clamp score between 0 and 100", async () => {
      budgetsService.getSummary.mockResolvedValueOnce({
        budget: mockBudget,
        totalBudgeted: 800,
        totalSpent: 5000,
        totalIncome: 5000,
        remaining: -4200,
        percentUsed: 625,
        categoryBreakdown: [
          {
            budgetCategoryId: "bc-1",
            categoryId: "cat-1",
            categoryName: "Groceries",
            budgeted: 500,
            spent: 3000,
            remaining: -2500,
            percentUsed: 600,
            isIncome: false,
          },
          {
            budgetCategoryId: "bc-2",
            categoryId: "cat-2",
            categoryName: "Dining",
            budgeted: 300,
            spent: 2000,
            remaining: -1700,
            percentUsed: 666.67,
            isIncome: false,
          },
        ],
      });

      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getHealthScore("user-1", "budget-1");

      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });
  });

  describe("getSeasonalPatterns", () => {
    it("should return seasonal spending patterns", async () => {
      const spendingData = [
        { categoryId: "cat-1", year: 2025, month: 6, total: "200" },
        { categoryId: "cat-1", year: 2025, month: 7, total: "250" },
        { categoryId: "cat-1", year: 2025, month: 12, total: "800" },
      ];

      const txQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue(spendingData),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(txQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getSeasonalPatterns("user-1", "budget-1");

      expect(result).toHaveLength(1);
      expect(result[0].categoryId).toBe("cat-1");
      expect(result[0].categoryName).toBe("Groceries");
      expect(result[0].monthlyAverages).toHaveLength(12);
      expect(result[0].typicalMonthlySpend).toBeGreaterThan(0);
    });

    it("should detect high-spending months", async () => {
      // Create data with a clear seasonal spike in December
      const spendingData = [
        { categoryId: "cat-1", year: 2025, month: 1, total: "100" },
        { categoryId: "cat-1", year: 2025, month: 2, total: "120" },
        { categoryId: "cat-1", year: 2025, month: 3, total: "110" },
        { categoryId: "cat-1", year: 2025, month: 4, total: "100" },
        { categoryId: "cat-1", year: 2025, month: 5, total: "115" },
        { categoryId: "cat-1", year: 2025, month: 6, total: "105" },
        { categoryId: "cat-1", year: 2025, month: 7, total: "100" },
        { categoryId: "cat-1", year: 2025, month: 8, total: "110" },
        { categoryId: "cat-1", year: 2025, month: 9, total: "100" },
        { categoryId: "cat-1", year: 2025, month: 10, total: "105" },
        { categoryId: "cat-1", year: 2025, month: 11, total: "120" },
        { categoryId: "cat-1", year: 2025, month: 12, total: "1000" },
      ];

      const txQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue(spendingData),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(txQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getSeasonalPatterns("user-1", "budget-1");

      expect(result[0].highMonths).toContain(12);
    });

    it("should return empty array when budget has no expense categories", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [mockIncomeCategory],
      });

      const result = await service.getSeasonalPatterns("user-1", "budget-1");

      expect(result).toEqual([]);
    });

    it("should merge split transaction spending with direct spending", async () => {
      const directData = [
        { categoryId: "cat-1", year: 2025, month: 6, total: "200" },
      ];
      const splitData = [
        { categoryId: "cat-1", year: 2025, month: 6, total: "100" },
      ];

      const txQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue(directData),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue(splitData),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(txQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getSeasonalPatterns("user-1", "budget-1");

      // June should have 300 (200 direct + 100 split)
      const junAvg = result[0].monthlyAverages.find((m) => m.month === 6);
      expect(junAvg?.average).toBe(300);
    });
  });

  describe("getSavingsRate", () => {
    const currentMonthKey = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    })();

    it("should return savings rate for each month", async () => {
      const incomeRows = [{ month: currentMonthKey, total: "5000" }];
      const expenseRows = [{ month: currentMonthKey, total: "3000" }];

      let qbCallCount = 0;
      transactionsRepository.createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        // 1st call = direct income, 3rd call = direct expenses
        if (qbCallCount === 1) {
          return createMockQueryBuilder({
            getRawMany: jest.fn().mockResolvedValue(incomeRows),
          });
        }
        if (qbCallCount === 2) {
          return createMockQueryBuilder({
            getRawMany: jest.fn().mockResolvedValue(expenseRows),
          });
        }
        return createMockQueryBuilder();
      });

      // splits: income splits (1st) and expense splits (2nd)
      splitsRepository.createQueryBuilder.mockImplementation(() =>
        createMockQueryBuilder(),
      );

      const result = await service.getSavingsRate("user-1", "budget-1", 1);

      expect(result).toHaveLength(1);
      expect(result[0].income).toBe(5000);
      expect(result[0].expenses).toBe(3000);
      expect(result[0].savings).toBe(2000);
      expect(result[0].savingsRate).toBe(40);
    });

    it("should include split income in totals", async () => {
      const directIncomeRows = [{ month: currentMonthKey, total: "2000" }];
      const splitIncomeRows = [{ month: currentMonthKey, total: "3000" }];

      let txCallCount = 0;
      transactionsRepository.createQueryBuilder.mockImplementation(() => {
        txCallCount++;
        if (txCallCount === 1) {
          // direct income
          return createMockQueryBuilder({
            getRawMany: jest.fn().mockResolvedValue(directIncomeRows),
          });
        }
        // direct expenses
        return createMockQueryBuilder();
      });

      let splitCallCount = 0;
      splitsRepository.createQueryBuilder.mockImplementation(() => {
        splitCallCount++;
        if (splitCallCount === 1) {
          // income splits
          return createMockQueryBuilder({
            getRawMany: jest.fn().mockResolvedValue(splitIncomeRows),
          });
        }
        // expense splits
        return createMockQueryBuilder();
      });

      const result = await service.getSavingsRate("user-1", "budget-1", 1);

      // 2000 direct + 3000 split = 5000 total income
      expect(result[0].income).toBe(5000);
    });

    it("should return zero savings rate when no income", async () => {
      transactionsRepository.createQueryBuilder.mockImplementation(() =>
        createMockQueryBuilder(),
      );
      splitsRepository.createQueryBuilder.mockImplementation(() =>
        createMockQueryBuilder(),
      );

      const result = await service.getSavingsRate("user-1", "budget-1", 1);

      expect(result[0].income).toBe(0);
      expect(result[0].savingsRate).toBe(0);
    });

    it("should fall back to all positive transactions when no income categories", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [mockBudgetCategory, mockBudgetCategory2],
      });

      const allPositiveRows = [{ month: currentMonthKey, total: "4000" }];

      transactionsRepository.createQueryBuilder.mockImplementation(() =>
        createMockQueryBuilder({
          getRawMany: jest.fn().mockResolvedValue(allPositiveRows),
        }),
      );
      splitsRepository.createQueryBuilder.mockImplementation(() =>
        createMockQueryBuilder(),
      );

      const result = await service.getSavingsRate("user-1", "budget-1", 1);

      expect(result[0].income).toBe(4000);
    });
  });

  describe("getFlexGroupStatus", () => {
    it("should return flex group aggregations", async () => {
      const result = await service.getFlexGroupStatus("user-1", "budget-1");

      expect(result).toHaveLength(2);
      // Should be sorted by percentUsed descending
      expect(result[0].groupName).toBeDefined();
      expect(result[0].totalBudgeted).toBeGreaterThan(0);
      expect(result[0].totalSpent).toBeGreaterThanOrEqual(0);
      expect(result[0].remaining).toBeDefined();
      expect(result[0].percentUsed).toBeGreaterThanOrEqual(0);
      expect(result[0].categories).toBeDefined();
    });

    it("should calculate remaining correctly", async () => {
      const result = await service.getFlexGroupStatus("user-1", "budget-1");

      for (const group of result) {
        expect(group.remaining).toBe(
          Math.round((group.totalBudgeted - group.totalSpent) * 100) / 100,
        );
      }
    });

    it("should sort by percentUsed descending", async () => {
      const result = await service.getFlexGroupStatus("user-1", "budget-1");

      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].percentUsed).toBeGreaterThanOrEqual(
          result[i].percentUsed,
        );
      }
    });

    it("should skip categories without flex groups", async () => {
      budgetsService.getSummary.mockResolvedValueOnce({
        budget: {
          ...mockBudget,
          categories: [
            { ...mockBudgetCategory, flexGroup: null },
            mockBudgetCategory2,
          ],
        },
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
        ],
      });

      const result = await service.getFlexGroupStatus("user-1", "budget-1");

      // Only "Fun Money" group (bc-2), bc-1 has no flex group
      expect(result).toHaveLength(1);
      expect(result[0].groupName).toBe("Fun Money");
    });

    it("should exclude income categories from flex groups", async () => {
      const result = await service.getFlexGroupStatus("user-1", "budget-1");

      const allCats = result.flatMap((g) => g.categories);
      const incomeCat = allCats.find((c) => c.categoryName === "Salary");
      expect(incomeCat).toBeUndefined();
    });

    it("should handle zero budgeted flex group without division error", async () => {
      budgetsService.getSummary.mockResolvedValueOnce({
        budget: {
          ...mockBudget,
          categories: [{ ...mockBudgetCategory, amount: 0 }],
        },
        totalBudgeted: 0,
        totalSpent: 0,
        totalIncome: 0,
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
  });

  describe("getHealthScoreHistory", () => {
    it("should return empty array when no periods exist", async () => {
      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        6,
      );

      expect(result).toEqual([]);
    });

    it("should compute scores for closed periods using stored actuals", async () => {
      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          totalBudgeted: 800,
          actualExpenses: 500,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
          periodCategories: [
            {
              id: "pc-1",
              budgetPeriodId: "p-1",
              budgetCategoryId: "bc-1",
              categoryId: "cat-1",
              budgetedAmount: 500,
              actualAmount: 350,
              rolloverIn: 0,
              effectiveBudget: 500,
              rolloverOut: 0,
              budgetCategory: mockBudgetCategory,
              category: mockCategory,
              budgetPeriod: {} as BudgetPeriod,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as BudgetPeriodCategory,
            {
              id: "pc-2",
              budgetPeriodId: "p-1",
              budgetCategoryId: "bc-2",
              categoryId: "cat-2",
              budgetedAmount: 300,
              actualAmount: 150,
              rolloverIn: 0,
              effectiveBudget: 300,
              rolloverOut: 0,
              budgetCategory: mockBudgetCategory2,
              category: mockCategory2,
              budgetPeriod: {} as BudgetPeriod,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as BudgetPeriodCategory,
          ],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        6,
      );

      expect(result).toHaveLength(1);
      expect(result[0].month).toBe("Jan 2026");
      expect(result[0].score).toBeGreaterThanOrEqual(0);
      expect(result[0].score).toBeLessThanOrEqual(100);
      expect(result[0].label).toBeDefined();
    });

    it("should apply over-budget deductions in history", async () => {
      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          totalBudgeted: 800,
          actualExpenses: 1200,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
          periodCategories: [
            {
              id: "pc-1",
              budgetPeriodId: "p-1",
              budgetCategoryId: "bc-1",
              categoryId: "cat-1",
              budgetedAmount: 500,
              actualAmount: 700,
              rolloverIn: 0,
              effectiveBudget: 500,
              rolloverOut: 0,
              budgetCategory: mockBudgetCategory,
              category: mockCategory,
              budgetPeriod: {} as BudgetPeriod,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as BudgetPeriodCategory,
          ],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        6,
      );

      expect(result).toHaveLength(1);
      // Over budget by 40% on NEED category: deductions + essential penalty
      expect(result[0].score).toBeLessThan(100);
    });

    it("should apply essential weight penalty for NEED categories over budget", async () => {
      // NEED category hugely over budget
      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-02-01",
          periodEnd: "2026-02-28",
          totalBudgeted: 500,
          actualExpenses: 1000,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
          periodCategories: [
            {
              id: "pc-1",
              budgetPeriodId: "p-1",
              budgetCategoryId: "bc-1",
              categoryId: "cat-1",
              budgetedAmount: 500,
              actualAmount: 1000,
              rolloverIn: 0,
              effectiveBudget: 500,
              rolloverOut: 0,
              budgetCategory: mockBudgetCategory, // CategoryGroup.NEED
              category: mockCategory,
              budgetPeriod: {} as BudgetPeriod,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as BudgetPeriodCategory,
          ],
        },
      ];

      // Also test a WANT category same overage for comparison
      const periodsWant: Partial<BudgetPeriod>[] = [
        {
          id: "p-2",
          budgetId: "budget-1",
          periodStart: "2026-02-01",
          periodEnd: "2026-02-28",
          totalBudgeted: 300,
          actualExpenses: 600,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
          periodCategories: [
            {
              id: "pc-2",
              budgetPeriodId: "p-2",
              budgetCategoryId: "bc-2",
              categoryId: "cat-2",
              budgetedAmount: 300,
              actualAmount: 600,
              rolloverIn: 0,
              effectiveBudget: 300,
              rolloverOut: 0,
              budgetCategory: mockBudgetCategory2, // CategoryGroup.WANT
              category: mockCategory2,
              budgetPeriod: {} as BudgetPeriod,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as BudgetPeriodCategory,
          ],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);
      const resultNeed = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        6,
      );

      periodsRepository.find.mockResolvedValueOnce(periodsWant);
      const resultWant = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        6,
      );

      // NEED category should have lower score due to essential weight penalty
      expect(resultNeed[0].score).toBeLessThan(resultWant[0].score);
    });

    it("should give under-budget bonus for categories at 80% or below", async () => {
      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-03-01",
          periodEnd: "2026-03-31",
          totalBudgeted: 800,
          actualExpenses: 200,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
          periodCategories: [
            {
              id: "pc-1",
              budgetPeriodId: "p-1",
              budgetCategoryId: "bc-1",
              categoryId: "cat-1",
              budgetedAmount: 500,
              actualAmount: 100,
              rolloverIn: 0,
              effectiveBudget: 500,
              rolloverOut: 0,
              budgetCategory: mockBudgetCategory,
              category: mockCategory,
              budgetPeriod: {} as BudgetPeriod,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as BudgetPeriodCategory,
            {
              id: "pc-2",
              budgetPeriodId: "p-1",
              budgetCategoryId: "bc-2",
              categoryId: "cat-2",
              budgetedAmount: 300,
              actualAmount: 100,
              rolloverIn: 0,
              effectiveBudget: 300,
              rolloverOut: 0,
              budgetCategory: mockBudgetCategory2,
              category: mockCategory2,
              budgetPeriod: {} as BudgetPeriod,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as BudgetPeriodCategory,
          ],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        6,
      );

      expect(result).toHaveLength(1);
      expect(result[0].score).toBe(100);
      expect(result[0].label).toBe("Excellent");
    });

    it("should skip zero-budgeted period categories", async () => {
      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          totalBudgeted: 0,
          actualExpenses: 0,
          actualIncome: 0,
          status: PeriodStatus.CLOSED,
          periodCategories: [
            {
              id: "pc-1",
              budgetPeriodId: "p-1",
              budgetCategoryId: "bc-1",
              categoryId: "cat-1",
              budgetedAmount: 0,
              actualAmount: 100,
              rolloverIn: 0,
              effectiveBudget: 0,
              rolloverOut: 0,
              budgetCategory: mockBudgetCategory,
              category: mockCategory,
              budgetPeriod: {} as BudgetPeriod,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as BudgetPeriodCategory,
          ],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        6,
      );

      expect(result).toHaveLength(1);
      expect(result[0].score).toBe(100);
    });

    it("should skip income categories from period scoring", async () => {
      const incomeBudgetCategory: BudgetCategory = {
        ...mockBudgetCategory,
        id: "bc-income",
        isIncome: true,
        categoryGroup: null,
      };

      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          totalBudgeted: 5000,
          actualExpenses: 0,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
          periodCategories: [
            {
              id: "pc-income",
              budgetPeriodId: "p-1",
              budgetCategoryId: "bc-income",
              categoryId: "cat-income",
              budgetedAmount: 5000,
              actualAmount: 5000,
              rolloverIn: 0,
              effectiveBudget: 5000,
              rolloverOut: 0,
              budgetCategory: incomeBudgetCategory,
              category: null,
              budgetPeriod: {} as BudgetPeriod,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as BudgetPeriodCategory,
          ],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        6,
      );

      expect(result).toHaveLength(1);
      // Income should not affect score; base should be 100
      expect(result[0].score).toBe(100);
    });

    it("should compute actuals from transactions for OPEN periods", async () => {
      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-03-01",
          periodEnd: "2026-03-31",
          totalBudgeted: 500,
          actualExpenses: 0,
          actualIncome: 0,
          status: PeriodStatus.OPEN,
          periodCategories: [
            {
              id: "pc-1",
              budgetPeriodId: "p-1",
              budgetCategoryId: "bc-1",
              categoryId: "cat-1",
              budgetedAmount: 500,
              actualAmount: 0, // Not yet stored for open periods
              rolloverIn: 0,
              effectiveBudget: 500,
              rolloverOut: 0,
              budgetCategory: mockBudgetCategory,
              category: mockCategory,
              budgetPeriod: {} as BudgetPeriod,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as BudgetPeriodCategory,
          ],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      // computeCategoryActual will query transactions and splits
      const txQb = createMockQueryBuilder({
        getRawOne: jest.fn().mockResolvedValue({ total: "-300" }),
      });
      const splitQb = createMockQueryBuilder({
        getRawOne: jest.fn().mockResolvedValue({ total: "-50" }),
      });
      transactionsRepository.createQueryBuilder.mockReturnValueOnce(txQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        6,
      );

      expect(result).toHaveLength(1);
      // actual = -(-300 + -50) = 350, 350/500 = 70% -> under budget bonus
      expect(result[0].score).toBeGreaterThanOrEqual(90);
      expect(transactionsRepository.createQueryBuilder).toHaveBeenCalled();
      expect(splitsRepository.createQueryBuilder).toHaveBeenCalled();
    });

    it("should compute actuals from transactions for OPEN period over budget", async () => {
      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-03-01",
          periodEnd: "2026-03-31",
          totalBudgeted: 500,
          actualExpenses: 0,
          actualIncome: 0,
          status: PeriodStatus.OPEN,
          periodCategories: [
            {
              id: "pc-1",
              budgetPeriodId: "p-1",
              budgetCategoryId: "bc-1",
              categoryId: "cat-1",
              budgetedAmount: 500,
              actualAmount: 0,
              rolloverIn: 0,
              effectiveBudget: 500,
              rolloverOut: 0,
              budgetCategory: mockBudgetCategory,
              category: mockCategory,
              budgetPeriod: {} as BudgetPeriod,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as BudgetPeriodCategory,
          ],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      // Expenses exceed budget: -800 total
      const txQb = createMockQueryBuilder({
        getRawOne: jest.fn().mockResolvedValue({ total: "-700" }),
      });
      const splitQb = createMockQueryBuilder({
        getRawOne: jest.fn().mockResolvedValue({ total: "-100" }),
      });
      transactionsRepository.createQueryBuilder.mockReturnValueOnce(txQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        6,
      );

      expect(result).toHaveLength(1);
      // actual = 800, 800/500 = 160% -> over budget deductions
      expect(result[0].score).toBeLessThan(100);
    });

    it("should format period months correctly", async () => {
      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2025-12-01",
          periodEnd: "2025-12-31",
          totalBudgeted: 800,
          actualExpenses: 500,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
          periodCategories: [],
        },
        {
          id: "p-2",
          budgetId: "budget-1",
          periodStart: "2026-06-01",
          periodEnd: "2026-06-30",
          totalBudgeted: 800,
          actualExpenses: 500,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
          periodCategories: [],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        12,
      );

      expect(result).toHaveLength(2);
      expect(result[0].month).toBe("Dec 2025");
      expect(result[1].month).toBe("Jun 2026");
    });

    it("should return correct labels for different score ranges", async () => {
      // Many over-budget categories to push score below 50
      // Each category deduction is capped at 15, essential penalty at 5
      // Need 4+ NEED categories to get score below 50:
      // 100 - 4*(15) - 4*(5) = 100 - 60 - 20 = 20
      const makePc = (idx: number): BudgetPeriodCategory =>
        ({
          id: `pc-${idx}`,
          budgetPeriodId: "p-1",
          budgetCategoryId: `bc-${idx}`,
          categoryId: `cat-${idx}`,
          budgetedAmount: 100,
          actualAmount: 600,
          rolloverIn: 0,
          effectiveBudget: 100,
          rolloverOut: 0,
          budgetCategory: {
            ...mockBudgetCategory,
            id: `bc-${idx}`,
            categoryId: `cat-${idx}`,
          },
          category: { ...mockCategory, id: `cat-${idx}` },
          budgetPeriod: {} as BudgetPeriod,
          createdAt: new Date(),
          updatedAt: new Date(),
        }) as BudgetPeriodCategory;

      // Add extra budget categories to bcMap via mockBudget
      const extraCategories = [3, 4, 5, 6].map((idx) => ({
        ...mockBudgetCategory,
        id: `bc-${idx}`,
        categoryId: `cat-${idx}`,
      }));
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [...mockBudget.categories, ...extraCategories],
      });

      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          totalBudgeted: 800,
          actualExpenses: 5000,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
          periodCategories: [
            makePc(1),
            makePc(2),
            makePc(3),
            makePc(4),
            makePc(5),
            makePc(6),
          ],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        6,
      );

      expect(result).toHaveLength(1);
      expect(result[0].score).toBeLessThanOrEqual(50);
      expect(["Needs Attention", "Off Track"]).toContain(result[0].label);
    });

    it("should handle multiple periods and return all scores", async () => {
      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          totalBudgeted: 800,
          actualExpenses: 400,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
          periodCategories: [
            {
              id: "pc-1",
              budgetPeriodId: "p-1",
              budgetCategoryId: "bc-2",
              categoryId: "cat-2",
              budgetedAmount: 300,
              actualAmount: 100,
              rolloverIn: 0,
              effectiveBudget: 300,
              rolloverOut: 0,
              budgetCategory: mockBudgetCategory2,
              category: mockCategory2,
              budgetPeriod: {} as BudgetPeriod,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as BudgetPeriodCategory,
          ],
        },
        {
          id: "p-2",
          budgetId: "budget-1",
          periodStart: "2026-02-01",
          periodEnd: "2026-02-28",
          totalBudgeted: 800,
          actualExpenses: 900,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
          periodCategories: [
            {
              id: "pc-2",
              budgetPeriodId: "p-2",
              budgetCategoryId: "bc-2",
              categoryId: "cat-2",
              budgetedAmount: 300,
              actualAmount: 450,
              rolloverIn: 0,
              effectiveBudget: 300,
              rolloverOut: 0,
              budgetCategory: mockBudgetCategory2,
              category: mockCategory2,
              budgetPeriod: {} as BudgetPeriod,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as BudgetPeriodCategory,
          ],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        6,
      );

      expect(result).toHaveLength(2);
      expect(result[0].month).toBe("Jan 2026");
      expect(result[1].month).toBe("Feb 2026");
      // First period under budget, second over budget
      expect(result[0].score).toBeGreaterThan(result[1].score);
    });

    it("should handle period category without budgetCategory relation", async () => {
      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          totalBudgeted: 800,
          actualExpenses: 500,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
          periodCategories: [
            {
              id: "pc-1",
              budgetPeriodId: "p-1",
              budgetCategoryId: "bc-1",
              categoryId: "cat-1",
              budgetedAmount: 500,
              actualAmount: 700,
              rolloverIn: 0,
              effectiveBudget: 500,
              rolloverOut: 0,
              budgetCategory: null as any,
              category: null,
              budgetPeriod: {} as BudgetPeriod,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as BudgetPeriodCategory,
          ],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        6,
      );

      // Should not crash -- budgetCategory is null, isEssential = false
      expect(result).toHaveLength(1);
      expect(result[0].score).toBeLessThan(100);
    });
  });

  describe("getSavingsRate - expense splits", () => {
    const currentMonthKey = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    })();

    it("should include expense splits in totals", async () => {
      const directExpenseRows = [{ month: currentMonthKey, total: "2000" }];
      const splitExpenseRows = [{ month: currentMonthKey, total: "500" }];

      let txCallCount = 0;
      transactionsRepository.createQueryBuilder.mockImplementation(() => {
        txCallCount++;
        if (txCallCount === 1) {
          // direct income
          return createMockQueryBuilder({
            getRawMany: jest
              .fn()
              .mockResolvedValue([{ month: currentMonthKey, total: "5000" }]),
          });
        }
        if (txCallCount === 2) {
          // direct expenses
          return createMockQueryBuilder({
            getRawMany: jest.fn().mockResolvedValue(directExpenseRows),
          });
        }
        return createMockQueryBuilder();
      });

      let splitCallCount = 0;
      splitsRepository.createQueryBuilder.mockImplementation(() => {
        splitCallCount++;
        if (splitCallCount === 1) {
          // income splits
          return createMockQueryBuilder();
        }
        // expense splits (2nd call)
        return createMockQueryBuilder({
          getRawMany: jest.fn().mockResolvedValue(splitExpenseRows),
        });
      });

      const result = await service.getSavingsRate("user-1", "budget-1", 1);

      // 2000 direct + 500 split = 2500 total expenses
      expect(result[0].expenses).toBe(2500);
      expect(result[0].income).toBe(5000);
      expect(result[0].savings).toBe(2500);
    });
  });

  describe("getHealthScore - trend bonus edge cases", () => {
    it("should return zero trend bonus when spending is getting worse", async () => {
      // latest period has higher spending % than previous
      periodsRepository.find.mockResolvedValueOnce([
        {
          id: "p-2",
          budgetId: "budget-1",
          periodStart: "2026-02-01",
          totalBudgeted: 800,
          actualExpenses: 900, // 112.5%
          status: PeriodStatus.CLOSED,
        },
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          totalBudgeted: 800,
          actualExpenses: 600, // 75%
          status: PeriodStatus.CLOSED,
        },
      ]);

      const result = await service.getHealthScore("user-1", "budget-1");

      expect(result.breakdown.trendBonus).toBe(0);
    });

    it("should return zero trend bonus when spending percentage is the same", async () => {
      periodsRepository.find.mockResolvedValueOnce([
        {
          id: "p-2",
          budgetId: "budget-1",
          periodStart: "2026-02-01",
          totalBudgeted: 800,
          actualExpenses: 600,
          status: PeriodStatus.CLOSED,
        },
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          totalBudgeted: 800,
          actualExpenses: 600,
          status: PeriodStatus.CLOSED,
        },
      ]);

      const result = await service.getHealthScore("user-1", "budget-1");

      expect(result.breakdown.trendBonus).toBe(0);
    });
  });

  describe("getHealthScore - null/edge branches", () => {
    it("should handle budget with no categories array (null)", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: null,
      });
      budgetsService.getSummary.mockResolvedValueOnce({
        budget: { ...mockBudget, categories: null },
        totalBudgeted: 0,
        totalSpent: 0,
        totalIncome: 0,
        remaining: 0,
        percentUsed: 0,
        categoryBreakdown: [],
      });
      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getHealthScore("user-1", "budget-1");

      expect(result.score).toBe(100);
      expect(result.categoryScores).toHaveLength(0);
    });

    it("should handle category without categoryId (null) in breakdown", async () => {
      budgetsService.getSummary.mockResolvedValueOnce({
        budget: mockBudget,
        totalBudgeted: 500,
        totalSpent: 200,
        totalIncome: 5000,
        remaining: 300,
        percentUsed: 40,
        categoryBreakdown: [
          {
            budgetCategoryId: "bc-1",
            categoryId: null,
            categoryName: "Groceries",
            budgeted: 500,
            spent: 200,
            remaining: 300,
            percentUsed: 40,
            isIncome: false,
          },
        ],
      });
      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getHealthScore("user-1", "budget-1");

      expect(result.categoryScores[0].categoryId).toBe("");
    });

    it("should handle zero totalBudgeted in trend bonus computation", async () => {
      periodsRepository.find.mockResolvedValueOnce([
        {
          id: "p-2",
          budgetId: "budget-1",
          periodStart: "2026-02-01",
          totalBudgeted: 0,
          actualExpenses: 100,
          status: PeriodStatus.CLOSED,
        },
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          totalBudgeted: 0,
          actualExpenses: 200,
          status: PeriodStatus.CLOSED,
        },
      ]);

      const result = await service.getHealthScore("user-1", "budget-1");

      // Should not crash -- totalBudgeted || 1 prevents division by zero
      expect(result.breakdown.trendBonus).toBeDefined();
    });

    it("should handle category between 80% and 100% used (no bonus, no penalty)", async () => {
      budgetsService.getSummary.mockResolvedValueOnce({
        budget: mockBudget,
        totalBudgeted: 500,
        totalSpent: 450,
        totalIncome: 5000,
        remaining: 50,
        percentUsed: 90,
        categoryBreakdown: [
          {
            budgetCategoryId: "bc-1",
            categoryId: "cat-1",
            categoryName: "Groceries",
            budgeted: 500,
            spent: 450,
            remaining: 50,
            percentUsed: 90,
            isIncome: false,
          },
        ],
      });
      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getHealthScore("user-1", "budget-1");

      // 90% is between 80% and 100%: no bonus, no penalty
      expect(result.breakdown.overBudgetDeductions).toBe(0);
      expect(result.breakdown.underBudgetBonus).toBe(0);
      expect(result.categoryScores[0].impact).toBe(0);
    });
  });

  describe("getHealthScoreHistory - null/edge branches", () => {
    it("should handle budget with null categories in history", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: null,
      });

      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          totalBudgeted: 500,
          actualExpenses: 200,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
          periodCategories: [
            {
              id: "pc-1",
              budgetPeriodId: "p-1",
              budgetCategoryId: "bc-1",
              categoryId: "cat-1",
              budgetedAmount: 500,
              actualAmount: 200,
              rolloverIn: 0,
              effectiveBudget: 500,
              rolloverOut: 0,
              budgetCategory: mockBudgetCategory,
              category: mockCategory,
              budgetPeriod: {} as BudgetPeriod,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as BudgetPeriodCategory,
          ],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        6,
      );

      // Should not crash -- bcMap built from null categories (empty)
      expect(result).toHaveLength(1);
    });

    it("should handle period with null periodCategories", async () => {
      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          totalBudgeted: 500,
          actualExpenses: 200,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
          periodCategories: null as any,
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        6,
      );

      expect(result).toHaveLength(1);
      expect(result[0].score).toBe(100);
    });

    it("should handle OPEN period with null categoryId (skips computation)", async () => {
      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-03-01",
          periodEnd: "2026-03-31",
          totalBudgeted: 500,
          actualExpenses: 0,
          actualIncome: 0,
          status: PeriodStatus.OPEN,
          periodCategories: [
            {
              id: "pc-1",
              budgetPeriodId: "p-1",
              budgetCategoryId: "bc-1",
              categoryId: null,
              budgetedAmount: 500,
              actualAmount: 200,
              rolloverIn: 0,
              effectiveBudget: 500,
              rolloverOut: 0,
              budgetCategory: mockBudgetCategory,
              category: null,
              budgetPeriod: {} as BudgetPeriod,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as BudgetPeriodCategory,
          ],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        6,
      );

      // OPEN + null categoryId means it uses stored actualAmount (200)
      // 200/500 = 40% -> under budget bonus
      expect(result).toHaveLength(1);
      expect(result[0].score).toBeGreaterThanOrEqual(90);
    });

    it("should handle computeCategoryActual with null query results", async () => {
      const periods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-03-01",
          periodEnd: "2026-03-31",
          totalBudgeted: 500,
          actualExpenses: 0,
          actualIncome: 0,
          status: PeriodStatus.OPEN,
          periodCategories: [
            {
              id: "pc-1",
              budgetPeriodId: "p-1",
              budgetCategoryId: "bc-1",
              categoryId: "cat-1",
              budgetedAmount: 500,
              actualAmount: 0,
              rolloverIn: 0,
              effectiveBudget: 500,
              rolloverOut: 0,
              budgetCategory: mockBudgetCategory,
              category: mockCategory,
              budgetPeriod: {} as BudgetPeriod,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as BudgetPeriodCategory,
          ],
        },
      ];

      periodsRepository.find.mockResolvedValueOnce(periods);

      // Return null results from queries (missing total field)
      const txQb = createMockQueryBuilder({
        getRawOne: jest.fn().mockResolvedValue(null),
      });
      const splitQb = createMockQueryBuilder({
        getRawOne: jest.fn().mockResolvedValue(null),
      });
      transactionsRepository.createQueryBuilder.mockReturnValueOnce(txQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        6,
      );

      // Should not crash -- null?.total || "0" => 0
      expect(result).toHaveLength(1);
      expect(result[0].score).toBe(100);
    });
  });

  describe("getSavingsRate - no expense categories", () => {
    const currentMonthKey = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    })();

    it("should skip expense queries when no expense categories exist", async () => {
      // Budget with only income categories (no expense categories)
      const transferCategory: BudgetCategory = {
        ...mockBudgetCategory,
        id: "bc-transfer",
        categoryId: null,
        isTransfer: true,
        isIncome: false,
      };

      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [mockIncomeCategory, transferCategory],
      });

      const incomeRows = [{ month: currentMonthKey, total: "5000" }];

      let txCallCount = 0;
      transactionsRepository.createQueryBuilder.mockImplementation(() => {
        txCallCount++;
        if (txCallCount === 1) {
          return createMockQueryBuilder({
            getRawMany: jest.fn().mockResolvedValue(incomeRows),
          });
        }
        return createMockQueryBuilder();
      });

      splitsRepository.createQueryBuilder.mockImplementation(() =>
        createMockQueryBuilder(),
      );

      const result = await service.getSavingsRate("user-1", "budget-1", 1);

      expect(result[0].income).toBe(5000);
      expect(result[0].expenses).toBe(0);
      expect(result[0].savings).toBe(5000);
      expect(result[0].savingsRate).toBe(100);
    });
  });

  describe("authorization", () => {
    it("should verify budget ownership via budgetsService.findOne", async () => {
      await service.getTrend("user-1", "budget-1", 6);
      expect(budgetsService.findOne).toHaveBeenCalledWith("user-1", "budget-1");
    });

    it("should propagate NotFoundException from budgetsService", async () => {
      budgetsService.findOne.mockRejectedValueOnce(
        new Error("Budget not found"),
      );

      await expect(
        service.getTrend("user-1", "nonexistent", 6),
      ).rejects.toThrow();
    });

    it("should propagate ForbiddenException from budgetsService", async () => {
      budgetsService.findOne.mockRejectedValueOnce(new Error("Forbidden"));

      await expect(
        service.getHealthScore("wrong-user", "budget-1"),
      ).rejects.toThrow();
    });
  });
});
