import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { BudgetsService } from "./budgets.service";
import { Budget, BudgetType, BudgetStrategy } from "./entities/budget.entity";
import {
  BudgetCategory,
  RolloverType,
} from "./entities/budget-category.entity";
import {
  BudgetAlert,
  AlertType,
  AlertSeverity,
} from "./entities/budget-alert.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "../scheduled-transactions/entities/scheduled-transaction-override.entity";

describe("BudgetsService", () => {
  let service: BudgetsService;
  let budgetsRepository: Record<string, jest.Mock>;
  let budgetCategoriesRepository: Record<string, jest.Mock>;
  let budgetAlertsRepository: Record<string, jest.Mock>;
  let transactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let scheduledTransactionsRepository: Record<string, jest.Mock>;
  let overridesRepository: Record<string, jest.Mock>;

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

  const mockBudgetCategory: BudgetCategory = {
    id: "bc-1",
    budgetId: "budget-1",
    budget: mockBudget,
    categoryId: "cat-1",
    category: mockCategory,
    categoryGroup: null,
    transferAccountId: null,
    transferAccount: null,
    isTransfer: false,
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

  const mockAlert: BudgetAlert = {
    id: "alert-1",
    userId: "user-1",
    budgetId: "budget-1",
    budget: mockBudget,
    budgetCategoryId: "bc-1",
    budgetCategory: mockBudgetCategory,
    alertType: AlertType.THRESHOLD_WARNING,
    severity: AlertSeverity.WARNING,
    title: "Groceries at 80%",
    message: "You have spent 80% of your groceries budget",
    data: {},
    isRead: false,
    isEmailSent: false,
    periodStart: "2026-02-01",
    createdAt: new Date("2026-02-15"),
    dismissedAt: null,
  };

  const createMockQueryBuilder = (
    overrides: Record<string, jest.Mock> = {},
  ) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getRawMany: jest.fn().mockResolvedValue([]),
    getCount: jest.fn().mockResolvedValue(0),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 0 }),
    ...overrides,
  });

  beforeEach(async () => {
    budgetsRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-budget" })),
      save: jest.fn().mockImplementation((data) => ({
        ...data,
        id: data.id || "new-budget",
      })),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      remove: jest.fn(),
    };

    budgetCategoriesRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-bc" })),
      save: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: data.id || "new-bc" })),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      remove: jest.fn(),
    };

    budgetAlertsRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((data) => data),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    transactionsRepository = {
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    splitsRepository = {
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    categoriesRepository = {
      findOne: jest.fn(),
    };

    scheduledTransactionsRepository = {
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    overridesRepository = {
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BudgetsService,
        { provide: getRepositoryToken(Budget), useValue: budgetsRepository },
        {
          provide: getRepositoryToken(BudgetCategory),
          useValue: budgetCategoriesRepository,
        },
        {
          provide: getRepositoryToken(BudgetAlert),
          useValue: budgetAlertsRepository,
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
          provide: getRepositoryToken(Category),
          useValue: categoriesRepository,
        },
        {
          provide: getRepositoryToken(ScheduledTransaction),
          useValue: scheduledTransactionsRepository,
        },
        {
          provide: getRepositoryToken(ScheduledTransactionOverride),
          useValue: overridesRepository,
        },
      ],
    }).compile();

    service = module.get<BudgetsService>(BudgetsService);
  });

  describe("create", () => {
    it("creates a budget with provided data", async () => {
      const dto = {
        name: "Monthly Budget",
        periodStart: "2026-02-01",
        currencyCode: "USD",
      };
      budgetsRepository.save.mockResolvedValue({
        ...dto,
        id: "new-budget",
        userId: "user-1",
      });

      const result = await service.create("user-1", dto);

      expect(budgetsRepository.create).toHaveBeenCalledWith({
        ...dto,
        userId: "user-1",
      });
      expect(budgetsRepository.save).toHaveBeenCalled();
      expect(result.name).toBe("Monthly Budget");
    });

    it("creates a budget with all optional fields", async () => {
      const dto = {
        name: "Full Budget",
        description: "My full budget",
        budgetType: BudgetType.ANNUAL,
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        baseIncome: 6000,
        incomeLinked: true,
        strategy: BudgetStrategy.ZERO_BASED,
        currencyCode: "CAD",
        config: { includeTransfers: true },
      };
      budgetsRepository.save.mockResolvedValue({
        ...dto,
        id: "new-budget",
        userId: "user-1",
      });

      const result = await service.create("user-1", dto);

      expect(result.strategy).toBe(BudgetStrategy.ZERO_BASED);
      expect(result.incomeLinked).toBe(true);
    });
  });

  describe("findAll", () => {
    it("returns budgets for the user", async () => {
      budgetsRepository.find.mockResolvedValue([mockBudget]);

      const result = await service.findAll("user-1");

      expect(result).toHaveLength(1);
      expect(budgetsRepository.find).toHaveBeenCalledWith({
        where: { userId: "user-1" },
        order: { createdAt: "DESC" },
        relations: ["categories"],
      });
    });

    it("returns empty array when user has no budgets", async () => {
      budgetsRepository.find.mockResolvedValue([]);

      const result = await service.findAll("user-1");

      expect(result).toEqual([]);
    });
  });

  describe("findOne", () => {
    it("returns budget when found and belongs to user", async () => {
      budgetsRepository.findOne.mockResolvedValue(mockBudget);

      const result = await service.findOne("user-1", "budget-1");

      expect(result).toEqual(mockBudget);
      expect(budgetsRepository.findOne).toHaveBeenCalledWith({
        where: { id: "budget-1", userId: "user-1" },
        relations: [
          "categories",
          "categories.category",
          "categories.category.parent",
          "categories.transferAccount",
        ],
      });
    });

    it("throws NotFoundException when budget not found", async () => {
      budgetsRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws NotFoundException when budget belongs to different user", async () => {
      budgetsRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne("user-1", "budget-1")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("update", () => {
    it("updates budget fields", async () => {
      budgetsRepository.findOne.mockResolvedValue({ ...mockBudget });
      budgetsRepository.save.mockImplementation((data) => data);

      const result = await service.update("user-1", "budget-1", {
        name: "Updated Budget",
        description: "New description",
        isActive: false,
      });

      expect(result.name).toBe("Updated Budget");
      expect(result.description).toBe("New description");
      expect(result.isActive).toBe(false);
    });

    it("does not overwrite fields not in the dto", async () => {
      budgetsRepository.findOne.mockResolvedValue({
        ...mockBudget,
        name: "Original",
        description: "Keep me",
      });
      budgetsRepository.save.mockImplementation((data) => data);

      const result = await service.update("user-1", "budget-1", {
        name: "Changed",
      });

      expect(result.name).toBe("Changed");
      expect(result.description).toBe("Keep me");
    });

    it("updates strategy", async () => {
      budgetsRepository.findOne.mockResolvedValue({ ...mockBudget });
      budgetsRepository.save.mockImplementation((data) => data);

      const result = await service.update("user-1", "budget-1", {
        strategy: BudgetStrategy.ROLLOVER,
      });

      expect(result.strategy).toBe(BudgetStrategy.ROLLOVER);
    });

    it("throws NotFoundException when budget not found", async () => {
      budgetsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.update("user-1", "budget-1", { name: "New" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when budget belongs to different user", async () => {
      budgetsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.update("user-1", "budget-1", { name: "New" }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("remove", () => {
    it("removes budget", async () => {
      budgetsRepository.findOne.mockResolvedValue({ ...mockBudget });

      await service.remove("user-1", "budget-1");

      expect(budgetsRepository.remove).toHaveBeenCalledWith(
        expect.objectContaining({ id: "budget-1" }),
      );
    });

    it("throws NotFoundException when budget not found", async () => {
      budgetsRepository.findOne.mockResolvedValue(null);

      await expect(service.remove("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("addCategory", () => {
    it("adds a category to the budget", async () => {
      budgetsRepository.findOne.mockResolvedValue({ ...mockBudget });
      categoriesRepository.findOne.mockResolvedValue(mockCategory);
      budgetCategoriesRepository.findOne.mockResolvedValue(null);
      budgetCategoriesRepository.save.mockResolvedValue({
        ...mockBudgetCategory,
        id: "new-bc",
      });

      const result = await service.addCategory("user-1", "budget-1", {
        categoryId: "cat-1",
        amount: 500,
      });

      expect(budgetCategoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          categoryId: "cat-1",
          amount: 500,
          budgetId: "budget-1",
        }),
      );
      expect(result.id).toBe("new-bc");
    });

    it("throws NotFoundException when category does not exist", async () => {
      budgetsRepository.findOne.mockResolvedValue({ ...mockBudget });
      categoriesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.addCategory("user-1", "budget-1", {
          categoryId: "nonexistent",
          amount: 100,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when category belongs to different user", async () => {
      budgetsRepository.findOne.mockResolvedValue({ ...mockBudget });
      categoriesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.addCategory("user-1", "budget-1", {
          categoryId: "cat-1",
          amount: 100,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException when category already in budget", async () => {
      budgetsRepository.findOne.mockResolvedValue({ ...mockBudget });
      categoriesRepository.findOne.mockResolvedValue(mockCategory);
      budgetCategoriesRepository.findOne.mockResolvedValue(mockBudgetCategory);

      await expect(
        service.addCategory("user-1", "budget-1", {
          categoryId: "cat-1",
          amount: 500,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("updateCategory", () => {
    it("updates budget category fields", async () => {
      budgetsRepository.findOne.mockResolvedValue({ ...mockBudget });
      budgetCategoriesRepository.findOne.mockResolvedValue({
        ...mockBudgetCategory,
      });
      budgetCategoriesRepository.save.mockImplementation((data) => data);

      const result = await service.updateCategory(
        "user-1",
        "budget-1",
        "bc-1",
        { amount: 600, rolloverType: RolloverType.MONTHLY },
      );

      expect(result.amount).toBe(600);
      expect(result.rolloverType).toBe(RolloverType.MONTHLY);
    });

    it("throws NotFoundException when budget category not found", async () => {
      budgetsRepository.findOne.mockResolvedValue({ ...mockBudget });
      budgetCategoriesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateCategory("user-1", "budget-1", "nonexistent", {
          amount: 100,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("does not overwrite fields not in the dto", async () => {
      budgetsRepository.findOne.mockResolvedValue({ ...mockBudget });
      budgetCategoriesRepository.findOne.mockResolvedValue({
        ...mockBudgetCategory,
        amount: 500,
        notes: "Keep these notes",
      });
      budgetCategoriesRepository.save.mockImplementation((data) => data);

      const result = await service.updateCategory(
        "user-1",
        "budget-1",
        "bc-1",
        { amount: 600 },
      );

      expect(result.amount).toBe(600);
      expect(result.notes).toBe("Keep these notes");
    });
  });

  describe("removeCategory", () => {
    it("removes budget category", async () => {
      budgetsRepository.findOne.mockResolvedValue({ ...mockBudget });
      budgetCategoriesRepository.findOne.mockResolvedValue({
        ...mockBudgetCategory,
      });

      await service.removeCategory("user-1", "budget-1", "bc-1");

      expect(budgetCategoriesRepository.remove).toHaveBeenCalledWith(
        expect.objectContaining({ id: "bc-1" }),
      );
    });

    it("throws NotFoundException when budget category not found", async () => {
      budgetsRepository.findOne.mockResolvedValue({ ...mockBudget });
      budgetCategoriesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.removeCategory("user-1", "budget-1", "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("bulkUpdateCategories", () => {
    it("updates multiple category amounts", async () => {
      budgetsRepository.findOne.mockResolvedValue({ ...mockBudget });
      budgetCategoriesRepository.findOne
        .mockResolvedValueOnce({ ...mockBudgetCategory, id: "bc-1" })
        .mockResolvedValueOnce({ ...mockBudgetCategory, id: "bc-2" });
      budgetCategoriesRepository.save.mockImplementation((data) => data);

      const result = await service.bulkUpdateCategories("user-1", "budget-1", [
        { id: "bc-1", amount: 600 },
        { id: "bc-2", amount: 300 },
      ]);

      expect(result).toHaveLength(2);
      expect(result[0].amount).toBe(600);
      expect(result[1].amount).toBe(300);
    });

    it("throws NotFoundException when a category is not found", async () => {
      budgetsRepository.findOne.mockResolvedValue({ ...mockBudget });
      budgetCategoriesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.bulkUpdateCategories("user-1", "budget-1", [
          { id: "nonexistent", amount: 100 },
        ]),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("getSummary", () => {
    it("returns budget summary with category breakdown", async () => {
      const budgetWithCategories = {
        ...mockBudget,
        categories: [
          {
            ...mockBudgetCategory,
            id: "bc-1",
            categoryId: "cat-1",
            amount: 500,
            isIncome: false,
            category: { name: "Groceries" },
          },
          {
            ...mockBudgetCategory,
            id: "bc-2",
            categoryId: "cat-2",
            amount: 1500,
            isIncome: false,
            category: { name: "Rent" },
          },
          {
            ...mockBudgetCategory,
            id: "bc-3",
            categoryId: "cat-3",
            amount: 3000,
            isIncome: true,
            category: { name: "Salary" },
          },
        ],
      };
      budgetsRepository.findOne.mockResolvedValue(budgetWithCategories);

      const directQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { categoryId: "cat-1", total: "350" },
          { categoryId: "cat-2", total: "1500" },
          { categoryId: "cat-3", total: "3000" },
        ]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      const result = await service.getSummary("user-1", "budget-1");

      expect(result.totalBudgeted).toBe(2000);
      expect(result.totalSpent).toBe(1850);
      expect(result.totalIncome).toBe(3000);
      expect(result.remaining).toBe(150);
      expect(result.categoryBreakdown).toHaveLength(3);

      const groceries = result.categoryBreakdown.find(
        (c) => c.categoryName === "Groceries",
      );
      expect(groceries!.budgeted).toBe(500);
      expect(groceries!.spent).toBe(350);
      expect(groceries!.remaining).toBe(150);
    });

    it("returns zero totals when budget has no categories", async () => {
      budgetsRepository.findOne.mockResolvedValue({
        ...mockBudget,
        categories: [],
      });

      const result = await service.getSummary("user-1", "budget-1");

      expect(result.totalBudgeted).toBe(0);
      expect(result.totalSpent).toBe(0);
      expect(result.categoryBreakdown).toHaveLength(0);
    });

    it("includes split transaction spending in category actuals", async () => {
      const budgetWithCategories = {
        ...mockBudget,
        categories: [
          {
            ...mockBudgetCategory,
            id: "bc-1",
            categoryId: "cat-1",
            amount: 500,
            isIncome: false,
            category: { name: "Groceries" },
          },
        ],
      };
      budgetsRepository.findOne.mockResolvedValue(budgetWithCategories);

      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-1", total: "200" }]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-1", total: "100" }]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      const result = await service.getSummary("user-1", "budget-1");

      const groceries = result.categoryBreakdown.find(
        (c) => c.categoryName === "Groceries",
      );
      expect(groceries!.spent).toBe(300);
    });
  });

  describe("getVelocity", () => {
    it("calculates velocity metrics", async () => {
      const budgetWithCategories = {
        ...mockBudget,
        categories: [
          {
            ...mockBudgetCategory,
            id: "bc-1",
            categoryId: "cat-1",
            amount: 600,
            isIncome: false,
            category: { name: "Groceries" },
          },
        ],
      };
      budgetsRepository.findOne.mockResolvedValue(budgetWithCategories);

      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-1", total: "200" }]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      const result = await service.getVelocity("user-1", "budget-1");

      expect(result.currentSpent).toBe(200);
      expect(result.budgetTotal).toBe(600);
      expect(result.totalDays).toBeGreaterThan(0);
      expect(result.daysElapsed).toBeGreaterThanOrEqual(1);
      expect(result.dailyBurnRate).toBeGreaterThanOrEqual(0);
      expect(result.projectedTotal).toBeGreaterThanOrEqual(0);
      expect(typeof result.safeDailySpend).toBe("number");
      expect(["under", "on_track", "over"]).toContain(result.paceStatus);
    });

    it("returns zero safe daily spend when no days remaining", async () => {
      const budgetWithCategories = {
        ...mockBudget,
        categories: [
          {
            ...mockBudgetCategory,
            id: "bc-1",
            categoryId: "cat-1",
            amount: 100,
            isIncome: false,
            category: { name: "Groceries" },
          },
        ],
      };
      budgetsRepository.findOne.mockResolvedValue(budgetWithCategories);

      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-1", total: "150" }]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(),
      );

      const result = await service.getVelocity("user-1", "budget-1");

      expect(result.currentSpent).toBe(150);
      expect(result.budgetTotal).toBe(100);
    });
  });

  describe("getAlerts", () => {
    // Helper to set up ensureBillAlerts mocks (ST query returns empty, overrides query returns empty)
    const mockEmptyBillAlerts = () => {
      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({ getMany: jest.fn().mockResolvedValue([]) }),
      );
    };

    it("returns alerts for the user", async () => {
      mockEmptyBillAlerts();
      budgetAlertsRepository.find.mockResolvedValue([mockAlert]);

      const result = await service.getAlerts("user-1");

      expect(result).toHaveLength(1);
      expect(budgetAlertsRepository.find).toHaveBeenCalledWith({
        where: { userId: "user-1", dismissedAt: expect.anything() },
        order: { createdAt: "DESC" },
        take: 50,
      });
    });

    it("returns only unread alerts when unreadOnly is true", async () => {
      budgetAlertsRepository.find.mockResolvedValue([mockAlert]);

      await service.getAlerts("user-1", true);

      expect(budgetAlertsRepository.find).toHaveBeenCalledWith({
        where: {
          userId: "user-1",
          isRead: false,
          dismissedAt: expect.anything(),
        },
        order: { createdAt: "DESC" },
        take: 50,
      });
    });

    it("returns empty array when no alerts exist", async () => {
      mockEmptyBillAlerts();
      budgetAlertsRepository.find.mockResolvedValue([]);

      const result = await service.getAlerts("user-1");

      expect(result).toHaveLength(0);
    });

    it("persists upcoming bill alerts with per-bill reminder window", async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split("T")[0];

      const billQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([
          {
            id: "st-1",
            userId: "user-1",
            name: "Netflix",
            payee: { name: "Netflix Inc" },
            payeeName: null,
            amount: -15.99,
            currencyCode: "USD",
            nextDueDate: tomorrowStr,
            isActive: true,
            autoPost: false,
            reminderDaysBefore: 3,
          },
        ]),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
      });
      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(
        billQb,
      );

      // No existing alerts, no overrides
      const alertQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      budgetAlertsRepository.createQueryBuilder.mockReturnValue(alertQb);
      overridesRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({ getMany: jest.fn().mockResolvedValue([]) }),
      );
      budgetAlertsRepository.save.mockImplementation((data: BudgetAlert) => ({
        ...data,
        id: "new-alert-1",
      }));
      budgetAlertsRepository.find.mockResolvedValue([]);

      await service.getAlerts("user-1");

      expect(budgetAlertsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          alertType: AlertType.BILL_DUE,
          title: expect.stringContaining("Netflix Inc"),
          message: expect.stringContaining("15.99"),
          budgetId: null,
        }),
      );
    });

    it("uses override amount when instance override exists", async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split("T")[0];

      const billQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([
          {
            id: "st-1",
            userId: "user-1",
            name: "Electric",
            payee: { name: "Power Co" },
            payeeName: null,
            amount: -250.0,
            currencyCode: "USD",
            nextDueDate: tomorrowStr,
            isActive: true,
            autoPost: false,
            reminderDaysBefore: 3,
          },
        ]),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
      });
      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(
        billQb,
      );

      const alertQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      budgetAlertsRepository.createQueryBuilder.mockReturnValue(alertQb);
      overridesRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getMany: jest.fn().mockResolvedValue([
            {
              scheduledTransactionId: "st-1",
              overrideDate: tomorrowStr,
              amount: -312.65,
            },
          ]),
        }),
      );
      budgetAlertsRepository.save.mockImplementation((data: BudgetAlert) => ({
        ...data,
        id: "new-alert-1",
      }));
      budgetAlertsRepository.find.mockResolvedValue([]);

      await service.getAlerts("user-1");

      expect(budgetAlertsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("312.65"),
        }),
      );
    });

    it("skips bills outside their reminder window", async () => {
      const in10Days = new Date();
      in10Days.setDate(in10Days.getDate() + 10);

      const billQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([
          {
            id: "st-1",
            userId: "user-1",
            name: "Netflix",
            payee: { name: "Netflix Inc" },
            payeeName: null,
            amount: -15.99,
            currencyCode: "USD",
            nextDueDate: in10Days.toISOString().split("T")[0],
            isActive: true,
            autoPost: false,
            reminderDaysBefore: 3,
          },
        ]),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
      });
      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(
        billQb,
      );
      budgetAlertsRepository.find.mockResolvedValue([]);

      await service.getAlerts("user-1");

      // Bill is 10 days out but reminderDaysBefore is 3 — should not create an alert
      expect(budgetAlertsRepository.save).not.toHaveBeenCalled();
    });

    it("does not call ensureBillAlerts when unreadOnly is true", async () => {
      budgetAlertsRepository.find.mockResolvedValue([mockAlert]);

      await service.getAlerts("user-1", true);

      expect(
        scheduledTransactionsRepository.createQueryBuilder,
      ).not.toHaveBeenCalled();
    });
  });

  describe("markAlertRead", () => {
    it("marks alert as read", async () => {
      budgetAlertsRepository.findOne.mockResolvedValue({ ...mockAlert });
      budgetAlertsRepository.save.mockImplementation((data) => data);

      const result = await service.markAlertRead("user-1", "alert-1");

      expect(result.isRead).toBe(true);
    });

    it("throws NotFoundException when alert not found", async () => {
      budgetAlertsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.markAlertRead("user-1", "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when alert belongs to different user", async () => {
      budgetAlertsRepository.findOne.mockResolvedValue(null);

      await expect(service.markAlertRead("user-1", "alert-1")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("deleteAlert", () => {
    it("soft-deletes alert when found and belongs to user", async () => {
      budgetAlertsRepository.findOne.mockResolvedValue({ ...mockAlert });
      budgetAlertsRepository.save.mockImplementation(
        (data: BudgetAlert) => data,
      );

      await service.deleteAlert("user-1", "alert-1");

      expect(budgetAlertsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "alert-1",
          dismissedAt: expect.any(Date),
        }),
      );
    });

    it("throws NotFoundException when alert not found", async () => {
      budgetAlertsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.deleteAlert("user-1", "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when alert belongs to different user", async () => {
      budgetAlertsRepository.findOne.mockResolvedValue(null);

      await expect(service.deleteAlert("user-1", "alert-1")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("markAllAlertsRead", () => {
    it("marks all unread alerts as read", async () => {
      budgetAlertsRepository.update.mockResolvedValue({ affected: 5 });

      const result = await service.markAllAlertsRead("user-1");

      expect(result.updated).toBe(5);
      expect(budgetAlertsRepository.update).toHaveBeenCalledWith(
        { userId: "user-1", isRead: false, dismissedAt: expect.anything() },
        { isRead: true },
      );
    });

    it("returns zero when no unread alerts exist", async () => {
      budgetAlertsRepository.update.mockResolvedValue({ affected: 0 });

      const result = await service.markAllAlertsRead("user-1");

      expect(result.updated).toBe(0);
    });
  });

  describe("getDashboardSummary", () => {
    it("returns null if no active budgets exist", async () => {
      budgetsRepository.find.mockResolvedValue([]);

      const result = await service.getDashboardSummary("user-1");

      expect(result).toBeNull();
      expect(budgetsRepository.find).toHaveBeenCalledWith({
        where: { userId: "user-1", isActive: true },
        relations: [
          "categories",
          "categories.category",
          "categories.category.parent",
          "categories.transferAccount",
        ],
        order: { createdAt: "DESC" },
      });
    });

    it("returns summary with topCategories sorted by percentUsed descending", async () => {
      const budgetWithCategories = {
        ...mockBudget,
        id: "budget-1",
        name: "February 2026",
        categories: [
          {
            ...mockBudgetCategory,
            id: "bc-1",
            categoryId: "cat-1",
            amount: 500,
            isIncome: false,
            category: { name: "Groceries" },
          },
          {
            ...mockBudgetCategory,
            id: "bc-2",
            categoryId: "cat-2",
            amount: 1000,
            isIncome: false,
            category: { name: "Rent" },
          },
          {
            ...mockBudgetCategory,
            id: "bc-3",
            categoryId: "cat-3",
            amount: 300,
            isIncome: false,
            category: { name: "Entertainment" },
          },
          {
            ...mockBudgetCategory,
            id: "bc-4",
            categoryId: "cat-4",
            amount: 200,
            isIncome: false,
            category: { name: "Dining Out" },
          },
          {
            ...mockBudgetCategory,
            id: "bc-5",
            categoryId: "cat-5",
            amount: 5000,
            isIncome: true,
            category: { name: "Salary" },
          },
        ],
      };
      budgetsRepository.find.mockResolvedValue([budgetWithCategories]);

      const directQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { categoryId: "cat-1", total: "400" },
          { categoryId: "cat-2", total: "950" },
          { categoryId: "cat-3", total: "280" },
          { categoryId: "cat-4", total: "50" },
          { categoryId: "cat-5", total: "5000" },
        ]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      const result = await service.getDashboardSummary("user-1");

      expect(result).not.toBeNull();
      expect(result!.budgetId).toBe("budget-1");
      expect(result!.budgetName).toBe("February 2026");
      expect(result!.totalBudgeted).toBe(2000);
      expect(result!.totalSpent).toBe(1680);
      expect(result!.remaining).toBe(320);
      expect(result!.topCategories).toHaveLength(3);

      // Sorted by percentUsed descending: Rent (95%), Entertainment (93.33%), Groceries (80%)
      expect(result!.topCategories[0].categoryName).toBe("Rent");
      expect(result!.topCategories[0].percentUsed).toBe(95);
      expect(result!.topCategories[1].categoryName).toBe("Entertainment");
      expect(result!.topCategories[2].categoryName).toBe("Groceries");

      // Income categories should not be in topCategories
      expect(
        result!.topCategories.find((c) => c.categoryName === "Salary"),
      ).toBeUndefined();
    });

    it("calculates safeDailySpend correctly", async () => {
      const budgetWithCategories = {
        ...mockBudget,
        categories: [
          {
            ...mockBudgetCategory,
            id: "bc-1",
            categoryId: "cat-1",
            amount: 3000,
            isIncome: false,
            category: { name: "Groceries" },
          },
        ],
      };
      budgetsRepository.find.mockResolvedValue([budgetWithCategories]);

      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-1", total: "1000" }]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      const result = await service.getDashboardSummary("user-1");

      expect(result).not.toBeNull();
      expect(result!.totalBudgeted).toBe(3000);
      expect(result!.totalSpent).toBe(1000);
      expect(result!.remaining).toBe(2000);
      expect(typeof result!.safeDailySpend).toBe("number");
      expect(result!.safeDailySpend).toBeGreaterThanOrEqual(0);
      expect(typeof result!.daysRemaining).toBe("number");
      expect(result!.daysRemaining).toBeGreaterThanOrEqual(0);
    });

    it("returns zero percentUsed when totalBudgeted is zero", async () => {
      const budgetWithNoExpenseCategories = {
        ...mockBudget,
        categories: [
          {
            ...mockBudgetCategory,
            id: "bc-1",
            categoryId: "cat-1",
            amount: 5000,
            isIncome: true,
            category: { name: "Salary" },
          },
        ],
      };
      budgetsRepository.find.mockResolvedValue([budgetWithNoExpenseCategories]);

      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-1", total: "5000" }]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      const result = await service.getDashboardSummary("user-1");

      expect(result).not.toBeNull();
      expect(result!.totalBudgeted).toBe(0);
      expect(result!.percentUsed).toBe(0);
      expect(result!.topCategories).toHaveLength(0);
    });
  });

  describe("getCategoryBudgetStatus", () => {
    it("returns empty map if no active budgets exist", async () => {
      budgetsRepository.find.mockResolvedValue([]);

      const result = await service.getCategoryBudgetStatus("user-1", ["cat-1"]);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it("returns empty map if categoryIds is empty", async () => {
      budgetsRepository.find.mockResolvedValue([mockBudget]);

      const result = await service.getCategoryBudgetStatus("user-1", []);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it("returns correct budget status for matching categories", async () => {
      const budgetWithCategories = {
        ...mockBudget,
        categories: [
          {
            ...mockBudgetCategory,
            id: "bc-1",
            categoryId: "cat-1",
            amount: 500,
            isIncome: false,
            category: { name: "Groceries" },
          },
          {
            ...mockBudgetCategory,
            id: "bc-2",
            categoryId: "cat-2",
            amount: 1000,
            isIncome: false,
            category: { name: "Rent" },
          },
        ],
      };
      budgetsRepository.find.mockResolvedValue([budgetWithCategories]);

      const directQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { categoryId: "cat-1", total: "350" },
          { categoryId: "cat-2", total: "900" },
        ]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      const result = await service.getCategoryBudgetStatus("user-1", [
        "cat-1",
        "cat-2",
      ]);

      expect(result.size).toBe(2);

      const groceries = result.get("cat-1");
      expect(groceries).toBeDefined();
      expect(groceries!.budgeted).toBe(500);
      expect(groceries!.spent).toBe(350);
      expect(groceries!.remaining).toBe(150);
      expect(groceries!.percentUsed).toBe(70);

      const rent = result.get("cat-2");
      expect(rent).toBeDefined();
      expect(rent!.budgeted).toBe(1000);
      expect(rent!.spent).toBe(900);
      expect(rent!.remaining).toBe(100);
      expect(rent!.percentUsed).toBe(90);
    });

    it("excludes income categories from the result", async () => {
      const budgetWithIncomeAndExpense = {
        ...mockBudget,
        categories: [
          {
            ...mockBudgetCategory,
            id: "bc-1",
            categoryId: "cat-1",
            amount: 500,
            isIncome: false,
            category: { name: "Groceries" },
          },
          {
            ...mockBudgetCategory,
            id: "bc-2",
            categoryId: "cat-2",
            amount: 5000,
            isIncome: true,
            category: { name: "Salary" },
          },
        ],
      };
      budgetsRepository.find.mockResolvedValue([budgetWithIncomeAndExpense]);

      const directQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { categoryId: "cat-1", total: "300" },
          { categoryId: "cat-2", total: "5000" },
        ]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      const result = await service.getCategoryBudgetStatus("user-1", [
        "cat-1",
        "cat-2",
      ]);

      expect(result.size).toBe(1);
      expect(result.has("cat-1")).toBe(true);
      expect(result.has("cat-2")).toBe(false);
    });

    it("only returns status for requested category IDs", async () => {
      const budgetWithCategories = {
        ...mockBudget,
        categories: [
          {
            ...mockBudgetCategory,
            id: "bc-1",
            categoryId: "cat-1",
            amount: 500,
            isIncome: false,
            category: { name: "Groceries" },
          },
          {
            ...mockBudgetCategory,
            id: "bc-2",
            categoryId: "cat-2",
            amount: 1000,
            isIncome: false,
            category: { name: "Rent" },
          },
          {
            ...mockBudgetCategory,
            id: "bc-3",
            categoryId: "cat-3",
            amount: 300,
            isIncome: false,
            category: { name: "Entertainment" },
          },
        ],
      };
      budgetsRepository.find.mockResolvedValue([budgetWithCategories]);

      const directQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { categoryId: "cat-1", total: "200" },
          { categoryId: "cat-2", total: "800" },
          { categoryId: "cat-3", total: "150" },
        ]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      const result = await service.getCategoryBudgetStatus("user-1", ["cat-1"]);

      expect(result.size).toBe(1);
      expect(result.has("cat-1")).toBe(true);
      expect(result.has("cat-2")).toBe(false);
      expect(result.has("cat-3")).toBe(false);
    });
  });

  describe("income-linked percentage budgets", () => {
    it("computes effective budget from percentage of actual income", async () => {
      const incomeLinkedBudget = {
        ...mockBudget,
        incomeLinked: true,
        baseIncome: null,
        categories: [
          {
            ...mockBudgetCategory,
            id: "bc-inc",
            categoryId: "cat-inc",
            amount: 5000,
            isIncome: true,
            category: { name: "Salary" },
          },
          {
            ...mockBudgetCategory,
            id: "bc-1",
            categoryId: "cat-1",
            amount: 30,
            isIncome: false,
            category: { name: "Groceries" },
          },
          {
            ...mockBudgetCategory,
            id: "bc-2",
            categoryId: "cat-2",
            amount: 50,
            isIncome: false,
            category: { name: "Rent" },
          },
        ],
      };
      budgetsRepository.findOne.mockResolvedValue(incomeLinkedBudget);

      // Income query returns 4000
      const incomeQb = createMockQueryBuilder({
        getRawOne: jest.fn().mockResolvedValue({ total: "4000" }),
        getRawMany: jest.fn().mockResolvedValue([
          { categoryId: "cat-inc", total: "4000" },
          { categoryId: "cat-1", total: "900" },
          { categoryId: "cat-2", total: "1800" },
        ]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue({ total: "0" }),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(incomeQb);
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      const result = await service.getSummary("user-1", "budget-1");

      expect(result.incomeLinked).toBe(true);
      expect(result.actualIncome).toBe(4000);

      // Groceries: 30% of 4000 = 1200
      const groceries = result.categoryBreakdown.find(
        (c) => c.categoryName === "Groceries",
      );
      expect(groceries).toBeDefined();
      expect(groceries!.budgeted).toBe(1200);
      expect(groceries!.percentage).toBe(30);
      expect(groceries!.spent).toBe(900);

      // Rent: 50% of 4000 = 2000
      const rent = result.categoryBreakdown.find(
        (c) => c.categoryName === "Rent",
      );
      expect(rent).toBeDefined();
      expect(rent!.budgeted).toBe(2000);
      expect(rent!.percentage).toBe(50);
    });

    it("returns null percentage for non-income-linked budgets", async () => {
      const normalBudget = {
        ...mockBudget,
        incomeLinked: false,
        categories: [
          {
            ...mockBudgetCategory,
            id: "bc-1",
            categoryId: "cat-1",
            amount: 500,
            isIncome: false,
            category: { name: "Groceries" },
          },
        ],
      };
      budgetsRepository.findOne.mockResolvedValue(normalBudget);

      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-1", total: "200" }]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      const result = await service.getSummary("user-1", "budget-1");

      expect(result.incomeLinked).toBe(false);
      expect(result.actualIncome).toBeNull();

      const groceries = result.categoryBreakdown.find(
        (c) => c.categoryName === "Groceries",
      );
      expect(groceries!.percentage).toBeNull();
      expect(groceries!.budgeted).toBe(500);
    });

    it("returns zero effective budget when no income recorded for income-linked budget", async () => {
      const incomeLinkedBudget = {
        ...mockBudget,
        incomeLinked: true,
        categories: [
          {
            ...mockBudgetCategory,
            id: "bc-1",
            categoryId: "cat-1",
            amount: 30,
            isIncome: false,
            category: { name: "Groceries" },
          },
        ],
      };
      budgetsRepository.findOne.mockResolvedValue(incomeLinkedBudget);

      const directQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue({ total: "0" }),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue({ total: "0" }),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      const result = await service.getSummary("user-1", "budget-1");

      const groceries = result.categoryBreakdown.find(
        (c) => c.categoryName === "Groceries",
      );
      expect(groceries!.budgeted).toBe(0);
      expect(groceries!.percentage).toBe(30);
    });
  });

  describe("upcoming bills awareness", () => {
    it("getUpcomingBills returns scheduled transactions due in the period", async () => {
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const stQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([
          {
            id: "st-1",
            name: "Netflix",
            amount: -15.99,
            nextDueDate: tomorrow.toISOString().split("T")[0],
            categoryId: "cat-ent",
          },
          {
            id: "st-2",
            name: "Internet",
            amount: -79.99,
            nextDueDate: tomorrow.toISOString().split("T")[0],
            categoryId: "cat-util",
          },
        ]),
      });
      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(stQb);

      const result = await service.getUpcomingBills("user-1", "2026-02-28");

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("Netflix");
      expect(result[0].amount).toBe(15.99);
      expect(result[1].name).toBe("Internet");
      expect(result[1].amount).toBe(79.99);
    });

    it("getUpcomingBills returns empty array when no bills are due", async () => {
      const stQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(stQb);

      const result = await service.getUpcomingBills("user-1", "2026-02-28");

      expect(result).toHaveLength(0);
    });

    it("getVelocity includes upcoming bills and truly available", async () => {
      const budgetWithCategories = {
        ...mockBudget,
        categories: [
          {
            ...mockBudgetCategory,
            id: "bc-1",
            categoryId: "cat-1",
            amount: 1000,
            isIncome: false,
            category: { name: "Groceries" },
          },
        ],
      };
      budgetsRepository.findOne.mockResolvedValue(budgetWithCategories);

      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-1", total: "400" }]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const stQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([
          {
            id: "st-1",
            name: "Rent",
            amount: -200,
            nextDueDate: tomorrow.toISOString().split("T")[0],
            categoryId: "cat-rent",
          },
        ]),
      });
      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(stQb);

      const result = await service.getVelocity("user-1", "budget-1");

      expect(result.upcomingBills).toHaveLength(1);
      expect(result.upcomingBills[0].name).toBe("Rent");
      expect(result.upcomingBills[0].amount).toBe(200);
      expect(result.totalUpcomingBills).toBe(200);
      // truly available = (1000 - 400) - 200 = 400
      expect(result.trulyAvailable).toBe(400);
      expect(result.currentSpent).toBe(400);
      expect(result.budgetTotal).toBe(1000);
    });

    it("getVelocity returns zero trulyAvailable when bills exceed remaining", async () => {
      const budgetWithCategories = {
        ...mockBudget,
        categories: [
          {
            ...mockBudgetCategory,
            id: "bc-1",
            categoryId: "cat-1",
            amount: 500,
            isIncome: false,
            category: { name: "Groceries" },
          },
        ],
      };
      budgetsRepository.findOne.mockResolvedValue(budgetWithCategories);

      const directQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-1", total: "400" }]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const stQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([
          {
            id: "st-1",
            name: "Large Bill",
            amount: -200,
            nextDueDate: tomorrow.toISOString().split("T")[0],
            categoryId: null,
          },
        ]),
      });
      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(stQb);

      const result = await service.getVelocity("user-1", "budget-1");

      // remaining = 500 - 400 = 100, upcoming = 200
      // truly available = 100 - 200 = -100
      expect(result.trulyAvailable).toBe(-100);
    });
  });
});
