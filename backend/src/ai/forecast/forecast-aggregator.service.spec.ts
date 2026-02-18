import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ForecastAggregatorService } from "./forecast-aggregator.service";
import { Transaction } from "../../transactions/entities/transaction.entity";
import { ScheduledTransaction } from "../../scheduled-transactions/entities/scheduled-transaction.entity";
import { AccountsService } from "../../accounts/accounts.service";

describe("ForecastAggregatorService", () => {
  let service: ForecastAggregatorService;
  let mockTransactionRepo: Record<string, jest.Mock>;
  let mockScheduledTransactionRepo: Record<string, jest.Mock>;
  let mockAccountsService: Record<string, jest.Mock>;

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ForecastAggregatorService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: mockTransactionRepo,
        },
        {
          provide: getRepositoryToken(ScheduledTransaction),
          useValue: mockScheduledTransactionRepo,
        },
        {
          provide: AccountsService,
          useValue: mockAccountsService,
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
          name: "Rent",
          amount: -1500,
          frequency: "MONTHLY",
          nextDueDate: new Date("2026-03-01"),
          category: { name: "Housing", isIncome: false },
          isTransfer: false,
        },
        {
          name: "Salary",
          amount: 5000,
          frequency: "BIWEEKLY",
          nextDueDate: new Date("2026-02-28"),
          category: { name: "Income", isIncome: true },
          isTransfer: false,
        },
      ]);

      const result = await service.computeAggregates(userId, "USD");

      expect(result.scheduledTransactions).toHaveLength(2);
      expect(result.scheduledTransactions[0].name).toBe("Rent");
      expect(result.scheduledTransactions[0].amount).toBe(1500);
      expect(result.scheduledTransactions[0].isIncome).toBe(false);
      expect(result.scheduledTransactions[1].name).toBe("Salary");
      expect(result.scheduledTransactions[1].isIncome).toBe(true);
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

    it("detects recurring charges from 12-month history", async () => {
      const recurringData = [
        {
          payeeName: "Netflix",
          categoryName: "Entertainment",
          amounts: [15.99, 15.99, 15.99, 17.99],
          dates: ["2025-09-01", "2025-10-01", "2025-11-01", "2025-12-01"],
          txnCount: "4",
        },
      ];

      mockTransactionRepo.createQueryBuilder.mockImplementation(() =>
        mockQueryBuilder(recurringData),
      );

      const result = await service.computeAggregates(userId, "USD");

      expect(result.recurringCharges).toHaveLength(1);
      expect(result.recurringCharges[0].payeeName).toBe("Netflix");
      expect(result.recurringCharges[0].frequency).toBe("monthly");
      expect(result.recurringCharges[0].currentAmount).toBe(17.99);
    });

    it("filters out irregular charges", async () => {
      const irregularData = [
        {
          payeeName: "Random Store",
          categoryName: "Shopping",
          amounts: [50, 20, 150],
          dates: ["2025-08-10", "2025-09-25", "2025-12-01"],
          txnCount: "3",
        },
      ];

      mockTransactionRepo.createQueryBuilder.mockImplementation(() =>
        mockQueryBuilder(irregularData),
      );

      const result = await service.computeAggregates(userId, "USD");

      expect(result.recurringCharges).toHaveLength(0);
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
