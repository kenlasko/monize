import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
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
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("BudgetPeriodService", () => {
  let scopedManager: ManagerMock;
  let scopedDataSource: DataSourceMock;
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
      findOneOrFail: jest.fn(),
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

    ({ manager: scopedManager, dataSource: scopedDataSource } =
      createScopedDbMocks([
        [BudgetPeriod, periodsRepository as never],
        [BudgetPeriodCategory, periodCategoriesRepository as never],
        [Transaction, transactionsRepository as never],
        [TransactionSplit, splitsRepository as never],
      ]));
    // closePeriod saves the period and its categories through the transaction's
    // EntityManager directly (it used to be queryRunner.manager.save).
    scopedManager.save.mockImplementation(
      (entity: unknown, data: unknown) => data ?? entity,
    );
    // The period insert is now `INSERT ... ON CONFLICT DO NOTHING RETURNING id`
    // so a lost race is a no-op instead of a transaction-aborting 23505. Default
    // to winning; the loser path is asserted explicitly.
    scopedManager.query.mockImplementation(async (sql: string) =>
      typeof sql === "string" && sql.includes("INSERT INTO budget_periods")
        ? [{ id: "new-period" }]
        : [],
    );
    periodsRepository.findOneOrFail.mockImplementation(async () => ({
      id: "new-period",
    }));

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
        { provide: DataSource, useValue: scopedDataSource },
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

  describe("closePeriod -- serialization", () => {
    it("locks the period and reads the actuals inside the same transaction", async () => {
      // The regression: the open period, the ledger the actuals come from, and
      // the write that freezes them were three separate transactions. A
      // transaction committing into the period's date range between the second
      // and the third was left out of the closing figures for good -- a closed
      // period is never recomputed. And the monthly cron fires on every replica,
      // so two of them found the same OPEN period.
      const budgetWithCategories = {
        ...mockBudget,
        categories: [{ ...mockBudgetCategory }],
      };
      budgetsService.findOne.mockResolvedValue(budgetWithCategories);
      periodsRepository.findOne.mockResolvedValue({
        ...mockPeriod,
        status: PeriodStatus.OPEN,
        periodCategories: [],
      });

      await service.closePeriod("user-1", "budget-1");

      // The period row is taken with a write lock, and taken *before* the ledger
      // the actuals are computed from is read -- that ordering is what makes
      // "these figures were computed from rows a concurrent close cannot have
      // moved" true rather than intended.
      expect(
        periodsRepository.findOne.mock.invocationCallOrder[0],
      ).toBeLessThan(
        transactionsRepository.createQueryBuilder.mock.invocationCallOrder[0],
      );
      expect(periodsRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { budgetId: "budget-1", status: PeriodStatus.OPEN },
          lock: { mode: "pessimistic_write" },
        }),
      );
    });

    it("refuses when another close already took the period", async () => {
      // The loser of the lock finds no OPEN period and must not write anything;
      // the cron reports it as a skip.
      budgetsService.findOne.mockResolvedValue(mockBudget);
      periodsRepository.findOne.mockResolvedValue(null);

      await expect(service.closePeriod("user-1", "budget-1")).rejects.toThrow(
        /No open period/,
      );
      expect(scopedManager.save).not.toHaveBeenCalled();
      expect(
        scopedManager.query.mock.calls.some((call: unknown[]) =>
          String(call[0]).includes("INSERT INTO budget_periods"),
        ),
      ).toBe(false);
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
      // closePeriod writes through the scoped transaction's EntityManager.
      expect(scopedDataSource.transaction).toHaveBeenCalled();
      expect(scopedManager.save).toHaveBeenCalled();
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

      const result = await service.getOrCreateCurrentPeriod(
        "user-1",
        "budget-1",
      );

      expect(result.id).toBe("new-period");
      expect(
        scopedManager.query.mock.calls.some((call: unknown[]) =>
          String(call[0]).includes("INSERT INTO budget_periods"),
        ),
      ).toBe(true);
      expect(periodCategoriesRepository.create).toHaveBeenCalled();
    });

    it("adopts the period another request created rather than failing", async () => {
      // Opening the Budgets screen for the first time this month fires several
      // requests; they all find no open period and they all try to insert.
      // `UNIQUE(budget_id, period_start)` stops the duplicate row, and inside a
      // transaction a unique violation aborts everything -- so the loser has to
      // find out by getting no row back, not by throwing.
      const budgetWithCategories = {
        ...mockBudget,
        categories: [{ ...mockBudgetCategory }],
      };
      budgetsService.findOne.mockResolvedValue(budgetWithCategories);
      const winner = { id: "their-period", periodCategories: [] };
      periodsRepository.findOne
        .mockResolvedValueOnce(null) // no open period when we looked
        .mockResolvedValue(winner); // ...but one exists by the time we insert
      scopedManager.query.mockImplementation(async () => []); // conflict: no row

      const result = await service.getOrCreateCurrentPeriod(
        "user-1",
        "budget-1",
      );

      expect(result).toBe(winner);
      // And it must not write category rows on top of the winner's.
      expect(periodCategoriesRepository.save).not.toHaveBeenCalled();
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
      await service.createPeriodForBudget(budgetWithCategories);

      // The period row is inserted with one guarded statement, so the totals are
      // checked on its parameters rather than on a `create()` call.
      const insert = scopedManager.query.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes("INSERT INTO budget_periods"),
      )!;
      expect(String(insert[0])).toContain(
        "ON CONFLICT (budget_id, period_start) DO NOTHING",
      );
      // budget_id, period_start, period_end, total_budgeted, status
      expect((insert[1] as unknown[])[3]).toBe(800);
      expect((insert[1] as unknown[])[4]).toBe(PeriodStatus.OPEN);
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
