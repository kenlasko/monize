import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { AnomalyReportsService } from "./anomaly-reports.service";
import { ReportCurrencyService } from "./report-currency.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";

describe("AnomalyReportsService", () => {
  let service: AnomalyReportsService;
  let transactionsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let currencyService: Record<string, jest.Mock>;

  const mockUserId = "user-1";

  const mockCategory: Category = {
    id: "cat-food",
    userId: mockUserId,
    parentId: null,
    parent: null,
    children: [],
    name: "Food & Dining",
    description: null,
    icon: null,
    color: "#FF5733",
    isIncome: false,
    isSystem: false,
    createdAt: new Date("2025-01-01"),
  };

  interface MockExpenseRow {
    id: string;
    transaction_date: Date;
    payee_id: string | null;
    payee_name: string | null;
    currency_code: string;
    category_id: string | null;
    amount: string;
  }

  /**
   * Helper to generate a set of "normal" expense rows (small amounts)
   * plus one or more "anomalous" rows (large amounts).
   * All dates fall within the last 6 months so they pass the date filter.
   */
  function buildRawExpenses(
    normalCount: number,
    normalAmount: number,
    anomalies: {
      id: string;
      amount: number;
      payee_name?: string;
      category_id?: string | null;
      transaction_date?: Date;
    }[] = [],
  ): MockExpenseRow[] {
    const now = new Date();
    const rows: MockExpenseRow[] = [];
    for (let i = 0; i < normalCount; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i - 10);
      rows.push({
        id: `tx-normal-${i}`,
        transaction_date: d,
        payee_id: null,
        payee_name: `Payee ${i}`,
        currency_code: "USD",
        category_id: null,
        amount: normalAmount.toFixed(2),
      });
    }
    for (const a of anomalies) {
      rows.push({
        id: a.id,
        transaction_date: a.transaction_date ?? new Date(),
        payee_id: null,
        payee_name: a.payee_name ?? "Big Store",
        currency_code: "USD",
        category_id: a.category_id ?? null,
        amount: a.amount.toFixed(2),
      });
    }
    return rows;
  }

  beforeEach(async () => {
    transactionsRepository = {
      query: jest.fn().mockResolvedValue([]),
    };

    categoriesRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    currencyService = {
      getDefaultCurrency: jest.fn().mockResolvedValue("USD"),
      buildRateMap: jest.fn().mockResolvedValue(new Map()),
      convertAmount: jest.fn().mockImplementation((amount) => amount),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnomalyReportsService,
        {
          provide: ReportCurrencyService,
          useValue: currencyService,
        },
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        {
          provide: getRepositoryToken(Category),
          useValue: categoriesRepository,
        },
      ],
    }).compile();

    service = module.get<AnomalyReportsService>(AnomalyReportsService);
  });

  // ---------------------------------------------------------------------------
  // getSpendingAnomalies
  // ---------------------------------------------------------------------------
  describe("getSpendingAnomalies", () => {
    it("returns empty result when fewer than 10 transactions exist", async () => {
      transactionsRepository.query.mockResolvedValue(buildRawExpenses(5, 20));

      const result = await service.getSpendingAnomalies(mockUserId);

      expect(result.statistics.mean).toBe(0);
      expect(result.statistics.stdDev).toBe(0);
      expect(result.anomalies).toEqual([]);
      expect(result.counts).toEqual({ high: 0, medium: 0, low: 0 });
    });

    it("returns empty anomalies when exactly 10 uniform transactions exist", async () => {
      transactionsRepository.query.mockResolvedValue(buildRawExpenses(10, 50));
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingAnomalies(mockUserId);

      // All transactions are 50.00, so stdDev = 0 and z-score would be NaN/Infinity
      // No anomalies should be detected
      expect(result.anomalies).toEqual([]);
    });

    it("detects a large single transaction anomaly", async () => {
      // 20 normal transactions at $50, one anomaly at $500
      const raw = buildRawExpenses(20, 50, [
        { id: "tx-anomaly-1", amount: 500, payee_name: "Big Purchase" },
      ]);
      transactionsRepository.query.mockResolvedValue(raw);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingAnomalies(mockUserId);

      const largeAnomaly = result.anomalies.find(
        (a) => a.type === "large_transaction",
      );
      expect(largeAnomaly).toBeDefined();
      expect(largeAnomaly!.transactionId).toBe("tx-anomaly-1");
      expect(largeAnomaly!.amount).toBe(500);
      expect(largeAnomaly!.title).toBe("Unusually large transaction");
    });

    it("assigns correct severity levels based on z-score", async () => {
      // Mean ~50, stdDev will be small. Threshold default = 2.
      // We need amounts that produce z-scores at different severity levels.
      // With 20 * $50, mean=50, stdDev=0, so we need a spread.
      // Let's use amounts from 10 to 29 (normal range), then large outliers.
      const raw: MockExpenseRow[] = [];
      const now = new Date();
      for (let i = 0; i < 20; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i - 10);
        raw.push({
          id: `tx-${i}`,
          transaction_date: d,
          payee_id: null,
          payee_name: `Payee ${i}`,
          currency_code: "USD",
          category_id: null,
          amount: ((i + 1) * 5).toFixed(2), // 5, 10, 15, ..., 100
        });
      }
      // Add a very large outlier
      raw.push({
        id: "tx-huge",
        transaction_date: now,
        payee_id: null,
        payee_name: "Mega Store",
        currency_code: "USD",
        category_id: null,
        amount: "5000.00",
      });
      transactionsRepository.query.mockResolvedValue(raw);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingAnomalies(mockUserId);

      // At least one anomaly should be detected
      expect(result.anomalies.length).toBeGreaterThan(0);
      // The 5000 transaction should be high severity (z-score will be very large)
      const huge = result.anomalies.find((a) => a.transactionId === "tx-huge");
      expect(huge).toBeDefined();
      expect(huge!.severity).toBe("high");
    });

    it("calculates mean and stdDev correctly", async () => {
      // 10 transactions: all $100
      const raw = buildRawExpenses(10, 100);
      transactionsRepository.query.mockResolvedValue(raw);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingAnomalies(mockUserId);

      expect(result.statistics.mean).toBe(100);
      expect(result.statistics.stdDev).toBe(0);
    });

    it("uses custom threshold parameter", async () => {
      // With a very high threshold (e.g., 100), even outliers won't be anomalies
      const raw = buildRawExpenses(20, 50, [{ id: "tx-big", amount: 200 }]);
      transactionsRepository.query.mockResolvedValue(raw);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingAnomalies(mockUserId, 100);

      const largeTxAnomalies = result.anomalies.filter(
        (a) => a.type === "large_transaction",
      );
      expect(largeTxAnomalies).toHaveLength(0);
    });

    it("detects category spending spikes", async () => {
      const now = new Date();
      const currentMonthDate = new Date(now.getFullYear(), now.getMonth(), 5);
      const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 15);

      // Build enough transactions for the minimum 10 check
      const raw: MockExpenseRow[] = [];
      for (let i = 0; i < 15; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i - 10);
        raw.push({
          id: `tx-filler-${i}`,
          transaction_date: d,
          payee_id: null,
          payee_name: `Filler ${i}`,
          currency_code: "USD",
          category_id: null,
          amount: "20.00",
        });
      }

      // Previous month: category "cat-food" spent $100
      raw.push({
        id: "tx-prev-food",
        transaction_date: prevMonthDate,
        payee_id: null,
        payee_name: "Restaurant A",
        currency_code: "USD",
        category_id: "cat-food",
        amount: "100.00",
      });

      // Current month: category "cat-food" spent $350 (> 200% increase)
      raw.push({
        id: "tx-curr-food",
        transaction_date: currentMonthDate,
        payee_id: null,
        payee_name: "Restaurant B",
        currency_code: "USD",
        category_id: "cat-food",
        amount: "350.00",
      });

      transactionsRepository.query.mockResolvedValue(raw);
      categoriesRepository.find.mockResolvedValue([mockCategory]);

      const result = await service.getSpendingAnomalies(mockUserId);

      const spike = result.anomalies.find((a) => a.type === "category_spike");
      expect(spike).toBeDefined();
      expect(spike!.categoryName).toBe("Food & Dining");
      expect(spike!.percentChange).toBeGreaterThan(100);
    });

    it("skips category spike when previous month spending is below 50", async () => {
      const now = new Date();
      const currentMonthDate = new Date(now.getFullYear(), now.getMonth(), 5);
      const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 15);

      const raw = buildRawExpenses(15, 20);

      // Previous month: only $30 in cat-food (below $50 threshold)
      raw.push({
        id: "tx-prev-food",
        transaction_date: prevMonthDate,
        payee_id: null,
        payee_name: "Small cafe",
        currency_code: "USD",
        category_id: "cat-food",
        amount: "30.00",
      });

      // Current month: $200 in cat-food
      raw.push({
        id: "tx-curr-food",
        transaction_date: currentMonthDate,
        payee_id: null,
        payee_name: "Restaurant",
        currency_code: "USD",
        category_id: "cat-food",
        amount: "200.00",
      });

      transactionsRepository.query.mockResolvedValue(raw);
      categoriesRepository.find.mockResolvedValue([mockCategory]);

      const result = await service.getSpendingAnomalies(mockUserId);

      const spike = result.anomalies.find(
        (a) =>
          a.type === "category_spike" && a.categoryName === "Food & Dining",
      );
      expect(spike).toBeUndefined();
    });

    it("detects new payees with significant spending", async () => {
      const now = new Date();
      // A payee that first appeared within the last month
      const recentDate = new Date(now);
      recentDate.setDate(recentDate.getDate() - 5);

      const raw = buildRawExpenses(15, 20);

      // All transactions for "new shop" are recent
      raw.push({
        id: "tx-new-payee-1",
        transaction_date: recentDate,
        payee_id: null,
        payee_name: "New Shop",
        currency_code: "USD",
        category_id: null,
        amount: "150.00",
      });

      transactionsRepository.query.mockResolvedValue(raw);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingAnomalies(mockUserId);

      const newPayee = result.anomalies.find((a) => a.type === "unusual_payee");
      expect(newPayee).toBeDefined();
      expect(newPayee!.payeeName).toBe("New Shop");
      expect(newPayee!.amount).toBe(150);
    });

    it("skips new payees with spending under 100", async () => {
      const now = new Date();
      const recentDate = new Date(now);
      recentDate.setDate(recentDate.getDate() - 5);

      const raw = buildRawExpenses(15, 20);

      raw.push({
        id: "tx-small-new-payee",
        transaction_date: recentDate,
        payee_id: null,
        payee_name: "Tiny Shop",
        currency_code: "USD",
        category_id: null,
        amount: "50.00",
      });

      transactionsRepository.query.mockResolvedValue(raw);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingAnomalies(mockUserId);

      const newPayee = result.anomalies.find(
        (a) => a.type === "unusual_payee" && a.payeeName === "Tiny Shop",
      );
      expect(newPayee).toBeUndefined();
    });

    it("skips payees that have been around longer than one month", async () => {
      const now = new Date();
      const oldDate = new Date(now);
      oldDate.setMonth(oldDate.getMonth() - 3);
      const recentDate = new Date(now);
      recentDate.setDate(recentDate.getDate() - 5);

      const raw = buildRawExpenses(15, 20);

      // This payee first appeared 3 months ago, so not "new"
      raw.push({
        id: "tx-old-payee-1",
        transaction_date: oldDate,
        payee_id: null,
        payee_name: "Old Shop",
        currency_code: "USD",
        category_id: null,
        amount: "10.00",
      });
      raw.push({
        id: "tx-old-payee-2",
        transaction_date: recentDate,
        payee_id: null,
        payee_name: "Old Shop",
        currency_code: "USD",
        category_id: null,
        amount: "200.00",
      });

      transactionsRepository.query.mockResolvedValue(raw);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingAnomalies(mockUserId);

      const oldPayee = result.anomalies.find(
        (a) => a.type === "unusual_payee" && a.payeeName === "Old Shop",
      );
      expect(oldPayee).toBeUndefined();
    });

    it("sorts anomalies by severity then by amount descending", async () => {
      const now = new Date();
      const raw: MockExpenseRow[] = [];
      for (let i = 0; i < 20; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i - 10);
        raw.push({
          id: `tx-${i}`,
          transaction_date: d,
          payee_id: null,
          payee_name: `Normal ${i}`,
          currency_code: "USD",
          category_id: null,
          amount: ((i + 1) * 2).toFixed(2), // 2, 4, ..., 40
        });
      }

      // Two outliers: one very large (high severity), one moderate
      raw.push({
        id: "tx-mega",
        transaction_date: now,
        payee_id: null,
        payee_name: "Mega",
        currency_code: "USD",
        category_id: null,
        amount: "10000.00",
      });
      raw.push({
        id: "tx-large",
        transaction_date: now,
        payee_id: null,
        payee_name: "Large",
        currency_code: "USD",
        category_id: null,
        amount: "500.00",
      });

      transactionsRepository.query.mockResolvedValue(raw);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingAnomalies(mockUserId);

      // Higher severity should come first
      if (result.anomalies.length >= 2) {
        const severityOrder: Record<string, number> = {
          high: 0,
          medium: 1,
          low: 2,
        };
        for (let i = 0; i < result.anomalies.length - 1; i++) {
          const s1 = severityOrder[result.anomalies[i].severity];
          const s2 = severityOrder[result.anomalies[i + 1].severity];
          expect(s1).toBeLessThanOrEqual(s2);
          if (s1 === s2) {
            expect(result.anomalies[i].amount || 0).toBeGreaterThanOrEqual(
              result.anomalies[i + 1].amount || 0,
            );
          }
        }
      }
    });

    it("returns correct severity counts", async () => {
      const now = new Date();
      const raw: MockExpenseRow[] = [];
      for (let i = 0; i < 20; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i - 10);
        raw.push({
          id: `tx-${i}`,
          transaction_date: d,
          payee_id: null,
          payee_name: `Normal ${i}`,
          currency_code: "USD",
          category_id: null,
          amount: "10.00",
        });
      }
      // Very large anomaly
      raw.push({
        id: "tx-huge",
        transaction_date: now,
        payee_id: null,
        payee_name: "Huge",
        currency_code: "USD",
        category_id: null,
        amount: "50000.00",
      });

      transactionsRepository.query.mockResolvedValue(raw);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingAnomalies(mockUserId);

      const totalCounts =
        result.counts.high + result.counts.medium + result.counts.low;
      expect(totalCounts).toBe(result.anomalies.length);
    });

    it("converts foreign currency amounts via currency service", async () => {
      currencyService.convertAmount.mockImplementation(
        (amount: number, fromCurrency: string) => {
          if (fromCurrency === "EUR") return amount * 1.1;
          return amount;
        },
      );

      const now = new Date();
      const raw: MockExpenseRow[] = [];
      for (let i = 0; i < 15; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i - 10);
        raw.push({
          id: `tx-${i}`,
          transaction_date: d,
          payee_id: null,
          payee_name: `Payee ${i}`,
          currency_code: "EUR",
          category_id: null,
          amount: "50.00",
        });
      }

      transactionsRepository.query.mockResolvedValue(raw);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingAnomalies(mockUserId);

      // Mean should be 50 * 1.1 = 55
      expect(result.statistics.mean).toBe(55);
    });

    it("calls currency service with correct user id", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      await service.getSpendingAnomalies(mockUserId);

      expect(currencyService.getDefaultCurrency).toHaveBeenCalledWith(
        mockUserId,
      );
      expect(currencyService.buildRateMap).toHaveBeenCalledWith("USD");
    });

    it("passes correct date range to the query (6 months)", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      await service.getSpendingAnomalies(mockUserId);

      const queryCall = transactionsRepository.query.mock.calls[0];
      const [, startDate, endDate] = queryCall[1];
      const start = new Date(startDate);
      const end = new Date(endDate);
      // The range should span approximately 6 months
      const diffMonths =
        (end.getFullYear() - start.getFullYear()) * 12 +
        (end.getMonth() - start.getMonth());
      expect(diffMonths).toBeGreaterThanOrEqual(5);
      expect(diffMonths).toBeLessThanOrEqual(7);
    });

    it("ignores payees with empty or blank names", async () => {
      const now = new Date();
      const recentDate = new Date(now);
      recentDate.setDate(recentDate.getDate() - 5);

      const raw = buildRawExpenses(15, 20);

      raw.push({
        id: "tx-blank-payee",
        transaction_date: recentDate,
        payee_id: null,
        payee_name: "",
        currency_code: "USD",
        category_id: null,
        amount: "500.00",
      });

      raw.push({
        id: "tx-null-payee",
        transaction_date: recentDate,
        payee_id: null,
        payee_name: null,
        currency_code: "USD",
        category_id: null,
        amount: "600.00",
      });

      transactionsRepository.query.mockResolvedValue(raw);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingAnomalies(mockUserId);

      const unusualPayees = result.anomalies.filter(
        (a) => a.type === "unusual_payee",
      );
      expect(unusualPayees).toHaveLength(0);
    });

    it("assigns correct severity for new payee amounts", async () => {
      const now = new Date();
      const recentDate = new Date(now);
      recentDate.setDate(recentDate.getDate() - 3);

      const raw = buildRawExpenses(15, 20);

      // > 500 = high
      raw.push({
        id: "tx-np-high",
        transaction_date: recentDate,
        payee_id: null,
        payee_name: "Expensive New",
        currency_code: "USD",
        category_id: null,
        amount: "600.00",
      });

      // > 200 = medium
      raw.push({
        id: "tx-np-medium",
        transaction_date: recentDate,
        payee_id: null,
        payee_name: "Medium New",
        currency_code: "USD",
        category_id: null,
        amount: "300.00",
      });

      // > 100 = low
      raw.push({
        id: "tx-np-low",
        transaction_date: recentDate,
        payee_id: null,
        payee_name: "Small New",
        currency_code: "USD",
        category_id: null,
        amount: "150.00",
      });

      transactionsRepository.query.mockResolvedValue(raw);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingAnomalies(mockUserId);

      const highPayee = result.anomalies.find(
        (a) => a.type === "unusual_payee" && a.payeeName === "Expensive New",
      );
      const medPayee = result.anomalies.find(
        (a) => a.type === "unusual_payee" && a.payeeName === "Medium New",
      );
      const lowPayee = result.anomalies.find(
        (a) => a.type === "unusual_payee" && a.payeeName === "Small New",
      );

      expect(highPayee?.severity).toBe("high");
      expect(medPayee?.severity).toBe("medium");
      expect(lowPayee?.severity).toBe("low");
    });

    it("uses 'Unknown payee' in large_transaction description when payee_name is null", async () => {
      const now = new Date();
      const raw: MockExpenseRow[] = [];
      for (let i = 0; i < 20; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i - 10);
        raw.push({
          id: `tx-${i}`,
          transaction_date: d,
          payee_id: null,
          payee_name: `Payee ${i}`,
          currency_code: "USD",
          category_id: null,
          amount: "10.00",
        });
      }
      raw.push({
        id: "tx-no-payee",
        transaction_date: now,
        payee_id: null,
        payee_name: null,
        currency_code: "USD",
        category_id: null,
        amount: "50000.00",
      });

      transactionsRepository.query.mockResolvedValue(raw);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingAnomalies(mockUserId);

      const anomaly = result.anomalies.find(
        (a) => a.transactionId === "tx-no-payee",
      );
      expect(anomaly).toBeDefined();
      expect(anomaly!.description).toContain("Unknown payee");
      expect(anomaly!.payeeName).toBeUndefined();
    });

    it("assigns correct severity for category spike percentages", async () => {
      const now = new Date();
      const currentMonthDate = new Date(now.getFullYear(), now.getMonth(), 5);
      const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 15);

      const raw = buildRawExpenses(15, 20);

      // Previous month: $100
      raw.push({
        id: "tx-prev",
        transaction_date: prevMonthDate,
        payee_id: null,
        payee_name: "Food place",
        currency_code: "USD",
        category_id: "cat-food",
        amount: "100.00",
      });

      // Current month: $500 = 400% increase -> high severity (> 300%)
      raw.push({
        id: "tx-curr",
        transaction_date: currentMonthDate,
        payee_id: null,
        payee_name: "Expensive food",
        currency_code: "USD",
        category_id: "cat-food",
        amount: "500.00",
      });

      transactionsRepository.query.mockResolvedValue(raw);
      categoriesRepository.find.mockResolvedValue([mockCategory]);

      const result = await service.getSpendingAnomalies(mockUserId);

      const spike = result.anomalies.find((a) => a.type === "category_spike");
      expect(spike).toBeDefined();
      expect(spike!.severity).toBe("high");
      expect(spike!.percentChange).toBe(400);
    });
  });
});
