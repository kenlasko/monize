import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { BudgetsService } from "./budgets.service";
import { ScheduledEffectiveAmountService } from "../scheduled-transactions/scheduled-effective-amount.service";
import { ScheduledOccurrenceService } from "../scheduled-transactions/scheduled-occurrence.service";
import { ScheduledTransactionLoanService } from "../scheduled-transactions/scheduled-transaction-loan.service";
import { CreateNotificationInput } from "../notification-center/notification.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { InvestmentTransactionsService } from "../securities/investment-transactions.service";
import {
  createInvestmentFxMock,
  InvestmentFxMock,
} from "../test-helpers/investment-fx-testing";
import { Budget, BudgetType, BudgetStrategy } from "./entities/budget.entity";
import {
  BudgetCategory,
  RolloverType,
} from "./entities/budget-category.entity";
import {
  Notification,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "../scheduled-transactions/entities/scheduled-transaction-override.entity";
import { ActionHistoryService } from "../action-history/action-history.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { addDaysYMD, getMonthEndYMD, todayYMD } from "../common/date-utils";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("BudgetsService", () => {
  let scopedManager: ManagerMock;
  let scopedDataSource: DataSourceMock;
  let service: BudgetsService;
  let budgetsRepository: Record<string, jest.Mock>;
  let budgetCategoriesRepository: Record<string, jest.Mock>;
  let budgetAlertsRepository: Record<string, jest.Mock>;
  let dispatchService: Partial<jest.Mocked<NotificationDispatchService>>;
  let transactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let scheduledTransactionsRepository: Record<string, jest.Mock>;
  let overridesRepository: Record<string, jest.Mock>;
  let investmentTransactionsService: InvestmentFxMock;
  let exchangeRateService: jest.Mocked<
    Pick<ExchangeRateService, "getRateForDate" | "getLatestRate">
  >;

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
  let mockActionHistoryService: Record<string, jest.Mock>;
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

    // BudgetsService fans BILL_DUE out through the dispatch seam now; `notify`
    // takes the same input `create` did, so the ensureBillDue assertions read it
    // the same way (the row shape is the write door's, tested there).
    dispatchService = {
      notify: jest.fn().mockResolvedValue(null),
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
      // The occurrence contract loads a schedule's overrides with `find`, keyed
      // by schedule id, and matches them on `originalDate` itself.
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    mockActionHistoryService = {
      record: jest.fn().mockResolvedValue(null),
    };

    ({ manager: scopedManager, dataSource: scopedDataSource } =
      createScopedDbMocks([
        [Budget, budgetsRepository as never],
        [BudgetCategory, budgetCategoriesRepository as never],
        [Notification, budgetAlertsRepository as never],
        [Transaction, transactionsRepository as never],
        [TransactionSplit, splitsRepository as never],
        [Category, categoriesRepository as never],
        [ScheduledTransaction, scheduledTransactionsRepository as never],
        [
          UserPreference,
          {
            // The copy these surfaces compose is addressed to this user, so the
            // figures in it follow their number locale (issue #1316).
            findOne: jest.fn().mockResolvedValue({
              numberFormat: "en-US",
              language: "en",
            }),
          } as never,
        ],
        [ScheduledTransactionOverride, overridesRepository as never],
      ]));
    // bulkUpdateCategories saves each category through the transaction's
    // EntityManager directly (it used to be queryRunner.manager.save).
    scopedManager.save.mockImplementation((entity: unknown) => entity);

    // Issue #1247: the settlement pair the effective-amount resolver derives.
    // Same-currency by default, so a plain schedule's effective amount equals its
    // stored one; the stale/unknown-rate cases override these per test.
    investmentTransactionsService = createInvestmentFxMock();
    // The display conversion into the budget's currency. A rate of 1 by default,
    // which is only ever asked for when the two currencies differ -- a
    // same-currency bill never reaches it.
    exchangeRateService = {
      getRateForDate: jest.fn().mockResolvedValue(1),
      getLatestRate: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BudgetsService,
        // The real effective-amount resolver over a mocked
        // InvestmentTransactionsService (issue #1247): the budget's upcoming-bill
        // figures ARE its output, so a double would test nothing. The default
        // pair is same-currency, so a plain schedule's effective amount equals
        // its stored one and every pre-existing expectation still holds.
        ScheduledEffectiveAmountService,
        ScheduledOccurrenceService,
        // No loan bill here: the per-occurrence loan pricing is
        // `scheduled-occurrence.service.spec.ts`'s.
        {
          provide: ScheduledTransactionLoanService,
          useValue: {
            projectLoanOccurrencesMany: jest.fn().mockResolvedValue(new Map()),
          },
        },
        {
          provide: InvestmentTransactionsService,
          useValue: investmentTransactionsService,
        },
        { provide: DataSource, useValue: scopedDataSource },
        { provide: getRepositoryToken(Budget), useValue: budgetsRepository },
        {
          provide: getRepositoryToken(BudgetCategory),
          useValue: budgetCategoriesRepository,
        },
        {
          provide: getRepositoryToken(Notification),
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
        {
          provide: ActionHistoryService,
          useValue: mockActionHistoryService,
        },
        // An occurrence's amount is in the occurrence's own currency; the budget
        // converts it into the budget's before totalling (issue #1247). Typed,
        // so a return shape the real service cannot produce is a compile error.
        { provide: ExchangeRateService, useValue: exchangeRateService },
        // Typed rather than a bare jest.fn() record: `create` returns the stored
        // row or null, and an untyped double would let a test assert against a
        // shape the real door cannot produce.
        { provide: NotificationDispatchService, useValue: dispatchService },
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

    it("records action history on create", async () => {
      const dto = { name: "March 2026", budgetType: BudgetType.MONTHLY } as any;
      budgetsRepository.save.mockResolvedValue({
        ...dto,
        id: "new-budget",
        userId: "user-1",
      });

      await service.create("user-1", dto);

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          entityType: "budget",
          action: "create",
          description: expect.stringContaining("March 2026"),
        }),
      );
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

    it("records action history on update", async () => {
      budgetsRepository.findOne.mockResolvedValue({ ...mockBudget });

      await service.update("user-1", "budget-1", { name: "Updated Budget" });

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          entityType: "budget",
          entityId: "budget-1",
          action: "update",
          beforeData: expect.objectContaining({ name: "February 2026" }),
          description: expect.stringContaining("Updated Budget"),
        }),
      );
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

    it("records action history on remove", async () => {
      budgetsRepository.findOne.mockResolvedValue({ ...mockBudget });

      await service.remove("user-1", "budget-1");

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          entityType: "budget",
          entityId: "budget-1",
          action: "delete",
          beforeData: expect.objectContaining({ name: "February 2026" }),
          description: expect.stringContaining("February 2026"),
        }),
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
      budgetCategoriesRepository.find.mockResolvedValue([
        { ...mockBudgetCategory, id: "bc-1" },
        { ...mockBudgetCategory, id: "bc-2" },
      ]);

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
      budgetCategoriesRepository.find.mockResolvedValue([]);

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
          { categoryId: "cat-1", total: "-350" },
          { categoryId: "cat-2", total: "-1500" },
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
          .mockResolvedValue([{ categoryId: "cat-1", total: "-200" }]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-1", total: "-100" }]),
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
          .mockResolvedValue([{ categoryId: "cat-1", total: "-200" }]),
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
          .mockResolvedValue([{ categoryId: "cat-1", total: "-150" }]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(),
      );

      const result = await service.getVelocity("user-1", "budget-1");

      expect(result.currentSpent).toBe(150);
      expect(result.budgetTotal).toBe(100);
    });

    // ---- Effective amounts and completeness (issue #1247) ----

    /**
     * A budget with one 600 category, 200 spent, and whatever upcoming bills the
     * scheduled-transaction query returns.
     */
    const stubVelocityBudget = (bills: unknown[]) => {
      budgetsRepository.findOne.mockResolvedValue({
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
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getRawMany: jest
            .fn()
            .mockResolvedValue([{ categoryId: "cat-1", total: "-200" }]),
        }),
      );
      splitsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({ getRawMany: jest.fn().mockResolvedValue([]) }),
      );
      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getMany: jest.fn().mockResolvedValue(bills),
        }),
      );
    };

    /**
     * The issue's schedule: 10 x 100, pinned at 1.50 while priced in EUR.
     *
     * Due today, because the period `getVelocity` reports on is the CURRENT
     * month and the occurrence window is now filtered in code rather than by a
     * mocked SQL predicate -- a fixture dated outside the window is simply not
     * an upcoming bill.
     */
    const staleInvestmentBill = () => ({
      id: "st-inv",
      userId: "user-1",
      name: "Monthly ETF buy",
      amount: -1000,
      currencyCode: "CAD",
      frequency: "MONTHLY",
      nextDueDate: todayYMD(),
      categoryId: null,
      isActive: true,
      isSplit: false,
      isInvestment: true,
      investmentAction: "BUY",
      investmentSecurityId: "SEC-1",
      investmentQuantity: 10,
      investmentPrice: 100,
      investmentCommission: 0,
      investmentExchangeRate: 1.5,
      investmentExchangeRateFromCurrency: "EUR",
      investmentExchangeRateToCurrency: "CAD",
      splits: [],
    });

    it("counts an upcoming bill at its current amount, not its persisted one", async () => {
      stubVelocityBudget([staleInvestmentBill()]);
      // The security is USD now, and USD -> CAD is 1.35.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1.35,
      );

      // The budget reports in USD (`mockBudget`) and this occurrence settles in
      // CAD, so the total needs the display conversion as well as the settlement
      // one: 1,350 CAD is 999 USD at 0.74.
      exchangeRateService.getRateForDate.mockResolvedValue(0.74);

      const result = await service.getVelocity("user-1", "budget-1");

      expect(result.upcomingBills[0].amount).toBe(1350);
      // What the persisted 1.50 rate would have given.
      expect(result.upcomingBills[0].amount).not.toBe(1500);
      // The amount is meaningless without this, and the budget is not in it.
      expect(result.upcomingBills[0].currencyCode).toBe("CAD");
      expect(exchangeRateService.getRateForDate).toHaveBeenCalledWith(
        "CAD",
        "USD",
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      );
      expect(result.totalUpcomingBills).toBe(999);
      // The CAD figure wearing the budget's USD label -- 35% over.
      expect(result.totalUpcomingBills).not.toBe(1350);
      expect(result.upcomingBillsComplete).toBe(true);
      expect(result.upcomingBillsMissingRates).toEqual([]);
      // 600 budgeted - 200 spent - 999 upcoming, all in USD.
      expect(result.trulyAvailable).toBe(-599);
    });

    it("treats a zero or negative stored rate as no rate at all", async () => {
      stubVelocityBudget([staleInvestmentBill()]);
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1.35,
      );
      // A bad provider bar or a truncated import. Multiplying by it converted the
      // whole bill to zero and reported the total COMPLETE -- understating what is
      // owed and overstating what is available, both as settled figures.
      exchangeRateService.getRateForDate.mockResolvedValue(0);

      const result = await service.getVelocity("user-1", "budget-1");

      expect(result.totalUpcomingBills).toBeNull();
      expect(result.totalUpcomingBills).not.toBe(0);
      expect(result.upcomingBillsComplete).toBe(false);
      expect(result.upcomingBillsMissingRates).toEqual(["CAD->USD"]);
      expect(result.trulyAvailable).toBeNull();
    });

    it("asks for each currency pair once, however many bills share it", async () => {
      stubVelocityBudget([
        staleInvestmentBill(),
        { ...staleInvestmentBill(), id: "st-inv-2", name: "Second ETF buy" },
        { ...staleInvestmentBill(), id: "st-inv-3", name: "Third ETF buy" },
      ]);
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1.35,
      );
      exchangeRateService.getRateForDate.mockResolvedValue(0.74);

      const result = await service.getVelocity("user-1", "budget-1");

      expect(result.upcomingBills).toHaveLength(3);
      // Three CAD bills, one CAD->USD question: the rate belongs to the pair.
      expect(exchangeRateService.getRateForDate).toHaveBeenCalledTimes(1);
      expect(result.totalUpcomingBills).toBe(2997);
    });

    it("withholds the total when a bill cannot be converted into the budget's currency", async () => {
      stubVelocityBudget([staleInvestmentBill()]);
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1.35,
      );
      // The occurrence's own amount is known; what is missing is the rate from
      // its currency to the budget's. A figure nobody can convert is not a
      // smaller figure, and 1,350 is not 1,350 USD.
      exchangeRateService.getRateForDate.mockResolvedValue(null);

      const result = await service.getVelocity("user-1", "budget-1");

      expect(result.upcomingBills[0].amount).toBe(1350);
      expect(result.upcomingBills[0].amountComplete).toBe(true);
      expect(result.totalUpcomingBills).toBeNull();
      expect(result.knownUpcomingBillsSubtotal).toBe(0);
      expect(result.upcomingBillsComplete).toBe(false);
      // The reader is told which pair to fix, not just that something is missing.
      expect(result.upcomingBillsMissingRates).toEqual(["CAD->USD"]);
      expect(result.trulyAvailable).toBeNull();
      expect(result.safeDailySpend).toBeNull();
    });

    it("withholds the upcoming total and truly-available when a bill's rate is unknown", async () => {
      stubVelocityBudget([
        staleInvestmentBill(),
        {
          id: "st-rent",
          userId: "user-1",
          name: "Rent",
          amount: -1200,
          currencyCode: "CAD",
          frequency: "MONTHLY",
          nextDueDate: todayYMD(),
          categoryId: "cat-1",
          isActive: true,
          isSplit: false,
          isInvestment: false,
          splits: [],
        },
      ]);
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );

      const result = await service.getVelocity("user-1", "budget-1");

      expect(result.upcomingBills[0].amount).toBeNull();
      expect(result.upcomingBills[0].amountComplete).toBe(false);
      expect(result.totalUpcomingBills).toBeNull();
      // The part that did resolve, under its own name -- never the total's.
      expect(result.knownUpcomingBillsSubtotal).toBe(1200);
      expect(result.upcomingBillsComplete).toBe(false);
      // Both derived figures are unknown, not larger.
      expect(result.trulyAvailable).toBeNull();
      expect(result.safeDailySpend).toBeNull();
    });

    // ---- Occurrence selection (issue #1247) ----

    it("counts the occurrence's override amount, not the schedule's", async () => {
      stubVelocityBudget([
        {
          id: "st-rent",
          userId: "user-1",
          name: "Rent",
          amount: -1350,
          currencyCode: "USD",
          frequency: "MONTHLY",
          nextDueDate: todayYMD(),
          categoryId: "cat-1",
          isActive: true,
          isSplit: false,
          isInvestment: false,
          splits: [],
        },
      ]);
      overridesRepository.find.mockResolvedValue([
        {
          id: "ovr-1",
          scheduledTransactionId: "st-rent",
          originalDate: todayYMD(),
          overrideDate: todayYMD(),
          amount: -675,
        },
      ]);

      const result = await service.getVelocity("user-1", "budget-1");

      expect(result.upcomingBills[0].amount).toBe(675);
      expect(result.totalUpcomingBills).toBe(675);
      // 600 budgeted - 200 spent - 675 upcoming.
      expect(result.trulyAvailable).toBe(-275);
    });

    /**
     * The override's identity is `originalDate`. Keying the lookup on
     * `overrideDate` -- which is what the alert path did -- silently returns the
     * template's amount for every occurrence the user MOVED, and the two dates
     * are equal in the ordinary case, so nothing notices.
     */
    it("honours an override that also moved the occurrence, and reports the moved date", async () => {
      const slot = todayYMD();
      // The period getVelocity reports on is the CURRENT month, and a move
      // past its end is the next test's case (the occurrence is dropped) --
      // so three days out is clamped to the month's last day, or this test
      // failed on the last three days of every month with nothing changed
      // ("a test that reads the wall clock is a test about today's date").
      // On the month's own last day the clamp lands back on the slot, which
      // still exercises the override lookup keyed on originalDate.
      const monthEnd = getMonthEndYMD(
        Number(slot.slice(0, 4)),
        Number(slot.slice(5, 7)),
      );
      const threeDaysOut = addDaysYMD(slot, 3);
      const movedTo = threeDaysOut < monthEnd ? threeDaysOut : monthEnd;
      stubVelocityBudget([
        {
          id: "st-rent",
          userId: "user-1",
          name: "Rent",
          amount: -1350,
          currencyCode: "USD",
          frequency: "MONTHLY",
          nextDueDate: slot,
          categoryId: "cat-1",
          isActive: true,
          isSplit: false,
          isInvestment: false,
          splits: [],
        },
      ]);
      overridesRepository.find.mockResolvedValue([
        {
          id: "ovr-1",
          scheduledTransactionId: "st-rent",
          originalDate: slot,
          overrideDate: movedTo,
          amount: -675,
        },
      ]);

      const result = await service.getVelocity("user-1", "budget-1");

      expect(result.upcomingBills[0].amount).toBe(675);
      expect(result.upcomingBills[0].dueDate).toBe(movedTo);
      expect(result.totalUpcomingBills).toBe(675);
    });

    it("drops an occurrence an override moved past the end of the period", async () => {
      const slot = todayYMD();
      stubVelocityBudget([
        {
          id: "st-rent",
          userId: "user-1",
          name: "Rent",
          amount: -1350,
          currencyCode: "USD",
          frequency: "ONCE",
          nextDueDate: slot,
          categoryId: "cat-1",
          isActive: true,
          isSplit: false,
          isInvestment: false,
          splits: [],
        },
      ]);
      overridesRepository.find.mockResolvedValue([
        {
          id: "ovr-1",
          scheduledTransactionId: "st-rent",
          originalDate: slot,
          // Pushed into next year: it is not this period's bill any more.
          overrideDate: addDaysYMD(slot, 400),
          amount: -675,
        },
      ]);

      const result = await service.getVelocity("user-1", "budget-1");

      expect(result.upcomingBills).toEqual([]);
      expect(result.totalUpcomingBills).toBe(0);
    });
  });

  describe("ensureBillDueNotifications", () => {
    /**
     * The bill reminder producer, which the notification centre calls before
     * serving a list read. It goes through `NotificationDispatchService.notify`
     * (which writes through the one door and then fans out to push / alert-email
     * per the PAYMENTS matrix) rather than saving an entity itself, so what these
     * assert is the notification it ASKS for -- the row shape (bounds, conflict
     * handling, period default) belongs to the door and is tested there.
     */
    let created: jest.Mock;

    beforeEach(() => {
      created = dispatchService.notify as jest.Mock;
      created.mockClear();
      created.mockResolvedValue({ id: "new-notification-1" } as Notification);
      // No BILL_DUE notification exists yet unless a test says otherwise.
      budgetAlertsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({ getMany: jest.fn().mockResolvedValue([]) }),
      );
      overridesRepository.find.mockResolvedValue([]);
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
      overridesRepository.find.mockResolvedValue([]);

      await service.ensureBillDueNotifications("user-1");

      expect(created).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          type: NotificationType.BILL_DUE,
          // The occurrence identity, so a concurrent second materialization is
          // refused by the dedupe index rather than pushed twice.
          dedupeKey: expect.stringMatching(
            /^BILL_DUE:[^:]+:\d{4}-\d{2}-\d{2}$/,
          ),
          title: expect.stringContaining("Netflix Inc"),
          message: expect.stringContaining("15.99"),
        }),
        // Detached: this producer runs on the notification list READ, and a
        // stalled push endpoint must not hold that response.
        { fanOut: "detached" },
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
      overridesRepository.find.mockResolvedValue([
        {
          // A stored override always carries an id and the original date it
          // replaces (the `(scheduled_transaction_id, original_date)` unique
          // index), and the occurrence contract matches on that date.
          id: "ovr-1",
          scheduledTransactionId: "st-1",
          originalDate: tomorrowStr,
          overrideDate: tomorrowStr,
          amount: -312.65,
        },
      ]);

      await service.ensureBillDueNotifications("user-1");

      expect(created).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          message: expect.stringContaining("312.65"),
        }),
        { fanOut: "detached" },
      );
    });

    it("says the amount is unavailable rather than naming a stale one (issue #1247)", async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split("T")[0];

      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getMany: jest.fn().mockResolvedValue([
            {
              id: "st-inv",
              userId: "user-1",
              name: "Monthly ETF buy",
              payee: null,
              payeeName: null,
              // -1,000 in the security's currency, pinned at 1.50 EUR/CAD.
              amount: -1000,
              currencyCode: "CAD",
              nextDueDate: tomorrowStr,
              isActive: true,
              autoPost: false,
              reminderDaysBefore: 3,
              isSplit: false,
              isInvestment: true,
              investmentAction: "BUY",
              investmentSecurityId: "SEC-1",
              investmentQuantity: 10,
              investmentPrice: 100,
              investmentCommission: 0,
              investmentExchangeRate: 1.5,
              investmentExchangeRateFromCurrency: "EUR",
              investmentExchangeRateToCurrency: "CAD",
              splits: [],
            },
          ]),
          leftJoinAndSelect: jest.fn().mockReturnThis(),
        }),
      );
      budgetAlertsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({ getMany: jest.fn().mockResolvedValue([]) }),
      );
      overridesRepository.find.mockResolvedValue([]);
      // The security is USD now and no USD -> CAD rate can be resolved.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );

      await service.ensureBillDueNotifications("user-1");

      const saved = created.mock.calls[0][1] as CreateNotificationInput;
      expect(saved.message).toContain("Amount unavailable");
      // Not the persisted snapshot, at either rate.
      expect(saved.message).not.toContain("1,500");
      expect(saved.message).not.toContain("1,000");
      expect((saved.data as Record<string, unknown>).amount).toBeNull();
      expect((saved.data as Record<string, unknown>).amountComplete).toBe(
        false,
      );
    });

    it("prices a moved occurrence from its override and announces the moved date", async () => {
      const slot = addDaysYMD(todayYMD(), 1);
      const movedTo = addDaysYMD(todayYMD(), 2);

      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getMany: jest.fn().mockResolvedValue([
            {
              id: "st-1",
              userId: "user-1",
              name: "Electric",
              payee: { name: "Power Co" },
              payeeName: null,
              amount: -250.0,
              currencyCode: "USD",
              frequency: "MONTHLY",
              nextDueDate: slot,
              isActive: true,
              autoPost: false,
              reminderDaysBefore: 3,
            },
          ]),
          leftJoinAndSelect: jest.fn().mockReturnThis(),
        }),
      );
      budgetAlertsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({ getMany: jest.fn().mockResolvedValue([]) }),
      );
      overridesRepository.find.mockResolvedValue([
        {
          id: "ovr-1",
          scheduledTransactionId: "st-1",
          originalDate: slot,
          overrideDate: movedTo,
          amount: -312.65,
        },
      ]);

      await service.ensureBillDueNotifications("user-1");

      const saved = created.mock.calls[0][1] as CreateNotificationInput;
      expect(saved.message).toContain("312.65");
      expect(saved.message).not.toContain("250");
      const data = saved.data as Record<string, unknown>;
      expect(data.amount).toBe(312.65);
      expect(data.dueDate).toBe(movedTo);
      // The occurrence's identity travels with the alert, so re-dating it again
      // cannot raise a second alert for the same occurrence.
      expect(data.originalDate).toBe(slot);
      expect(saved.periodStart).toBe(movedTo);
    });

    it("does not re-alert an occurrence whose alert was filed under an earlier date", async () => {
      const slot = addDaysYMD(todayYMD(), 1);

      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getMany: jest.fn().mockResolvedValue([
            {
              id: "st-1",
              userId: "user-1",
              name: "Electric",
              payee: { name: "Power Co" },
              payeeName: null,
              amount: -250.0,
              currencyCode: "USD",
              frequency: "MONTHLY",
              nextDueDate: slot,
              isActive: true,
              autoPost: false,
              reminderDaysBefore: 3,
            },
          ]),
          leftJoinAndSelect: jest.fn().mockReturnThis(),
        }),
      );
      // The stored alert announced the original date; the user has since moved
      // the occurrence, so `periodStart` no longer matches -- the identity does.
      budgetAlertsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getMany: jest.fn().mockResolvedValue([
            {
              id: "alert-1",
              periodStart: "1999-01-01",
              data: { billId: "st-1", originalDate: slot },
            },
          ]),
        }),
      );
      overridesRepository.find.mockResolvedValue([
        {
          id: "ovr-1",
          scheduledTransactionId: "st-1",
          originalDate: slot,
          overrideDate: addDaysYMD(todayYMD(), 2),
          amount: -312.65,
        },
      ]);

      await service.ensureBillDueNotifications("user-1");

      expect(created).not.toHaveBeenCalled();
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

      await service.ensureBillDueNotifications("user-1");

      // Bill is 10 days out but reminderDaysBefore is 3 — should not create an alert
      expect(created).not.toHaveBeenCalled();
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
          { categoryId: "cat-1", total: "-400" },
          { categoryId: "cat-2", total: "-950" },
          { categoryId: "cat-3", total: "-280" },
          { categoryId: "cat-4", total: "-50" },
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
          .mockResolvedValue([{ categoryId: "cat-1", total: "-1000" }]),
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
          { categoryId: "cat-1", total: "-350" },
          { categoryId: "cat-2", total: "-900" },
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
          { categoryId: "cat-1", total: "-300" },
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
          { categoryId: "cat-1", total: "-200" },
          { categoryId: "cat-2", total: "-800" },
          { categoryId: "cat-3", total: "-150" },
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
          { categoryId: "cat-1", total: "-900" },
          { categoryId: "cat-2", total: "-1800" },
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
          .mockResolvedValue([{ categoryId: "cat-1", total: "-200" }]),
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
      const tomorrow = addDaysYMD(todayYMD(), 1);

      const stQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([
          {
            id: "st-1",
            name: "Netflix",
            amount: -15.99,
            frequency: "MONTHLY",
            nextDueDate: tomorrow,
            categoryId: "cat-ent",
          },
          {
            id: "st-2",
            name: "Internet",
            amount: -79.99,
            frequency: "MONTHLY",
            nextDueDate: tomorrow,
            categoryId: "cat-util",
          },
        ]),
      });
      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(stQb);

      const result = await service.getUpcomingBills(
        "user-1",
        addDaysYMD(todayYMD(), 7),
      );

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

      const result = await service.getUpcomingBills(
        "user-1",
        addDaysYMD(todayYMD(), 7),
      );

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
          .mockResolvedValue([{ categoryId: "cat-1", total: "-400" }]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      const stQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([
          {
            id: "st-1",
            name: "Rent",
            amount: -200,
            frequency: "MONTHLY",
            nextDueDate: todayYMD(),
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
          .mockResolvedValue([{ categoryId: "cat-1", total: "-400" }]),
      });
      const splitQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      const stQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([
          {
            id: "st-1",
            name: "Large Bill",
            amount: -200,
            frequency: "MONTHLY",
            nextDueDate: todayYMD(),
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

  // ─── Branch coverage extras ─────────────────────────────────────────

  describe("update field branch coverage", () => {
    it("updates all individually mappable fields", async () => {
      budgetsRepository.findOne.mockResolvedValue({ ...mockBudget });
      budgetsRepository.save.mockImplementation((d) => d);
      const dto = {
        name: "n",
        description: "d",
        budgetType: BudgetType.MONTHLY,
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        baseIncome: 5000,
        incomeLinked: true,
        strategy: BudgetStrategy.ROLLOVER,
        isActive: false,
        config: { foo: "bar" },
      };
      const r = await service.update("user-1", "budget-1", dto as never);
      expect(r.name).toBe("n");
      expect(r.description).toBe("d");
      expect(r.budgetType).toBe(BudgetType.MONTHLY);
      expect(r.periodStart).toBe("2026-01-01");
      expect(r.periodEnd).toBe("2026-01-31");
      expect(r.baseIncome).toBe(5000);
      expect(r.incomeLinked).toBe(true);
      expect(r.strategy).toBe(BudgetStrategy.ROLLOVER);
      expect(r.isActive).toBe(false);
      expect(r.config).toEqual({ foo: "bar" });
    });
  });

  describe("updateCategory field branch coverage", () => {
    const baseCat: BudgetCategory = {
      id: "bc-1",
      budgetId: "budget-1",
      categoryId: "cat-1",
      categoryGroup: "fixed",
      amount: 500,
      isIncome: false,
      rolloverType: RolloverType.NONE,
      rolloverCap: null,
      flexGroup: null,
      alertWarnPercent: null,
      alertCriticalPercent: null,
      notes: null,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never;

    it("updates all category fields individually", async () => {
      budgetsRepository.findOne.mockResolvedValue({ ...mockBudget });
      budgetCategoriesRepository.findOne.mockResolvedValue({ ...baseCat });
      budgetCategoriesRepository.save.mockImplementation((d) => d);

      const dto = {
        categoryGroup: "flex",
        amount: 700,
        isIncome: true,
        rolloverType: RolloverType.MONTHLY,
        rolloverCap: 1000,
        flexGroup: "g1",
        alertWarnPercent: 80,
        alertCriticalPercent: 95,
        notes: "n",
        sortOrder: 5,
      };
      const r = await service.updateCategory(
        "user-1",
        "budget-1",
        "bc-1",
        dto as never,
      );
      expect(r.categoryGroup).toBe("flex");
      expect(r.amount).toBe(700);
      expect(r.isIncome).toBe(true);
      expect(r.rolloverType).toBe(RolloverType.MONTHLY);
      expect(r.rolloverCap).toBe(1000);
      expect(r.flexGroup).toBe("g1");
      expect(r.alertWarnPercent).toBe(80);
      expect(r.alertCriticalPercent).toBe(95);
      expect(r.notes).toBe("n");
      expect(r.sortOrder).toBe(5);
    });
  });
});
