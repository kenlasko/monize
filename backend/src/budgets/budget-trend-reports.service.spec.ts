import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BudgetTrendReportsService } from "./budget-trend-reports.service";
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

describe("BudgetTrendReportsService", () => {
  let service: BudgetTrendReportsService;
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

  const mockParentCategory: Category = {
    id: "cat-parent",
    userId: "user-1",
    parentId: null,
    parent: null,
    children: [],
    name: "Food",
    description: null,
    icon: null,
    color: null,
    isIncome: false,
    isSystem: false,
    createdAt: new Date("2025-01-01"),
  };

  const mockChildCategory: Category = {
    id: "cat-child",
    userId: "user-1",
    parentId: "cat-parent",
    parent: mockParentCategory,
    children: [],
    name: "Fast Food",
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
    category: null as unknown as Category,
    categoryGroup: null,
    transferAccountId: "acct-savings",
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
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BudgetTrendReportsService,
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

    service = module.get<BudgetTrendReportsService>(
      BudgetTrendReportsService,
    );
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

    it("should include current open period with computed actuals", async () => {
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

    it("should handle zero budgeted in open period without division error", async () => {
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
        totalBudgeted: 0,
        status: PeriodStatus.OPEN,
      };

      periodsRepository.find.mockResolvedValueOnce(closedPeriods);
      periodsRepository.findOne.mockResolvedValueOnce(openPeriod);

      const result = await service.getTrend("user-1", "budget-1", 6);

      expect(result).toHaveLength(2);
      expect(result[1].percentUsed).toBe(0);
    });

    it("should fall back to live transactions when no closed periods exist", async () => {
      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getTrend("user-1", "budget-1", 3);

      expect(result).toHaveLength(3);
      expect(budgetsService.findOne).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
      );
    });

    it("should return empty when no categories and no transfers in live mode", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [],
      });
      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getTrend("user-1", "budget-1", 6);

      expect(result).toEqual([]);
    });
  });

  describe("getTrend - computePeriodActuals with transfers", () => {
    it("should query transfer accounts when budget has transfer categories", async () => {
      const budgetWithTransfers: Budget = {
        ...mockBudget,
        categories: [
          mockBudgetCategory,
          mockTransferCategory,
          mockIncomeCategory,
        ],
      };
      budgetsService.findOne.mockResolvedValueOnce(budgetWithTransfers);

      const closedPeriods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          totalBudgeted: 700,
          actualExpenses: 600,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
        },
      ];

      const openPeriod: Partial<BudgetPeriod> = {
        id: "p-2",
        budgetId: "budget-1",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
        totalBudgeted: 700,
        status: PeriodStatus.OPEN,
      };

      periodsRepository.find.mockResolvedValueOnce(closedPeriods);
      periodsRepository.findOne.mockResolvedValueOnce(openPeriod);

      // direct transactions query
      const directQb = createMockQueryBuilder({
        getRawOne: jest.fn().mockResolvedValue({ total: "-300" }),
      });
      // splits query
      const splitQb = createMockQueryBuilder({
        getRawOne: jest.fn().mockResolvedValue({ total: "-50" }),
      });
      // transfer query
      const transferQb = createMockQueryBuilder({
        getRawOne: jest.fn().mockResolvedValue({ total: "-150" }),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(directQb)
        .mockReturnValueOnce(transferQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getTrend("user-1", "budget-1", 6);

      expect(result).toHaveLength(2);
      // actuals = -(-300 + -50 + -150) = 500
      expect(result[1].actual).toBe(500);
    });

    it("should handle budget with only transfer categories (no regular categories)", async () => {
      const budgetOnlyTransfers: Budget = {
        ...mockBudget,
        categories: [mockTransferCategory, mockIncomeCategory],
      };
      budgetsService.findOne.mockResolvedValueOnce(budgetOnlyTransfers);

      const closedPeriods: Partial<BudgetPeriod>[] = [
        {
          id: "p-1",
          budgetId: "budget-1",
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          totalBudgeted: 200,
          actualExpenses: 180,
          actualIncome: 5000,
          status: PeriodStatus.CLOSED,
        },
      ];

      const openPeriod: Partial<BudgetPeriod> = {
        id: "p-2",
        budgetId: "budget-1",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
        totalBudgeted: 200,
        status: PeriodStatus.OPEN,
      };

      periodsRepository.find.mockResolvedValueOnce(closedPeriods);
      periodsRepository.findOne.mockResolvedValueOnce(openPeriod);

      const transferQb = createMockQueryBuilder({
        getRawOne: jest.fn().mockResolvedValue({ total: "-175" }),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(
        transferQb,
      );

      const result = await service.getTrend("user-1", "budget-1", 6);

      expect(result).toHaveLength(2);
      expect(result[1].actual).toBe(175);
    });
  });

  describe("getTrend - computeLiveTrendFromTransactions", () => {
    it("should return empty when budget has no expense categories or transfers", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [mockIncomeCategory],
      });
      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getTrend("user-1", "budget-1", 3);

      expect(result).toEqual([]);
    });

    it("should compute live trend with category and split data", async () => {
      periodsRepository.find.mockResolvedValueOnce([]);

      const today = new Date();
      const monthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;

      // Direct transactions query builder
      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ month: monthKey, total: "250" }]),
      });
      // Splits query builder
      const splitQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ month: monthKey, total: "100" }]),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(directQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getTrend("user-1", "budget-1", 3);

      expect(result).toHaveLength(3);

      // The current month should have actual = 250 + 100 = 350
      const currentMonth = result[result.length - 1];
      expect(currentMonth.actual).toBe(350);

      // Total budgeted = 500 + 300 = 800 (non-income categories)
      expect(currentMonth.budgeted).toBe(800);
    });

    it("should compute live trend including transfer accounts", async () => {
      const budgetWithTransfers: Budget = {
        ...mockBudget,
        categories: [
          mockBudgetCategory,
          mockTransferCategory,
          mockIncomeCategory,
        ],
      };
      budgetsService.findOne.mockResolvedValueOnce(budgetWithTransfers);
      periodsRepository.find.mockResolvedValueOnce([]);

      const today = new Date();
      const monthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;

      // Direct transactions query
      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ month: monthKey, total: "200" }]),
      });
      // Splits query
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      // Transfer query
      const transferQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ month: monthKey, total: "150" }]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(directQb)
        .mockReturnValueOnce(transferQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getTrend("user-1", "budget-1", 3);

      expect(result).toHaveLength(3);

      const currentMonth = result[result.length - 1];
      // 200 (direct) + 150 (transfer)
      expect(currentMonth.actual).toBe(350);

      // totalBudgeted = 500 (cat) + 200 (transfer) = 700
      expect(currentMonth.budgeted).toBe(700);
    });

    it("should compute live trend with only transfers (no category IDs)", async () => {
      const budgetOnlyTransfers: Budget = {
        ...mockBudget,
        categories: [mockTransferCategory, mockIncomeCategory],
      };
      budgetsService.findOne.mockResolvedValueOnce(budgetOnlyTransfers);
      periodsRepository.find.mockResolvedValueOnce([]);

      const today = new Date();
      const monthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;

      const transferQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ month: monthKey, total: "180" }]),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(
        transferQb,
      );

      const result = await service.getTrend("user-1", "budget-1", 3);

      expect(result).toHaveLength(3);
      const currentMonth = result[result.length - 1];
      expect(currentMonth.actual).toBe(180);
      expect(currentMonth.budgeted).toBe(200);
    });

    it("should handle zero totalBudgeted in live trend", async () => {
      const zeroBudget: Budget = {
        ...mockBudget,
        categories: [{ ...mockBudgetCategory, amount: 0 }],
      };
      budgetsService.findOne.mockResolvedValueOnce(zeroBudget);
      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getTrend("user-1", "budget-1", 2);

      expect(result).toHaveLength(2);
      for (const point of result) {
        expect(point.percentUsed).toBe(0);
      }
    });

    it("should fill zero actuals for months without transactions", async () => {
      periodsRepository.find.mockResolvedValueOnce([]);

      // Return empty rows -- no transactions in any month
      transactionsRepository.createQueryBuilder.mockReturnValueOnce(
        createMockQueryBuilder({ getRawMany: jest.fn().mockResolvedValue([]) }),
      );
      splitsRepository.createQueryBuilder.mockReturnValueOnce(
        createMockQueryBuilder({ getRawMany: jest.fn().mockResolvedValue([]) }),
      );

      const result = await service.getTrend("user-1", "budget-1", 3);

      expect(result).toHaveLength(3);
      for (const point of result) {
        expect(point.actual).toBe(0);
      }
    });
  });

  describe("getCategoryTrend", () => {
    it("should return category trend from periods", async () => {
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

      const result = await service.getCategoryTrend(
        "user-1",
        "budget-1",
        6,
      );

      expect(result).toHaveLength(1);
      expect(result[0].categoryId).toBe("cat-1");
      expect(result[0].categoryName).toBe("Groceries");
      expect(result[0].data[0].budgeted).toBe(500);
      expect(result[0].data[0].actual).toBe(420);
    });

    it("should show parent:child category name when category has parent", async () => {
      const mockPeriodCat: Partial<BudgetPeriodCategory> = {
        id: "bpc-child",
        budgetPeriodId: "p-1",
        budgetCategoryId: "bc-child",
        categoryId: "cat-child",
        budgetedAmount: 100,
        actualAmount: 80,
        budgetCategory: { ...mockBudgetCategory, isIncome: false },
        category: mockChildCategory,
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

      const result = await service.getCategoryTrend(
        "user-1",
        "budget-1",
        6,
      );

      expect(result).toHaveLength(1);
      expect(result[0].categoryName).toBe("Food: Fast Food");
    });

    it("should show 'Uncategorized' when category is null", async () => {
      const mockPeriodCat: Partial<BudgetPeriodCategory> = {
        id: "bpc-null",
        budgetPeriodId: "p-1",
        budgetCategoryId: "bc-1",
        categoryId: "cat-1",
        budgetedAmount: 100,
        actualAmount: 50,
        budgetCategory: { ...mockBudgetCategory, isIncome: false },
        category: null as unknown as Category,
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

      const result = await service.getCategoryTrend(
        "user-1",
        "budget-1",
        6,
      );

      expect(result).toHaveLength(1);
      expect(result[0].categoryName).toBe("Uncategorized");
    });

    it("should filter by category IDs when periods exist", async () => {
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

      const result = await service.getCategoryTrend(
        "user-1",
        "budget-1",
        6,
        ["cat-1"],
      );

      expect(result).toHaveLength(1);
      expect(result[0].categoryId).toBe("cat-1");
    });

    it("should compute live actuals for open period categories", async () => {
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

      const result = await service.getCategoryTrend(
        "user-1",
        "budget-1",
        6,
      );

      expect(result).toHaveLength(1);
      expect(result[0].data[0].actual).toBe(325);
      expect(result[0].data[0].budgeted).toBe(500);
      expect(result[0].data[0].percentUsed).toBe(65);
    });

    it("should fall back to live category trend when no periods exist", async () => {
      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getCategoryTrend(
        "user-1",
        "budget-1",
        3,
      );

      // Should invoke computeLiveCategoryTrend which uses budget categories
      // mockBudget has 2 expense categories: cat-1, cat-2
      expect(result).toHaveLength(2);
      expect(result[0].categoryId).toBe("cat-1");
      expect(result[1].categoryId).toBe("cat-2");
      // Each series should have 3 months of data
      expect(result[0].data).toHaveLength(3);
      expect(result[1].data).toHaveLength(3);
    });

    it("should fall back to live category trend with category filter", async () => {
      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getCategoryTrend(
        "user-1",
        "budget-1",
        3,
        ["cat-1"],
      );

      expect(result).toHaveLength(1);
      expect(result[0].categoryId).toBe("cat-1");
    });
  });

  describe("getCategoryTrend - computeLiveCategoryTrend", () => {
    it("should return empty when all categories are income or transfer", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [mockIncomeCategory, mockTransferCategory],
      });
      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getCategoryTrend(
        "user-1",
        "budget-1",
        3,
      );

      expect(result).toEqual([]);
    });

    it("should return empty when filtered categories yield no matches", async () => {
      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getCategoryTrend(
        "user-1",
        "budget-1",
        3,
        ["nonexistent-cat"],
      );

      expect(result).toEqual([]);
    });

    it("should compute live category trend with actual transaction data", async () => {
      periodsRepository.find.mockResolvedValueOnce([]);

      const today = new Date();
      const monthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;

      const directQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { categoryId: "cat-1", month: monthKey, total: "350" },
          { categoryId: "cat-2", month: monthKey, total: "180" },
        ]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { categoryId: "cat-1", month: monthKey, total: "50" },
        ]),
      });

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(directQb);
      splitsRepository.createQueryBuilder.mockReturnValueOnce(splitQb);

      const result = await service.getCategoryTrend(
        "user-1",
        "budget-1",
        3,
      );

      expect(result).toHaveLength(2);

      const cat1 = result.find((s) => s.categoryId === "cat-1");
      const cat2 = result.find((s) => s.categoryId === "cat-2");

      // Current month for cat-1: 350 + 50 = 400
      const cat1CurrentMonth = cat1!.data[cat1!.data.length - 1];
      expect(cat1CurrentMonth.actual).toBe(400);
      expect(cat1CurrentMonth.budgeted).toBe(500);
      expect(cat1CurrentMonth.variance).toBe(-100);

      // Current month for cat-2: 180
      const cat2CurrentMonth = cat2!.data[cat2!.data.length - 1];
      expect(cat2CurrentMonth.actual).toBe(180);
      expect(cat2CurrentMonth.budgeted).toBe(300);
    });

    it("should display parent:child name for categories with parents in live mode", async () => {
      const childBudgetCat: BudgetCategory = {
        ...mockBudgetCategory,
        id: "bc-child",
        categoryId: "cat-child",
        category: mockChildCategory,
      };
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [childBudgetCat],
      });
      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getCategoryTrend(
        "user-1",
        "budget-1",
        2,
      );

      expect(result).toHaveLength(1);
      expect(result[0].categoryName).toBe("Food: Fast Food");
    });

    it("should display 'Uncategorized' for null category in live mode", async () => {
      const nullCatBudgetCat: BudgetCategory = {
        ...mockBudgetCategory,
        id: "bc-nocat",
        categoryId: "cat-nocat",
        category: null as unknown as Category,
      };
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [nullCatBudgetCat],
      });
      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getCategoryTrend(
        "user-1",
        "budget-1",
        2,
      );

      expect(result).toHaveLength(1);
      expect(result[0].categoryName).toBe("Uncategorized");
    });

    it("should handle zero budgeted amount in live category trend", async () => {
      const zeroBudgetCat: BudgetCategory = {
        ...mockBudgetCategory,
        amount: 0,
      };
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [zeroBudgetCat],
      });
      periodsRepository.find.mockResolvedValueOnce([]);

      const result = await service.getCategoryTrend(
        "user-1",
        "budget-1",
        2,
      );

      expect(result).toHaveLength(1);
      for (const point of result[0].data) {
        expect(point.percentUsed).toBe(0);
      }
    });

    it("should fill zero actuals for months without matching transactions", async () => {
      periodsRepository.find.mockResolvedValueOnce([]);

      transactionsRepository.createQueryBuilder.mockReturnValueOnce(
        createMockQueryBuilder({ getRawMany: jest.fn().mockResolvedValue([]) }),
      );
      splitsRepository.createQueryBuilder.mockReturnValueOnce(
        createMockQueryBuilder({ getRawMany: jest.fn().mockResolvedValue([]) }),
      );

      const result = await service.getCategoryTrend(
        "user-1",
        "budget-1",
        3,
      );

      expect(result).toHaveLength(2);
      for (const series of result) {
        expect(series.data).toHaveLength(3);
        for (const point of series.data) {
          expect(point.actual).toBe(0);
        }
      }
    });
  });
});
