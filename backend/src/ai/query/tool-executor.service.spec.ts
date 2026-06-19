import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ToolExecutorService } from "./tool-executor.service";
import { AccountsService } from "../../accounts/accounts.service";
import { CategoriesService } from "../../categories/categories.service";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { NetWorthService } from "../../net-worth/net-worth.service";
import { BudgetReportsService } from "../../budgets/budget-reports.service";
import { PortfolioService } from "../../securities/portfolio.service";
import { InvestmentTransactionsService } from "../../securities/investment-transactions.service";
import { ScheduledTransactionsService } from "../../scheduled-transactions/scheduled-transactions.service";
import { TransactionsService } from "../../transactions/transactions.service";
import { PayeesService } from "../../payees/payees.service";
import { AiActionSigningService } from "../actions/ai-action-signing.service";
import { AiActionBuilderService } from "../actions/ai-action-builder.service";

describe("ToolExecutorService", () => {
  let service: ToolExecutorService;
  let analytics: Record<string, jest.Mock>;
  let accounts: Record<string, jest.Mock>;
  let netWorth: Record<string, jest.Mock>;
  let budgetReports: Record<string, jest.Mock>;
  let portfolio: Record<string, jest.Mock>;
  let investmentTransactions: Record<string, jest.Mock>;
  let categories: Record<string, jest.Mock>;
  let scheduledTransactions: Record<string, jest.Mock>;
  let transactions: Record<string, jest.Mock>;
  let payees: Record<string, jest.Mock>;
  let signing: Record<string, jest.Mock>;

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
      resolveLlmCategoryIds: jest
        .fn()
        .mockResolvedValue({ categoryIds: ["cat-1"], unresolved: [] }),
    };

    categories = {
      getLlmCategories: jest.fn().mockResolvedValue({
        categories: [
          {
            id: "cat-1",
            name: "Groceries",
            parentName: "Food",
            isIncome: false,
            transactionCount: 12,
          },
        ],
        totalCount: 1,
      }),
    };

    accounts = {
      findAll: jest.fn().mockResolvedValue([
        { id: "acc-1", name: "Checking", currencyCode: "USD" },
        { id: "acc-2", name: "Savings", currencyCode: "USD" },
        { id: "acc-3", name: "Brokerage", currencyCode: "USD" },
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
      previewCreateInvestmentTransaction: jest.fn().mockResolvedValue({
        accountId: "acc-3",
        accountName: "Brokerage",
        accountCurrency: "USD",
        action: "BUY",
        transactionDate: "2026-01-15",
        securityId: "sec-1",
        symbol: "AAPL",
        securityName: "Apple Inc.",
        securityCurrency: "USD",
        quantity: 10,
        price: 150,
        commission: 9.99,
        totalAmount: 1509.99,
        exchangeRate: 1,
        fundingAccountId: null,
        cashAccountName: "Brokerage Cash",
        cashCurrency: "USD",
        cashAmount: -1509.99,
        description: null,
      }),
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
      getLlmCapitalGains: jest.fn().mockResolvedValue({
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        totals: {
          realizedGain: 120,
          unrealizedGain: 80,
          totalCapitalGain: 200,
        },
        groupedBy: "month",
        entries: [
          {
            month: "2024-06",
            accountName: null,
            symbol: null,
            securityName: null,
            currency: "CAD",
            startValue: 1000,
            endValue: 1200,
            realizedGain: 0,
            unrealizedGain: 200,
            totalCapitalGain: 200,
          },
        ],
        entryCount: 1,
        truncatedEntryList: false,
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

    scheduledTransactions = {
      getLlmUpcomingBillsAndDeposits: jest.fn().mockResolvedValue({
        daysWindow: 30,
        itemCount: 2,
        overdueCount: 1,
        totalUpcomingBills: 1200,
        totalUpcomingDeposits: 3000,
        items: [],
      }),
      getLlmScheduledList: jest.fn().mockResolvedValue({
        totalCount: 3,
        activeCount: 2,
        autoPostCount: 1,
        billCount: 2,
        depositCount: 1,
        items: [],
      }),
    };

    transactions = {
      getLlmTransactionRows: jest.fn().mockResolvedValue({
        transactions: [
          {
            id: "tx-1",
            date: "2026-01-15",
            payeeName: "Starbucks",
            categoryName: "Dining",
            amount: -12.5,
            accountName: "Checking",
            description: null,
            status: "unreconciled",
          },
        ],
        total: 1,
        hasMore: false,
      }),
      previewCreate: jest.fn().mockResolvedValue({
        accountId: "acc-1",
        accountName: "Checking",
        amount: -12.5,
        transactionDate: "2026-01-15",
        payeeId: "payee-1",
        payeeName: "Starbucks",
        payeeMatched: true,
        payeeWillBeCreated: false,
        categoryId: "cat-1",
        categoryName: "Dining",
        description: null,
        currencyCode: "USD",
      }),
      previewCategorize: jest.fn().mockResolvedValue({
        transactionId: "tx-1",
        payeeName: "Starbucks",
        amount: -12.5,
        transactionDate: "2026-01-15",
        accountName: "Checking",
        currentCategoryName: "Uncategorized",
        categoryId: "cat-1",
        newCategoryName: "Dining",
      }),
    };

    payees = {
      previewCreate: jest.fn().mockResolvedValue({
        name: "Acme",
        defaultCategoryId: "cat-1",
        defaultCategoryName: "Dining",
      }),
    };

    signing = {
      sign: jest.fn().mockReturnValue("signature-abc"),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ToolExecutorService,
        { provide: AccountsService, useValue: accounts },
        { provide: CategoriesService, useValue: categories },
        { provide: TransactionAnalyticsService, useValue: analytics },
        { provide: NetWorthService, useValue: netWorth },
        { provide: BudgetReportsService, useValue: budgetReports },
        { provide: PortfolioService, useValue: portfolio },
        {
          provide: InvestmentTransactionsService,
          useValue: investmentTransactions,
        },
        {
          provide: ScheduledTransactionsService,
          useValue: scheduledTransactions,
        },
        { provide: TransactionsService, useValue: transactions },
        { provide: PayeesService, useValue: payees },
        { provide: AiActionSigningService, useValue: signing },
        // Real builder wrapping the mocked signing service, so the executor's
        // pending-action construction (and signing.sign assertions) still run.
        AiActionBuilderService,
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

    it("query_transactions returns an error when a category name cannot be resolved", async () => {
      analytics.resolveLlmCategoryIds.mockResolvedValueOnce({
        categoryIds: [],
        unresolved: ["Bogus"],
      });

      const result = await service.execute(userId, "query_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        categoryNames: ["Bogus"],
      });

      expect(result.isError).toBe(true);
      expect(result.summary).toContain("Bogus");
      expect(analytics.getLlmQueryTransactions).not.toHaveBeenCalled();
    });

    it("get_account_balances delegates to accounts.getLlmBalances", async () => {
      const result = await service.execute(userId, "get_account_balances", {});

      expect(accounts.getLlmBalances).toHaveBeenCalledWith(
        userId,
        undefined,
        "open",
        undefined,
      );
      expect(result.sources[0].type).toBe("accounts");
      expect(result.summary).toContain("Net worth");
    });

    it("get_account_balances passes status and accountTypes through", async () => {
      await service.execute(userId, "get_account_balances", {
        status: "closed",
        accountTypes: ["CHEQUING", "SAVINGS"],
      });

      expect(accounts.getLlmBalances).toHaveBeenCalledWith(
        userId,
        undefined,
        "closed",
        ["CHEQUING", "SAVINGS"],
      );
    });

    it("get_account_balances supports 'all' status", async () => {
      await service.execute(userId, "get_account_balances", { status: "all" });

      expect(accounts.getLlmBalances).toHaveBeenCalledWith(
        userId,
        undefined,
        "all",
        undefined,
      );
    });

    it("get_categories delegates to categoriesService.getLlmCategories", async () => {
      const result = await service.execute(userId, "get_categories", {});

      expect(categories.getLlmCategories).toHaveBeenCalledWith(userId, {
        type: undefined,
        search: undefined,
      });
      expect(result.sources[0].type).toBe("categories");
      expect(result.summary).toContain("categor");
    });

    it("get_categories passes type and search through", async () => {
      await service.execute(userId, "get_categories", {
        type: "expense",
        search: "groc",
      });

      expect(categories.getLlmCategories).toHaveBeenCalledWith(userId, {
        type: "expense",
        search: "groc",
      });
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

    it("get_spending_by_category defaults topN to 10 and fills in dates when omitted", async () => {
      await service.execute(userId, "get_spending_by_category", {});

      expect(analytics.getLlmSpendingByCategory).toHaveBeenCalledWith(
        userId,
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        10,
      );
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
      // data must be the bare array returned by getLlmHistory so it matches the
      // MCP server's get_net_worth_history payload exactly.
      expect(result.data).toEqual([
        {
          month: "2026-01",
          assets: 19000,
          liabilities: 1300,
          netWorth: 17700,
        },
      ]);
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

    it("compare_periods fills in all four dates when omitted", async () => {
      await service.execute(userId, "compare_periods", {});

      expect(analytics.getLlmPeriodComparison).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          period1Start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          period1End: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          period2Start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          period2End: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          groupBy: "category",
          direction: "expenses",
        }),
      );
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

    it("query_investment_transactions defaults groupBy to 'security' when omitted", async () => {
      await service.execute(userId, "query_investment_transactions", {});

      expect(
        investmentTransactions.getLlmInvestmentTransactions,
      ).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ groupBy: "security" }),
      );
    });

    it("get_capital_gains delegates to investmentTransactions.getLlmCapitalGains", async () => {
      const result = await service.execute(userId, "get_capital_gains", {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        symbols: ["AAA"],
        groupBy: "month",
      });

      expect(investmentTransactions.getLlmCapitalGains).toHaveBeenCalledWith(
        userId,
        {
          startDate: "2024-01-01",
          endDate: "2024-12-31",
          accountIds: undefined,
          symbols: ["AAA"],
          groupBy: "month",
        },
      );
      expect(result.sources[0].type).toBe("investment_capital_gains");
      expect(result.sources[0].dateRange).toBe("2024-01-01 to 2024-12-31");
      expect(result.summary).toContain("capital gains 200.00");
      expect(result.summary).toContain("realized 120.00");
      expect(result.summary).toContain("unrealized 80.00");
      expect(result.summary).toContain("grouped by month");
    });

    it("get_capital_gains resolves account names and defaults groupBy to 'month'", async () => {
      await service.execute(userId, "get_capital_gains", {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        accountNames: ["Checking"],
      });

      expect(accounts.findAll).toHaveBeenCalledWith(userId, false);
      expect(investmentTransactions.getLlmCapitalGains).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          accountIds: ["acc-1"],
          groupBy: "month",
        }),
      );
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

    it("get_transfers applies default date range when omitted", async () => {
      await service.execute(userId, "get_transfers", {});

      expect(analytics.getTransfersByAccount).toHaveBeenCalledWith(
        userId,
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        undefined,
      );
    });

    it("get_income_summary applies default date range when omitted", async () => {
      await service.execute(userId, "get_income_summary", {});

      expect(analytics.getLlmIncomeSummary).toHaveBeenCalledWith(
        userId,
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        "category",
      );
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

    it("get_upcoming_bills delegates to scheduledTransactions.getLlmUpcomingBillsAndDeposits", async () => {
      const result = await service.execute(userId, "get_upcoming_bills", {});

      expect(
        scheduledTransactions.getLlmUpcomingBillsAndDeposits,
      ).toHaveBeenCalledWith(userId, {
        days: 30,
        kind: undefined,
        accountIds: undefined,
      });
      expect(result.sources[0].type).toBe("scheduled_transactions");
      expect(result.summary).toContain("upcoming");
      expect(result.summary).toContain("Bills: 1200.00");
      expect(result.summary).toContain("Deposits: 3000.00");
      expect(result.summary).toContain("1 overdue");
    });

    it("get_upcoming_bills passes through days, kind, and resolves account names", async () => {
      await service.execute(userId, "get_upcoming_bills", {
        days: 7,
        kind: "bill",
        accountNames: ["Checking"],
      });

      expect(accounts.findAll).toHaveBeenCalledWith(userId, false);
      expect(
        scheduledTransactions.getLlmUpcomingBillsAndDeposits,
      ).toHaveBeenCalledWith(userId, {
        days: 7,
        kind: "bill",
        accountIds: ["acc-1"],
      });
    });

    it("get_scheduled_transactions delegates to scheduledTransactions.getLlmScheduledList", async () => {
      const result = await service.execute(
        userId,
        "get_scheduled_transactions",
        {},
      );

      expect(scheduledTransactions.getLlmScheduledList).toHaveBeenCalledWith(
        userId,
        { kind: undefined, accountIds: undefined, isActive: undefined },
      );
      expect(result.sources[0].type).toBe("scheduled_transactions");
      expect(result.summary).toContain("2 active");
      expect(result.summary).toContain("1 auto-posting");
    });

    it("get_scheduled_transactions passes kind, account names, and isActive filter", async () => {
      await service.execute(userId, "get_scheduled_transactions", {
        kind: "deposit",
        accountNames: ["Checking"],
        isActive: false,
      });

      expect(scheduledTransactions.getLlmScheduledList).toHaveBeenCalledWith(
        userId,
        { kind: "deposit", accountIds: ["acc-1"], isActive: false },
      );
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

    it("applies default date range when startDate and endDate are omitted", async () => {
      const result = await service.execute(userId, "query_transactions", {});

      expect(result.isError).toBeUndefined();
      expect(analytics.getLlmQueryTransactions).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          endDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      );
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

  describe("search_transactions", () => {
    it("returns transaction rows resolving account/category names to ids", async () => {
      const result = await service.execute(userId, "search_transactions", {
        searchText: "coffee",
        accountName: "Checking",
        categoryName: "Dining",
        limit: 10,
      });

      expect(accounts.findAll).toHaveBeenCalledWith(userId, false);
      expect(analytics.resolveLlmCategoryIds).toHaveBeenCalledWith(userId, [
        "Dining",
      ]);
      expect(transactions.getLlmTransactionRows).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          accountId: "acc-1",
          categoryId: "cat-1",
          query: "coffee",
          limit: 10,
        }),
      );
      expect(
        (result.data as { transactions: unknown[] }).transactions,
      ).toHaveLength(1);
      expect(result.isError).toBeUndefined();
    });

    it("errors on an unknown account name", async () => {
      const result = await service.execute(userId, "search_transactions", {
        accountName: "Nope",
      });
      expect(transactions.getLlmTransactionRows).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
    });
  });

  describe("create_transaction (human-in-the-loop)", () => {
    it("returns a signed pending action and never persists", async () => {
      const result = await service.execute(userId, "create_transaction", {
        accountName: "Checking",
        amount: -12.5,
        date: "2026-01-15",
        payeeName: "Starbucks",
        categoryName: "Dining",
      });

      expect(transactions.previewCreate).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ accountId: "acc-1", amount: -12.5 }),
      );
      // Never writes during the agentic loop.
      expect(transactions.create).toBeUndefined();
      expect(signing.sign).toHaveBeenCalled();
      expect(result.pendingAction?.type).toBe("create_transaction");
      expect(result.pendingAction?.signature).toBe("signature-abc");
      expect(result.pendingAction?.descriptor).toMatchObject({
        type: "create_transaction",
        userId,
        accountId: "acc-1",
        amount: -12.5,
        currencyCode: "USD",
        // The resolved payee id is signed into the descriptor so the confirmed
        // transaction links to the existing payee.
        payeeId: "payee-1",
      });
      expect(result.pendingAction?.preview).toMatchObject({
        accountName: "Checking",
        categoryName: "Dining",
      });
    });

    it("defaults to creating a payee for an unmatched name (createPayee flagged on the descriptor)", async () => {
      transactions.previewCreate.mockResolvedValueOnce({
        accountId: "acc-1",
        accountName: "Checking",
        amount: -12.5,
        transactionDate: "2026-01-15",
        payeeId: null,
        payeeName: "Brand New Store",
        payeeMatched: false,
        payeeWillBeCreated: true,
        categoryId: null,
        categoryName: null,
        description: null,
        currencyCode: "USD",
      });

      const result = await service.execute(userId, "create_transaction", {
        accountName: "Checking",
        amount: -12.5,
        date: "2026-01-15",
        payeeName: "Brand New Store",
      });

      // createPayeeIfMissing defaults to true, so previewCreate is asked to plan
      // a payee and the signed descriptor records that intent for the confirm step.
      expect(transactions.previewCreate).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ createPayeeIfMissing: true }),
      );
      expect(result.pendingAction?.type).toBe("create_transaction");
      expect(result.pendingAction?.descriptor).toMatchObject({
        payeeId: null,
        payeeName: "Brand New Store",
        createPayee: true,
      });
      expect(result.pendingAction?.preview).toMatchObject({
        payeeName: "Brand New Store",
        payeeWillBeCreated: true,
      });
      const data = result.data as { payeeNote?: string };
      expect(data.payeeNote).toContain("a new payee will be created");
    });

    it("records a free-text payee when createPayeeIfMissing is false", async () => {
      transactions.previewCreate.mockResolvedValueOnce({
        accountId: "acc-1",
        accountName: "Checking",
        amount: -12.5,
        transactionDate: "2026-01-15",
        payeeId: null,
        payeeName: "Brand New Store",
        payeeMatched: false,
        payeeWillBeCreated: false,
        categoryId: null,
        categoryName: null,
        description: null,
        currencyCode: "USD",
      });

      const result = await service.execute(userId, "create_transaction", {
        accountName: "Checking",
        amount: -12.5,
        date: "2026-01-15",
        payeeName: "Brand New Store",
        createPayeeIfMissing: false,
      });

      expect(transactions.previewCreate).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ createPayeeIfMissing: false }),
      );
      expect(result.pendingAction?.descriptor).toMatchObject({
        payeeId: null,
        createPayee: false,
      });
      const data = result.data as { payeeNote?: string };
      expect(data.payeeNote).toContain("free-text");
    });

    it("does not leak the signature into the LLM-facing data", async () => {
      const result = await service.execute(userId, "create_transaction", {
        accountName: "Checking",
        amount: -12.5,
        date: "2026-01-15",
      });
      expect(JSON.stringify(result.data)).not.toContain("signature-abc");
      expect((result.data as { status: string }).status).toBe("preview_shown");
    });

    it("errors on an unknown account", async () => {
      const result = await service.execute(userId, "create_transaction", {
        accountName: "Ghost",
        amount: -1,
        date: "2026-01-15",
      });
      expect(result.isError).toBe(true);
      expect(result.pendingAction).toBeUndefined();
    });
  });

  describe("categorize_transaction (human-in-the-loop)", () => {
    it("returns a signed pending action with current and new category", async () => {
      const result = await service.execute(userId, "categorize_transaction", {
        transactionId: "11111111-1111-4111-8111-111111111111",
        categoryName: "Dining",
      });

      expect(transactions.previewCategorize).toHaveBeenCalledWith(
        userId,
        "11111111-1111-4111-8111-111111111111",
        "cat-1",
      );
      expect(result.pendingAction?.type).toBe("categorize_transaction");
      expect(result.pendingAction?.preview).toMatchObject({
        currentCategoryName: "Uncategorized",
        newCategoryName: "Dining",
      });
    });
  });

  describe("create_payee (human-in-the-loop)", () => {
    it("returns a signed pending action", async () => {
      const result = await service.execute(userId, "create_payee", {
        name: "Acme",
        defaultCategoryName: "Dining",
      });

      expect(payees.previewCreate).toHaveBeenCalledWith(userId, {
        name: "Acme",
        defaultCategoryId: "cat-1",
      });
      expect(result.pendingAction?.type).toBe("create_payee");
      expect(result.pendingAction?.preview).toMatchObject({
        name: "Acme",
        categoryName: "Dining",
      });
    });
  });

  describe("create_investment_transaction (human-in-the-loop)", () => {
    it("resolves the account and returns a signed pending action", async () => {
      const result = await service.execute(
        userId,
        "create_investment_transaction",
        {
          accountName: "Brokerage",
          action: "BUY",
          date: "2026-01-15",
          security: "AAPL",
          quantity: 10,
          price: 150,
          commission: 9.99,
        },
      );

      expect(
        investmentTransactions.previewCreateInvestmentTransaction,
      ).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          accountId: "acc-3",
          action: "BUY",
          transactionDate: "2026-01-15",
          securityQuery: "AAPL",
          quantity: 10,
          price: 150,
          commission: 9.99,
          fundingAccountId: undefined,
        }),
      );
      expect(result.pendingAction?.type).toBe("create_investment_transaction");
      expect(result.pendingAction?.signature).toBe("signature-abc");
      expect(result.pendingAction?.descriptor).toMatchObject({
        type: "create_investment_transaction",
        accountId: "acc-3",
        action: "BUY",
        securityId: "sec-1",
        quantity: 10,
        price: 150,
        commission: 9.99,
        exchangeRate: 1,
      });
      expect(result.pendingAction?.preview).toMatchObject({
        accountName: "Brokerage",
        investmentAction: "BUY",
        symbol: "AAPL",
        securityName: "Apple Inc.",
        totalAmount: 1509.99,
        cashAccountName: "Brokerage Cash",
        cashAmount: -1509.99,
      });
      // The model-facing data never leaks the signature.
      expect(JSON.stringify(result.data)).not.toContain("signature-abc");
    });

    it("resolves an optional funding account by name", async () => {
      await service.execute(userId, "create_investment_transaction", {
        accountName: "Brokerage",
        action: "SELL",
        date: "2026-01-15",
        security: "AAPL",
        quantity: 5,
        price: 160,
        fundingAccountName: "Checking",
      });

      expect(
        investmentTransactions.previewCreateInvestmentTransaction,
      ).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ fundingAccountId: "acc-1" }),
      );
    });

    it("returns a tool error for an unknown account (no pending action)", async () => {
      const result = await service.execute(
        userId,
        "create_investment_transaction",
        {
          accountName: "Nonexistent",
          action: "BUY",
          date: "2026-01-15",
          security: "AAPL",
          quantity: 1,
          price: 1,
        },
      );
      expect(result.isError).toBe(true);
      expect(result.pendingAction).toBeUndefined();
      expect(
        investmentTransactions.previewCreateInvestmentTransaction,
      ).not.toHaveBeenCalled();
    });

    it("returns a tool error for an unknown funding account", async () => {
      const result = await service.execute(
        userId,
        "create_investment_transaction",
        {
          accountName: "Brokerage",
          action: "BUY",
          date: "2026-01-15",
          security: "AAPL",
          quantity: 1,
          price: 1,
          fundingAccountName: "Nonexistent",
        },
      );
      expect(result.isError).toBe(true);
      expect(result.pendingAction).toBeUndefined();
    });

    it("surfaces a 4xx from the preview (e.g. ambiguous security)", async () => {
      investmentTransactions.previewCreateInvestmentTransaction.mockRejectedValueOnce(
        new BadRequestException(
          '"Apple" matches multiple securities: AAPL (Apple Inc.), AAPL.L (Apple London). Use the exact ticker symbol.',
        ),
      );
      const result = await service.execute(
        userId,
        "create_investment_transaction",
        {
          accountName: "Brokerage",
          action: "BUY",
          date: "2026-01-15",
          security: "Apple",
          quantity: 1,
          price: 1,
        },
      );
      expect(result.isError).toBe(true);
      expect(result.summary).toContain("multiple securities");
      expect(result.pendingAction).toBeUndefined();
    });
  });
});
