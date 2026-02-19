import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { BudgetPeriodService } from "./budget-period.service";
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

describe("BudgetPeriodService", () => {
  let service: BudgetPeriodService;
  let periodsRepository: Record<string, jest.Mock>;
  let periodCategoriesRepository: Record<string, jest.Mock>;
  let transactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let budgetsService: Record<string, jest.Mock>;

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
    categories: [],
    periods: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  const mockBudgetCategory: BudgetCategory = {
    id: "bc-1",
    budgetId: "budget-1",
    budget: mockBudget,
    categoryId: "cat-1",
    category: null,
    categoryGroup: null,
    amount: 500,
    isIncome: false,
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

  const mockPeriod: BudgetPeriod = {
    id: "period-1",
    budgetId: "budget-1",
    budget: mockBudget,
    periodStart: "2026-02-01",
    periodEnd: "2026-02-28",
    actualIncome: 0,
    actualExpenses: 0,
    totalBudgeted: 500,
    status: PeriodStatus.OPEN,
    periodCategories: [],
    createdAt: new Date("2026-02-01"),
    updatedAt: new Date("2026-02-01"),
  };

  const mockPeriodCategory: BudgetPeriodCategory = {
    id: "bpc-1",
    budgetPeriodId: "period-1",
    budgetPeriod: mockPeriod,
    budgetCategoryId: "bc-1",
    budgetCategory: mockBudgetCategory,
    categoryId: "cat-1",
    category: null,
    budgetedAmount: 500,
    rolloverIn: 0,
    actualAmount: 0,
    effectiveBudget: 500,
    rolloverOut: 0,
    createdAt: new Date("2026-02-01"),
    updatedAt: new Date("2026-02-01"),
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

  beforeEach(async () => {
    periodsRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-period" })),
      save: jest.fn().mockImplementation((data) => ({
        ...data,
        id: data.id || "new-period",
      })),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
    };

    periodCategoriesRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-bpc" })),
      save: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: data.id || "new-bpc" })),
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
        BudgetPeriodService,
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
      ],
    }).compile();

    service = module.get<BudgetPeriodService>(BudgetPeriodService);
  });

  describe("findAll", () => {
    it("returns periods for the budget", async () => {
      periodsRepository.find.mockResolvedValue([mockPeriod]);

      const result = await service.findAll("user-1", "budget-1");

      expect(result).toHaveLength(1);
      expect(budgetsService.findOne).toHaveBeenCalledWith("user-1", "budget-1");
      expect(periodsRepository.find).toHaveBeenCalledWith({
        where: { budgetId: "budget-1" },
        order: { periodStart: "DESC" },
      });
    });

    it("returns empty array when no periods exist", async () => {
      periodsRepository.find.mockResolvedValue([]);

      const result = await service.findAll("user-1", "budget-1");

      expect(result).toEqual([]);
    });
  });

  describe("findOne", () => {
    it("returns period with categories when found", async () => {
      periodsRepository.findOne.mockResolvedValue({
        ...mockPeriod,
        periodCategories: [mockPeriodCategory],
      });

      const result = await service.findOne("user-1", "budget-1", "period-1");

      expect(result.id).toBe("period-1");
      expect(periodsRepository.findOne).toHaveBeenCalledWith({
        where: { id: "period-1", budgetId: "budget-1" },
        relations: [
          "periodCategories",
          "periodCategories.budgetCategory",
          "periodCategories.category",
        ],
      });
    });

    it("throws NotFoundException when period not found", async () => {
      periodsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findOne("user-1", "budget-1", "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("closePeriod", () => {
    it("closes the open period and creates next period", async () => {
      const budgetWithCategories = {
        ...mockBudget,
        categories: [{ ...mockBudgetCategory }],
      };
      budgetsService.findOne.mockResolvedValue(budgetWithCategories);

      const openPeriod = {
        ...mockPeriod,
        status: PeriodStatus.OPEN,
        periodCategories: [
          {
            ...mockPeriodCategory,
            budgetCategoryId: "bc-1",
            effectiveBudget: 500,
            budgetCategory: {
              ...mockBudgetCategory,
              rolloverType: RolloverType.NONE,
            },
          },
        ],
      };
      periodsRepository.findOne.mockResolvedValue(openPeriod);
      periodsRepository.save.mockImplementation((data) => data);

      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-1", total: "350" }]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(),
      );

      const result = await service.closePeriod("user-1", "budget-1");

      expect(result.status).toBe(PeriodStatus.CLOSED);
      expect(periodCategoriesRepository.save).toHaveBeenCalled();
      expect(periodsRepository.save).toHaveBeenCalled();
    });

    it("throws BadRequestException when no open period", async () => {
      budgetsService.findOne.mockResolvedValue(mockBudget);
      periodsRepository.findOne.mockResolvedValue(null);

      await expect(service.closePeriod("user-1", "budget-1")).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("getOrCreateCurrentPeriod", () => {
    it("returns existing open period if one exists", async () => {
      periodsRepository.findOne.mockResolvedValue({
        ...mockPeriod,
        status: PeriodStatus.OPEN,
      });

      const result = await service.getOrCreateCurrentPeriod(
        "user-1",
        "budget-1",
      );

      expect(result.status).toBe(PeriodStatus.OPEN);
    });

    it("creates a new period if no open period exists", async () => {
      const budgetWithCategories = {
        ...mockBudget,
        categories: [{ ...mockBudgetCategory }],
      };
      budgetsService.findOne.mockResolvedValue(budgetWithCategories);
      periodsRepository.findOne.mockResolvedValue(null);
      periodsRepository.save.mockImplementation((data) => ({
        ...data,
        id: "new-period",
      }));

      const result = await service.getOrCreateCurrentPeriod(
        "user-1",
        "budget-1",
      );

      expect(result.id).toBe("new-period");
      expect(periodsRepository.create).toHaveBeenCalled();
      expect(periodCategoriesRepository.create).toHaveBeenCalled();
    });
  });

  describe("createPeriodForBudget", () => {
    it("creates period with categories and correct totals", async () => {
      const budgetWithCategories = {
        ...mockBudget,
        categories: [
          { ...mockBudgetCategory, id: "bc-1", amount: 500, isIncome: false },
          { ...mockBudgetCategory, id: "bc-2", amount: 300, isIncome: false },
          { ...mockBudgetCategory, id: "bc-3", amount: 3000, isIncome: true },
        ],
      };
      periodsRepository.save.mockImplementation((data) => ({
        ...data,
        id: "new-period",
      }));

      await service.createPeriodForBudget(budgetWithCategories);

      expect(periodsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          totalBudgeted: 800,
          status: PeriodStatus.OPEN,
        }),
      );
      expect(periodCategoriesRepository.create).toHaveBeenCalledTimes(3);
    });

    it("applies rollover amounts from previous period", async () => {
      const budgetWithCategories = {
        ...mockBudget,
        categories: [
          {
            ...mockBudgetCategory,
            id: "bc-1",
            amount: 500,
            categoryId: "cat-1",
          },
        ],
      };
      const rolloverMap = new Map<string, number>();
      rolloverMap.set("bc-1", 100);

      periodsRepository.save.mockImplementation((data) => ({
        ...data,
        id: "new-period",
      }));

      await service.createPeriodForBudget(budgetWithCategories, rolloverMap);

      expect(periodCategoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          budgetedAmount: 500,
          rolloverIn: 100,
          effectiveBudget: 600,
        }),
      );
    });

    it("creates period with empty categories when budget has none", async () => {
      const emptyBudget = { ...mockBudget, categories: [] };
      periodsRepository.save.mockImplementation((data) => ({
        ...data,
        id: "new-period",
      }));

      await service.createPeriodForBudget(emptyBudget);

      expect(periodCategoriesRepository.create).not.toHaveBeenCalled();
    });
  });

  describe("computeRollover", () => {
    it("returns 0 for NONE rollover type", () => {
      const pc = {
        ...mockPeriodCategory,
        effectiveBudget: 500,
        budgetCategory: {
          ...mockBudgetCategory,
          rolloverType: RolloverType.NONE,
        },
      };

      const result = service.computeRollover(pc, 300);

      expect(result).toBe(0);
    });

    it("returns unused amount for MONTHLY rollover type", () => {
      const pc = {
        ...mockPeriodCategory,
        effectiveBudget: 500,
        budgetCategory: {
          ...mockBudgetCategory,
          rolloverType: RolloverType.MONTHLY,
          rolloverCap: null,
        },
      };

      const result = service.computeRollover(pc, 300);

      expect(result).toBe(200);
    });

    it("caps rollover at rolloverCap when set", () => {
      const pc = {
        ...mockPeriodCategory,
        effectiveBudget: 500,
        budgetCategory: {
          ...mockBudgetCategory,
          rolloverType: RolloverType.MONTHLY,
          rolloverCap: 50,
        },
      };

      const result = service.computeRollover(pc, 300);

      expect(result).toBe(50);
    });

    it("returns 0 when actual exceeds budget", () => {
      const pc = {
        ...mockPeriodCategory,
        effectiveBudget: 500,
        budgetCategory: {
          ...mockBudgetCategory,
          rolloverType: RolloverType.MONTHLY,
        },
      };

      const result = service.computeRollover(pc, 600);

      expect(result).toBe(0);
    });

    it("returns 0 when actual equals budget", () => {
      const pc = {
        ...mockPeriodCategory,
        effectiveBudget: 500,
        budgetCategory: {
          ...mockBudgetCategory,
          rolloverType: RolloverType.QUARTERLY,
        },
      };

      const result = service.computeRollover(pc, 500);

      expect(result).toBe(0);
    });

    it("returns 0 when budgetCategory is null", () => {
      const pc = {
        ...mockPeriodCategory,
        effectiveBudget: 500,
        budgetCategory: null as unknown as BudgetCategory,
      };

      const result = service.computeRollover(pc, 300);

      expect(result).toBe(0);
    });

    it("handles ANNUAL rollover type", () => {
      const pc = {
        ...mockPeriodCategory,
        effectiveBudget: 1000,
        budgetCategory: {
          ...mockBudgetCategory,
          rolloverType: RolloverType.ANNUAL,
          rolloverCap: null,
        },
      };

      const result = service.computeRollover(pc, 200);

      expect(result).toBe(800);
    });

    it("handles rollover with zero effective budget", () => {
      const pc = {
        ...mockPeriodCategory,
        effectiveBudget: 0,
        budgetCategory: {
          ...mockBudgetCategory,
          rolloverType: RolloverType.MONTHLY,
        },
      };

      const result = service.computeRollover(pc, 0);

      expect(result).toBe(0);
    });

    it("rounds rollover to 4 decimal places", () => {
      const pc = {
        ...mockPeriodCategory,
        effectiveBudget: 100.1234,
        budgetCategory: {
          ...mockBudgetCategory,
          rolloverType: RolloverType.MONTHLY,
          rolloverCap: null,
        },
      };

      const result = service.computeRollover(pc, 0.0001);

      expect(result).toBe(100.1233);
    });
  });
});
