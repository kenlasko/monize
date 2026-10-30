import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { InsightsAggregatorService } from "./insights-aggregator.service";
import { Transaction } from "../../transactions/entities/transaction.entity";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

describe("InsightsAggregatorService", () => {
  let service: InsightsAggregatorService;
  let mockTransactionRepo: Record<string, jest.Mock>;
  let mockTransactionAnalytics: Record<string, jest.Mock>;
  let managerQuery: jest.Mock;

  const userId = "user-1";

  const mockQueryBuilder = () => {
    const qb: Record<string, jest.Mock> = {
      innerJoin: jest.fn().mockReturnThis(),
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
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    return qb;
  };

  beforeEach(async () => {
    const qb = mockQueryBuilder();

    mockTransactionRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };

    mockTransactionAnalytics = {
      getRecurringCharges: jest.fn().mockResolvedValue([]),
    };

    const scoped = createScopedDbMocks([[Transaction, mockTransactionRepo]]);
    managerQuery = scoped.manager.query;
    // The user's timezone preference row; none means UTC.
    managerQuery.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InsightsAggregatorService,
        {
          provide: DataSource,
          useValue: scoped.dataSource,
        },
        {
          provide: TransactionAnalyticsService,
          useValue: mockTransactionAnalytics,
        },
      ],
    }).compile();

    service = module.get<InsightsAggregatorService>(InsightsAggregatorService);
  });

  describe("computeAggregates()", () => {
    it("returns empty aggregates when no transactions exist", async () => {
      const result = await service.computeAggregates(userId, "USD");

      expect(result.categorySpending).toEqual([]);
      expect(result.monthlySpending).toEqual([]);
      expect(result.recurringCharges).toEqual([]);
      expect(result.totalSpendingCurrentMonth).toBe(0);
      expect(result.totalSpendingPreviousMonth).toBe(0);
      expect(result.averageMonthlySpending).toBe(0);
      expect(result.currency).toBe("USD");
      expect(result.daysInMonth).toBeGreaterThan(0);
      expect(result.daysElapsedInMonth).toBeGreaterThan(0);
    });

    const row = (
      overrides: Partial<Record<string, string>> & { month: string },
    ) => ({
      categoryId: "cat-1",
      categoryName: "Dining",
      currencyCode: "USD",
      net: "100",
      txnCount: "2",
      ...overrides,
    });

    const withRows = (rows: unknown[]) => {
      const qb = mockQueryBuilder();
      qb.getRawMany.mockResolvedValue(rows);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);
      return qb;
    };

    it("derives category spending from the monthly rows", async () => {
      const now = new Date();
      const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const prevKey = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
      withRows([
        row({ month: prevKey, net: "100", txnCount: "4" }),
        row({ month: cur, net: "140", txnCount: "6" }),
        row({
          month: cur,
          categoryId: "cat-2",
          categoryName: "Groceries",
          net: "400",
        }),
      ]);

      const result = await service.computeAggregates(userId, "USD");

      expect(result.categorySpending.map((c) => c.categoryName)).toEqual([
        "Groceries",
        "Dining",
      ]);
      const dining = result.categorySpending[1];
      expect(dining.currentMonthTotal).toBe(140);
      expect(dining.previousMonthTotal).toBe(100);
      expect(dining.monthCount).toBe(2);
      expect(dining.averageMonthlyTotal).toBe(120); // 240 / 2
      expect(dining.transactionCount).toBe(10);
    });

    it("nets refunds within a category and drops a category that nets to a credit", async () => {
      withRows([
        row({ month: "2026-01", net: "500" }),
        row({ month: "2026-02", net: "-100" }), // refund month
        // Income category: negated credits are negative, so it is not spending.
        row({
          month: "2026-01",
          categoryId: "cat-inc",
          categoryName: "Salary",
          net: "-4000",
        }),
      ]);

      const result = await service.computeAggregates(userId, "USD");

      expect(result.categorySpending).toHaveLength(1);
      expect(result.categorySpending[0].averageMonthlyTotal).toBe(200); // 400 / 2
      const [jan, feb] = result.monthlySpending;
      expect(jan.total).toBe(500);
      expect(feb.total).toBe(-100);
      expect(
        result.monthlySpending.flatMap((m) => m.categoryBreakdown),
      ).not.toContainEqual(expect.objectContaining({ categoryName: "Salary" }));
    });

    it("reads the split line's category and amount, not only the parent's", async () => {
      const qb = withRows([]);

      await service.computeAggregates(userId, "USD");

      expect(qb.leftJoin).toHaveBeenCalledWith("t.splits", "ts");
      expect(qb.addSelect).toHaveBeenCalledWith(
        "SUM(-COALESCE(ts.amount, t.amount))",
        "net",
      );
      expect(qb.innerJoin).toHaveBeenCalledWith(
        expect.anything(),
        "cat",
        expect.stringContaining("COALESCE(ts.categoryId, t.categoryId)"),
      );
    });

    it("converts each currency into the reporting currency and names a missing pair", async () => {
      withRows([
        row({ month: "2026-01", net: "100" }),
        row({ month: "2026-01", net: "50", currencyCode: "EUR" }),
        row({ month: "2026-01", net: "70", currencyCode: "GBP" }),
      ]);
      managerQuery.mockImplementation(async (sql: string) =>
        /exchange_rates/.test(sql)
          ? [
              {
                from_currency: "EUR",
                to_currency: "USD",
                rate: "2",
                rate_date: "2026-01-20",
              },
            ]
          : [],
      );

      const result = await service.computeAggregates(userId, "USD");

      // 100 USD + 50 EUR * 2; the GBP row has no rate and is left out, not
      // added as 70 USD.
      expect(result.monthlySpending[0].total).toBe(200);
      expect(result.fxComplete).toBe(false);
      expect(result.missingRatePairs).toEqual(["GBP->USD"]);
    });

    it("includes recurring charges from the shared analytics service", async () => {
      // Recurring-charge detection lives on TransactionAnalyticsService; the
      // aggregator just surfaces whatever the shared method returns.
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
      );
      expect(result.recurringCharges).toEqual(charges);
    });

    it("computes average monthly spending from completed months only", async () => {
      const now = new Date();
      const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      withRows([
        row({ month: "2025-10", net: "1000" }),
        row({ month: "2025-11", net: "1200" }),
        row({ month: "2025-12", net: "800" }),
        row({ month: currentMonthKey, net: "500" }),
      ]);

      const result = await service.computeAggregates(userId, "USD");

      // Average should exclude current month: (1000+1200+800)/3 = 1000
      expect(result.averageMonthlySpending).toBe(1000);
      expect(result.totalSpendingCurrentMonth).toBe(500);
    });

    it("joins the category with an inner join", async () => {
      const qb = mockQueryBuilder();
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      await service.computeAggregates(userId, "USD");

      expect(qb.innerJoin).toHaveBeenCalled();
    });
  });

  describe("the user's own calendar (A26-L29)", () => {
    const ALL_BUT_DATE = [
      "nextTick",
      "queueMicrotask",
      "setImmediate",
      "clearImmediate",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
      "hrtime",
    ] as const;
    afterEach(() => jest.useRealTimers());

    it("takes the month from the user's day when UTC is still the day before", async () => {
      jest.useFakeTimers({
        now: new Date("2026-10-21T00:30:00+02:00"),
        doNotFake: [...ALL_BUT_DATE],
      });
      managerQuery.mockResolvedValue([
        { timezone: "Europe/Warsaw", last_client_timezone: null },
      ]);
      const qb = mockQueryBuilder();
      qb.getRawMany.mockResolvedValue([
        {
          month: "2026-10",
          categoryId: "c",
          categoryName: "Dining",
          currencyCode: "PLN",
          net: "40",
          txnCount: "1",
        },
        {
          month: "2026-09",
          categoryId: "c",
          categoryName: "Dining",
          currencyCode: "PLN",
          net: "10",
          txnCount: "1",
        },
      ]);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.computeAggregates(userId, "PLN");

      expect(result.categorySpending[0]).toMatchObject({
        currentMonthTotal: 40,
        previousMonthTotal: 10,
      });
      expect(qb.andWhere).toHaveBeenCalledWith(
        "t.transactionDate >= :startDate",
        { startDate: "2026-04-01" },
      );
      expect(mockTransactionAnalytics.getRecurringCharges).toHaveBeenCalledWith(
        userId,
        "2026-04-01",
        "2026-10-21",
      );
      expect(result.daysElapsedInMonth).toBe(21);
      expect(result.daysInMonth).toBe(31);
    });

    it("enters the new month when the user's zone is already there", async () => {
      jest.useFakeTimers({
        now: new Date("2026-10-31T23:30:00Z"),
        doNotFake: [...ALL_BUT_DATE],
      });
      managerQuery.mockResolvedValue([
        { timezone: "Asia/Tokyo", last_client_timezone: null },
      ]);
      const qb = mockQueryBuilder();
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);
      qb.getRawMany.mockResolvedValue([
        {
          month: "2026-11",
          categoryId: "c",
          categoryName: "Dining",
          currencyCode: "JPY",
          net: "40",
          txnCount: "1",
        },
        {
          month: "2026-10",
          categoryId: "c",
          categoryName: "Dining",
          currencyCode: "JPY",
          net: "10",
          txnCount: "1",
        },
      ]);

      const result = await service.computeAggregates(userId, "JPY");

      expect(result.categorySpending[0]).toMatchObject({
        currentMonthTotal: 40,
        previousMonthTotal: 10,
      });
      expect(mockTransactionAnalytics.getRecurringCharges).toHaveBeenCalledWith(
        userId,
        "2026-05-01",
        "2026-11-01",
      );
      expect(result.daysElapsedInMonth).toBe(1);
      expect(result.daysInMonth).toBe(30);
    });

    it("steps back over a year boundary and into February", async () => {
      jest.useFakeTimers({
        now: new Date("2028-03-15T12:00:00Z"),
        doNotFake: [...ALL_BUT_DATE],
      });
      const qb = mockQueryBuilder();
      qb.getRawMany.mockResolvedValue([
        {
          month: "2028-02",
          categoryId: "c",
          categoryName: "Dining",
          currencyCode: "USD",
          net: "10",
          txnCount: "1",
        },
      ]);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.computeAggregates(userId, "USD");

      expect(result.categorySpending[0]).toMatchObject({
        currentMonthTotal: 0,
        previousMonthTotal: 10,
      });
      expect(mockTransactionAnalytics.getRecurringCharges).toHaveBeenCalledWith(
        userId,
        "2027-09-01",
        "2028-03-15",
      );
      expect(result.daysInMonth).toBe(31);
    });
  });
});
