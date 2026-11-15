import { DataSource } from "typeorm";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  BudgetGeneratorService,
  CategoryAnalysis,
} from "./budget-generator.service";
import { Budget, BudgetType, BudgetStrategy } from "./entities/budget.entity";
import {
  BudgetCategory,
  RolloverType,
} from "./entities/budget-category.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { Account } from "../accounts/entities/account.entity";
import {
  BudgetBucket,
  BudgetBucketTargetType,
} from "./entities/budget-bucket.entity";
import { BadRequestException } from "@nestjs/common";
import { withScopedDb } from "../common/db/scoped-db";
import { BudgetProfile } from "./dto/generate-budget.dto";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("BudgetGeneratorService", () => {
  let scopedDataSource: DataSourceMock;
  let service: BudgetGeneratorService;
  let transactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let accountsRepository: Record<string, jest.Mock>;
  let budgetsRepository: Record<string, jest.Mock>;
  let budgetCategoriesRepository: Record<string, jest.Mock>;
  let budgetBucketsRepository: Record<string, jest.Mock>;

  const createMockQueryBuilder = (
    overrides: Record<string, jest.Mock> = {},
  ) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getRawMany: jest.fn().mockResolvedValue([]),
    getCount: jest.fn().mockResolvedValue(0),
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    transactionsRepository = {
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    splitsRepository = {
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    categoriesRepository = {
      find: jest.fn().mockResolvedValue([{ id: "cat-1" }, { id: "cat-2" }]),
      findOne: jest.fn(),
    };

    accountsRepository = {
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    };

    budgetsRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-budget" })),
      save: jest.fn().mockImplementation((data) => ({
        ...data,
        id: data.id || "new-budget",
      })),
      findOne: jest.fn(),
    };

    budgetCategoriesRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-bc" })),
      save: jest.fn().mockImplementation((data) => {
        if (Array.isArray(data)) {
          return data.map((d, i) => ({ ...d, id: d.id || `new-bc-${i}` }));
        }
        return { ...data, id: data.id || "new-bc" };
      }),
    };

    budgetBucketsRepository = {
      create: jest.fn().mockImplementation((data) => ({ ...data })),
      save: jest
        .fn()
        .mockImplementation((rows: unknown[]) =>
          rows.map((r, i) => ({ ...(r as object), id: `new-bucket-${i}` })),
        ),
    };

    ({ dataSource: scopedDataSource } = createScopedDbMocks([
      [Transaction, transactionsRepository as never],
      [TransactionSplit, splitsRepository as never],
      [Category, categoriesRepository as never],
      [Account, accountsRepository as never],
      [Budget, budgetsRepository as never],
      [BudgetCategory, budgetCategoriesRepository as never],
      [BudgetBucket, budgetBucketsRepository as never],
    ]));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BudgetGeneratorService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        {
          provide: getRepositoryToken(TransactionSplit),
          useValue: splitsRepository,
        },
        {
          provide: getRepositoryToken(Category),
          useValue: categoriesRepository,
        },
        {
          provide: getRepositoryToken(Account),
          useValue: accountsRepository,
        },
        {
          provide: getRepositoryToken(Budget),
          useValue: budgetsRepository,
        },
        {
          provide: getRepositoryToken(BudgetCategory),
          useValue: budgetCategoriesRepository,
        },
        { provide: DataSource, useValue: scopedDataSource },
      ],
    }).compile();

    service = module.get<BudgetGeneratorService>(BudgetGeneratorService);
  });

  describe("percentile", () => {
    it("returns 0 for empty array", () => {
      expect(service.percentile([], 50)).toBe(0);
    });

    it("returns the only element for single-element array", () => {
      expect(service.percentile([100], 50)).toBe(100);
      expect(service.percentile([100], 25)).toBe(100);
      expect(service.percentile([100], 75)).toBe(100);
    });

    it("returns min for 0th percentile", () => {
      expect(service.percentile([10, 20, 30, 40, 50], 0)).toBe(10);
    });

    it("returns max for 100th percentile", () => {
      expect(service.percentile([10, 20, 30, 40, 50], 100)).toBe(50);
    });

    it("calculates median (p50) correctly for odd-length arrays", () => {
      expect(service.percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    });

    it("calculates median (p50) correctly for even-length arrays", () => {
      expect(service.percentile([10, 20, 30, 40], 50)).toBe(25);
    });

    it("calculates p25 correctly", () => {
      const sorted = [100, 200, 300, 400, 500];
      expect(service.percentile(sorted, 25)).toBe(200);
    });

    it("calculates p75 correctly", () => {
      const sorted = [100, 200, 300, 400, 500];
      expect(service.percentile(sorted, 75)).toBe(400);
    });

    it("interpolates between values for non-exact percentiles", () => {
      const sorted = [10, 20];
      expect(service.percentile(sorted, 50)).toBe(15);
    });
  });

  describe("mean", () => {
    it("returns 0 for empty array", () => {
      expect(service.mean([])).toBe(0);
    });

    it("returns the value for single element", () => {
      expect(service.mean([42])).toBe(42);
    });

    it("calculates average correctly", () => {
      expect(service.mean([10, 20, 30])).toBe(20);
    });

    it("handles decimal values", () => {
      expect(service.mean([1.5, 2.5])).toBe(2);
    });

    it("handles zeros", () => {
      expect(service.mean([0, 0, 0, 100])).toBe(25);
    });
  });

  describe("standardDeviation", () => {
    it("returns 0 for empty array", () => {
      expect(service.standardDeviation([])).toBe(0);
    });

    it("returns 0 for single element", () => {
      expect(service.standardDeviation([42])).toBe(0);
    });

    it("returns 0 for identical values", () => {
      expect(service.standardDeviation([5, 5, 5, 5])).toBe(0);
    });

    it("calculates standard deviation correctly", () => {
      const values = [2, 4, 4, 4, 5, 5, 7, 9];
      const result = service.standardDeviation(values);
      expect(result).toBeCloseTo(2.0, 1);
    });

    it("handles two values", () => {
      const result = service.standardDeviation([0, 10]);
      expect(result).toBe(5);
    });
  });

  describe("isFixedExpense", () => {
    it("returns false for arrays with fewer than 2 non-zero values", () => {
      expect(service.isFixedExpense([0, 0, 100])).toBe(false);
      expect(service.isFixedExpense([0, 0, 0])).toBe(false);
    });

    it("returns true for consistent amounts (low coefficient of variation)", () => {
      expect(service.isFixedExpense([100, 100, 100, 100, 100, 100])).toBe(true);
    });

    it("returns true for near-consistent amounts (CV < 0.1)", () => {
      expect(service.isFixedExpense([99, 100, 101, 100, 99, 100])).toBe(true);
    });

    it("returns false for highly variable amounts", () => {
      expect(service.isFixedExpense([50, 200, 30, 500, 100, 10])).toBe(false);
    });

    it("identifies subscriptions as fixed", () => {
      expect(
        service.isFixedExpense([14.99, 14.99, 14.99, 14.99, 14.99, 14.99]),
      ).toBe(true);
    });

    it("returns false when average is 0 (all zeros after filtering)", () => {
      expect(service.isFixedExpense([0, 0, 0, 0])).toBe(false);
    });
  });

  describe("detectSeasonalPeaks", () => {
    it("returns empty array for short arrays", () => {
      expect(service.detectSeasonalPeaks([100, 200])).toEqual([]);
    });

    it("returns empty array when standard deviation is 0", () => {
      expect(service.detectSeasonalPeaks([100, 100, 100])).toEqual([]);
    });

    it("returns empty array when average is 0", () => {
      expect(service.detectSeasonalPeaks([0, 0, 0])).toEqual([]);
    });

    it("detects months with spending significantly above average", () => {
      const amounts = [
        100, 100, 100, 100, 100, 500, 100, 100, 100, 100, 100, 100,
      ];
      const peaks = service.detectSeasonalPeaks(amounts);
      expect(peaks.length).toBeGreaterThan(0);
    });

    it("returns empty for uniform spending", () => {
      const amounts = [
        100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
      ];
      const peaks = service.detectSeasonalPeaks(amounts);
      expect(peaks).toEqual([]);
    });
  });

  describe("getSuggestedAmount", () => {
    const mockCat: Omit<CategoryAnalysis, "suggested"> = {
      categoryId: "cat-1",
      categoryName: "Groceries",
      isIncome: false,
      average: 400,
      median: 350,
      p25: 250,
      p75: 500,
      min: 200,
      max: 600,
      stdDev: 100,
      monthlyAmounts: [200, 300, 350, 400, 500, 600],
      monthlyOccurrences: 6,
      isFixed: false,
      seasonalMonths: [],
    };

    it("returns p75 for COMFORTABLE profile", () => {
      expect(
        service.getSuggestedAmount(mockCat, BudgetProfile.COMFORTABLE),
      ).toBe(500);
    });

    it("returns median for ON_TRACK profile", () => {
      expect(service.getSuggestedAmount(mockCat, BudgetProfile.ON_TRACK)).toBe(
        350,
      );
    });

    it("returns p25 for AGGRESSIVE profile", () => {
      expect(
        service.getSuggestedAmount(mockCat, BudgetProfile.AGGRESSIVE),
      ).toBe(250);
    });
  });

  describe("generate", () => {
    it("returns analysis with empty categories when no transactions exist", async () => {
      const result = await service.generate("user-1", {
        analysisMonths: 3,
      });

      expect(result.categories).toEqual([]);
      expect(result.estimatedMonthlyIncome).toBe(0);
      expect(result.totalBudgeted).toBe(0);
      expect(result.projectedMonthlySavings).toBe(0);
      expect(result.analysisWindow.months).toBe(3);
    });

    it("analyzes spending and returns category suggestions", async () => {
      const now = new Date();
      const month1 = now.getMonth(); // 0-indexed
      const year1 = now.getFullYear();
      const prevMonth = month1 === 0 ? 12 : month1;
      const prevYear = month1 === 0 ? year1 - 1 : year1;
      const prevMonth2 = prevMonth === 1 ? 12 : prevMonth - 1;
      const prevYear2 = prevMonth === 1 ? prevYear - 1 : prevYear;

      const mockDirectExpenseData = [
        {
          categoryId: "cat-groceries",
          categoryName: "Groceries",
          isIncome: false,
          year: prevYear2,
          month: prevMonth2,
          total: "300.00",
        },
        {
          categoryId: "cat-groceries",
          categoryName: "Groceries",
          isIncome: false,
          year: prevYear,
          month: prevMonth,
          total: "400.00",
        },
        {
          categoryId: "cat-groceries",
          categoryName: "Groceries",
          isIncome: false,
          year: year1,
          month: month1 + 1,
          total: "350.00",
        },
      ];

      const mockDirectIncomeData = [
        {
          categoryId: "cat-salary",
          categoryName: "Salary",
          isIncome: true,
          year: prevYear2,
          month: prevMonth2,
          total: "5000.00",
        },
        {
          categoryId: "cat-salary",
          categoryName: "Salary",
          isIncome: true,
          year: prevYear,
          month: prevMonth,
          total: "5000.00",
        },
        {
          categoryId: "cat-salary",
          categoryName: "Salary",
          isIncome: true,
          year: year1,
          month: month1 + 1,
          total: "5000.00",
        },
      ];

      let expenseCallCount = 0;
      let incomeCallCount = 0;

      transactionsRepository.createQueryBuilder.mockImplementation(() => {
        const qb = createMockQueryBuilder();
        let isIncomeQuery = false;

        qb.andWhere = jest.fn().mockImplementation((...args: unknown[]) => {
          if (
            typeof args[0] === "string" &&
            (args[0] as string).includes("t.amount > 0")
          ) {
            isIncomeQuery = true;
          }
          return qb;
        });

        qb.getRawMany = jest.fn().mockImplementation(() => {
          if (isIncomeQuery) {
            incomeCallCount++;
            return Promise.resolve(
              incomeCallCount === 1 ? mockDirectIncomeData : [],
            );
          }
          expenseCallCount++;
          return Promise.resolve(
            expenseCallCount === 1 ? mockDirectExpenseData : [],
          );
        });

        return qb;
      });

      splitsRepository.createQueryBuilder.mockImplementation(() => {
        return createMockQueryBuilder({
          getRawMany: jest.fn().mockResolvedValue([]),
        });
      });

      const result = await service.generate("user-1", {
        analysisMonths: 3,
        profile: BudgetProfile.ON_TRACK,
      });

      expect(result.categories.length).toBeGreaterThan(0);
      expect(result.analysisWindow.months).toBe(3);

      const groceries = result.categories.find(
        (c) => c.categoryName === "Groceries",
      );
      expect(groceries).toBeDefined();
      if (groceries) {
        expect(groceries.median).toBeGreaterThan(0);
        expect(groceries.suggested).toBe(groceries.median);
      }
    });

    it("counts a transfer recorded as one line of a split parent in the transfer analysis", async () => {
      const now = new Date();
      const month1 = now.getMonth();
      const year1 = now.getFullYear();
      const prevMonth = month1 === 0 ? 12 : month1;
      const prevYear = month1 === 0 ? year1 - 1 : year1;

      const savingsRow = {
        accountId: "acct-savings",
        accountName: "Savings",
        accountType: "SAVINGS",
        year: prevYear,
        month: prevMonth,
        total: "200.00",
      };

      transactionsRepository.createQueryBuilder.mockImplementation(() => {
        const qb = createMockQueryBuilder();
        let isTransferQuery = false;
        qb.andWhere = jest.fn().mockImplementation((...args: unknown[]) => {
          const arg = typeof args[0] === "string" ? (args[0] as string) : "";
          if (arg.includes("t.is_transfer = true")) isTransferQuery = true;
          return qb;
        });
        qb.getRawMany = jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(isTransferQuery ? [savingsRow] : []),
          );
        return qb;
      });

      // The same destination also receives 100 through a split line carrying
      // transfer_account_id -- a savings habit recorded inside a split
      // paycheque. Keyed off the split query's own marker predicate, so this
      // fails when the split-transfer read is dropped (review #1131).
      splitsRepository.createQueryBuilder.mockImplementation(() => {
        const qb = createMockQueryBuilder();
        let isSplitTransferQuery = false;
        qb.andWhere = jest.fn().mockImplementation((...args: unknown[]) => {
          const arg = typeof args[0] === "string" ? (args[0] as string) : "";
          if (arg.includes("s.transfer_account_id IS NOT NULL"))
            isSplitTransferQuery = true;
          return qb;
        });
        qb.getRawMany = jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(
              isSplitTransferQuery ? [{ ...savingsRow, total: "100.00" }] : [],
            ),
          );
        return qb;
      });

      const result = await service.generate("user-1", {
        analysisMonths: 3,
        profile: BudgetProfile.ON_TRACK,
      });

      const savings = result.transfers.find(
        (t) => t.accountId === "acct-savings",
      );
      expect(savings).toBeDefined();
      // 200 whole-row + 100 split-line in the same month
      expect(savings!.max).toBe(300);
    });

    it("suggests transfer income per source, netted and clamped per month (issue #2141)", async () => {
      const now = new Date();
      const monthsAgo = (n: number) => {
        const d = new Date(now.getFullYear(), now.getMonth() - n, 1);
        return { year: d.getFullYear(), month: d.getMonth() + 1 };
      };
      const source = (id: string, n: number, total: string) => ({
        accountId: id,
        accountName: id.toUpperCase(),
        accountType: "SAVINGS",
        ...monthsAgo(n),
        total,
      });
      // The incoming reads are the only ones joined to the source account
      // with the owner predicate.
      const incoming = (qb: ReturnType<typeof createMockQueryBuilder>) => {
        let isIncoming = false;
        qb.andWhere = jest.fn().mockImplementation((arg: unknown) => {
          if (arg === "a.user_id = :userId") isIncoming = true;
          return qb;
        });
        return () => isIncoming;
      };
      transactionsRepository.createQueryBuilder.mockImplementation(() => {
        const qb = createMockQueryBuilder();
        const isIncoming = incoming(qb);
        qb.getRawMany = jest.fn().mockImplementation(() =>
          Promise.resolve(
            isIncoming()
              ? [
                  source("hisa", 1, "2000"),
                  source("hisa", 2, "2000"),
                  source("hisa", 3, "2500"),
                  // Net outflow to the account: clamped at zero, never listed.
                  source("chequing", 1, "-800"),
                ]
              : [],
          ),
        );
        return qb;
      });
      splitsRepository.createQueryBuilder.mockImplementation(() => {
        const qb = createMockQueryBuilder();
        const isIncoming = incoming(qb);
        qb.getRawMany = jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(isIncoming() ? [source("hisa", 3, "-500")] : []),
          );
        return qb;
      });

      const result = await service.generate("user-1", {
        analysisMonths: 3,
        profile: BudgetProfile.ON_TRACK,
      });

      expect(result.incomeTransfers.map((t) => t.accountId)).toEqual(["hisa"]);
      const hisa = result.incomeTransfers[0];
      expect(hisa.monthlyAmounts).toEqual([2000, 2000, 2000]);
      expect(hisa.suggested).toBe(2000);
      // Not preselected income: the estimate is the categories' alone.
      expect(result.estimatedMonthlyIncome).toBe(0);
    });

    it("prefers expense data when a refund causes a category to appear in both queries", async () => {
      const now = new Date();
      const month1 = now.getMonth();
      const year1 = now.getFullYear();
      const prevMonth = month1 === 0 ? 12 : month1;
      const prevYear = month1 === 0 ? year1 - 1 : year1;
      const prevMonth2 = prevMonth === 1 ? 12 : prevMonth - 1;
      const prevYear2 = prevMonth === 1 ? prevYear - 1 : prevYear;

      // Expense query: real dining out spending across 3 months
      const mockDirectExpenseData = [
        {
          categoryId: "cat-dining",
          categoryName: "Food: Dining Out",
          isIncome: false,
          year: prevYear2,
          month: prevMonth2,
          total: "120.00",
        },
        {
          categoryId: "cat-dining",
          categoryName: "Food: Dining Out",
          isIncome: false,
          year: prevYear,
          month: prevMonth,
          total: "150.00",
        },
        {
          categoryId: "cat-dining",
          categoryName: "Food: Dining Out",
          isIncome: false,
          year: year1,
          month: month1 + 1,
          total: "130.00",
        },
      ];

      // Income query: a single refund appears for the same expense category
      const mockDirectIncomeData = [
        {
          categoryId: "cat-dining",
          categoryName: "Food: Dining Out",
          isIncome: false,
          year: prevYear,
          month: prevMonth,
          total: "15.00",
        },
      ];

      let expenseCallCount = 0;
      let incomeCallCount = 0;

      transactionsRepository.createQueryBuilder.mockImplementation(() => {
        const qb = createMockQueryBuilder();
        let isIncomeQuery = false;
        let isTransferQuery = false;

        qb.andWhere = jest.fn().mockImplementation((...args: unknown[]) => {
          const arg = typeof args[0] === "string" ? (args[0] as string) : "";
          if (arg.includes("t.amount > 0")) isIncomeQuery = true;
          if (arg.includes("t.is_transfer = true")) isTransferQuery = true;
          return qb;
        });

        qb.getRawMany = jest.fn().mockImplementation(() => {
          if (isTransferQuery) return Promise.resolve([]);
          if (isIncomeQuery) {
            incomeCallCount++;
            return Promise.resolve(
              incomeCallCount === 1 ? mockDirectIncomeData : [],
            );
          }
          expenseCallCount++;
          return Promise.resolve(
            expenseCallCount === 1 ? mockDirectExpenseData : [],
          );
        });

        return qb;
      });

      splitsRepository.createQueryBuilder.mockImplementation(() => {
        return createMockQueryBuilder({
          getRawMany: jest.fn().mockResolvedValue([]),
        });
      });

      const result = await service.generate("user-1", {
        analysisMonths: 3,
        profile: BudgetProfile.ON_TRACK,
      });

      const dining = result.categories.find(
        (c) => c.categoryName === "Food: Dining Out",
      );
      expect(dining).toBeDefined();
      // The expense data should win — median of ~130 rather than the refund's ~5
      expect(dining!.median).toBeGreaterThanOrEqual(100);
      expect(dining!.suggested).toBeGreaterThanOrEqual(100);
    });

    it("uses default ON_TRACK profile when not specified", async () => {
      const result = await service.generate("user-1", {
        analysisMonths: 6,
      });

      expect(result).toBeDefined();
      expect(result.analysisWindow.months).toBe(6);
    });

    it("respects analysis window of 12 months", async () => {
      const result = await service.generate("user-1", {
        analysisMonths: 12,
      });

      expect(result.analysisWindow.months).toBe(12);
    });
  });

  describe("apply", () => {
    it("creates a budget with categories from generated suggestions", async () => {
      const savedBudget = {
        id: "new-budget",
        userId: "user-1",
        name: "February 2026",
        budgetType: BudgetType.MONTHLY,
        periodStart: "2026-02-01",
        strategy: BudgetStrategy.FIXED,
        currencyCode: "USD",
        isActive: true,
        categories: [],
      };

      budgetsRepository.save.mockResolvedValue(savedBudget);
      budgetsRepository.findOne.mockResolvedValue({
        ...savedBudget,
        categories: [
          {
            id: "bc-1",
            categoryId: "cat-1",
            amount: 500,
            isIncome: false,
            category: { id: "cat-1", name: "Groceries" },
          },
        ],
      });

      const result = await service.apply("user-1", {
        name: "February 2026",
        periodStart: "2026-02-01",
        strategy: BudgetStrategy.FIXED,
        currencyCode: "USD",
        categories: [
          {
            categoryId: "cat-1",
            amount: 500,
            isIncome: false,
            rolloverType: RolloverType.NONE,
          },
        ],
      });

      expect(budgetsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          name: "February 2026",
          periodStart: "2026-02-01",
          currencyCode: "USD",
          strategy: BudgetStrategy.FIXED,
        }),
      );
      expect(budgetsRepository.save).toHaveBeenCalled();
      expect(budgetCategoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          budgetId: "new-budget",
          categoryId: "cat-1",
          amount: 500,
        }),
      );
      expect(budgetCategoriesRepository.save).toHaveBeenCalled();
      expect(result.categories).toHaveLength(1);
    });

    it("refuses a foreign category inside the one transaction, before any write", async () => {
      budgetsRepository.save.mockResolvedValue({ id: "new-budget" });
      categoriesRepository.find.mockResolvedValue([]);

      await expect(
        service.apply("user-1", {
          name: "B",
          periodStart: "2026-02-01",
          strategy: BudgetStrategy.FIXED,
          currencyCode: "USD",
          categories: [
            {
              categoryId: "cat-not-mine",
              amount: 100,
              rolloverType: RolloverType.NONE,
            },
          ],
        }),
      ).rejects.toThrow("cat-not-mine");
      // The ownership check runs inside the one transaction, before the budget
      // row is written, so the refusal leaves through it with nothing written.
      expect(budgetsRepository.save).not.toHaveBeenCalled();
      await expect(
        scopedDataSource.transaction.mock.results[0].value,
      ).rejects.toThrow("cat-not-mine");
    });

    it("refuses two transfer lines for one account before writing (issue #2141)", async () => {
      await expect(
        service.apply("user-1", {
          name: "B",
          periodStart: "2026-02-01",
          strategy: BudgetStrategy.FIXED,
          currencyCode: "USD",
          categories: [
            {
              transferAccountId: "acct-hisa",
              isTransfer: true,
              amount: 100,
              rolloverType: RolloverType.NONE,
            },
            {
              transferAccountId: "acct-hisa",
              isTransfer: true,
              isIncome: true,
              amount: 2000,
              rolloverType: RolloverType.NONE,
            },
          ],
        }),
      ).rejects.toThrow("already has a transfer line");
      expect(budgetsRepository.save).not.toHaveBeenCalled();
    });

    it("refuses a transfer income source the user does not own before writing", async () => {
      accountsRepository.find.mockResolvedValue([]);

      await expect(
        service.apply("user-1", {
          name: "B",
          periodStart: "2026-02-01",
          strategy: BudgetStrategy.FIXED,
          currencyCode: "USD",
          categories: [
            {
              transferAccountId: "acct-other",
              isTransfer: true,
              isIncome: true,
              amount: 2000,
              rolloverType: RolloverType.NONE,
            },
          ],
        }),
      ).rejects.toThrow("acct-other");
      expect(accountsRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: "user-1" }),
        }),
      );
      expect(budgetsRepository.save).not.toHaveBeenCalled();
    });

    it("saves an owned transfer income source as an income transfer line", async () => {
      accountsRepository.find.mockResolvedValue([{ id: "acct-hisa" }]);
      budgetsRepository.findOne.mockResolvedValue({ id: "new-budget" });

      await service.apply("user-1", {
        name: "B",
        periodStart: "2026-02-01",
        strategy: BudgetStrategy.FIXED,
        currencyCode: "USD",
        config: { transfersInAsIncome: true },
        categories: [
          {
            transferAccountId: "acct-hisa",
            isTransfer: true,
            isIncome: true,
            amount: 2000,
            rolloverType: RolloverType.NONE,
          },
        ],
      });

      expect(budgetsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ config: { transfersInAsIncome: true } }),
      );
      expect(budgetCategoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          categoryId: null,
          transferAccountId: "acct-hisa",
          isTransfer: true,
          isIncome: true,
          amount: 2000,
        }),
      );
    });

    it("creates a budget with multiple categories", async () => {
      const savedBudget = {
        id: "new-budget",
        userId: "user-1",
        name: "Budget",
        budgetType: BudgetType.MONTHLY,
        periodStart: "2026-02-01",
        strategy: BudgetStrategy.FIXED,
        currencyCode: "USD",
        isActive: true,
      };

      budgetsRepository.save.mockResolvedValue(savedBudget);
      budgetsRepository.findOne.mockResolvedValue({
        ...savedBudget,
        categories: [
          {
            id: "bc-1",
            categoryId: "cat-1",
            amount: 500,
            category: { id: "cat-1", name: "Groceries" },
          },
          {
            id: "bc-2",
            categoryId: "cat-2",
            amount: 5000,
            isIncome: true,
            category: { id: "cat-2", name: "Salary" },
          },
        ],
      });

      const result = await service.apply("user-1", {
        name: "Budget",
        periodStart: "2026-02-01",
        currencyCode: "USD",
        categories: [
          { categoryId: "cat-1", amount: 500, rolloverType: RolloverType.NONE },
          {
            categoryId: "cat-2",
            amount: 5000,
            isIncome: true,
            rolloverType: RolloverType.NONE,
          },
        ],
      });

      expect(budgetCategoriesRepository.create).toHaveBeenCalledTimes(2);
      expect(result.categories).toHaveLength(2);
    });

    it("creates a budget with all optional fields", async () => {
      const savedBudget = {
        id: "new-budget",
        userId: "user-1",
        name: "Full Budget",
        description: "Detailed budget",
        budgetType: BudgetType.ANNUAL,
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        baseIncome: 6000,
        incomeLinked: true,
        strategy: BudgetStrategy.ROLLOVER,
        currencyCode: "CAD",
        config: { includeTransfers: false },
        isActive: true,
      };

      budgetsRepository.save.mockResolvedValue(savedBudget);
      budgetsRepository.findOne.mockResolvedValue({
        ...savedBudget,
        categories: [],
      });

      await service.apply("user-1", {
        name: "Full Budget",
        description: "Detailed budget",
        budgetType: BudgetType.ANNUAL,
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        baseIncome: 6000,
        incomeLinked: true,
        strategy: BudgetStrategy.ROLLOVER,
        currencyCode: "CAD",
        config: { includeTransfers: false },
        categories: [
          {
            categoryId: "cat-1",
            amount: 500,
            rolloverType: RolloverType.MONTHLY,
            rolloverCap: 200,
            flexGroup: "Fun Money",
            alertWarnPercent: 70,
            alertCriticalPercent: 90,
            notes: "Grocery budget",
            sortOrder: 1,
          },
        ],
      });

      expect(budgetsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Detailed budget",
          budgetType: BudgetType.ANNUAL,
          periodEnd: "2026-12-31",
          baseIncome: 6000,
          incomeLinked: true,
          strategy: BudgetStrategy.ROLLOVER,
        }),
      );

      expect(budgetCategoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          rolloverType: RolloverType.MONTHLY,
          rolloverCap: 200,
          flexGroup: "Fun Money",
          alertWarnPercent: 70,
          alertCriticalPercent: 90,
          notes: "Grocery budget",
          sortOrder: 1,
        }),
      );
    });

    it("applies default values for optional category fields", async () => {
      const savedBudget = {
        id: "new-budget",
        userId: "user-1",
        name: "Budget",
        periodStart: "2026-02-01",
        strategy: BudgetStrategy.FIXED,
        currencyCode: "USD",
        isActive: true,
      };

      budgetsRepository.save.mockResolvedValue(savedBudget);
      budgetsRepository.findOne.mockResolvedValue({
        ...savedBudget,
        categories: [
          {
            id: "bc-1",
            categoryId: "cat-1",
            amount: 100,
            category: { id: "cat-1", name: "Test" },
          },
        ],
      });

      await service.apply("user-1", {
        name: "Budget",
        periodStart: "2026-02-01",
        currencyCode: "USD",
        categories: [{ categoryId: "cat-1", amount: 100 }],
      });

      expect(budgetCategoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          isIncome: false,
          categoryGroup: null,
          rolloverCap: null,
          flexGroup: null,
          alertWarnPercent: 80,
          alertCriticalPercent: 95,
          notes: null,
          sortOrder: 0,
        }),
      );
    });

    it("returns budget with loaded categories relation", async () => {
      const savedBudget = { id: "new-budget", userId: "user-1" };
      budgetsRepository.save.mockResolvedValue(savedBudget);
      budgetsRepository.findOne.mockResolvedValue({
        ...savedBudget,
        categories: [],
      });

      await service.apply("user-1", {
        name: "Budget",
        periodStart: "2026-02-01",
        currencyCode: "USD",
        categories: [{ categoryId: "cat-1", amount: 100 }],
      });

      expect(budgetsRepository.findOne).toHaveBeenCalledWith({
        where: { id: "new-budget" },
        relations: [
          "categories",
          "categories.category",
          "categories.transferAccount",
          "buckets",
        ],
        order: { buckets: { sortOrder: "ASC", name: "ASC" } },
      });
    });

    describe("with buckets (design 6.6)", () => {
      const baseDto = {
        name: "Buckets",
        periodStart: "2026-02-01",
        currencyCode: "USD",
        strategy: BudgetStrategy.BUCKET,
      };
      const bucket = (over: Record<string, unknown> = {}) => ({
        key: "save",
        name: "Savings",
        targetType: BudgetBucketTargetType.PERCENT,
        targetValue: 20,
        ...over,
      });
      const line = (over: Record<string, unknown> = {}) => ({
        categoryId: "cat-1",
        amount: 100,
        rolloverType: RolloverType.NONE,
        ...over,
      });
      const expectNothingWritten = () => {
        expect(budgetsRepository.save).not.toHaveBeenCalled();
        expect(budgetBucketsRepository.save).not.toHaveBeenCalled();
        expect(budgetCategoriesRepository.save).not.toHaveBeenCalled();
      };

      beforeEach(() => {
        budgetsRepository.findOne.mockResolvedValue({
          id: "new-budget",
          categories: [],
          buckets: [],
        });
      });

      it("writes budget, buckets and lines in one transaction and resolves keys", async () => {
        const result = await service.apply("user-1", {
          ...baseDto,
          buckets: [
            bucket(),
            bucket({
              key: "fun",
              name: "Fun",
              targetType: BudgetBucketTargetType.AMOUNT,
              targetValue: 150,
              carryOver: true,
              carryCap: 300,
            }),
          ],
          categories: [
            line({ bucketKey: "fun" }),
            line({ categoryId: "cat-2" }),
            line({ categoryId: "cat-2", isIncome: true }),
          ],
        });

        expect(withScopedDb).toHaveBeenCalledTimes(1);
        expect(scopedDataSource.transaction).toHaveBeenCalledTimes(1);
        expect(budgetBucketsRepository.create).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            budgetId: "new-budget",
            name: "Fun",
            targetType: BudgetBucketTargetType.AMOUNT,
            targetValue: 150,
            carryOver: true,
            carryCap: 300,
            sortOrder: 1,
          }),
        );
        expect(budgetCategoriesRepository.create).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ bucketId: "new-bucket-1" }),
        );
        const unassigned = budgetCategoriesRepository.create.mock.calls[1][0];
        expect(unassigned).not.toHaveProperty("bucketId");
        expect(budgetsRepository.findOne).toHaveBeenCalledWith(
          expect.objectContaining({
            relations: expect.arrayContaining(["buckets"]),
          }),
        );
        expect(result.buckets).toEqual([]);
      });

      it("trims the bucket name and defaults carry flags and order", async () => {
        await service.apply("user-1", {
          ...baseDto,
          buckets: [bucket({ name: "  Savings  " })],
          categories: [line()],
        });
        expect(budgetBucketsRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "Savings",
            carryOver: false,
            carryCap: null,
            sortOrder: 0,
          }),
        );
      });

      it("a request without buckets writes none and one transaction", async () => {
        await service.apply("user-1", { ...baseDto, categories: [line()] });
        expect(withScopedDb).toHaveBeenCalledTimes(1);
        expect(budgetBucketsRepository.save).not.toHaveBeenCalled();
        expect(budgetCategoriesRepository.save).toHaveBeenCalled();
      });

      it.each([
        [
          "a duplicate key",
          { buckets: [bucket(), bucket({ name: "Other" })], categories: [] },
        ],
        [
          "a bucketKey naming no bucket",
          { buckets: [bucket()], categories: [line({ bucketKey: "nope" })] },
        ],
        [
          "a bucketKey with no buckets at all",
          { categories: [line({ bucketKey: "save" })] },
        ],
        [
          "a bucketKey on an income line",
          {
            buckets: [bucket()],
            categories: [line({ bucketKey: "save", isIncome: true })],
          },
        ],
        [
          "a duplicate name ignoring case and space",
          {
            buckets: [bucket(), bucket({ key: "b", name: " SAVINGS " })],
            categories: [line()],
          },
        ],
        [
          "a percent above 100",
          { buckets: [bucket({ targetValue: 100.5 })], categories: [line()] },
        ],
        [
          "a percent with three decimals",
          { buckets: [bucket({ targetValue: 10.123 })], categories: [line()] },
        ],
        [
          "a zero target",
          {
            buckets: [
              bucket({
                targetType: BudgetBucketTargetType.AMOUNT,
                targetValue: 0,
              }),
            ],
            categories: [line()],
          },
        ],
        [
          "a carry cap without carry-over",
          { buckets: [bucket({ carryCap: 50 })], categories: [line()] },
        ],
        [
          "a blank name",
          { buckets: [bucket({ name: "   " })], categories: [line()] },
        ],
        [
          "more than 12 buckets",
          {
            buckets: Array.from({ length: 13 }, (_, i) =>
              bucket({ key: `k${i}`, name: `B${i}` }),
            ),
            categories: [line()],
          },
        ],
      ])("refuses %s and writes nothing", async (_label, extra) => {
        await expect(
          service.apply("user-1", { ...baseDto, ...extra } as never),
        ).rejects.toThrow(BadRequestException);
        expectNothingWritten();
      });

      it("refuses a foreign category before any write", async () => {
        categoriesRepository.find.mockResolvedValue([]);
        await expect(
          service.apply("user-1", {
            ...baseDto,
            buckets: [bucket()],
            categories: [line({ bucketKey: "save" })],
          }),
        ).rejects.toThrow(BadRequestException);
        expectNothingWritten();
      });
    });
  });
});
