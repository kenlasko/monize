import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ForecastAggregatorService } from "./forecast-aggregator.service";
import { ScheduledEffectiveAmountService } from "../../scheduled-transactions/scheduled-effective-amount.service";
import { ScheduledOccurrenceService } from "../../scheduled-transactions/scheduled-occurrence.service";
import { ScheduledTransactionLoanService } from "../../scheduled-transactions/scheduled-transaction-loan.service";
import { ScheduledTransactionOverride } from "../../scheduled-transactions/entities/scheduled-transaction-override.entity";
import {
  createInvestmentFxMock,
  InvestmentFxMock,
} from "../../test-helpers/investment-fx-testing";
import { InvestmentTransactionsService } from "../../securities/investment-transactions.service";
import { Transaction } from "../../transactions/entities/transaction.entity";
import { ScheduledTransaction } from "../../scheduled-transactions/entities/scheduled-transaction.entity";
import { AccountsService } from "../../accounts/accounts.service";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

describe("ForecastAggregatorService", () => {
  let service: ForecastAggregatorService;
  let mockTransactionRepo: Record<string, jest.Mock>;
  let mockScheduledTransactionRepo: Record<string, jest.Mock>;
  let mockOverridesRepo: Record<string, jest.Mock>;
  let mockAccountsService: Record<string, jest.Mock>;
  let mockTransactionAnalytics: Record<string, jest.Mock>;
  let fx: InvestmentFxMock;

  const userId = "user-1";

  const mockQueryBuilder = (getRawManyResult: unknown[] = []) => {
    const qb: Record<string, jest.Mock> = {
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      having: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(getRawManyResult),
    };
    return qb;
  };

  beforeEach(async () => {
    mockTransactionRepo = {
      createQueryBuilder: jest
        .fn()
        .mockImplementation(() => mockQueryBuilder()),
    };

    mockScheduledTransactionRepo = {
      find: jest.fn().mockResolvedValue([]),
    };

    mockAccountsService = {
      findAll: jest.fn().mockResolvedValue([
        {
          name: "Chequing",
          accountType: "CHEQUING",
          currentBalance: 5000,
          currencyCode: "USD",
          isClosed: false,
        },
        {
          name: "Savings",
          accountType: "SAVINGS",
          currentBalance: 10000,
          currencyCode: "USD",
          isClosed: false,
        },
      ]),
    };

    mockOverridesRepo = { find: jest.fn().mockResolvedValue([]) };

    mockTransactionAnalytics = {
      getRecurringCharges: jest.fn().mockResolvedValue([]),
    };

    fx = createInvestmentFxMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ForecastAggregatorService,
        {
          provide: DataSource,
          useValue: createScopedDbMocks([
            [Transaction, mockTransactionRepo],
            [ScheduledTransaction, mockScheduledTransactionRepo],
            [ScheduledTransactionOverride, mockOverridesRepo],
          ]).dataSource,
        },
        {
          provide: AccountsService,
          useValue: mockAccountsService,
        },
        {
          provide: TransactionAnalyticsService,
          useValue: mockTransactionAnalytics,
        },
        // The real read-side services over a mocked FX source (issue #1247):
        // the dates and amounts these assertions read ARE their output.
        ScheduledOccurrenceService,
        // No loan bill here: the per-occurrence loan pricing is
        // `scheduled-occurrence.service.spec.ts`'s.
        {
          provide: ScheduledTransactionLoanService,
          useValue: {
            projectLoanOccurrencesMany: jest.fn().mockResolvedValue(new Map()),
          },
        },
        ScheduledEffectiveAmountService,
        {
          provide: InvestmentTransactionsService,
          useValue: fx,
        },
      ],
    }).compile();

    service = module.get<ForecastAggregatorService>(ForecastAggregatorService);
  });

  describe("computeAggregates()", () => {
    it("returns empty aggregates when no transactions exist", async () => {
      const result = await service.computeAggregates(userId, "USD");

      expect(result.monthlyHistory).toEqual([]);
      expect(result.scheduledTransactions).toEqual([]);
      expect(result.recurringCharges).toEqual([]);
      expect(result.incomePatterns.monthlyIncome).toEqual([]);
      expect(result.incomePatterns.averageMonthlyIncome).toBe(0);
      expect(result.incomePatterns.incomeVariability).toBe(0);
      expect(result.currency).toBe("USD");
      expect(result.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("computes account balances from AccountsService", async () => {
      const result = await service.computeAggregates(userId, "USD");

      expect(mockAccountsService.findAll).toHaveBeenCalledWith(userId, false);
      expect(result.accountBalances.totalBalance).toBe(15000);
      expect(result.accountBalances.accounts).toHaveLength(2);
      expect(result.accountBalances.accounts[0].name).toBe("Chequing");
      expect(result.accountBalances.accounts[0].balance).toBe(5000);
    });

    it("computes monthly history with income and expenses", async () => {
      // Each createQueryBuilder call returns a fresh qb.
      // All 3 queries return the same data, but only the monthly
      // history query produces meaningful results since it has
      // the income/expenses fields.
      const monthlyData = [
        {
          month: "2025-06",
          categoryName: "Salary",
          isIncome: true,
          income: "4000",
          expenses: "0",
        },
        {
          month: "2025-06",
          categoryName: "Groceries",
          isIncome: false,
          income: "0",
          expenses: "500",
        },
        {
          month: "2025-07",
          categoryName: "Salary",
          isIncome: true,
          income: "4000",
          expenses: "0",
        },
        {
          month: "2025-07",
          categoryName: "Dining",
          isIncome: false,
          income: "0",
          expenses: "300",
        },
      ];

      mockTransactionRepo.createQueryBuilder.mockImplementation(() =>
        mockQueryBuilder(monthlyData),
      );

      const result = await service.computeAggregates(userId, "USD");

      expect(result.monthlyHistory).toHaveLength(2);
      expect(result.monthlyHistory[0].month).toBe("2025-06");
      expect(result.monthlyHistory[0].totalIncome).toBe(4000);
      expect(result.monthlyHistory[0].totalExpenses).toBe(500);
      expect(result.monthlyHistory[0].netCashFlow).toBe(3500);
      expect(result.monthlyHistory[0].categoryBreakdown).toHaveLength(2);
    });

    it("fetches active scheduled transactions with categories", async () => {
      mockScheduledTransactionRepo.find.mockResolvedValue([
        {
          // A real row always has an id, and the effective-amount resolver files
          // its answer under it (issue #1247).
          id: "st-rent",
          name: "Rent",
          amount: -1500,
          frequency: "MONTHLY",
          nextDueDate: new Date("2026-03-01"),
          category: { name: "Housing", isIncome: false },
          isTransfer: false,
        },
        {
          id: "st-salary",
          name: "Salary",
          amount: 5000,
          frequency: "BIWEEKLY",
          nextDueDate: new Date("2026-02-28"),
          category: { name: "Income", isIncome: true },
          isTransfer: false,
        },
      ]);

      const result = await service.computeAggregates(userId, "USD");

      // Ordered by the date each occurrence actually falls on, so the salary due
      // on the 28th precedes the rent due on the 1st (issue #1247).
      expect(result.scheduledTransactions).toHaveLength(2);
      expect(result.scheduledTransactions[0].name).toBe("Salary");
      expect(result.scheduledTransactions[0].nextDueDate).toBe("2026-02-28");
      expect(result.scheduledTransactions[0].isIncome).toBe(true);
      expect(result.scheduledTransactions[1].name).toBe("Rent");
      expect(result.scheduledTransactions[1].amount).toBe(1500);
      expect(result.scheduledTransactions[1].isIncome).toBe(false);
    });

    it("quotes the next occurrence's own date and amount, override included", async () => {
      mockScheduledTransactionRepo.find.mockResolvedValue([
        {
          id: "st-rent",
          name: "Rent",
          amount: -1500,
          frequency: "MONTHLY",
          nextDueDate: new Date("2026-09-01"),
          category: { name: "Housing", isIncome: false },
          isTransfer: false,
        },
      ]);
      mockOverridesRepo.find.mockResolvedValue([
        {
          id: "ovr-1",
          scheduledTransactionId: "st-rent",
          originalDate: "2026-09-01",
          overrideDate: "2026-09-05",
          amount: -1650,
        },
      ]);

      const result = await service.computeAggregates(userId, "USD");

      expect(result.scheduledTransactions[0].amount).toBe(1650);
      expect(result.scheduledTransactions[0].nextDueDate).toBe("2026-09-05");
    });

    it("takes the direction from the occurrence, not the stored parent sign", async () => {
      // A mixed-sign split parent with no category of its own: an ordinary -1200
      // line beside an embedded SELL of 10 x 100. The SELL's stored pair is stale,
      // so the line re-prices at the current 1.35 to +1350 and the occurrence is
      // an inflow of 150 -- while the stored parent still says -200.
      fx.resolveSettlementCurrencyPair.mockResolvedValue({
        from: "EUR",
        to: "USD",
      });
      fx.resolveCashExchangeRateOrNull.mockResolvedValue(1.35);
      mockScheduledTransactionRepo.find.mockResolvedValue([
        {
          id: "st-split",
          name: "Sell 10 shares, pay the fee",
          amount: -200,
          currencyCode: "USD",
          frequency: "MONTHLY",
          nextDueDate: new Date("2026-09-01"),
          category: null,
          isTransfer: false,
          isSplit: true,
          splits: [
            { id: "sp-1", kind: "category", amount: -1200 },
            {
              id: "sp-2",
              kind: "investment",
              amount: 1000,
              investmentAction: "SELL",
              investmentSecurityId: "SEC-1",
              investmentQuantity: 10,
              investmentPrice: 100,
              investmentCommission: 0,
              investmentExchangeRate: 1,
              investmentExchangeRateFromCurrency: "CAD",
              investmentExchangeRateToCurrency: "USD",
            },
          ],
        },
      ]);

      const result = await service.computeAggregates(userId, "USD");

      expect(result.scheduledTransactions[0].amount).toBe(150);
      // The stored -200 would have made this an expense in the model's summary.
      expect(result.scheduledTransactions[0].isIncome).toBe(true);
    });

    it("computes income patterns and variability", async () => {
      const incomeData = [
        { month: "2025-03", total: "4000", sourceCount: "1" },
        { month: "2025-04", total: "4200", sourceCount: "1" },
        { month: "2025-05", total: "3800", sourceCount: "1" },
        { month: "2025-06", total: "4100", sourceCount: "1" },
      ];

      // All 3 QB calls return income data; getIncomePatterns
      // will interpret it correctly via its own column aliases
      mockTransactionRepo.createQueryBuilder.mockImplementation(() =>
        mockQueryBuilder(incomeData),
      );

      const result = await service.computeAggregates(userId, "USD");

      expect(result.incomePatterns.monthlyIncome).toHaveLength(4);
      expect(result.incomePatterns.averageMonthlyIncome).toBe(4025);
      // Low variability for stable income
      expect(result.incomePatterns.incomeVariability).toBeLessThan(0.1);
    });

    it("detects high income variability for freelancer patterns", async () => {
      const incomeData = [
        { month: "2025-03", total: "2000", sourceCount: "2" },
        { month: "2025-04", total: "6000", sourceCount: "3" },
        { month: "2025-05", total: "1500", sourceCount: "1" },
        { month: "2025-06", total: "8000", sourceCount: "4" },
      ];

      mockTransactionRepo.createQueryBuilder.mockImplementation(() =>
        mockQueryBuilder(incomeData),
      );

      const result = await service.computeAggregates(userId, "USD");

      // CV should be > 0.3 for highly variable income
      expect(result.incomePatterns.incomeVariability).toBeGreaterThan(0.3);
    });

    it("includes recurring charges from the shared analytics service", async () => {
      // Recurring-charge detection lives on TransactionAnalyticsService; the
      // forecast aggregator surfaces whatever the shared method returns and
      // requests the "Uncategorized" label for charges with no category.
      const charges = [
        {
          payeeName: "Netflix",
          amounts: [15.99, 17.99],
          dates: ["2025-11-01", "2025-12-01"],
          frequency: "monthly",
          currentAmount: 17.99,
          previousAmount: 15.99,
          categoryName: "Entertainment",
        },
      ];
      mockTransactionAnalytics.getRecurringCharges.mockResolvedValue(charges);

      const result = await service.computeAggregates(userId, "USD");

      expect(mockTransactionAnalytics.getRecurringCharges).toHaveBeenCalledWith(
        userId,
        expect.any(String),
        expect.any(String),
        { uncategorizedLabel: "Uncategorized" },
      );
      expect(result.recurringCharges).toEqual(charges);
    });

    it("filters out void transactions and transfers", async () => {
      const qb = mockQueryBuilder();
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      await service.computeAggregates(userId, "USD");

      const andWhereCalls = qb.andWhere.mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(andWhereCalls).toContain("t.status != 'VOID'");
      expect(andWhereCalls).toContain("t.isTransfer = false");
      expect(andWhereCalls).toContain("t.parentTransactionId IS NULL");
    });

    it("excludes investment-linked cash transactions from every forecast query", async () => {
      // The forecast aggregator's own queries (monthly history, income
      // patterns) must strip out BUY/SELL/DIVIDEND cash side-effects so they
      // don't skew the forecast. (Recurring-charge detection applies the same
      // exclusion, but now lives in TransactionAnalyticsService.)
      const qb = mockQueryBuilder();
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      await service.computeAggregates(userId, "USD");

      const andWhereCalls = qb.andWhere.mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      const investmentExclusion =
        "NOT EXISTS (SELECT 1 FROM investment_transactions it WHERE it.transaction_id = t.id)";
      const matches = andWhereCalls.filter((c) => c === investmentExclusion);
      // Applied by both remaining forecast query builders
      // (getMonthlyHistory, getIncomePatterns).
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it("handles empty account list", async () => {
      mockAccountsService.findAll.mockResolvedValue([]);

      const result = await service.computeAggregates(userId, "USD");

      expect(result.accountBalances.totalBalance).toBe(0);
      expect(result.accountBalances.accounts).toEqual([]);
    });

    it("returns zero variability for single month of income", async () => {
      const singleMonthData = [
        { month: "2025-06", total: "5000", sourceCount: "1" },
      ];

      mockTransactionRepo.createQueryBuilder.mockImplementation(() =>
        mockQueryBuilder(singleMonthData),
      );

      const result = await service.computeAggregates(userId, "USD");

      expect(result.incomePatterns.incomeVariability).toBe(0);
      expect(result.incomePatterns.averageMonthlyIncome).toBe(5000);
    });

    it("marks scheduled transactions with positive amounts as income", async () => {
      mockScheduledTransactionRepo.find.mockResolvedValue([
        {
          id: "st-freelance",
          name: "Freelance Payment",
          amount: 2000,
          frequency: "MONTHLY",
          nextDueDate: new Date("2026-03-15"),
          category: null,
          isTransfer: false,
        },
      ]);

      const result = await service.computeAggregates(userId, "USD");

      expect(result.scheduledTransactions[0].isIncome).toBe(true);
    });

    it("includes transfer flag on scheduled transactions", async () => {
      mockScheduledTransactionRepo.find.mockResolvedValue([
        {
          id: "st-savings",
          name: "Savings Transfer",
          amount: -500,
          frequency: "MONTHLY",
          nextDueDate: new Date("2026-03-01"),
          category: null,
          isTransfer: true,
        },
      ]);

      const result = await service.computeAggregates(userId, "USD");

      expect(result.scheduledTransactions[0].isTransfer).toBe(true);
    });
  });
});
