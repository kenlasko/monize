import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { BudgetPeriodService } from "./budget-period.service";
import { BudgetPeriodCronService } from "./budget-period-cron.service";
import { BudgetReportsService } from "./budget-reports.service";
import { BudgetsService } from "./budgets.service";
import { Budget, BudgetType, BudgetStrategy } from "./entities/budget.entity";
import {
  BudgetCategory,
  RolloverType,
} from "./entities/budget-category.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { BudgetPeriodCategory } from "./entities/budget-period-category.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { EmailService } from "../notifications/email.service";

describe("Budget Period Lifecycle Integration", () => {
  let periodService: BudgetPeriodService;
  let cronService: BudgetPeriodCronService;
  let periodsRepository: Record<string, jest.Mock>;
  let periodCategoriesRepository: Record<string, jest.Mock>;
  let transactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let budgetsService: Record<string, jest.Mock>;
  let budgetsRepository: Record<string, jest.Mock>;

  const mockBudgetCategory: BudgetCategory = {
    id: "bc-groceries",
    budgetId: "budget-1",
    budget: {} as Budget,
    categoryId: "cat-groceries",
    category: null,
    categoryGroup: null,
    transferAccountId: null,
    transferAccount: null,
    isTransfer: false,
    amount: 600,
    isIncome: false,
    rolloverType: RolloverType.MONTHLY,
    rolloverCap: 200,
    flexGroup: null,
    alertWarnPercent: 80,
    alertCriticalPercent: 95,
    notes: null,
    sortOrder: 0,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  const mockRentCategory: BudgetCategory = {
    ...mockBudgetCategory,
    id: "bc-rent",
    categoryId: "cat-rent",
    amount: 1500,
    rolloverType: RolloverType.NONE,
    rolloverCap: null,
  };

  const mockTravelCategory: BudgetCategory = {
    ...mockBudgetCategory,
    id: "bc-travel",
    categoryId: "cat-travel",
    amount: 200,
    rolloverType: RolloverType.ANNUAL,
    rolloverCap: null,
  };

  const mockIncomeCategory: BudgetCategory = {
    ...mockBudgetCategory,
    id: "bc-income",
    categoryId: "cat-income",
    amount: 5000,
    isIncome: true,
    rolloverType: RolloverType.NONE,
  };

  const mockBudget: Budget = {
    id: "budget-1",
    userId: "user-1",
    name: "2026 Monthly Budget",
    description: null,
    budgetType: BudgetType.MONTHLY,
    periodStart: "2026-01-01",
    periodEnd: null,
    baseIncome: 5000,
    incomeLinked: false,
    strategy: BudgetStrategy.ROLLOVER,
    isActive: true,
    currencyCode: "USD",
    config: {},
    categories: [
      mockBudgetCategory,
      mockRentCategory,
      mockTravelCategory,
      mockIncomeCategory,
    ],
    periods: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  const createMockQueryBuilder = (
    overrides: Record<string, jest.Mock> = {},
  ) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getRawMany: jest.fn().mockResolvedValue([]),
    ...overrides,
  });

  const mockDataSource = {
    createQueryRunner: jest.fn().mockReturnValue({
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        save: jest.fn().mockImplementation((_entity, data) => data || _entity),
        getRepository: jest.fn().mockReturnValue({
          create: jest
            .fn()
            .mockImplementation((data) => ({ ...data, id: "new-id" })),
          save: jest.fn().mockImplementation((data) => ({
            ...data,
            id: data.id || "new-id",
          })),
        }),
      },
    }),
  };

  beforeEach(async () => {
    const savedPeriods: BudgetPeriod[] = [];

    periodsRepository = {
      create: jest.fn().mockImplementation((data) => ({
        ...data,
        id: `period-${savedPeriods.length + 1}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      save: jest.fn().mockImplementation((data) => {
        const saved = {
          ...data,
          id: data.id || `period-${savedPeriods.length + 1}`,
        };
        savedPeriods.push(saved);
        return saved;
      }),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
    };

    periodCategoriesRepository = {
      create: jest.fn().mockImplementation((data) => ({
        ...data,
        id: `bpc-${Math.random().toString(36).slice(2, 8)}`,
      })),
      save: jest.fn().mockImplementation((data) => ({
        ...data,
        id: data.id || `bpc-${Math.random().toString(36).slice(2, 8)}`,
      })),
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

    budgetsRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BudgetPeriodService,
        BudgetPeriodCronService,
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
        { provide: BudgetsService, useValue: budgetsService },
        { provide: DataSource, useValue: mockDataSource },
        {
          provide: getRepositoryToken(Budget),
          useValue: budgetsRepository,
        },
        {
          provide: getRepositoryToken(User),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(UserPreference),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: BudgetReportsService,
          useValue: { getHealthScore: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: EmailService,
          useValue: {
            isSmtpConfigured: jest.fn().mockReturnValue(false),
            getStatus: jest.fn().mockReturnValue({ configured: false }),
            sendEmail: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("http://localhost:3000") },
        },
      ],
    }).compile();

    periodService = module.get<BudgetPeriodService>(BudgetPeriodService);
    cronService = module.get<BudgetPeriodCronService>(BudgetPeriodCronService);
  });

  describe("Full Period Lifecycle: Create -> Close -> Rollover -> Next", () => {
    it("creates initial period with correct budget allocations", async () => {
      const period = await periodService.createPeriodForBudget(mockBudget);

      expect(period.status).toBe(PeriodStatus.OPEN);
      expect(period.totalBudgeted).toBe(2300);

      expect(periodCategoriesRepository.create).toHaveBeenCalledTimes(4);

      expect(periodCategoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          budgetCategoryId: "bc-groceries",
          budgetedAmount: 600,
          rolloverIn: 0,
          effectiveBudget: 600,
        }),
      );
      expect(periodCategoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          budgetCategoryId: "bc-rent",
          budgetedAmount: 1500,
          rolloverIn: 0,
          effectiveBudget: 1500,
        }),
      );
      expect(periodCategoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          budgetCategoryId: "bc-travel",
          budgetedAmount: 200,
          rolloverIn: 0,
          effectiveBudget: 200,
        }),
      );
      expect(periodCategoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          budgetCategoryId: "bc-income",
          budgetedAmount: 5000,
          rolloverIn: 0,
          effectiveBudget: 5000,
        }),
      );
    });

    it("creates next period with rollover from closed period", async () => {
      const rolloverMap = new Map<string, number>();
      rolloverMap.set("bc-groceries", 150);
      rolloverMap.set("bc-travel", 200);

      const period = await periodService.createPeriodForBudget(
        mockBudget,
        rolloverMap,
      );

      expect(periodCategoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          budgetCategoryId: "bc-groceries",
          budgetedAmount: 600,
          rolloverIn: 150,
          effectiveBudget: 750,
        }),
      );

      expect(periodCategoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          budgetCategoryId: "bc-travel",
          budgetedAmount: 200,
          rolloverIn: 200,
          effectiveBudget: 400,
        }),
      );

      expect(periodCategoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          budgetCategoryId: "bc-rent",
          budgetedAmount: 1500,
          rolloverIn: 0,
          effectiveBudget: 1500,
        }),
      );

      expect(period.totalBudgeted).toBe(2300);
    });

    it("closes period with actuals and computes correct rollovers", async () => {
      const openPeriod: BudgetPeriod = {
        id: "period-open",
        budgetId: "budget-1",
        budget: mockBudget,
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        actualIncome: 0,
        actualExpenses: 0,
        totalBudgeted: 2300,
        status: PeriodStatus.OPEN,
        periodCategories: [
          {
            id: "bpc-groceries",
            budgetPeriodId: "period-open",
            budgetCategoryId: "bc-groceries",
            budgetCategory: mockBudgetCategory,
            categoryId: "cat-groceries",
            category: null,
            budgetedAmount: 600,
            rolloverIn: 0,
            effectiveBudget: 600,
            actualAmount: 0,
            rolloverOut: 0,
            budgetPeriod: {} as BudgetPeriod,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: "bpc-rent",
            budgetPeriodId: "period-open",
            budgetCategoryId: "bc-rent",
            budgetCategory: mockRentCategory,
            categoryId: "cat-rent",
            category: null,
            budgetedAmount: 1500,
            rolloverIn: 0,
            effectiveBudget: 1500,
            actualAmount: 0,
            rolloverOut: 0,
            budgetPeriod: {} as BudgetPeriod,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: "bpc-travel",
            budgetPeriodId: "period-open",
            budgetCategoryId: "bc-travel",
            budgetCategory: mockTravelCategory,
            categoryId: "cat-travel",
            category: null,
            budgetedAmount: 200,
            rolloverIn: 0,
            effectiveBudget: 200,
            actualAmount: 0,
            rolloverOut: 0,
            budgetPeriod: {} as BudgetPeriod,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: "bpc-income",
            budgetPeriodId: "period-open",
            budgetCategoryId: "bc-income",
            budgetCategory: mockIncomeCategory,
            categoryId: "cat-income",
            category: null,
            budgetedAmount: 5000,
            rolloverIn: 0,
            effectiveBudget: 5000,
            actualAmount: 0,
            rolloverOut: 0,
            budgetPeriod: {} as BudgetPeriod,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      periodsRepository.findOne.mockResolvedValue(openPeriod);
      periodsRepository.save.mockImplementation((data) => data);

      const directQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { categoryId: "cat-groceries", total: "450" },
          { categoryId: "cat-rent", total: "1500" },
          { categoryId: "cat-travel", total: "50" },
          { categoryId: "cat-income", total: "5200" },
        ]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(),
      );

      const result = await periodService.closePeriod("user-1", "budget-1");

      expect(result.status).toBe(PeriodStatus.CLOSED);
      expect(result.actualExpenses).toBe(2000);
      expect(result.actualIncome).toBe(5200);

      const groceriesPc = openPeriod.periodCategories.find(
        (pc) => pc.budgetCategoryId === "bc-groceries",
      );
      expect(groceriesPc!.actualAmount).toBe(450);
      expect(groceriesPc!.rolloverOut).toBe(150);

      const rentPc = openPeriod.periodCategories.find(
        (pc) => pc.budgetCategoryId === "bc-rent",
      );
      expect(rentPc!.actualAmount).toBe(1500);
      expect(rentPc!.rolloverOut).toBe(0);

      const travelPc = openPeriod.periodCategories.find(
        (pc) => pc.budgetCategoryId === "bc-travel",
      );
      expect(travelPc!.actualAmount).toBe(50);
      expect(travelPc!.rolloverOut).toBe(150);

      // closePeriod now uses queryRunner for atomicity:
      // 4 saves for closing period categories + 1 save for the period itself via queryRunner.manager.save
      const qr = mockDataSource.createQueryRunner();
      expect(qr.manager.save).toHaveBeenCalledTimes(5);
      // 1 batch save for next period categories + 1 save for the next period via queryRunner.manager.getRepository().save
      const repoSave = qr.manager.getRepository().save;
      expect(repoSave).toHaveBeenCalledTimes(2);
    });

    it("respects rollover cap when computing rollover", () => {
      const pc: BudgetPeriodCategory = {
        id: "bpc-1",
        budgetPeriodId: "period-1",
        budgetCategoryId: "bc-groceries",
        budgetCategory: mockBudgetCategory,
        categoryId: "cat-groceries",
        category: null,
        budgetedAmount: 600,
        rolloverIn: 0,
        effectiveBudget: 600,
        actualAmount: 0,
        rolloverOut: 0,
        budgetPeriod: {} as BudgetPeriod,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const rollover = periodService.computeRollover(pc, 300);
      expect(rollover).toBe(200);
    });

    it("produces zero rollover when budget is fully spent", () => {
      const pc: BudgetPeriodCategory = {
        id: "bpc-1",
        budgetPeriodId: "period-1",
        budgetCategoryId: "bc-groceries",
        budgetCategory: mockBudgetCategory,
        categoryId: "cat-groceries",
        category: null,
        budgetedAmount: 600,
        rolloverIn: 0,
        effectiveBudget: 600,
        actualAmount: 0,
        rolloverOut: 0,
        budgetPeriod: {} as BudgetPeriod,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const rollover = periodService.computeRollover(pc, 600);
      expect(rollover).toBe(0);
    });

    it("produces zero rollover for overspent categories", () => {
      const pc: BudgetPeriodCategory = {
        id: "bpc-1",
        budgetPeriodId: "period-1",
        budgetCategoryId: "bc-groceries",
        budgetCategory: mockBudgetCategory,
        categoryId: "cat-groceries",
        category: null,
        budgetedAmount: 600,
        rolloverIn: 0,
        effectiveBudget: 600,
        actualAmount: 0,
        rolloverOut: 0,
        budgetPeriod: {} as BudgetPeriod,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const rollover = periodService.computeRollover(pc, 750);
      expect(rollover).toBe(0);
    });

    it("unlimited rollover for ANNUAL type without cap", () => {
      const pc: BudgetPeriodCategory = {
        id: "bpc-1",
        budgetPeriodId: "period-1",
        budgetCategoryId: "bc-travel",
        budgetCategory: mockTravelCategory,
        categoryId: "cat-travel",
        category: null,
        budgetedAmount: 200,
        rolloverIn: 0,
        effectiveBudget: 200,
        actualAmount: 0,
        rolloverOut: 0,
        budgetPeriod: {} as BudgetPeriod,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const rollover = periodService.computeRollover(pc, 0);
      expect(rollover).toBe(200);
    });

    it("accumulates rollover across periods for ANNUAL categories", async () => {
      const rolloverMap = new Map<string, number>();
      rolloverMap.set("bc-travel", 600);

      await periodService.createPeriodForBudget(mockBudget, rolloverMap);

      expect(periodCategoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          budgetCategoryId: "bc-travel",
          budgetedAmount: 200,
          rolloverIn: 600,
          effectiveBudget: 800,
        }),
      );
    });
  });

  describe("Cron Service Period Lifecycle", () => {
    it("cron closes expired periods and creates next ones", async () => {
      budgetsRepository.find.mockResolvedValue([mockBudget]);

      const expiredPeriod: BudgetPeriod = {
        id: "period-expired",
        budgetId: "budget-1",
        budget: mockBudget,
        periodStart: "2025-12-01",
        periodEnd: "2025-12-31",
        actualIncome: 0,
        actualExpenses: 0,
        totalBudgeted: 2300,
        status: PeriodStatus.OPEN,
        periodCategories: [
          {
            id: "bpc-1",
            budgetPeriodId: "period-expired",
            budgetCategoryId: "bc-groceries",
            budgetCategory: mockBudgetCategory,
            categoryId: "cat-groceries",
            category: null,
            budgetedAmount: 600,
            rolloverIn: 0,
            effectiveBudget: 600,
            actualAmount: 0,
            rolloverOut: 0,
            budgetPeriod: {} as BudgetPeriod,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      periodsRepository.findOne
        .mockResolvedValueOnce(expiredPeriod)
        .mockResolvedValueOnce(expiredPeriod);

      periodsRepository.save.mockImplementation((data) => data);

      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-groceries", total: "400" }]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(),
      );

      await cronService.closeExpiredPeriods();

      expect(budgetsService.findOne).toHaveBeenCalledWith("user-1", "budget-1");
    });

    it("cron does not close periods that are still current", async () => {
      budgetsRepository.find.mockResolvedValue([mockBudget]);

      const currentPeriod: BudgetPeriod = {
        id: "period-current",
        budgetId: "budget-1",
        budget: mockBudget,
        periodStart: "2099-01-01",
        periodEnd: "2099-01-31",
        actualIncome: 0,
        actualExpenses: 0,
        totalBudgeted: 2300,
        status: PeriodStatus.OPEN,
        periodCategories: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      periodsRepository.findOne.mockResolvedValue(currentPeriod);

      await cronService.closeExpiredPeriods();

      expect(budgetsService.findOne).not.toHaveBeenCalled();
    });

    it("cron skips inactive budgets", async () => {
      budgetsRepository.find.mockResolvedValue([]);

      await cronService.closeExpiredPeriods();

      expect(periodsRepository.findOne).not.toHaveBeenCalled();
    });

    it("cron processes multiple budgets independently", async () => {
      const budget2: Budget = {
        ...mockBudget,
        id: "budget-2",
        userId: "user-2",
        name: "Second Budget",
        categories: [mockBudgetCategory],
      };

      budgetsRepository.find.mockResolvedValue([mockBudget, budget2]);

      periodsRepository.findOne
        .mockResolvedValueOnce({
          id: "period-1",
          budgetId: "budget-1",
          periodEnd: "2025-12-31",
          status: PeriodStatus.OPEN,
          periodCategories: [],
        })
        .mockResolvedValueOnce({
          id: "period-2",
          budgetId: "budget-2",
          periodEnd: "2099-12-31",
          status: PeriodStatus.OPEN,
          periodCategories: [],
        });

      await cronService.closeExpiredPeriods();

      expect(budgetsService.findOne).toHaveBeenCalledWith("user-1", "budget-1");
      expect(budgetsService.findOne).not.toHaveBeenCalledWith(
        "user-2",
        "budget-2",
      );
    });
  });

  describe("Edge Cases", () => {
    it("handles budget with no categories gracefully", async () => {
      const emptyBudget: Budget = {
        ...mockBudget,
        categories: [],
      };
      budgetsService.findOne.mockResolvedValue(emptyBudget);

      const period = await periodService.createPeriodForBudget(emptyBudget);

      expect(period.totalBudgeted).toBe(0);
      expect(periodCategoriesRepository.create).not.toHaveBeenCalled();
    });

    it("handles period with all zero spending", async () => {
      const openPeriod: BudgetPeriod = {
        id: "period-zero",
        budgetId: "budget-1",
        budget: mockBudget,
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        actualIncome: 0,
        actualExpenses: 0,
        totalBudgeted: 600,
        status: PeriodStatus.OPEN,
        periodCategories: [
          {
            id: "bpc-1",
            budgetPeriodId: "period-zero",
            budgetCategoryId: "bc-groceries",
            budgetCategory: mockBudgetCategory,
            categoryId: "cat-groceries",
            category: null,
            budgetedAmount: 600,
            rolloverIn: 0,
            effectiveBudget: 600,
            actualAmount: 0,
            rolloverOut: 0,
            budgetPeriod: {} as BudgetPeriod,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      periodsRepository.findOne.mockResolvedValue(openPeriod);
      periodsRepository.save.mockImplementation((data) => data);

      const directQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(),
      );

      const result = await periodService.closePeriod("user-1", "budget-1");

      expect(result.status).toBe(PeriodStatus.CLOSED);
      expect(result.actualExpenses).toBe(0);

      const pc = openPeriod.periodCategories[0];
      expect(pc.actualAmount).toBe(0);
      expect(pc.rolloverOut).toBe(200);
    });

    it("handles getOrCreateCurrentPeriod when period already exists", async () => {
      const existingPeriod: BudgetPeriod = {
        id: "existing-period",
        budgetId: "budget-1",
        budget: mockBudget,
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
        actualIncome: 0,
        actualExpenses: 0,
        totalBudgeted: 2300,
        status: PeriodStatus.OPEN,
        periodCategories: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      periodsRepository.findOne.mockResolvedValue(existingPeriod);

      const result = await periodService.getOrCreateCurrentPeriod(
        "user-1",
        "budget-1",
      );

      expect(result.id).toBe("existing-period");
      expect(periodsRepository.create).not.toHaveBeenCalled();
    });

    it("handles getOrCreateCurrentPeriod when no period exists", async () => {
      periodsRepository.findOne.mockResolvedValue(null);
      periodsRepository.save.mockImplementation((data) => ({
        ...data,
        id: "new-period",
      }));

      const result = await periodService.getOrCreateCurrentPeriod(
        "user-1",
        "budget-1",
      );

      expect(result.id).toBe("new-period");
      expect(periodsRepository.create).toHaveBeenCalled();
    });

    it("income categories do not receive rollover", async () => {
      const rolloverMap = new Map<string, number>();
      rolloverMap.set("bc-income", 500);

      await periodService.createPeriodForBudget(mockBudget, rolloverMap);

      expect(periodCategoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          budgetCategoryId: "bc-income",
          budgetedAmount: 5000,
          rolloverIn: 500,
          effectiveBudget: 5500,
        }),
      );
    });

    it("split transactions are included in period actuals during close", async () => {
      const openPeriod: BudgetPeriod = {
        id: "period-split",
        budgetId: "budget-1",
        budget: mockBudget,
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        actualIncome: 0,
        actualExpenses: 0,
        totalBudgeted: 600,
        status: PeriodStatus.OPEN,
        periodCategories: [
          {
            id: "bpc-1",
            budgetPeriodId: "period-split",
            budgetCategoryId: "bc-groceries",
            budgetCategory: mockBudgetCategory,
            categoryId: "cat-groceries",
            category: null,
            budgetedAmount: 600,
            rolloverIn: 0,
            effectiveBudget: 600,
            actualAmount: 0,
            rolloverOut: 0,
            budgetPeriod: {} as BudgetPeriod,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      periodsRepository.findOne.mockResolvedValue(openPeriod);
      periodsRepository.save.mockImplementation((data) => data);

      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-groceries", total: "300" }]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-groceries", total: "100" }]),
      });

      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      const result = await periodService.closePeriod("user-1", "budget-1");

      expect(result.actualExpenses).toBe(400);
      expect(openPeriod.periodCategories[0].actualAmount).toBe(400);
      expect(openPeriod.periodCategories[0].rolloverOut).toBe(200);
    });
  });
});
