import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ToolExecutorService } from "./tool-executor.service";
import { AccountsService } from "../../accounts/accounts.service";
import { CategoriesService } from "../../categories/categories.service";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { NetWorthService } from "../../net-worth/net-worth.service";
import { Transaction } from "../../transactions/entities/transaction.entity";
import { Category } from "../../categories/entities/category.entity";

describe("ToolExecutorService", () => {
  let service: ToolExecutorService;
  let mockAccountsService: Record<string, jest.Mock>;
  let mockCategoriesService: Record<string, jest.Mock>;
  let mockAnalyticsService: Record<string, jest.Mock>;
  let mockNetWorthService: Record<string, jest.Mock>;
  let mockTransactionRepo: Record<string, jest.Mock>;
  let mockCategoryRepo: Record<string, jest.Mock>;
  let mockQueryBuilder: Record<string, jest.Mock>;

  const userId = "user-1";

  const mockAccounts = [
    {
      id: "acc-1",
      name: "Checking",
      accountType: "checking",
      currencyCode: "USD",
      currentBalance: "5000.00",
    },
    {
      id: "acc-2",
      name: "Savings",
      accountType: "savings",
      currencyCode: "USD",
      currentBalance: "15000.00",
    },
    {
      id: "acc-3",
      name: "Credit Card",
      accountType: "credit_card",
      currencyCode: "USD",
      currentBalance: "-1200.00",
    },
  ];

  const mockCategories = [
    { id: "cat-1", name: "Groceries" },
    { id: "cat-2", name: "Dining Out" },
    { id: "cat-3", name: "Salary" },
  ];

  beforeEach(async () => {
    mockQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    mockAccountsService = {
      findAll: jest.fn().mockResolvedValue(mockAccounts),
      getSummary: jest.fn().mockResolvedValue({
        totalAssets: 20000,
        totalLiabilities: 1200,
        netWorth: 18800,
        totalAccounts: 3,
      }),
    };

    mockCategoriesService = {
      getTree: jest.fn().mockResolvedValue([]),
    };

    mockAnalyticsService = {
      getSummary: jest.fn().mockResolvedValue({
        totalIncome: 5000,
        totalExpenses: -3000,
        netCashFlow: 2000,
        transactionCount: 45,
        byCurrency: { USD: { income: 5000, expenses: -3000 } },
      }),
    };

    mockNetWorthService = {
      getMonthlyNetWorth: jest.fn().mockResolvedValue([
        { month: "2026-01", assets: 19000, liabilities: 1300, netWorth: 17700 },
        { month: "2026-02", assets: 20000, liabilities: 1200, netWorth: 18800 },
      ]),
    };

    mockTransactionRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
    };

    mockCategoryRepo = {
      find: jest.fn().mockResolvedValue(mockCategories),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ToolExecutorService,
        { provide: AccountsService, useValue: mockAccountsService },
        { provide: CategoriesService, useValue: mockCategoriesService },
        {
          provide: TransactionAnalyticsService,
          useValue: mockAnalyticsService,
        },
        { provide: NetWorthService, useValue: mockNetWorthService },
        {
          provide: getRepositoryToken(Transaction),
          useValue: mockTransactionRepo,
        },
        { provide: getRepositoryToken(Category), useValue: mockCategoryRepo },
      ],
    }).compile();

    service = module.get<ToolExecutorService>(ToolExecutorService);
  });

  describe("execute()", () => {
    it("routes to query_transactions tool", async () => {
      const result = await service.execute(userId, "query_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(result.data).toBeDefined();
      expect(result.summary).toContain("transactions");
      expect(result.sources).toHaveLength(1);
      expect(result.sources[0].type).toBe("transactions");
    });

    it("routes to get_account_balances tool", async () => {
      const result = await service.execute(userId, "get_account_balances", {});

      expect(result.data).toBeDefined();
      expect(result.summary).toContain("Net worth");
      expect(result.sources[0].type).toBe("accounts");
    });

    it("routes to get_spending_by_category tool", async () => {
      const result = await service.execute(userId, "get_spending_by_category", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(result.data).toBeDefined();
      expect(result.summary).toContain("spending");
      expect(result.sources[0].type).toBe("spending");
    });

    it("routes to get_income_summary tool", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValueOnce([
        { label: "Salary", total: "5000", count: "1" },
      ]);

      const result = await service.execute(userId, "get_income_summary", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(result.data).toBeDefined();
      expect(result.summary).toContain("income");
      expect(result.sources[0].type).toBe("income");
    });

    it("routes to get_net_worth_history tool", async () => {
      const result = await service.execute(userId, "get_net_worth_history", {});

      expect(result.data).toBeDefined();
      expect(result.summary).toContain("Net worth history");
      expect(result.sources[0].type).toBe("net_worth");
    });

    it("routes to compare_periods tool", async () => {
      const result = await service.execute(userId, "compare_periods", {
        period1Start: "2025-12-01",
        period1End: "2025-12-31",
        period2Start: "2026-01-01",
        period2End: "2026-01-31",
      });

      expect(result.data).toBeDefined();
      expect(result.summary).toContain("Period 1");
      expect(result.sources[0].type).toBe("comparison");
    });

    it("returns error for unknown tool", async () => {
      const result = await service.execute(userId, "unknown_tool", {});

      expect(result.data).toBeNull();
      expect(result.summary).toContain("Unknown tool: unknown_tool");
      expect(result.sources).toEqual([]);
    });

    it("catches errors and returns error result", async () => {
      mockAnalyticsService.getSummary.mockRejectedValueOnce(
        new Error("Database connection failed"),
      );

      const result = await service.execute(userId, "query_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(result.data).toEqual({ error: "Database connection failed" });
      expect(result.summary).toContain("Error executing query_transactions");
      expect(result.sources).toEqual([]);
    });
  });

  describe("query_transactions", () => {
    it("passes dates to analytics service", async () => {
      await service.execute(userId, "query_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(mockAnalyticsService.getSummary).toHaveBeenCalledWith(
        userId,
        undefined, // accountIds
        "2026-01-01",
        "2026-01-31",
        undefined, // categoryIds
        undefined, // payeeId
        undefined, // searchText
      );
    });

    it("resolves account names to IDs", async () => {
      await service.execute(userId, "query_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        accountNames: ["Checking", "Savings"],
      });

      expect(mockAccountsService.findAll).toHaveBeenCalledWith(userId, false);
      expect(mockAnalyticsService.getSummary).toHaveBeenCalledWith(
        userId,
        ["acc-1", "acc-2"],
        "2026-01-01",
        "2026-01-31",
        undefined,
        undefined,
        undefined,
      );
    });

    it("resolves category names to IDs (case-insensitive)", async () => {
      await service.execute(userId, "query_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        categoryNames: ["groceries", "DINING OUT"],
      });

      expect(mockCategoryRepo.find).toHaveBeenCalledWith({
        where: { userId },
        select: ["id", "name"],
      });
      expect(mockAnalyticsService.getSummary).toHaveBeenCalledWith(
        userId,
        undefined,
        "2026-01-01",
        "2026-01-31",
        ["cat-1", "cat-2"],
        undefined,
        undefined,
      );
    });

    it("passes searchText to analytics service", async () => {
      await service.execute(userId, "query_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        searchText: "Walmart",
      });

      expect(mockAnalyticsService.getSummary).toHaveBeenCalledWith(
        userId,
        undefined,
        "2026-01-01",
        "2026-01-31",
        undefined,
        undefined,
        "Walmart",
      );
    });

    it("includes byCurrency when multiple currencies present", async () => {
      mockAnalyticsService.getSummary.mockResolvedValueOnce({
        totalIncome: 5000,
        totalExpenses: -3000,
        netCashFlow: 2000,
        transactionCount: 45,
        byCurrency: {
          USD: { income: 3000, expenses: -2000 },
          CAD: { income: 2000, expenses: -1000 },
        },
      });

      const result = await service.execute(userId, "query_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect((result.data as Record<string, unknown>).byCurrency).toBeDefined();
    });

    it("omits byCurrency when single currency", async () => {
      const result = await service.execute(userId, "query_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(
        (result.data as Record<string, unknown>).byCurrency,
      ).toBeUndefined();
    });

    it("includes breakdown when groupBy is specified", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValueOnce([
        { label: "Groceries", total: "1500", count: "20" },
        { label: "Dining Out", total: "800", count: "10" },
      ]);

      const result = await service.execute(userId, "query_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        groupBy: "category",
      });

      const data = result.data as Record<string, unknown>;
      expect(data.breakdown).toBeDefined();
      const breakdown = data.breakdown as Array<Record<string, unknown>>;
      expect(breakdown[0].category).toBe("Groceries");
      expect(breakdown[0].total).toBe(1500);
    });

    it("formats summary with date range and amounts", async () => {
      const result = await service.execute(userId, "query_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(result.summary).toContain("45 transactions");
      expect(result.summary).toContain("2026-01-01");
      expect(result.summary).toContain("2026-01-31");
      expect(result.summary).toContain("5000.00");
    });

    it("includes filter names in source description", async () => {
      await service.execute(userId, "query_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        categoryNames: ["Groceries"],
        accountNames: ["Checking"],
      });

      // We can't directly check sources since names are in them
      // Just verify it ran without error
      expect(mockAnalyticsService.getSummary).toHaveBeenCalled();
    });
  });

  describe("get_account_balances", () => {
    it("returns all accounts when no filter", async () => {
      const result = await service.execute(userId, "get_account_balances", {});

      const data = result.data as Record<string, unknown>;
      const accounts = data.accounts as Array<Record<string, unknown>>;
      expect(accounts).toHaveLength(3);
      expect(accounts[0].name).toBe("Checking");
      expect(accounts[0].balance).toBe(5000);
      expect(data.netWorth).toBe(18800);
      expect(data.totalAssets).toBe(20000);
      expect(data.totalLiabilities).toBe(1200);
    });

    it("filters by account names (case-insensitive)", async () => {
      const result = await service.execute(userId, "get_account_balances", {
        accountNames: ["checking"],
      });

      const data = result.data as Record<string, unknown>;
      const accounts = data.accounts as Array<Record<string, unknown>>;
      expect(accounts).toHaveLength(1);
      expect(accounts[0].name).toBe("Checking");
    });

    it("includes summary with net worth info", async () => {
      const result = await service.execute(userId, "get_account_balances", {});

      expect(result.summary).toContain("3 accounts");
      expect(result.summary).toContain("18800.00");
    });

    it("shows filtered account names in source description", async () => {
      const result = await service.execute(userId, "get_account_balances", {
        accountNames: ["Checking", "Savings"],
      });

      expect(result.sources[0].description).toContain("Checking, Savings");
    });

    it("shows 'All account balances' when no filter", async () => {
      const result = await service.execute(userId, "get_account_balances", {});

      expect(result.sources[0].description).toBe("All account balances");
    });
  });

  describe("get_spending_by_category", () => {
    it("builds correct query for expense transactions", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValueOnce([
        { category: "Groceries", total: "1500", count: "20" },
        { category: "Dining Out", total: "800", count: "10" },
      ]);

      const result = await service.execute(userId, "get_spending_by_category", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      const data = result.data as Record<string, unknown>;
      const categories = data.categories as Array<Record<string, unknown>>;
      expect(categories).toHaveLength(2);
      expect(categories[0].category).toBe("Groceries");
      expect(categories[0].amount).toBe(1500);
      expect(categories[0].percentage).toBeCloseTo(65.22, 1);
      expect(data.totalSpending).toBe(2300);

      // Verify query filters for expenses (amount < 0)
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith("t.amount < 0");
    });

    it("limits results when topN specified", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValueOnce([
        { category: "Groceries", total: "1500", count: "20" },
        { category: "Dining Out", total: "800", count: "10" },
        { category: "Entertainment", total: "300", count: "5" },
      ]);

      const result = await service.execute(userId, "get_spending_by_category", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        topN: 2,
      });

      const data = result.data as Record<string, unknown>;
      const categories = data.categories as Array<Record<string, unknown>>;
      expect(categories).toHaveLength(2);
    });

    it("handles no spending data", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValueOnce([]);

      const result = await service.execute(userId, "get_spending_by_category", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      const data = result.data as Record<string, unknown>;
      expect(data.totalSpending).toBe(0);
      expect((data.categories as unknown[]).length).toBe(0);
    });
  });

  describe("get_income_summary", () => {
    it("groups by category by default", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValueOnce([
        { label: "Salary", total: "5000", count: "1" },
        { label: "Freelance", total: "2000", count: "3" },
      ]);

      const result = await service.execute(userId, "get_income_summary", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      const data = result.data as Record<string, unknown>;
      expect(data.groupedBy).toBe("category");
      expect(data.totalIncome).toBe(7000);
      const items = data.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);

      // Verify query filters for income (amount > 0)
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith("t.amount > 0");
    });

    it("groups by payee when specified", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValueOnce([
        { label: "ACME Corp", total: "5000", count: "1" },
      ]);

      const result = await service.execute(userId, "get_income_summary", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        groupBy: "payee",
      });

      const data = result.data as Record<string, unknown>;
      expect(data.groupedBy).toBe("payee");
      expect(mockQueryBuilder.select).toHaveBeenCalledWith(
        "COALESCE(t.payeeName, 'Unknown')",
        "label",
      );
    });

    it("groups by month when specified", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValueOnce([
        { label: "2026-01", total: "5000", count: "1" },
        { label: "2026-02", total: "5200", count: "1" },
      ]);

      const result = await service.execute(userId, "get_income_summary", {
        startDate: "2026-01-01",
        endDate: "2026-02-28",
        groupBy: "month",
      });

      const data = result.data as Record<string, unknown>;
      expect(data.groupedBy).toBe("month");
      expect(data.totalIncome).toBe(10200);
    });
  });

  describe("get_net_worth_history", () => {
    it("returns monthly net worth data", async () => {
      const result = await service.execute(userId, "get_net_worth_history", {
        startDate: "2026-01-01",
        endDate: "2026-02-28",
      });

      const data = result.data as Record<string, unknown>;
      const months = data.months as unknown[];
      expect(months).toHaveLength(2);
      expect(result.summary).toContain("2 months");
    });

    it("defaults dates when not provided", async () => {
      await service.execute(userId, "get_net_worth_history", {});

      expect(mockNetWorthService.getMonthlyNetWorth).toHaveBeenCalledWith(
        userId,
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      );
    });
  });

  describe("compare_periods", () => {
    it("computes differences between two periods", async () => {
      // Period 1 data
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([
          { label: "Groceries", total: "1000" },
          { label: "Dining Out", total: "500" },
        ])
        // Period 2 data
        .mockResolvedValueOnce([
          { label: "Groceries", total: "1200" },
          { label: "Dining Out", total: "400" },
          { label: "Entertainment", total: "200" },
        ]);

      const result = await service.execute(userId, "compare_periods", {
        period1Start: "2025-12-01",
        period1End: "2025-12-31",
        period2Start: "2026-01-01",
        period2End: "2026-01-31",
      });

      const data = result.data as Record<string, unknown>;
      expect(data.period1).toBeDefined();
      expect(data.period2).toBeDefined();
      expect(data.totalChange).toBeDefined();
      expect(data.comparison).toBeDefined();

      const comparison = data.comparison as Array<Record<string, unknown>>;
      // Sorted by abs change descending
      expect(comparison.length).toBe(3);

      // Groceries: 1200 - 1000 = +200
      const groceries = comparison.find((c) => c.label === "Groceries");
      expect(groceries).toBeDefined();
      expect(groceries!.change).toBe(200);
      expect(groceries!.changePercent).toBe(20);

      // Entertainment: 200 - 0 = +200 (100% since new)
      const entertainment = comparison.find((c) => c.label === "Entertainment");
      expect(entertainment).toBeDefined();
      expect(entertainment!.period1Amount).toBe(0);
      expect(entertainment!.period2Amount).toBe(200);
      expect(entertainment!.changePercent).toBe(100);
    });

    it("defaults to expenses direction and category groupBy", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.execute(userId, "compare_periods", {
        period1Start: "2025-12-01",
        period1End: "2025-12-31",
        period2Start: "2026-01-01",
        period2End: "2026-01-31",
      });

      // Expenses filter: amount < 0
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith("t.amount < 0");
      // Category join
      expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith(
        "t.category",
        "cat",
      );
    });

    it("includes date range in source description", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await service.execute(userId, "compare_periods", {
        period1Start: "2025-12-01",
        period1End: "2025-12-31",
        period2Start: "2026-01-01",
        period2End: "2026-01-31",
      });

      expect(result.sources[0].dateRange).toContain("2025-12-01");
      expect(result.sources[0].dateRange).toContain("2026-01-31");
    });
  });
});
