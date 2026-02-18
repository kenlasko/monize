import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { InsightsAggregatorService } from "./insights-aggregator.service";
import { Transaction } from "../../transactions/entities/transaction.entity";
import { ScheduledTransaction } from "../../scheduled-transactions/entities/scheduled-transaction.entity";

describe("InsightsAggregatorService", () => {
  let service: InsightsAggregatorService;
  let mockTransactionRepo: Record<string, jest.Mock>;
  let mockScheduledTransactionRepo: Record<string, jest.Mock>;

  const userId = "user-1";

  const mockQueryBuilder = () => {
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
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    return qb;
  };

  beforeEach(async () => {
    const qb = mockQueryBuilder();

    mockTransactionRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };

    mockScheduledTransactionRepo = {
      find: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InsightsAggregatorService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: mockTransactionRepo,
        },
        {
          provide: getRepositoryToken(ScheduledTransaction),
          useValue: mockScheduledTransactionRepo,
        },
      ],
    }).compile();

    service = module.get<InsightsAggregatorService>(
      InsightsAggregatorService,
    );
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

    it("computes category spending from raw data", async () => {
      const qb = mockQueryBuilder();
      let callCount = 0;

      qb.getRawMany.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // Category spending query
          return Promise.resolve([
            {
              categoryName: "Dining",
              categoryId: "cat-1",
              total: "600",
              txnCount: "12",
              currentMonthTotal: "120",
              previousMonthTotal: "100",
              monthCount: "6",
            },
            {
              categoryName: "Groceries",
              categoryId: "cat-2",
              total: "1200",
              txnCount: "24",
              currentMonthTotal: "200",
              previousMonthTotal: "190",
              monthCount: "6",
            },
          ]);
        }
        return Promise.resolve([]);
      });

      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.computeAggregates(userId, "USD");

      expect(result.categorySpending).toHaveLength(2);
      expect(result.categorySpending[0].categoryName).toBe("Dining");
      expect(result.categorySpending[0].currentMonthTotal).toBe(120);
      expect(result.categorySpending[0].previousMonthTotal).toBe(100);
      expect(result.categorySpending[0].averageMonthlyTotal).toBe(100); // 600/6
      expect(result.categorySpending[0].monthCount).toBe(6);
    });

    it("computes monthly spending with category breakdown", async () => {
      const qb = mockQueryBuilder();
      let callCount = 0;

      qb.getRawMany.mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          // Monthly spending query (second call)
          return Promise.resolve([
            { month: "2026-01", categoryName: "Dining", total: "100" },
            { month: "2026-01", categoryName: "Groceries", total: "200" },
            { month: "2026-02", categoryName: "Dining", total: "150" },
          ]);
        }
        return Promise.resolve([]);
      });

      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.computeAggregates(userId, "CAD");

      expect(result.monthlySpending).toHaveLength(2);
      expect(result.monthlySpending[0].month).toBe("2026-01");
      expect(result.monthlySpending[0].total).toBe(300);
      expect(result.monthlySpending[0].categoryBreakdown).toHaveLength(2);
      expect(result.monthlySpending[1].month).toBe("2026-02");
      expect(result.monthlySpending[1].total).toBe(150);
    });

    it("detects recurring charges with consistent timing", async () => {
      const qb = mockQueryBuilder();
      let callCount = 0;

      qb.getRawMany.mockImplementation(() => {
        callCount++;
        if (callCount === 3) {
          // Recurring charges query (third call)
          return Promise.resolve([
            {
              payeeName: "Netflix",
              categoryName: "Entertainment",
              amounts: [15.99, 15.99, 15.99, 17.99],
              dates: [
                "2025-09-01",
                "2025-10-01",
                "2025-11-01",
                "2025-12-01",
              ],
              txnCount: "4",
            },
          ]);
        }
        return Promise.resolve([]);
      });

      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.computeAggregates(userId, "USD");

      expect(result.recurringCharges).toHaveLength(1);
      expect(result.recurringCharges[0].payeeName).toBe("Netflix");
      expect(result.recurringCharges[0].frequency).toBe("monthly");
      expect(result.recurringCharges[0].currentAmount).toBe(17.99);
      expect(result.recurringCharges[0].previousAmount).toBe(15.99);
    });

    it("filters out irregular charges", async () => {
      const qb = mockQueryBuilder();
      let callCount = 0;

      qb.getRawMany.mockImplementation(() => {
        callCount++;
        if (callCount === 3) {
          return Promise.resolve([
            {
              payeeName: "Random Store",
              categoryName: "Shopping",
              amounts: [50, 20, 150],
              dates: ["2025-08-10", "2025-09-25", "2025-12-01"],
              txnCount: "3",
            },
          ]);
        }
        return Promise.resolve([]);
      });

      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.computeAggregates(userId, "USD");

      expect(result.recurringCharges).toHaveLength(0);
    });
  });
});
