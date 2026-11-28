import { DataSource } from "typeorm";
import { FxAggregate } from "../common/fx-aggregate";
import { investmentLinkedSplitExclusion } from "../common/investment-filter.util";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BudgetHealthReportsService } from "./budget-health-reports.service";
import {
  CategorySpending,
  queryCategorySpending,
  queryCategorySpendingBuckets,
} from "./budget-spending.util";
import { BudgetsService } from "./budgets.service";
import { monthBuckets } from "../test-helpers/budget-spending-buckets";
import { Budget, BudgetType, BudgetStrategy } from "./entities/budget.entity";
import {
  BudgetCategory,
  CategoryGroup,
  RolloverType,
} from "./entities/budget-category.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
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

jest.mock("./budget-spending.util", () => ({
  ...jest.requireActual("./budget-spending.util"),
  queryCategorySpendingBuckets: jest.fn(),
  queryCategorySpending: jest.fn(),
}));

const mockedSpending = queryCategorySpendingBuckets as jest.MockedFunction<
  typeof queryCategorySpendingBuckets
>;
const mockedPeriodSpending = queryCategorySpending as jest.MockedFunction<
  typeof queryCategorySpending
>;

/** Every month of the requested range answers with `s`. */
const mockSpending = (s: CategorySpending) =>
  mockedSpending.mockImplementation(monthBuckets(() => s));

/** One CategorySpending for the given net sums (expenses negative). */
function spending(
  categories: Record<string, number>,
  incomplete: string[] = [],
): CategorySpending {
  return {
    spendingMap: new Map(Object.entries(categories)),
    transferSpendingMap: new Map(),
    currency: "USD",
    incompleteCategoryIds: new Set(incomplete),
    incompleteTransferAccountIds: new Set(),
    transferIncomeMap: new Map(),
    incompleteTransferIncomeAccountIds: new Set(),
    outsideTransferIncome: 0,
    outsideTransferIncomeAggregate: new FxAggregate(),
    outsideTransferIncomeComplete: true,
    missingRatePairs: incomplete.length > 0 ? ["JPY->USD"] : [],
    categoryMissingPairs: new Map(),
    transferMissingPairs: new Map(),
    transferIncomeMissingPairs: new Map(),
    outsideMissingPairs: [],
    transferProvisionalCounts: new Map(),
    transferIncomeProvisionalCounts: new Map(),
    outsideTransferIncomeProvisionalCount: 0,
    categoryProvisionalCounts: new Map(),
    provisionalCount: 0,
  };
}

const roundTo2 = (x: number) => Math.round(x * 100) / 100;

/**
 * The toggle's figure as `queryCategorySpendingBuckets` builds it: its reading
 * and the aggregate of its converted rows.
 */
function outsideIncome(
  ...converted: number[]
): Pick<
  CategorySpending,
  "outsideTransferIncome" | "outsideTransferIncomeAggregate"
> {
  const agg = new FxAggregate();
  for (const amount of converted) agg.addConverted(amount);
  return {
    outsideTransferIncome: agg.knownSubtotal,
    outsideTransferIncomeAggregate: agg,
  };
}

