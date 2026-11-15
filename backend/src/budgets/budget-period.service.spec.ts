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
import { BudgetPeriodBucket } from "./entities/budget-period-bucket.entity";
import {
  BudgetBucket,
  BudgetBucketTargetType,
} from "./entities/budget-bucket.entity";
import { Currency } from "../currencies/entities/currency.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import * as spendingUtil from "./budget-spending.util";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

/**
 * `queryCategorySpending` reads raw rows that carry a currency and a date. Every
 * row here is in the budget's currency, which needs no rate, so each number is
 * the one the unconverted query returned.
 */
const spendingRow = (key: string, total: string) => ({
  key,
  currencyCode: "USD",
  txDate: "2026-02-10",
  total,
});

describe("BudgetPeriodService", () => {
  let scopedManager: ManagerMock;
  let scopedDataSource: DataSourceMock;
  let service: BudgetPeriodService;
  let periodsRepository: Record<string, jest.Mock>;
  let periodCategoriesRepository: Record<string, jest.Mock>;
  let periodBucketsRepository: Record<string, jest.Mock>;
  let bucketsRepository: Record<string, jest.Mock>;
  let currenciesRepository: Record<string, jest.Mock>;
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
    bucketId: null,
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
    addGroupBy: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
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

    bucketsRepository = { find: jest.fn().mockResolvedValue([]) };

    periodBucketsRepository = {
      find: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockResolvedValue({ identifiers: [] }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    // `loadCurrencyPlaces` reads the budget currency's places FOR KEY SHARE
    // through the Currency repository's `query`.
    currenciesRepository = {
      query: jest.fn().mockResolvedValue([{ code: "USD", decimal_places: 2 }]),
    };

    // `queryCategorySpending` reads the budget's currency and config, and the
    // rate index, through the repository's own manager: the close transaction's.
    transactionsRepository = {
      manager: undefined,
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    } as unknown as Record<string, jest.Mock>;

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
        [BudgetPeriodBucket, periodBucketsRepository as never],
        [BudgetBucket, bucketsRepository as never],
        [Currency, currenciesRepository as never],
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
    scopedManager.query.mockImplementation(async (sql: string) => {
      if (typeof sql !== "string") return [];
      if (sql.includes("INSERT INTO budget_periods")) {
        return [{ id: "new-period" }];
      }
      // The actuals query names the budget's currency; every row below is in it.
      if (sql.includes("FROM budgets")) {
        return [{ currency_code: "USD", config: {} }];
      }
      return [];
    });
    (transactionsRepository as { manager?: unknown }).manager = scopedManager;
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
          "periodCategories.budgetCategory.transferAccount",
          "periodCategories.category",
          "periodBuckets",
        ],
        order: { periodBuckets: { bucketName: "ASC" } },
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
        getRawMany: jest.fn().mockResolvedValue([spendingRow("cat-1", "350")]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directQb);
      splitsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(),
      );

      const result = await service.closePeriod("user-1", "budget-1");

      expect(result.status).toBe(PeriodStatus.CLOSED);
      // The period categories are loaded with their budget line, which carries
      // the rollover type `computeRollover` reads.
      expect(periodsRepository.findOne.mock.calls[1][0].relations).toContain(
        "periodCategories.budgetCategory",
      );
      // The next period is the month after the closed one (mockPeriod ends on
      // 2026-02-28), not the current calendar month.
      const nextInsert = scopedManager.query.mock.calls.find(
        (call: unknown[]) =>
          String(call[0]).includes("INSERT INTO budget_periods"),
      )!;
      expect((nextInsert[1] as unknown[]).slice(1, 3)).toEqual([
        "2026-03-01",
        "2026-03-31",
      ]);
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

    it("freezes transfer actuals from whole-row transfers AND split-line transfers", async () => {
      // A transfer can arrive as one line of a split parent (audit P5-007). A
      // closed period is never recomputed, so leaving that shape out here made
      // the materialized month disagree with the live budget page for the same
      // dates (review #1131).
      const transferCategory: BudgetCategory = {
        ...mockBudgetCategory,
        id: "bc-transfer",
        categoryId: null,
        isTransfer: true,
        transferAccountId: "acct-savings",
      };
      budgetsService.findOne.mockResolvedValue({
        ...mockBudget,
        categories: [transferCategory],
      });

      const openPeriod = {
        ...mockPeriod,
        status: PeriodStatus.OPEN,
        periodCategories: [
          {
            ...mockPeriodCategory,
            budgetCategoryId: "bc-transfer",
            budgetCategory: transferCategory,
          },
        ],
      };
      periodsRepository.findOne.mockResolvedValue(openPeriod);
      periodsRepository.save.mockImplementation((data) => data);

      transactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getRawMany: jest
            .fn()
            .mockResolvedValue([spendingRow("acct-savings", "100")]),
        }),
      );
      splitsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getRawMany: jest
            .fn()
            .mockResolvedValue([spendingRow("acct-savings", "50")]),
        }),
      );

      await service.closePeriod("user-1", "budget-1");

      expect(periodsRepository.findOne.mock.calls[1][0].relations).toContain(
        "periodCategories.budgetCategory",
      );
      expect(scopedManager.save).toHaveBeenCalledWith(
        BudgetPeriodCategory,
        expect.objectContaining({
          budgetCategoryId: "bc-transfer",
          actualAmount: 150,
        }),
      );
    });

    it("freezes transfers in as the period's income (issue #2141)", async () => {
      const incomeLine = {
        ...mockBudgetCategory,
        id: "bc-hisa",
        categoryId: null,
        isTransfer: true,
        isIncome: true,
        transferAccountId: "hisa",
      };
      budgetsService.findOne.mockResolvedValue({
        ...mockBudget,
        categories: [incomeLine],
      });
      periodsRepository.findOne.mockResolvedValue({
        ...mockPeriod,
        status: PeriodStatus.OPEN,
        periodCategories: [
          {
            ...mockPeriodCategory,
            budgetCategoryId: "bc-hisa",
            budgetCategory: incomeLine,
          },
        ],
      });
      periodsRepository.save.mockImplementation((data) => data);
      const baseQuery = scopedManager.query.getMockImplementation()!;
      scopedManager.query.mockImplementation(async (sql: string, p: unknown) =>
        typeof sql === "string" && sql.includes("FROM budgets")
          ? [
              {
                currency_code: "USD",
                config: {
                  excludedAccountIds: ["hisa", "rrsp"],
                  transfersInAsIncome: true,
                },
              },
            ]
          : baseQuery(sql, p),
      );
      transactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getRawMany: jest
            .fn()
            .mockResolvedValue([
              spendingRow("hisa", "2000"),
              spendingRow("rrsp", "300"),
            ]),
        }),
      );
      splitsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(),
      );

      await service.closePeriod("user-1", "budget-1");

      expect(scopedManager.save).toHaveBeenCalledWith(
        BudgetPeriodCategory,
        expect.objectContaining({
          budgetCategoryId: "bc-hisa",
          actualAmount: 2000,
        }),
      );
      expect(scopedManager.save).toHaveBeenCalledWith(
        BudgetPeriod,
        expect.objectContaining({ actualIncome: 2300, actualExpenses: 0 }),
      );
    });

    it("freezes the toggle's income on a budget with no line (issue #2141)", async () => {
      budgetsService.findOne.mockResolvedValue({
        ...mockBudget,
        categories: [],
      });
      periodsRepository.findOne.mockResolvedValue({
        ...mockPeriod,
        status: PeriodStatus.OPEN,
        periodCategories: [],
      });
      periodsRepository.save.mockImplementation((data) => data);
      const baseQuery = scopedManager.query.getMockImplementation()!;
      scopedManager.query.mockImplementation(async (sql: string, p: unknown) =>
        typeof sql === "string" && sql.includes("FROM budgets")
          ? [
              {
                currency_code: "USD",
                config: {
                  excludedAccountIds: ["hisa"],
                  transfersInAsIncome: true,
                },
              },
            ]
          : baseQuery(sql, p),
      );
      transactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getRawMany: jest.fn().mockResolvedValue([spendingRow("hisa", "400")]),
        }),
      );
      splitsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(),
      );

      await service.closePeriod("user-1", "budget-1");

      expect(scopedManager.save).toHaveBeenCalledWith(
        BudgetPeriod,
        expect.objectContaining({ actualIncome: 400, actualExpenses: 0 }),
      );
    });
  });

  describe("closePeriod -- bucket snapshot and carry (INV-BUDGET-003)", () => {
    // Design section 8: CAD in the design, USD here (the fixture currency),
    // not income-linked, base income 5000.
    const bucket = (over: Partial<BudgetBucket> & { id: string }) => {
      const b: BudgetBucket = {
        budgetId: "budget-1",
        name: over.id,
        targetType: BudgetBucketTargetType.PERCENT,
        targetValue: 10,
        carryOver: false,
        carryCap: null,
        sortOrder: 0,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
        ...over,
      };
      return b;
    };
    const fixed = bucket({
      id: "b-fixed",
      name: "Fixed costs",
      targetValue: 50,
    });
    const everyday = bucket({
      id: "b-every",
      name: "Everyday",
      targetType: BudgetBucketTargetType.AMOUNT,
      targetValue: 1200,
    });
    const savings = bucket({
      id: "b-save",
      name: "Savings",
      targetValue: 20,
      carryOver: true,
    });

    const line = (
      id: string,
      bucketId: string | null,
      over: Partial<BudgetCategory> = {},
    ): BudgetCategory => ({
      ...mockBudgetCategory,
      id,
      categoryId: `cat-${id}`,
      bucketId,
      amount: 0,
      ...over,
    });

    /** Arrange one close: the budget, its lines' spending, existing rows. */
    const arrangeClose = (opts: {
      buckets: BudgetBucket[];
      /** Expense spent per bucket id (one line each), positive. */
      spent: Record<string, number>;
      budget?: Partial<Budget>;
      incomeLines?: Array<{ id: string; amount: number; received: number }>;
      existing?: Array<Partial<BudgetPeriodBucket>>;
      /** The buckets as the close's own transaction reads them. */
      currentBuckets?: BudgetBucket[];
    }) => {
      const expenseLines = Object.keys(opts.spent).map((bucketId) =>
        line(`l-${bucketId}`, bucketId),
      );
      const incomeLines = (opts.incomeLines ?? []).map((i) =>
        line(i.id, null, { isIncome: true, amount: i.amount }),
      );
      const categories = [...expenseLines, ...incomeLines];
      budgetsService.findOne.mockResolvedValue({
        ...mockBudget,
        categories,
        buckets: opts.buckets,
        ...opts.budget,
      });
      periodsRepository.findOne.mockResolvedValue({
        ...mockPeriod,
        status: PeriodStatus.OPEN,
        periodCategories: categories.map((bc) => ({
          ...mockPeriodCategory,
          id: `bpc-${bc.id}`,
          budgetCategoryId: bc.id,
          categoryId: bc.categoryId,
          budgetCategory: bc,
        })),
      });
      periodBucketsRepository.find.mockResolvedValue(opts.existing ?? []);
      bucketsRepository.find.mockResolvedValue(
        opts.currentBuckets ?? opts.buckets,
      );
      const rows = [
        ...Object.entries(opts.spent).map(([bucketId, amount]) =>
          spendingRow(`cat-l-${bucketId}`, String(-amount)),
        ),
        ...(opts.incomeLines ?? []).map((i) =>
          spendingRow(`cat-${i.id}`, String(i.received)),
        ),
      ];
      transactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getRawMany: jest.fn().mockResolvedValue(rows),
        }),
      );
    };

    /** The frozen row the close wrote for a bucket, update or insert. */
    const written = (bucketId: string): Record<string, unknown> => {
      const update = periodBucketsRepository.update.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as { bucketId?: string }).bucketId === bucketId,
      );
      if (update) {
        return {
          via: "update",
          ...(update[0] as object),
          ...(update[1] as object),
        };
      }
      const insert = periodBucketsRepository.insert.mock.calls.find(
        (call: unknown[]) =>
          !Array.isArray(call[0]) &&
          (call[0] as { bucketId?: string }).bucketId === bucketId,
      );
      if (!insert) throw new Error(`no row written for ${bucketId}`);
      return { via: "insert", ...(insert[0] as object) };
    };

    /** The rows the next period's creation inserted (one array insert). */
    const createdRows = (): Array<Record<string, unknown>> =>
      periodBucketsRepository.insert.mock.calls
        .filter((call: unknown[]) => Array.isArray(call[0]))
        .flatMap(
          (call: unknown[]) => call[0] as Array<Record<string, unknown>>,
        );

    const savingsRow = {
      id: "bpb-save",
      budgetPeriodId: "period-1",
      bucketId: "b-save",
      carryIn: 250,
    };

    it("freezes the section 8 figures and carries Savings' 850 into the next period", async () => {
      arrangeClose({
        buckets: [fixed, everyday, savings],
        spent: { "b-fixed": 2400, "b-every": 1350, "b-save": 400 },
        existing: [savingsRow],
      });

      await service.closePeriod("user-1", "budget-1");

      // Truth table C row 1: carry off, whatever is left (100 here).
      expect(written("b-fixed")).toEqual({
        via: "insert",
        budgetPeriodId: "period-1",
        bucketId: "b-fixed",
        carryIn: 0,
        bucketName: "Fixed costs",
        targetType: "PERCENT",
        targetValue: 50,
        incomeBasis: 5000,
        allocatedAmount: 2500,
        actualAmount: 2400,
        carryOut: 0,
      });
      // Carry off and overspent (available -150).
      expect(written("b-every")).toMatchObject({
        via: "insert",
        allocatedAmount: 1200,
        actualAmount: 1350,
        carryOut: 0,
      });
      // Row C3: carry on, no cap, available 1000 + 250 - 400 = 850. The row
      // written at creation is updated by id; its carry_in is not rewritten.
      const save = written("b-save");
      expect(save).toEqual({
        via: "update",
        id: "bpb-save",
        bucketId: "b-save",
        bucketName: "Savings",
        targetType: "PERCENT",
        targetValue: 20,
        incomeBasis: 5000,
        allocatedAmount: 1000,
        actualAmount: 400,
        carryOut: 850,
      });
      expect(save).not.toHaveProperty("carryIn");

      // INV-BUDGET-003: the next period's carry_in is the closed carry_out,
      // and only the bucket with a positive carry gets a row at creation.
      expect(createdRows()).toEqual([
        {
          budgetPeriodId: "new-period",
          bucketId: "b-save",
          bucketName: "Savings",
          targetType: "PERCENT",
          targetValue: 20,
          carryIn: 850,
        },
      ]);
      // Read and written inside the close's one transaction.
      expect(scopedDataSource.transaction).toHaveBeenCalledTimes(1);
      expect(periodBucketsRepository.find).toHaveBeenCalledWith({
        where: { budgetPeriodId: "period-1" },
      });
    });

    it("hands the positive carries to the next period's creation", async () => {
      arrangeClose({
        buckets: [fixed, everyday, savings],
        spent: { "b-fixed": 2400, "b-every": 1350, "b-save": 400 },
        existing: [savingsRow],
      });
      const create = jest.spyOn(service, "createPeriodForBudget");

      await service.closePeriod("user-1", "budget-1");

      expect(create).toHaveBeenCalledTimes(1);
      const carry = create.mock.calls[0][4];
      expect(carry && [...carry]).toEqual([["b-save", 850]]);
      expect(create.mock.calls[0][3]).toEqual({
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
      });
    });

    it("caps the carry at carry_cap (row C4: 850 capped at 500)", async () => {
      arrangeClose({
        buckets: [{ ...savings, carryCap: 500 }],
        spent: { "b-save": 400 },
        existing: [savingsRow],
      });

      await service.closePeriod("user-1", "budget-1");

      expect(written("b-save")).toMatchObject({
        allocatedAmount: 1000,
        actualAmount: 400,
        carryOut: 500,
      });
      expect(createdRows()).toEqual([
        expect.objectContaining({ bucketId: "b-save", carryIn: 500 }),
      ]);
    });

    it("carries nothing from an overspent carry-over bucket (row C5)", async () => {
      // Everyday with carry on: 1200 + 0 - 1350 = -150.
      arrangeClose({
        buckets: [{ ...everyday, carryOver: true }],
        spent: { "b-every": 1350 },
      });

      await service.closePeriod("user-1", "budget-1");

      expect(written("b-every")).toMatchObject({
        allocatedAmount: 1200,
        actualAmount: 1350,
        carryOut: 0,
      });
      expect(createdRows()).toEqual([]);
    });

    it("carries nothing when exactly nothing is left (row C6)", async () => {
      arrangeClose({
        buckets: [savings],
        spent: { "b-save": 1250 },
        existing: [savingsRow],
      });

      await service.closePeriod("user-1", "budget-1");

      expect(written("b-save")).toMatchObject({
        allocatedAmount: 1000,
        actualAmount: 1250,
        carryOut: 0,
      });
      expect(createdRows()).toEqual([]);
    });

    it("freezes an unknown allocation as null and carries 0 (row C2, design section 9)", async () => {
      arrangeClose({
        buckets: [fixed, everyday, savings],
        spent: { "b-fixed": 2400, "b-every": 1350, "b-save": 400 },
        budget: { baseIncome: null },
        existing: [savingsRow],
      });

      await service.closePeriod("user-1", "budget-1");

      expect(written("b-save")).toMatchObject({
        incomeBasis: null,
        allocatedAmount: null,
        actualAmount: 400,
        carryOut: 0,
      });
      expect(written("b-fixed")).toMatchObject({
        incomeBasis: null,
        allocatedAmount: null,
        carryOut: 0,
      });
      // An amount target needs no income, but the basis is still unknown.
      expect(written("b-every")).toMatchObject({
        incomeBasis: null,
        allocatedAmount: 1200,
      });
      expect(createdRows()).toEqual([]);
    });

    it("allocates against the period's actual income for an income-linked budget", async () => {
      // The summary's actual income is the income lines' received amounts;
      // base income is ignored (truth table A row 1).
      arrangeClose({
        buckets: [savings],
        spent: { "b-save": 100 },
        budget: { incomeLinked: true, baseIncome: 9999 },
        incomeLines: [{ id: "pay", amount: 4000, received: 4200 }],
      });

      await service.closePeriod("user-1", "budget-1");

      expect(written("b-save")).toMatchObject({
        via: "insert",
        incomeBasis: 4200,
        allocatedAmount: 840,
        actualAmount: 100,
        carryOut: 740,
      });
    });

    it("counts the transfers-in-as-income figure in an income-linked budget's bucket income", async () => {
      // The live summary's income includes what `config.transfersInAsIncome`
      // adds (issue #2141); the close's bucket income must too, or the frozen
      // allocation differs from the one the card showed.
      const outside = jest
        .spyOn(spendingUtil, "resolveOutsideTransferIncome")
        .mockReturnValue(300);
      arrangeClose({
        buckets: [savings],
        spent: { "b-save": 100 },
        budget: { incomeLinked: true, baseIncome: 9999 },
        incomeLines: [{ id: "pay", amount: 4000, received: 4200 }],
      });

      try {
        await service.closePeriod("user-1", "budget-1");
      } finally {
        outside.mockRestore();
      }

      expect(written("b-save")).toMatchObject({
        incomeBasis: 4500,
        allocatedAmount: 900,
        actualAmount: 100,
        carryOut: 800,
      });
    });

    it("inserts a row with carry_in 0 for a bucket created mid-period", async () => {
      // Savings got its row when the period was created; Fixed did not exist
      // then and has no row.
      arrangeClose({
        buckets: [fixed, savings],
        spent: { "b-fixed": 2400, "b-save": 400 },
        existing: [savingsRow],
      });

      await service.closePeriod("user-1", "budget-1");

      expect(written("b-fixed")).toMatchObject({
        via: "insert",
        budgetPeriodId: "period-1",
        carryIn: 0,
      });
      expect(written("b-save")).toMatchObject({ via: "update" });
      expect(periodBucketsRepository.update).toHaveBeenCalledTimes(1);
    });

    it("leaves a deleted bucket's row (bucket_id NULL) untouched", async () => {
      arrangeClose({
        buckets: [savings],
        spent: { "b-save": 400 },
        existing: [
          savingsRow,
          {
            id: "bpb-gone",
            budgetPeriodId: "period-1",
            bucketId: null,
            carryIn: 99,
          },
        ],
      });

      await service.closePeriod("user-1", "budget-1");

      const touched = periodBucketsRepository.update.mock.calls.map(
        (call: unknown[]) => (call[0] as { id: string }).id,
      );
      expect(touched).toEqual(["bpb-save"]);
      // Only Savings' own carry, never the deleted bucket's 99.
      expect(written("b-save")).toMatchObject({ carryOut: 850 });
      expect(
        periodBucketsRepository.insert.mock.calls.filter(
          (call: unknown[]) => !Array.isArray(call[0]),
        ),
      ).toEqual([]);
    });

    it("reads the buckets inside the close, so one deleted since the budget was read is not frozen", async () => {
      arrangeClose({
        buckets: [fixed, savings],
        currentBuckets: [fixed],
        spent: { "b-fixed": 100, "b-save": 50 },
      });

      await service.closePeriod("user-1", "budget-1");

      expect(bucketsRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          lock: { mode: "pessimistic_read" },
        }),
      );
      expect(() => written("b-save")).toThrow("no row written");
      expect(written("b-fixed")).toMatchObject({ bucketName: "Fixed costs" });
    });

    it("reads and writes no bucket rows for a budget without buckets", async () => {
      arrangeClose({ buckets: [], spent: { "b-none": 300 } });

      const result = await service.closePeriod("user-1", "budget-1");

      expect(result.status).toBe(PeriodStatus.CLOSED);
      const asked = scopedManager.getRepository.mock.calls.map(
        (call: unknown[]) => call[0],
      );
      expect(asked).not.toContain(BudgetPeriodBucket);
      expect(asked).not.toContain(Currency);
      expect(periodBucketsRepository.find).not.toHaveBeenCalled();
      expect(periodBucketsRepository.insert).not.toHaveBeenCalled();
      expect(periodBucketsRepository.update).not.toHaveBeenCalled();
    });
  });

  describe("createPeriodForBudget -- bucket carry", () => {
    const savings: BudgetBucket = {
      id: "b-save",
      budgetId: "budget-1",
      name: "Savings",
      targetType: BudgetBucketTargetType.PERCENT,
      targetValue: 20,
      carryOver: true,
      carryCap: null,
      sortOrder: 0,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    };
    const fixed: BudgetBucket = {
      ...savings,
      id: "b-fixed",
      name: "Fixed costs",
      targetValue: 50,
      carryOver: false,
    };
    const budgetWithBuckets = {
      ...mockBudget,
      categories: [{ ...mockBudgetCategory }],
      buckets: [fixed, savings],
    };

    it("inserts a carry_in row only for a bucket with a positive carry", async () => {
      await service.createPeriodForBudget(
        budgetWithBuckets,
        undefined,
        undefined,
        { periodStart: "2026-03-01", periodEnd: "2026-03-31" },
        new Map([
          ["b-save", 850],
          ["b-fixed", 0],
        ]),
      );

      expect(periodBucketsRepository.insert).toHaveBeenCalledTimes(1);
      expect(periodBucketsRepository.insert).toHaveBeenCalledWith([
        {
          budgetPeriodId: "new-period",
          bucketId: "b-save",
          bucketName: "Savings",
          targetType: "PERCENT",
          targetValue: 20,
          carryIn: 850,
        },
      ]);
    });

    it("writes no bucket row without a carry map", async () => {
      await service.createPeriodForBudget(budgetWithBuckets);

      expect(periodBucketsRepository.insert).not.toHaveBeenCalled();
    });

    it("writes no bucket row when another call won the period claim", async () => {
      const winner = { id: "their-period", periodCategories: [] };
      periodsRepository.findOne.mockResolvedValue(winner);
      scopedManager.query.mockImplementation(async () => []); // conflict: no row

      const result = await service.createPeriodForBudget(
        budgetWithBuckets,
        undefined,
        undefined,
        { periodStart: "2026-03-01", periodEnd: "2026-03-31" },
        new Map([["b-save", 850]]),
      );

      expect(result).toBe(winner);
      expect(periodBucketsRepository.insert).not.toHaveBeenCalled();
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
