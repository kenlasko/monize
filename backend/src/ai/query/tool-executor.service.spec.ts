import { Test, TestingModule } from "@nestjs/testing";
import { ToolExecutorService } from "./tool-executor.service";
import { AccountsService } from "../../accounts/accounts.service";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { NetWorthService } from "../../net-worth/net-worth.service";
import { BudgetReportsService } from "../../budgets/budget-reports.service";
import { PortfolioService } from "../../securities/portfolio.service";
import { InvestmentTransactionsService } from "../../securities/investment-transactions.service";

describe("ToolExecutorService", () => {
  let service: ToolExecutorService;
  let analytics: Record<string, jest.Mock>;
  let accounts: Record<string, jest.Mock>;
  let netWorth: Record<string, jest.Mock>;
  let budgetReports: Record<string, jest.Mock>;
  let portfolio: Record<string, jest.Mock>;
  let investmentTransactions: Record<string, jest.Mock>;

  const userId = "user-1";

  beforeEach(async () => {
    analytics = {
      getLlmQueryTransactions: jest.fn().mockResolvedValue({
        totalIncome: 5000,
        totalExpenses: 3000,
        netCashFlow: 2000,
        transactionCount: 45,
      }),
      getLlmSpendingByCategory: jest.fn().mockResolvedValue({
        categories: [
          {
            category: "Groceries",
            amount: 500,
            percentage: 50,
            transactionCount: 10,
          },
        ],
        totalSpending: 1000,
      }),
      getLlmIncomeSummary: jest.fn().mockResolvedValue({
        items: [{ label: "Salary", amount: 5000, count: 1 }],
        totalIncome: 5000,
        groupedBy: "category",
      }),
      getLlmPeriodComparison: jest.fn().mockResolvedValue({
        period1: { start: "2025-12-01", end: "2025-12-31", total: 3000 },
        period2: { start: "2026-01-01", end: "2026-01-31", total: 3500 },
        totalChange: 500,
        totalChangePercent: 16.67,
        comparison: [],
      }),
      getTransfersByAccount: jest.fn().mockResolvedValue({
        accounts: [],
        totalInbound: 0,
        totalOutbound: 0,
        transferCount: 0,
      }),
      resolveLlmCategoryIds: jest.fn().mockResolvedValue(["cat-1"]),
    };

    accounts = {
      findAll: jest.fn().mockResolvedValue([
        { id: "acc-1", name: "Checking" },
        { id: "acc-2", name: "Savings" },
      ]),
      getLlmBalances: jest.fn().mockResolvedValue({
        accounts: [
          {
            name: "Checking",
            type: "CHECKING",
            balance: 5000,
            currency: "USD",
          },
        ],
        totalAssets: 20000,
        totalLiabilities: 1200,
        netWorth: 18800,
        totalAccounts: 3,
      }),
    };

    netWorth = {
      getLlmHistory: jest.fn().mockResolvedValue([
        {
          month: "2026-01",
          assets: 19000,
          liabilities: 1300,
          netWorth: 17700,
        },
      ]),
    };

    budgetReports = {
      getLlmBudgetStatus: jest.fn().mockResolvedValue({
        budgetName: "Default",
        strategy: "zero_based",
        period: { start: "2026-04-01", end: "2026-04-30" },
        totalBudgeted: 3000,
        totalSpent: 1200,
        totalIncome: 5000,
        remaining: 1800,
        percentUsed: 40,
        overBudgetCategories: [],
        nearLimitCategories: [],
        categoryCount: 5,
      }),
    };

    investmentTransactions = {
      getLlmInvestmentTransactions: jest.fn().mockResolvedValue({
        transactionCount: 3,
        totalAmount: 2325,
        totalCommission: 19.98,
        totalQuantity: 15,
        actionCounts: { BUY: 1, SELL: 1, DIVIDEND: 1 },
        groupedBy: null,
        groups: null,
        transactions: [],
        truncatedTransactionList: false,
      }),
    };

    portfolio = {
      getLlmSummary: jest.fn().mockResolvedValue({
        holdingCount: 0,
        totalCashValue: 0,
        totalHoldingsValue: 0,
        totalCostBasis: 0,
        totalPortfolioValue: 0,
        totalGainLoss: 0,
        totalGainLossPercent: 0,
        timeWeightedReturn: null,
        cagr: null,
        holdings: [],
        allocation: [],
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ToolExecutorService,
        { provide: AccountsService, useValue: accounts },
        { provide: TransactionAnalyticsService, useValue: analytics },
        { provide: NetWorthService, useValue: netWorth },
        { provide: BudgetReportsService, useValue: budgetReports },
        { provide: PortfolioService, useValue: portfolio },
        {
          provide: InvestmentTransactionsService,
          useValue: investmentTransactions,
        },
      ],
    }).compile();

    service = module.get<ToolExecutorService>(ToolExecutorService);
  });

  describe("tool routing", () => {
    it("query_transactions delegates to analytics.getLlmQueryTransactions", async () => {
      const result = await service.execute(userId, "query_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(analytics.getLlmQueryTransactions).toHaveBeenCalledWith(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        accountIds: undefined,
        categoryIds: undefined,
        searchText: undefined,
        groupBy: undefined,
        direction: undefined,
      });
      expect(result.sources[0].type).toBe("transactions");
      expect(result.summary).toContain("transactions");
    });

    it("query_transactions resolves account names to IDs", async () => {
      await service.execute(userId, "query_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        accountNames: ["Checking"],
      });

      expect(accounts.findAll).toHaveBeenCalledWith(userId, false);
      expect(analytics.getLlmQueryTransactions).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ accountIds: ["acc-1"] }),
      );
    });

    it("query_transactions resolves category names via analytics helper", async () => {
      await service.execute(userId, "query_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        categoryNames: ["Groceries"],
      });

      expect(analytics.resolveLlmCategoryIds).toHaveBeenCalledWith(userId, [
        "Groceries",
      ]);
      expect(analytics.getLlmQueryTransactions).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ categoryIds: ["cat-1"] }),
      );
    });

    it("get_account_balances delegates to accounts.getLlmBalances", async () => {
      const result = await service.execute(userId, "get_account_balances", {});

      expect(accounts.getLlmBalances).toHaveBeenCalledWith(userId, undefined);
      expect(result.sources[0].type).toBe("accounts");
      expect(result.summary).toContain("Net worth");
    });

    it("get_spending_by_category delegates to analytics.getLlmSpendingByCategory", async () => {
      const result = await service.execute(userId, "get_spending_by_category", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        topN: 10,
      });

      expect(analytics.getLlmSpendingByCategory).toHaveBeenCalledWith(
        userId,
        "2026-01-01",
        "2026-01-31",
        10,
      );
      expect(result.sources[0].type).toBe("spending");
    });

    it("get_income_summary delegates to analytics.getLlmIncomeSummary", async () => {
      const result = await service.execute(userId, "get_income_summary", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        groupBy: "payee",
      });

      expect(analytics.getLlmIncomeSummary).toHaveBeenCalledWith(
        userId,
        "2026-01-01",
        "2026-01-31",
        "payee",
      );
      expect(result.sources[0].type).toBe("income");
    });

    it("get_income_summary defaults groupBy to category", async () => {
      await service.execute(userId, "get_income_summary", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(analytics.getLlmIncomeSummary).toHaveBeenCalledWith(
        userId,
        "2026-01-01",
        "2026-01-31",
        "category",
      );
    });

    it("get_net_worth_history delegates to netWorthService.getLlmHistory", async () => {
      const result = await service.execute(userId, "get_net_worth_history", {});

      expect(netWorth.getLlmHistory).toHaveBeenCalledWith(
        userId,
        undefined,
        undefined,
      );
      expect(result.sources[0].type).toBe("net_worth");
    });

    it("compare_periods delegates to analytics.getLlmPeriodComparison", async () => {
      const result = await service.execute(userId, "compare_periods", {
        period1Start: "2025-12-01",
        period1End: "2025-12-31",
        period2Start: "2026-01-01",
        period2End: "2026-01-31",
      });

      expect(analytics.getLlmPeriodComparison).toHaveBeenCalledWith(userId, {
        period1Start: "2025-12-01",
        period1End: "2025-12-31",
        period2Start: "2026-01-01",
        period2End: "2026-01-31",
        groupBy: "category",
        direction: "expenses",
      });
      expect(result.sources[0].type).toBe("comparison");
    });

    it("get_portfolio_summary delegates to portfolioService.getLlmSummary", async () => {
      const result = await service.execute(userId, "get_portfolio_summary", {});

      expect(portfolio.getLlmSummary).toHaveBeenCalledWith(userId, undefined);
      expect(result.sources[0].type).toBe("portfolio");
    });

    it("query_investment_transactions delegates to investmentTransactions.getLlmInvestmentTransactions", async () => {
      investmentTransactions.getLlmInvestmentTransactions.mockResolvedValueOnce(
        {
          transactionCount: 3,
          totalAmount: 2325,
          totalCommission: 19.98,
          totalQuantity: 15,
          actionCounts: { BUY: 1, SELL: 1 },
          groupedBy: "security",
          groups: [
            {
              key: "AAPL",
              transactionCount: 3,
              totalQuantity: 15,
              totalAmount: 2325,
              totalCommission: 19.98,
            },
          ],
          transactions: [],
          truncatedTransactionList: false,
        },
      );
      const result = await service.execute(
        userId,
        "query_investment_transactions",
        {
          startDate: "2026-01-01",
          endDate: "2026-03-31",
          symbols: ["AAPL"],
          actions: ["BUY", "SELL"],
          groupBy: "security",
        },
      );

      expect(
        investmentTransactions.getLlmInvestmentTransactions,
      ).toHaveBeenCalledWith(userId, {
        startDate: "2026-01-01",
        endDate: "2026-03-31",
        accountIds: undefined,
        symbols: ["AAPL"],
        actions: ["BUY", "SELL"],
        groupBy: "security",
      });
      expect(result.sources[0].type).toBe("investment_transactions");
      expect(result.sources[0].dateRange).toBe("2026-01-01 to 2026-03-31");
      expect(result.summary).toContain("3 investment transactions");
      expect(result.summary).toContain("grouped by security");
    });

    it("query_investment_transactions resolves account names to IDs", async () => {
      await service.execute(userId, "query_investment_transactions", {
        accountNames: ["Checking"],
      });

      expect(accounts.findAll).toHaveBeenCalledWith(userId, false);
      expect(
        investmentTransactions.getLlmInvestmentTransactions,
      ).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ accountIds: ["acc-1"] }),
      );
    });

    it("query_investment_transactions handles all-dates summary", async () => {
      const result = await service.execute(
        userId,
        "query_investment_transactions",
        {},
      );

      expect(result.sources[0].dateRange).toBe("all dates");
    });

    it("get_transfers delegates to analytics.getTransfersByAccount", async () => {
      const result = await service.execute(userId, "get_transfers", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(analytics.getTransfersByAccount).toHaveBeenCalledWith(
        userId,
        "2026-01-01",
        "2026-01-31",
        undefined,
      );
      expect(result.sources[0].type).toBe("transfers");
    });

    it("get_budget_status delegates to budgetReports.getLlmBudgetStatus", async () => {
      const result = await service.execute(userId, "get_budget_status", {});

      expect(budgetReports.getLlmBudgetStatus).toHaveBeenCalledWith(
        userId,
        "CURRENT",
        undefined,
      );
      expect(result.sources[0].type).toBe("budget");
    });

    it("calculate runs locally without hitting any service", async () => {
      const result = await service.execute(userId, "calculate", {
        operation: "sum",
        values: [1, 2, 3],
      });

      expect(analytics.getLlmQueryTransactions).not.toHaveBeenCalled();
      expect(accounts.getLlmBalances).not.toHaveBeenCalled();
      expect(result.sources[0].type).toBe("calculation");
    });

    it("render_chart echoes input as sanitized chart data", async () => {
      const result = await service.execute(userId, "render_chart", {
        type: "bar",
        title: "Spending",
        data: [{ label: "Food", value: 100 }],
      });

      expect(result.data).toEqual({
        type: "bar",
        title: "Spending",
        data: [{ label: "Food", value: 100 }],
      });
      expect(result.sources).toEqual([]);
    });

    it("returns error for unknown tools", async () => {
      const result = await service.execute(userId, "unknown_tool", {});

      expect(result.data).toBeNull();
      expect(result.summary).toContain("Unknown tool: unknown_tool");
      expect(result.sources).toEqual([]);
    });
  });

  describe("input validation (LLM07-F1)", () => {
    it("rejects invalid dates", async () => {
      const result = await service.execute(userId, "query_transactions", {
        startDate: "not-a-date",
        endDate: "2026-01-31",
      });

      expect(result.isError).toBe(true);
      expect(result.summary).toContain("Invalid input");
      expect(analytics.getLlmQueryTransactions).not.toHaveBeenCalled();
    });

    it("rejects missing required fields", async () => {
      const result = await service.execute(userId, "query_transactions", {});

      expect(result.isError).toBe(true);
      expect(result.summary).toContain("Invalid input");
    });

    it("allows valid input and delegates to the analytics service", async () => {
      const result = await service.execute(userId, "query_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(result.isError).toBeUndefined();
      expect(analytics.getLlmQueryTransactions).toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("wraps thrown errors in a safe error result", async () => {
      analytics.getLlmQueryTransactions.mockRejectedValueOnce(
        new Error("boom"),
      );

      const result = await service.execute(userId, "query_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(result.data).toEqual({
        error: "An error occurred while retrieving data.",
      });
      expect(result.summary).toContain("Error executing query_transactions");
      expect(result.isError).toBe(true);
    });
  });
});
