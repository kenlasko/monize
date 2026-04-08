import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BudgetActivityReportsService } from "./budget-activity-reports.service";
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

describe("BudgetActivityReportsService", () => {
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
      ],
    }).compile();

    service = module.get<BudgetActivityReportsService>(
      BudgetActivityReportsService,
    );
  });

  describe("getDailySpending", () => {
    it("should use open period date range when one exists", async () => {
      const openPeriod: Partial<BudgetPeriod> = {
        id: "p-1",
        budgetId: "budget-1",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
        status: PeriodStatus.OPEN,
      };

      periodsRepository.findOne.mockResolvedValueOnce(openPeriod);

      const directQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { date: "2026-02-05", total: "50.00" },
          { date: "2026-02-10", total: "75.50" },
        ]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(directQb)
        .mockReturnValueOnce(splitQb);
      // The split query builder is also called
      splitsRepository.createQueryBuilder.mockReturnValueOnce(
        createMockQueryBuilder(),
      );

      const result = await service.getDailySpending("user-1", "budget-1");

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ date: "2026-02-05", amount: 50 });
      expect(result[1]).toEqual({ date: "2026-02-10", amount: 75.5 });
      expect(periodsRepository.findOne).toHaveBeenCalledWith({
        where: { budgetId: "budget-1", status: PeriodStatus.OPEN },
      });
    });

    it("should fall back to budget periodStart when no open period exists", async () => {
      periodsRepository.findOne.mockResolvedValueOnce(null);

      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ date: "2026-02-03", total: "25.00" }]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(directQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getDailySpending("user-1", "budget-1");

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ date: "2026-02-03", amount: 25 });
      // Verify the budget's periodStart was used (fallback path)
      expect(budgetsService.findOne).toHaveBeenCalledWith("user-1", "budget-1");
    });

    it("should merge direct and split spending on the same date", async () => {
      const openPeriod: Partial<BudgetPeriod> = {
        id: "p-1",
        budgetId: "budget-1",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
        status: PeriodStatus.OPEN,
      };

      periodsRepository.findOne.mockResolvedValueOnce(openPeriod);

      const directQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { date: "2026-02-05", total: "30.00" },
          { date: "2026-02-10", total: "40.00" },
        ]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { date: "2026-02-05", total: "20.00" },
          { date: "2026-02-12", total: "15.00" },
        ]),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(directQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getDailySpending("user-1", "budget-1");

      expect(result).toHaveLength(3);
      // Sorted by date
      expect(result[0]).toEqual({ date: "2026-02-05", amount: 50 });
      expect(result[1]).toEqual({ date: "2026-02-10", amount: 40 });
      expect(result[2]).toEqual({ date: "2026-02-12", amount: 15 });
    });

    it("should include transfer account queries when budget has transfer categories", async () => {
      const budgetWithTransfers: Budget = {
        ...mockBudget,
        categories: [
          mockBudgetCategory,
          mockTransferCategory,
          mockIncomeCategory,
        ],
      };

      budgetsService.findOne.mockResolvedValueOnce(budgetWithTransfers);

      const openPeriod: Partial<BudgetPeriod> = {
        id: "p-1",
        budgetId: "budget-1",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
        status: PeriodStatus.OPEN,
      };

      periodsRepository.findOne.mockResolvedValueOnce(openPeriod);

      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ date: "2026-02-05", total: "100.00" }]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      const transferQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { date: "2026-02-05", total: "200.00" },
          { date: "2026-02-15", total: "50.00" },
        ]),
      });

      // Direct spending query, split query, then transfer query
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(directQb)
        .mockReturnValueOnce(transferQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getDailySpending("user-1", "budget-1");

      // 3 queries should have been created
      expect(transactionsRepository.createQueryBuilder).toHaveBeenCalledTimes(
        2,
      );
      expect(splitsRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
      // Feb 5: 100 direct + 200 transfer = 300
      expect(result[0]).toEqual({ date: "2026-02-05", amount: 300 });
      expect(result[1]).toEqual({ date: "2026-02-15", amount: 50 });
    });

    it("should return empty array when no expense categories exist", async () => {
      const incomeOnlyBudget: Budget = {
        ...mockBudget,
        categories: [mockIncomeCategory],
      };

      budgetsService.findOne.mockResolvedValueOnce(incomeOnlyBudget);
      periodsRepository.findOne.mockResolvedValueOnce(null);

      const result = await service.getDailySpending("user-1", "budget-1");

      expect(result).toEqual([]);
      // No queries should be created since there are no categoryIds or transferAccountIds
      expect(transactionsRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(splitsRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("should handle only transfer categories with no regular categories", async () => {
      const transferOnlyBudget: Budget = {
        ...mockBudget,
        categories: [mockTransferCategory, mockIncomeCategory],
      };

      budgetsService.findOne.mockResolvedValueOnce(transferOnlyBudget);

      const openPeriod: Partial<BudgetPeriod> = {
        id: "p-1",
        budgetId: "budget-1",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
        status: PeriodStatus.OPEN,
      };

      periodsRepository.findOne.mockResolvedValueOnce(openPeriod);

      const transferQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ date: "2026-02-20", total: "150.00" }]),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(transferQb);

      const result = await service.getDailySpending("user-1", "budget-1");

      // Only the transfer query should be created (no direct/split queries)
      expect(transactionsRepository.createQueryBuilder).toHaveBeenCalledTimes(
        1,
      );
      expect(splitsRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ date: "2026-02-20", amount: 150 });
    });

    it("should handle empty query results", async () => {
      periodsRepository.findOne.mockResolvedValueOnce({
        id: "p-1",
        budgetId: "budget-1",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
        status: PeriodStatus.OPEN,
      });

      const result = await service.getDailySpending("user-1", "budget-1");

      expect(result).toEqual([]);
    });

    it("should handle null total values in query results", async () => {
      periodsRepository.findOne.mockResolvedValueOnce({
        id: "p-1",
        budgetId: "budget-1",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
        status: PeriodStatus.OPEN,
      });

      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ date: "2026-02-05", total: null }]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(directQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getDailySpending("user-1", "budget-1");

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ date: "2026-02-05", amount: 0 });
    });

    it("should sort results by date ascending", async () => {
      periodsRepository.findOne.mockResolvedValueOnce({
        id: "p-1",
        budgetId: "budget-1",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
        status: PeriodStatus.OPEN,
      });

      const directQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { date: "2026-02-20", total: "30.00" },
          { date: "2026-02-05", total: "10.00" },
          { date: "2026-02-12", total: "20.00" },
        ]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(directQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getDailySpending("user-1", "budget-1");

      expect(result[0].date).toBe("2026-02-05");
      expect(result[1].date).toBe("2026-02-12");
      expect(result[2].date).toBe("2026-02-20");
    });

    it("should round amounts to two decimal places", async () => {
      periodsRepository.findOne.mockResolvedValueOnce({
        id: "p-1",
        budgetId: "budget-1",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
        status: PeriodStatus.OPEN,
      });

      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ date: "2026-02-05", total: "33.335" }]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(directQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getDailySpending("user-1", "budget-1");

      expect(result[0].amount).toBe(33.34);
    });

    it("should handle budget with no categories array", async () => {
      const budgetNoCats: Budget = {
        ...mockBudget,
        categories: undefined as unknown as BudgetCategory[],
      };

      budgetsService.findOne.mockResolvedValueOnce(budgetNoCats);
      periodsRepository.findOne.mockResolvedValueOnce(null);

      const result = await service.getDailySpending("user-1", "budget-1");

      expect(result).toEqual([]);
    });

    it("should truncate date strings to 10 characters", async () => {
      periodsRepository.findOne.mockResolvedValueOnce({
        id: "p-1",
        budgetId: "budget-1",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
        status: PeriodStatus.OPEN,
      });

      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([
            { date: "2026-02-05T00:00:00.000Z", total: "10.00" },
          ]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(directQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getDailySpending("user-1", "budget-1");

      expect(result[0].date).toBe("2026-02-05");
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
    it("should return empty array when no expense categories exist", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [mockIncomeCategory],
      });

      const result = await service.getSeasonalPatterns("user-1", "budget-1");

      expect(result).toEqual([]);
    });

    it("should compute seasonal patterns from transaction data", async () => {
      const directQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { categoryId: "cat-1", year: 2025, month: 6, total: "800" },
          { categoryId: "cat-1", year: 2025, month: 7, total: "200" },
          { categoryId: "cat-1", year: 2025, month: 12, total: "900" },
        ]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(directQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getSeasonalPatterns("user-1", "budget-1");

      expect(result).toHaveLength(1);
      expect(result[0].categoryId).toBe("cat-1");
      expect(result[0].categoryName).toBe("Groceries");
      expect(result[0].monthlyAverages).toHaveLength(12);
      expect(result[0].typicalMonthlySpend).toBeGreaterThan(0);
    });

    it("should merge split spending with direct spending", async () => {
      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([
            { categoryId: "cat-1", year: 2025, month: 3, total: "100" },
          ]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([
            { categoryId: "cat-1", year: 2025, month: 3, total: "50" },
          ]),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(directQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getSeasonalPatterns("user-1", "budget-1");

      // March (month 3) should have 150 (100 + 50)
      const marchAvg = result[0].monthlyAverages.find((m) => m.month === 3);
      expect(marchAvg!.average).toBe(150);
    });

    it("should identify high months above threshold", async () => {
      // Create data where December is very high relative to others
      const directQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { categoryId: "cat-1", year: 2025, month: 1, total: "100" },
          { categoryId: "cat-1", year: 2025, month: 2, total: "110" },
          { categoryId: "cat-1", year: 2025, month: 3, total: "105" },
          { categoryId: "cat-1", year: 2025, month: 4, total: "95" },
          { categoryId: "cat-1", year: 2025, month: 5, total: "100" },
          { categoryId: "cat-1", year: 2025, month: 6, total: "100" },
          { categoryId: "cat-1", year: 2025, month: 7, total: "100" },
          { categoryId: "cat-1", year: 2025, month: 8, total: "100" },
          { categoryId: "cat-1", year: 2025, month: 9, total: "100" },
          { categoryId: "cat-1", year: 2025, month: 10, total: "100" },
          { categoryId: "cat-1", year: 2025, month: 11, total: "100" },
          { categoryId: "cat-1", year: 2025, month: 12, total: "1000" },
        ]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(directQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getSeasonalPatterns("user-1", "budget-1");

      expect(result[0].highMonths).toContain(12);
    });

    it("should handle categories with null categoryId", async () => {
      const budgetWithNull: Budget = {
        ...mockBudget,
        categories: [
          { ...mockBudgetCategory, categoryId: null, category: null },
          mockIncomeCategory,
        ],
      };

      budgetsService.findOne.mockResolvedValueOnce(budgetWithNull);

      const result = await service.getSeasonalPatterns("user-1", "budget-1");

      expect(result).toEqual([]);
    });

    it("should use parent name when category has a parent", async () => {
      const parentCategory: Category = {
        ...mockCategory,
        id: "cat-parent",
        name: "Food",
      };

      const childCategory: Category = {
        ...mockCategory,
        id: "cat-1",
        name: "Groceries",
        parentId: "cat-parent",
        parent: parentCategory,
      };

      const budgetWithChild: Budget = {
        ...mockBudget,
        categories: [
          { ...mockBudgetCategory, category: childCategory },
          mockBudgetCategory2,
          mockIncomeCategory,
        ],
      };

      budgetsService.findOne.mockResolvedValueOnce(budgetWithChild);

      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([
            { categoryId: "cat-1", year: 2025, month: 6, total: "100" },
          ]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(directQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getSeasonalPatterns("user-1", "budget-1");

      const catResult = result.find((r) => r.categoryId === "cat-1");
      expect(catResult!.categoryName).toBe("Food: Groceries");
    });

    it("should handle all zero spending", async () => {
      const directQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(directQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getSeasonalPatterns("user-1", "budget-1");

      expect(result).toEqual([]);
    });
  });
});