describe("BudgetHealthReportsService", () => {
  let scopedDataSource: DataSourceMock;
  let scopedManager: ManagerMock;
  let service: BudgetHealthReportsService;
  let periodsRepository: Record<string, jest.Mock>;
  let transactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let budgetsService: Record<string, jest.Mock>;

  const makeBudgetCategory = (
    overrides: Partial<BudgetCategory> = {},
  ): BudgetCategory =>
    ({
      id: overrides.id ?? "bc-essential",
      budgetId: "budget-1",
      categoryId: overrides.categoryId ?? "cat-1",
      categoryGroup: CategoryGroup.NEED,
      transferAccountId: null,
      isTransfer: false,
      amount: 500,
      isIncome: false,
      valuationComplete: true,
      missingRatePairs: [],
      budgetedComplete: true,
      budgetedMissingRatePairs: [],
      rolloverType: RolloverType.NONE,
      rolloverCap: null,
      flexGroup: null,
      alertWarnPercent: 80,
      alertCriticalPercent: 95,
      notes: null,
      sortOrder: 0,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      ...overrides,
    }) as BudgetCategory;

  const mockBudget: Budget = {
    id: "budget-1",
    userId: "user-1",
    name: "Test Budget",
    description: null,
    budgetType: BudgetType.MONTHLY,
    periodStart: "2026-05-01",
    periodEnd: null,
    baseIncome: 5000,
    incomeLinked: false,
    strategy: BudgetStrategy.FIXED,
    isActive: true,
    currencyCode: "USD",
    config: {},
    categories: [
      makeBudgetCategory({
        id: "bc-essential",
        categoryId: "cat-essential",
        categoryGroup: CategoryGroup.NEED,
      }),
      makeBudgetCategory({
        id: "bc-discretionary",
        categoryId: "cat-discretionary",
        categoryGroup: CategoryGroup.WANT,
      }),
    ],
    periods: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  } as Budget;

  const createMockQueryBuilder = (overrides = {}) => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    getRawOne: jest.fn().mockResolvedValue({ total: "0" }),
    ...overrides,
  });

  beforeEach(async () => {
    mockedSpending.mockReset();
    mockSpending(spending({}));
    mockedPeriodSpending.mockReset();
    mockedPeriodSpending.mockResolvedValue(spending({}));
    periodsRepository = {
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
      getSummary: jest.fn(),
    };

    ({ dataSource: scopedDataSource, manager: scopedManager } =
      createScopedDbMocks([
        [BudgetPeriod, periodsRepository as never],
        [Transaction, transactionsRepository as never],
        [TransactionSplit, splitsRepository as never],
      ]));
    // No exchange-rate history unless a case supplies it.
    scopedManager.query.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BudgetHealthReportsService,
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
        { provide: BudgetsService, useValue: budgetsService },
        { provide: DataSource, useValue: scopedDataSource },
      ],
    }).compile();

    service = module.get(BudgetHealthReportsService);
  });

  describe("getHealthScore", () => {
    it("returns Excellent (>=90) when all categories are well within budget", async () => {
      budgetsService.getSummary.mockResolvedValue({
        budget: mockBudget,
        categoryBreakdown: [
          {
            budgetCategoryId: "bc-essential",
            categoryId: "cat-essential",
            categoryName: "Rent",
            budgeted: 1000,
            spent: 700,
            percentUsed: 70,
            isIncome: false,
            valuationComplete: true,
            missingRatePairs: [],
            budgetedComplete: true,
            budgetedMissingRatePairs: [],
          },
          {
            budgetCategoryId: "bc-discretionary",
            categoryId: "cat-discretionary",
            categoryName: "Dining",
            budgeted: 500,
            spent: 250,
            percentUsed: 50,
            isIncome: false,
            valuationComplete: true,
            missingRatePairs: [],
            budgetedComplete: true,
            budgetedMissingRatePairs: [],
          },
        ],
      });

      const result = await service.getHealthScore("user-1", "budget-1");

      expect(result.score).toBeGreaterThanOrEqual(90);
      expect(result.label).toBe("Excellent");
      expect(result.breakdown.baseScore).toBe(100);
      expect(result.breakdown.overBudgetDeductions).toBe(0);
      expect(result.breakdown.underBudgetBonus).toBeGreaterThan(0);
      expect(result.categoryScores).toHaveLength(2);
    });

    it("returns an unknown score and the missing pair when a line is incomplete (audit #2365 p)", async () => {
      budgetsService.getSummary.mockResolvedValue({
        budget: mockBudget,
        missingRatePairs: ["QQQ->USD"],
        categoryBreakdown: [
          {
            budgetCategoryId: "bc-essential",
            categoryId: "cat-essential",
            categoryName: "Rent",
            budgeted: 1000,
            spent: 20,
            percentUsed: 2,
            isIncome: false,
            valuationComplete: false,
            missingRatePairs: ["QQQ->USD"],
            budgetedComplete: true,
            budgetedMissingRatePairs: [],
          },
        ],
      });

      const result = await service.getHealthScore("user-1", "budget-1");

      expect(result.score).toBeNull();
      expect(result.label).toBeNull();
      expect(result.valuationComplete).toBe(false);
      expect(result.missingRatePairs).toEqual(["QQQ->USD"]);
    });

    it("deducts more from the score for overspending essential categories", async () => {
      budgetsService.getSummary.mockResolvedValue({
        budget: mockBudget,
        categoryBreakdown: [
          {
            budgetCategoryId: "bc-essential",
            categoryId: "cat-essential",
            categoryName: "Rent",
            budgeted: 1000,
            spent: 1500,
            percentUsed: 150,
            isIncome: false,
            valuationComplete: true,
            missingRatePairs: [],
            budgetedComplete: true,
            budgetedMissingRatePairs: [],
          },
          {
            budgetCategoryId: "bc-discretionary",
            categoryId: "cat-discretionary",
            categoryName: "Dining",
            budgeted: 500,
            spent: 750,
            percentUsed: 150,
            isIncome: false,
            valuationComplete: true,
            missingRatePairs: [],
            budgetedComplete: true,
            budgetedMissingRatePairs: [],
          },
        ],
      });

      const result = await service.getHealthScore("user-1", "budget-1");

      expect(result.breakdown.overBudgetDeductions).toBeGreaterThan(0);
      expect(result.breakdown.essentialWeightPenalty).toBeGreaterThan(0);
      expect(result.score).toBeLessThan(100);
    });

    it("clamps score to a 0-100 range", async () => {
      const massiveOverspend = Array.from({ length: 5 }).map((_, i) => ({
        budgetCategoryId: `bc-${i}`,
        categoryId: `cat-${i}`,
        categoryName: `Cat ${i}`,
        budgeted: 100,
        spent: 1000,
        percentUsed: 1000,
        isIncome: false,
        valuationComplete: true,
        missingRatePairs: [],
        budgetedComplete: true,
        budgetedMissingRatePairs: [],
      }));
      budgetsService.getSummary.mockResolvedValue({
        budget: mockBudget,
        categoryBreakdown: massiveOverspend,
      });

      const result = await service.getHealthScore("user-1", "budget-1");

      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it("ignores income categories and zero-budget categories", async () => {
      budgetsService.getSummary.mockResolvedValue({
        budget: mockBudget,
        categoryBreakdown: [
          {
            budgetCategoryId: "bc-income",
            categoryId: "cat-income",
            categoryName: "Salary",
            budgeted: 5000,
            spent: 5000,
            percentUsed: 100,
            isIncome: true,
            valuationComplete: true,
            missingRatePairs: [],
            budgetedComplete: true,
            budgetedMissingRatePairs: [],
          },
          {
            budgetCategoryId: "bc-empty",
            categoryId: "cat-empty",
            categoryName: "Empty",
            budgeted: 0,
            spent: 0,
            percentUsed: 0,
            isIncome: false,
            valuationComplete: true,
            missingRatePairs: [],
            budgetedComplete: true,
            budgetedMissingRatePairs: [],
          },
        ],
      });

      const result = await service.getHealthScore("user-1", "budget-1");

      expect(result.categoryScores).toHaveLength(0);
      expect(result.breakdown.overBudgetDeductions).toBe(0);
    });

    it("applies a trend bonus when the latest period spent less of its budget", async () => {
      periodsRepository.find.mockResolvedValue([
        {
          id: "p-latest",
          budgetId: "budget-1",
          status: PeriodStatus.CLOSED,
          totalBudgeted: 1000,
          actualExpenses: 600,
          periodStart: "2026-04-01",
        },
        {
          id: "p-previous",
          budgetId: "budget-1",
          status: PeriodStatus.CLOSED,
          totalBudgeted: 1000,
          actualExpenses: 950,
          periodStart: "2026-03-01",
        },
      ]);
      budgetsService.getSummary.mockResolvedValue({
        budget: mockBudget,
        categoryBreakdown: [],
      });

      const result = await service.getHealthScore("user-1", "budget-1");

      expect(result.breakdown.trendBonus).toBeGreaterThan(0);
    });
  });

  describe("getHealthScoreHistory", () => {
    it("returns an empty array when no periods exist", async () => {
      periodsRepository.find.mockResolvedValue([]);
      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        6,
      );
      expect(result).toEqual([]);
    });

    it("returns a score per closed period in chronological order", async () => {
      periodsRepository.find.mockResolvedValue([
        {
          id: "p1",
          budgetId: "budget-1",
          status: PeriodStatus.CLOSED,
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          periodCategories: [
            {
              categoryId: "cat-essential",
              budgetedAmount: 1000,
              actualAmount: 600,
              budgetCategory: {
                id: "bc-essential",
                isIncome: false,
                valuationComplete: true,
                missingRatePairs: [],
                budgetedComplete: true,
                budgetedMissingRatePairs: [],
                categoryGroup: CategoryGroup.NEED,
              },
            },
          ],
        },
        {
          id: "p2",
          budgetId: "budget-1",
          status: PeriodStatus.CLOSED,
          periodStart: "2026-02-01",
          periodEnd: "2026-02-28",
          periodCategories: [
            {
              categoryId: "cat-essential",
              budgetedAmount: 1000,
              actualAmount: 1500,
              budgetCategory: {
                id: "bc-essential",
                isIncome: false,
                valuationComplete: true,
                missingRatePairs: [],
                budgetedComplete: true,
                budgetedMissingRatePairs: [],
                categoryGroup: CategoryGroup.NEED,
              },
            },
          ],
        },
      ]);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        12,
      );

      expect(result).toHaveLength(2);
      // Structure, not a label: a `Jan 2026` from the server was English on
      // every locale and sorted alphabetically at the client. `YYYY-MM` also
      // sorts chronologically as a string, which is what the two reports'
      // month columns now order on.
      expect(result[0].monthKey).toBe("2026-01");
      expect(result[1].monthKey).toBe("2026-02");
      // First period was under, second was over -> first should be higher
      expect(result[0].score).toBeGreaterThan(result[1].score);
      expect(["Excellent", "Good", "Needs Attention", "Off Track"]).toContain(
        result[0].label,
      );
    });

    it("reads an OPEN period's actuals through the budget page's converted read", async () => {
      // 1200 of the 1000 budgeted, net within the category and already in the
      // budget's currency: what the budget page shows for the period.
      mockedPeriodSpending.mockResolvedValue(
        spending({ "cat-essential": -1200 }),
      );

      periodsRepository.find.mockResolvedValue([
        {
          id: "p-open",
          budgetId: "budget-1",
          status: PeriodStatus.OPEN,
          periodStart: "2026-05-01",
          periodEnd: "2026-05-31",
          periodCategories: [
            {
              categoryId: "cat-essential",
              budgetedAmount: 1000,
              actualAmount: 0,
              budgetCategory: {
                id: "bc-essential",
                isIncome: false,
                valuationComplete: true,
                missingRatePairs: [],
                budgetedComplete: true,
                budgetedMissingRatePairs: [],
                categoryGroup: CategoryGroup.NEED,
              },
            },
          ],
        },
      ]);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        1,
      );

      expect(mockedPeriodSpending).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "user-1",
        mockBudget.categories,
        "2026-05-01",
        "2026-05-31",
      );
      // No raw, unconverted sum of its own (issue #2155).
      expect(transactionsRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].score).toBeLessThan(100);
    });

    it("leaves an OPEN period's category with an unrated row out of the score (issue #2155)", async () => {
      // The converted part alone is 1200 of 1000; with a row that had no rate
      // the real figure is unknown, so the category is not scored on it.
      mockedPeriodSpending.mockResolvedValue(
        spending({ "cat-essential": -1200 }, ["cat-essential"]),
      );
      periodsRepository.find.mockResolvedValue([
        {
          id: "p-open",
          budgetId: "budget-1",
          status: PeriodStatus.OPEN,
          periodStart: "2026-05-01",
          periodEnd: "2026-05-31",
          periodCategories: [
            {
              categoryId: "cat-essential",
              budgetedAmount: 1000,
              actualAmount: 0,
              budgetCategory: {
                id: "bc-essential",
                isIncome: false,
                valuationComplete: true,
                missingRatePairs: [],
                budgetedComplete: true,
                budgetedMissingRatePairs: [],
                categoryGroup: CategoryGroup.NEED,
              },
            },
          ],
        },
      ]);

      const result = await service.getHealthScoreHistory(
        "user-1",
        "budget-1",
        1,
      );

      // No deduction for the unknown overspend, and no under-budget bonus.
      expect(result[0].score).toBe(100);
    });
  });

  describe("getSavingsRate", () => {
    it("returns one entry per month requested", async () => {
      const result = await service.getSavingsRate("user-1", "budget-1", 3);
      expect(result).toHaveLength(3);
    });

    it("counts transfer income lines and the toggle's figure as income (issue #2141)", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [
          {
            id: "bc-hisa",
            budgetId: "budget-1",
            categoryId: null,
            isTransfer: true,
            isIncome: true,
            valuationComplete: true,
            missingRatePairs: [],
            budgetedComplete: true,
            budgetedMissingRatePairs: [],
            transferAccountId: "acct-hisa",
            amount: 2000,
          },
          {
            id: "bc-food",
            budgetId: "budget-1",
            categoryId: "cat-food",
            isTransfer: false,
            isIncome: false,
            valuationComplete: true,
            missingRatePairs: [],
            budgetedComplete: true,
            budgetedMissingRatePairs: [],
            transferAccountId: null,
            amount: 500,
          },
        ],
      });
      mockSpending({
        ...spending({ "cat-food": -1000 }),
        transferIncomeMap: new Map([["acct-hisa", 2000]]),
        ...outsideIncome(500),
      });

      const result = await service.getSavingsRate("user-1", "budget-1", 1);

      // The transfer income line passes to the actuals read with the others.
      expect(mockedSpending.mock.calls[0][3].map((bc) => bc.id)).toEqual([
        "bc-hisa",
        "bc-food",
      ]);
      // No income category, but the budget has an income line: the income
      // side is 2,000 + 500, never the every-deposit fallback.
      expect(transactionsRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(result[0]).toMatchObject({
        income: 2500,
        expenses: 1000,
        savings: 1500,
        savingsRate: 60,
        valuationComplete: true,
      });
    });

    it("still reads the toggle's figure when the budget has only savings transfer lines", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        config: {
          excludedAccountIds: ["acct-hisa"],
          transfersInAsIncome: true,
        },
        categories: [
          {
            id: "bc-tfsa",
            budgetId: "budget-1",
            categoryId: null,
            isTransfer: true,
            isIncome: false,
            valuationComplete: true,
            missingRatePairs: [],
            budgetedComplete: true,
            budgetedMissingRatePairs: [],
            transferAccountId: "acct-tfsa",
            amount: 300,
          },
        ],
      });
      transactionsRepository.createQueryBuilder.mockReturnValueOnce(
        createMockQueryBuilder(),
      );
      mockSpending({ ...spending({}), ...outsideIncome(2000) });

      const result = await service.getSavingsRate("user-1", "budget-1", 1);

      expect(mockedSpending).toHaveBeenCalledTimes(1);
      // The savings line names the budget; it is not an expense of the rate.
      expect(result[0]).toMatchObject({ income: 2000, expenses: 0 });
    });

    it("leaves the budget's excluded accounts out of the no-income-category query", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        config: { excludedAccountIds: ["acc-x"] },
      });
      const qb = createMockQueryBuilder();
      transactionsRepository.createQueryBuilder.mockReturnValueOnce(qb);

      await service.getSavingsRate("user-1", "budget-1", 1);

      expect(qb.andWhere).toHaveBeenCalledWith(
        "t.account_id NOT IN (:...excludedAccountIds)",
        { excludedAccountIds: ["acc-x"] },
      );
    });

    it("converts foreign income into the budget's currency when no income category is set (issue #2155)", async () => {
      const thisMonth = new Date();
      const month = `${thisMonth.getFullYear()}-${String(thisMonth.getMonth() + 1).padStart(2, "0")}`;
      const qb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { month, currencyCode: "USD", total: "3000" },
          // EUR 1250 that settled into USD at its own 1.25 EUR per USD.
          {
            month,
            currencyCode: "EUR",
            total: "1250",
            fx_day: `${month}-05`,
            fx_original_currency: "USD",
            fx_exchange_rate: "1.25000000",
          },
        ]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.getSavingsRate("user-1", "budget-1", 1);

      // USD 4000, never the 4250 a sum across currencies gave.
      expect(result[0].income).toBe(4000);
      expect(result[0].valuationComplete).toBe(true);
      expect(qb.setParameter).toHaveBeenCalledWith(
        "fxReportingCurrency",
        "USD",
      );
    });

    it("reads the income fallback at line grain, without split transfer lines", async () => {
      const qb = createMockQueryBuilder();
      transactionsRepository.createQueryBuilder.mockReturnValueOnce(qb);

      await service.getSavingsRate("user-1", "budget-1", 1);

      expect(qb.leftJoin).toHaveBeenCalledWith("t.splits", "ts");
      expect(qb.andWhere).toHaveBeenCalledWith(
        "(ts.transferAccountId IS NULL OR ts.id IS NULL)",
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        "COALESCE(ts.amount, t.amount) > 0",
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        investmentLinkedSplitExclusion("ts"),
      );
    });

    it("flags a month whose foreign income had no rate, keeping what converted", async () => {
      const thisMonth = new Date();
      const month = `${thisMonth.getFullYear()}-${String(thisMonth.getMonth() + 1).padStart(2, "0")}`;
      transactionsRepository.createQueryBuilder.mockReturnValueOnce(
        createMockQueryBuilder({
          getRawMany: jest.fn().mockResolvedValue([
            { month, currencyCode: "USD", total: "3000" },
            {
              month,
              currencyCode: "JPY",
              total: "100000",
              fx_day: `${month}-05`,
            },
          ]),
        }),
      );

      const result = await service.getSavingsRate("user-1", "budget-1", 1);

      expect(result[0].income).toBe(3000);
      expect(result[0].valuationComplete).toBe(false);
    });

    /**
     * A month's income is one aggregate over its native rows, its converted
     * foreign parts and the toggle's converted figure, read once (issue #2408,
     * `docs/specs/report-rounding-and-aggregation.md` rule 2), at the
     * budget currency's two places (issue #2410). Adding the parts' readings
     * gives 10.00 + 0.01 + 0.63 = 10.64; the exact 10.6340625 reads 10.63.
     */
    it("folds a month's native, foreign and transferred-in income into one aggregate", async () => {
      const thisMonth = new Date();
      const month = `${thisMonth.getFullYear()}-${String(thisMonth.getMonth() + 1).padStart(2, "0")}`;
      transactionsRepository.createQueryBuilder.mockReturnValueOnce(
        createMockQueryBuilder({
          getRawMany: jest.fn().mockResolvedValue([
            { month, currencyCode: "USD", total: "10.004" },
            // EUR 0.008 settled into USD at its own 1.6: 0.005.
            {
              month,
              currencyCode: "EUR",
              total: "0.008",
              fx_day: `${month}-05`,
              fx_original_currency: "USD",
              fx_exchange_rate: "1.60000000",
            },
          ]),
        }),
      );
      // EUR 1.0001 transferred in at 1.6: 0.6250625, which reads 0.63.
      mockSpending({ ...spending({}), ...outsideIncome(1.0001 / 1.6) });

      const result = await service.getSavingsRate("user-1", "budget-1", 1);

      const exact = new FxAggregate();
      for (const part of [10.004, 0.008 / 1.6, 1.0001 / 1.6]) {
        exact.addConverted(part);
      }
      expect(result[0].income).toBe(exact.knownSubtotalAt(2));
      expect(result[0].income).toBe(10.63);
      expect(result[0]).toMatchObject({
        expenses: 0,
        savings: 10.63,
        savingsRate: 100,
        valuationComplete: true,
      });
    });

    /**
     * Savings is income less expenses worked out before either is rounded,
     * and the rate is the ratio of the unrounded figures (rules 2 and 8):
     * 0.63125 + 0.63125 - 0.006 = 1.2565 reads 1.26 at USD's two places
     * (issue #2410), where the two readings, 1.26 - 0.01, read 1.25.
     */
    it("works savings out as one difference of the unrounded income and expenses", async () => {
      const thisMonth = new Date();
      const month = `${thisMonth.getFullYear()}-${String(thisMonth.getMonth() + 1).padStart(2, "0")}`;
      transactionsRepository.createQueryBuilder.mockReturnValueOnce(
        createMockQueryBuilder({
          getRawMany: jest.fn().mockResolvedValue([
            {
              month,
              currencyCode: "EUR",
              total: "1.01",
              fx_day: `${month}-05`,
              fx_original_currency: "USD",
              fx_exchange_rate: "1.60000000",
            },
          ]),
        }),
      );
      mockSpending({
        ...spending({ "cat-essential": -0.006 }),
        ...outsideIncome(1.01 / 1.6),
      });

      const result = await service.getSavingsRate("user-1", "budget-1", 1);

      expect(result[0]).toMatchObject({
        income: 1.26,
        expenses: 0.01,
        savings: 1.26,
        savingsRate: roundTo2((1.2565 / 1.2625) * 100),
        valuationComplete: true,
      });
    });

    it("reads the figures at the budget currency's own places, whole yen for JPY (issue #2410)", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        currencyCode: "JPY",
      });
      transactionsRepository.createQueryBuilder.mockReturnValueOnce(
        createMockQueryBuilder(),
      );
      mockSpending({
        ...spending({ "cat-essential": -0.4 }),
        ...outsideIncome(1000.6),
      });

      const result = await service.getSavingsRate("user-1", "budget-1", 1);

      // At USD's two places these would read 1000.60, 0.40 and 1000.20.
      expect(result[0]).toMatchObject({
        income: 1001,
        expenses: 0,
        savings: 1000,
      });
    });

    it("keeps a month's native income and the toggle's figure when its foreign income had no rate", async () => {
      const thisMonth = new Date();
      const month = `${thisMonth.getFullYear()}-${String(thisMonth.getMonth() + 1).padStart(2, "0")}`;
      transactionsRepository.createQueryBuilder.mockReturnValueOnce(
        createMockQueryBuilder({
          getRawMany: jest.fn().mockResolvedValue([
            { month, currencyCode: "USD", total: "3000" },
            {
              month,
              currencyCode: "JPY",
              total: "100000",
              fx_day: `${month}-05`,
            },
          ]),
        }),
      );
      mockSpending({ ...spending({}), ...outsideIncome(1.0001 / 1.6) });

      const result = await service.getSavingsRate("user-1", "budget-1", 1);

      // 3000 + 0.6250625, at USD's two places.
      expect(result[0].income).toBe(3000.63);
      expect(result[0].valuationComplete).toBe(false);
    });

    it("leaves a net outflow from the toggle's accounts out of income", async () => {
      transactionsRepository.createQueryBuilder.mockReturnValueOnce(
        createMockQueryBuilder(),
      );
      mockSpending({ ...spending({}), ...outsideIncome(-250) });

      const result = await service.getSavingsRate("user-1", "budget-1", 1);

      expect(result[0]).toMatchObject({ income: 0, savingsRate: 0 });
    });

    it("gives no rate over an income that reads as zero at the budget's places", async () => {
      transactionsRepository.createQueryBuilder.mockReturnValueOnce(
        createMockQueryBuilder(),
      );
      // 0.004 is money in (its sign), but it reads 0.00 at USD's two places
      // (issue #2410); at four it read 0.004 and took a rate.
      mockSpending({
        ...spending({ "cat-essential": -500 }),
        ...outsideIncome(0.004),
      });

      const result = await service.getSavingsRate("user-1", "budget-1", 1);

      expect(result[0]).toMatchObject({
        income: 0,
        expenses: 500,
        savings: -500,
        savingsRate: 0,
      });
    });

    it("reads income and expenses through the budget page's net, converted actuals", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [
          makeBudgetCategory({
            id: "bc-income",
            categoryId: "cat-income",
            isIncome: true,
          }),
          makeBudgetCategory({ id: "bc-1", categoryId: "cat-1" }),
        ],
      });
      // 5000 less a 400 correction; 2000 spent less 500 refunded.
      mockSpending(spending({ "cat-income": 4600, "cat-1": -1500 }));

      const result = await service.getSavingsRate("user-1", "budget-1", 1);

      expect(mockedSpending).toHaveBeenCalledTimes(1);
      expect(result[0]).toMatchObject({
        income: 4600,
        expenses: 1500,
        savings: 3100,
        valuationComplete: true,
      });
    });

    it("flags a month whose category had a row with no rate", async () => {
      budgetsService.findOne.mockResolvedValueOnce({
        ...mockBudget,
        categories: [
          makeBudgetCategory({
            id: "bc-income",
            categoryId: "cat-income",
            isIncome: true,
          }),
          makeBudgetCategory({ id: "bc-1", categoryId: "cat-1" }),
        ],
      });
      mockSpending(spending({ "cat-income": 5000, "cat-1": -100 }, ["cat-1"]));

      const result = await service.getSavingsRate("user-1", "budget-1", 1);

      expect(result[0].valuationComplete).toBe(false);
    });

    it("computes savings rate as (income - expenses) / income * 100", async () => {
      transactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getRawMany: jest.fn().mockResolvedValue([]),
        }),
      );

      const result = await service.getSavingsRate("user-1", "budget-1", 1);
      // With no transactions, savings rate falls back to 0
      expect(result[0].savingsRate).toBe(0);
      expect(result[0].income).toBe(0);
      expect(result[0].expenses).toBe(0);
    });

    it("reads every money field as zero over a month with no rows", async () => {
      const result = await service.getSavingsRate("user-1", "budget-1", 1);
      expect(result[0]).toMatchObject({
        income: 0,
        expenses: 0,
        savings: 0,
        savingsRate: 0,
      });
    });

    /**
     * The month was a server-rendered `Mmm YYYY` label and nothing in this
     * suite looked at it, so shipping English months to 22 locales -- and a
     * client-side sort that put Apr before Jan -- was invisible here. These
     * assertions are deliberately clock-free: they check the SHAPE and the
     * consecutiveness of the keys, both of which a label fails, rather than
     * naming today's months.
     */
    it("keys each month structurally and in calendar order", async () => {
      const result = await service.getSavingsRate("user-1", "budget-1", 6);

      const keys = result.map((point) => point.monthKey);
      for (const key of keys) {
        expect(key).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
      }

      // `YYYY-MM` sorts chronologically as a plain string, which is what the
      // report's month column now orders on; `Apr 2026` does not.
      expect([...keys].sort()).toEqual(keys);

      // Oldest first, one calendar month apart -- so the series really is the
      // requested window and not six renderings of one label.
      const asMonthNumber = (key: string) => {
        const [year, month] = key.split("-").map(Number);
        return year * 12 + month;
      };
      for (let i = 1; i < keys.length; i++) {
        expect(asMonthNumber(keys[i]) - asMonthNumber(keys[i - 1])).toBe(1);
      }

      // The old label field is gone rather than kept as an alias: two names for
      // one value is how a consumer goes on reading the English one.
      expect(result[0]).not.toHaveProperty("month");
    });
  });
});
