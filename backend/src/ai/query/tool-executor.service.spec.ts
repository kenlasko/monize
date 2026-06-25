import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ToolExecutorService } from "./tool-executor.service";
import { AccountsService } from "../../accounts/accounts.service";
import { CategoriesService } from "../../categories/categories.service";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { NetWorthService } from "../../net-worth/net-worth.service";
import { BudgetReportsService } from "../../budgets/budget-reports.service";
import { PortfolioService } from "../../securities/portfolio.service";
import { SecuritiesService } from "../../securities/securities.service";
import { BuiltInReportsService } from "../../built-in-reports/built-in-reports.service";
import { InvestmentTransactionsService } from "../../securities/investment-transactions.service";
import { ScheduledTransactionsService } from "../../scheduled-transactions/scheduled-transactions.service";
import { TransactionsService } from "../../transactions/transactions.service";
import { PayeesService } from "../../payees/payees.service";
import { AiActionSigningService } from "../actions/ai-action-signing.service";
import { AiActionBuilderService } from "../actions/ai-action-builder.service";
import { TransactionToolPrepService } from "../../transactions/transaction-tool-prep.service";
import { PayeeToolPrepService } from "../../payees/payee-tool-prep.service";
import { SecurityToolPrepService } from "../../securities/security-tool-prep.service";
import { TransactionTransferService } from "../../transactions/transaction-transfer.service";
import { TransactionSplitService } from "../../transactions/transaction-split.service";

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
  let securities: Record<string, jest.Mock>;
  let signing: Record<string, jest.Mock>;
  let transfer: Record<string, jest.Mock>;
  let splitService: Record<string, jest.Mock>;
  let builtInReports: Record<string, jest.Mock>;

  const userId = "user-1";

  // Preview shapes shared between the mocked single + bulk investment prep
  // methods, matching CreateInvestmentTransactionPreview /
  // Update / DeleteInvestmentTransactionPreview so the real AiActionBuilder can
  // consume them.
  const createInvestmentPreview = {
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
  };

  const updateInvestmentPreview = {
    transactionId: "inv-tx-1",
    accountId: "acc-3",
    accountName: "Brokerage",
    accountCurrency: "USD",
    action: "SELL",
    transactionDate: "2026-02-01",
    securityId: "sec-1",
    symbol: "AAPL",
    securityName: "Apple Inc.",
    securityCurrency: "USD",
    quantity: 5,
    price: 160,
    commission: 0,
    totalAmount: 800,
    exchangeRate: 1,
    fundingAccountId: null,
    cashAccountName: "Brokerage Cash",
    cashCurrency: "USD",
    cashAmount: 800,
    description: null,
  };

  const deleteInvestmentPreview = {
    transactionId: "inv-tx-1",
    accountName: "Brokerage",
    action: "BUY",
    transactionDate: "2026-01-15",
    symbol: "AAPL",
    securityName: "Apple Inc.",
    securityCurrency: "USD",
    quantity: 10,
    price: 150,
    commission: 9.99,
    totalAmount: 1509.99,
    description: null,
  };

  beforeEach(async () => {
    analytics = {
      getLlmListTransactions: jest.fn().mockResolvedValue({
        totalIncome: 5000,
        totalExpenses: 3000,
        netCashFlow: 2000,
        transactionCount: 45,
        groupedBy: "none",
        groups: null,
        transfers: null,
        perCurrency: [],
      }),
      getLlmPeriodComparison: jest.fn().mockResolvedValue({
        period1: { start: "2025-12-01", end: "2025-12-31", total: 3000 },
        period2: { start: "2026-01-01", end: "2026-01-31", total: 3500 },
        totalChange: 500,
        totalChangePercent: 16.67,
        comparison: [],
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
      resolveByName: jest.fn(async (_uid: string, name: string) => {
        const byName: Record<
          string,
          { id: string; name: string; currencyCode: string }
        > = {
          checking: { id: "acc-1", name: "Checking", currencyCode: "USD" },
          savings: { id: "acc-2", name: "Savings", currencyCode: "USD" },
          brokerage: { id: "acc-3", name: "Brokerage", currencyCode: "USD" },
        };
        return byName[name.toLowerCase()];
      }),
      resolveAccountFilter: jest.fn(async (_uid: string, names?: string[]) => {
        if (!names || names.length === 0) return { accountIds: undefined };
        const byName: Record<string, string> = {
          checking: "acc-1",
          savings: "acc-2",
          brokerage: "acc-3",
        };
        const accountIds: string[] = [];
        const unresolved: string[] = [];
        for (const n of names) {
          const id = byName[n.toLowerCase()];
          if (id) accountIds.push(id);
          else unresolved.push(n);
        }
        if (unresolved.length > 0) {
          return { error: `Unknown account: ${unresolved.join(", ")}.` };
        }
        return { accountIds };
      }),
      findOne: jest.fn(async (_uid: string, id: string) => {
        const byId: Record<
          string,
          { id: string; name: string; currencyCode: string }
        > = {
          "acc-1": { id: "acc-1", name: "Checking", currencyCode: "USD" },
          "acc-2": { id: "acc-2", name: "Savings", currencyCode: "USD" },
          "acc-3": { id: "acc-3", name: "Brokerage", currencyCode: "USD" },
        };
        return byId[id];
      }),
      getLlmAccounts: jest.fn().mockResolvedValue({
        accounts: [
          {
            id: "acc-1",
            name: "Checking",
            type: "CHEQUING",
            balance: 5000,
            currentBalance: 5000,
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
      prepareCreateInvestmentSingle: jest
        .fn()
        .mockResolvedValue({ ...createInvestmentPreview }),
      prepareCreateInvestmentBulk: jest.fn().mockResolvedValue({
        okPreviews: [{ ...createInvestmentPreview }],
        okIndex: [0],
        previewRows: [{ status: "ok", accountName: "Brokerage" }],
        skipped: [],
      }),
      previewUpdateInvestmentTransaction: jest
        .fn()
        .mockResolvedValue({ ...updateInvestmentPreview }),
      prepareUpdateInvestmentBulk: jest.fn().mockResolvedValue({
        okRows: [
          {
            transactionId: "inv-tx-1",
            accountId: "acc-3",
            action: "SELL",
            transactionDate: "2026-02-01",
            securityId: "sec-1",
            fundingAccountId: null,
            quantity: 5,
            price: 160,
            commission: 0,
            exchangeRate: 1,
            description: null,
          },
        ],
        okIndex: [0],
        previewRows: [{ status: "ok", accountName: "Brokerage" }],
        skipped: [],
      }),
      previewDeleteInvestmentTransaction: jest
        .fn()
        .mockResolvedValue({ ...deleteInvestmentPreview }),
      prepareDeleteInvestmentBulk: jest.fn().mockResolvedValue({
        okRows: [{ transactionId: "inv-tx-1" }],
        okIndex: [0],
        previewRows: [{ status: "ok", accountName: "Brokerage" }],
        skipped: [],
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
        holdingsByAccount: [],
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
      previewUpdate: jest.fn().mockResolvedValue({
        transactionId: "tx-1",
        accountId: "acc-1",
        accountName: "Checking",
        amount: -30,
        transactionDate: "2026-02-01",
        payeeId: "payee-1",
        payeeName: "Starbucks",
        payeeMatched: true,
        payeeWillBeCreated: false,
        categoryId: "cat-1",
        categoryName: "Dining",
        description: null,
        currencyCode: "USD",
      }),
      previewDelete: jest.fn().mockResolvedValue({
        transactionId: "tx-1",
        accountName: "Checking",
        amount: -12.5,
        transactionDate: "2026-01-15",
        payeeName: "Starbucks",
        categoryName: "Dining",
        description: null,
        currencyCode: "USD",
      }),
      // Used by the prep service to auto-detect transfers on update.
      findOne: jest.fn().mockResolvedValue({
        id: "tx-1",
        isTransfer: false,
        linkedTransactionId: null,
      }),
    };

    payees = {
      findByName: jest.fn(async (_uid: string, name: string) => {
        const byName: Record<string, { id: string; name: string }> = {
          walmart: { id: "payee-1", name: "Walmart" },
          starbucks: { id: "payee-2", name: "Starbucks" },
        };
        return byName[name.toLowerCase()] ?? null;
      }),
      findAll: jest.fn().mockResolvedValue([
        { id: "payee-1", name: "Walmart" },
        { id: "payee-2", name: "Starbucks" },
      ]),
      search: jest.fn().mockResolvedValue([{ id: "payee-1", name: "Walmart" }]),
      previewCreate: jest.fn().mockResolvedValue({
        name: "Acme",
        defaultCategoryId: "cat-1",
        defaultCategoryName: "Dining",
      }),
      previewCreatePayee: jest.fn().mockResolvedValue({
        name: "Acme",
        defaultCategoryId: "cat-1",
        defaultCategoryName: "Dining",
      }),
      previewUpdatePayee: jest.fn().mockResolvedValue({
        payeeId: "payee-1",
        name: "Acme",
        defaultCategoryId: "cat-1",
        defaultCategoryName: "Dining",
      }),
      previewDeletePayee: jest.fn().mockResolvedValue({
        payeeId: "payee-1",
        name: "Walmart",
      }),
    };

    securities = {
      previewCreateSecurity: jest.fn().mockResolvedValue({
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK",
        exchange: "NASDAQ",
        currencyCode: "USD",
        isFavourite: false,
        quoteProvider: "yahoo",
        msnInstrumentId: null,
      }),
      previewUpdateSecurity: jest.fn().mockResolvedValue({
        securityId: "sec-1",
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK",
        exchange: "NASDAQ",
        currencyCode: "USD",
        isFavourite: true,
      }),
      previewDeleteSecurity: jest.fn().mockResolvedValue({
        securityId: "sec-1",
        symbol: "AAPL",
        name: "Apple Inc.",
      }),
      lookupSecuritiesForLlm: jest.fn().mockResolvedValue({
        query: "apple",
        count: 2,
        candidates: [
          {
            symbol: "AAPL",
            name: "Apple Inc.",
            exchange: "NASDAQ",
            securityType: "STOCK",
            currencyCode: "USD",
            provider: "yahoo",
            alreadyAdded: false,
          },
          {
            symbol: "APC.F",
            name: "Apple Inc.",
            exchange: "FRA",
            securityType: "STOCK",
            currencyCode: "EUR",
            provider: "yahoo",
            alreadyAdded: false,
          },
        ],
      }),
    };

    signing = {
      sign: jest.fn().mockReturnValue("signature-abc"),
    };

    // Category-split validation is a no-op by default; tests that exercise an
    // invalid sum override it to throw.
    splitService = {
      validateSplits: jest.fn(),
    };

    transfer = {
      isTransfer: jest.fn(
        (tx: { isTransfer?: boolean }) => tx.isTransfer === true,
      ),
      previewCreateTransfer: jest.fn().mockResolvedValue({
        fromAccountId: "acc-1",
        fromAccountName: "Checking",
        fromCurrencyCode: "USD",
        toAccountId: "acc-2",
        toAccountName: "Savings",
        toCurrencyCode: "USD",
        amount: 100,
        toAmount: 100,
        exchangeRate: 1,
        transactionDate: "2026-01-15",
        description: null,
      }),
      previewUpdateTransfer: jest.fn().mockResolvedValue({
        transactionId: "tx-1",
        fromAccountId: "acc-1",
        fromAccountName: "Checking",
        fromCurrencyCode: "USD",
        toAccountId: "acc-2",
        toAccountName: "Savings",
        toCurrencyCode: "USD",
        amount: 100,
        toAmount: 100,
        exchangeRate: 1,
        transactionDate: "2026-01-15",
        description: null,
      }),
    };

    builtInReports = {
      getSpendingByCategory: jest
        .fn()
        .mockResolvedValue({ categories: [], total: 0 }),
      getSpendingByPayee: jest.fn().mockResolvedValue({ payees: [], total: 0 }),
      getIncomeVsExpenses: jest
        .fn()
        .mockResolvedValue({ income: 5000, expenses: 3000, net: 2000 }),
      getMonthlySpendingTrend: jest.fn().mockResolvedValue({ months: [] }),
      getIncomeBySource: jest.fn().mockResolvedValue({ sources: [], total: 0 }),
      getSpendingAnomalies: jest.fn().mockResolvedValue({
        statistics: {},
        anomalies: [{ id: "tx-9" }, { id: "tx-10" }],
        counts: { total: 2 },
      }),
      getMonthlyComparison: jest.fn().mockResolvedValue({
        currentMonth: "2026-04",
        previousMonth: "2026-03",
        currentMonthLabel: "April 2026",
        previousMonthLabel: "March 2026",
        currency: "USD",
      }),
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
        { provide: SecuritiesService, useValue: securities },
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
        { provide: TransactionTransferService, useValue: transfer },
        { provide: TransactionSplitService, useValue: splitService },
        { provide: AiActionSigningService, useValue: signing },
        { provide: BuiltInReportsService, useValue: builtInReports },
        // Real prep + builder wrapping the mocked services, so the executor's
        // name resolution, preview building, and pending-action construction
        // (and signing.sign assertions) still run end-to-end.
        TransactionToolPrepService,
        PayeeToolPrepService,
        SecurityToolPrepService,
        AiActionBuilderService,
      ],
    }).compile();

    service = module.get<ToolExecutorService>(ToolExecutorService);
  });

  describe("tool routing", () => {
    it("list_transactions delegates to analytics.getLlmListTransactions", async () => {
      const result = await service.execute(userId, "list_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(analytics.getLlmListTransactions).toHaveBeenCalledWith(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        accountIds: undefined,
        categoryIds: undefined,
        payeeIds: undefined,
        searchText: undefined,
        minAmount: undefined,
        maxAmount: undefined,
        direction: undefined,
        groupBy: undefined,
        transfersOnly: undefined,
      });
      expect(result.sources[0].type).toBe("transactions");
      expect(result.summary).toContain("transactions");
    });

    it("list_transactions returns the summary only by default (no raw rows)", async () => {
      const result = await service.execute(userId, "list_transactions", {});

      expect(transactions.getLlmTransactionRows).not.toHaveBeenCalled();
      expect(result.data).not.toHaveProperty("transactions");
    });

    it("list_transactions attaches raw rows when includeTransactions is true", async () => {
      const result = await service.execute(userId, "list_transactions", {
        includeTransactions: true,
      });

      expect(transactions.getLlmTransactionRows).toHaveBeenCalled();
      expect(
        (result.data as { transactions: unknown[] }).transactions,
      ).toHaveLength(1);
      expect(result.summary).toContain("Included 1 raw row");
    });

    it("list_transactions computes a transfer rollup when transfersOnly is set", async () => {
      analytics.getLlmListTransactions.mockResolvedValueOnce({
        totalIncome: 0,
        totalExpenses: 0,
        netCashFlow: 0,
        transactionCount: 2,
        groupedBy: "none",
        groups: null,
        transfers: {
          totalInbound: 500,
          totalOutbound: 300,
          net: 200,
          accounts: [],
        },
        perCurrency: [],
      });

      const result = await service.execute(userId, "list_transactions", {
        transfersOnly: true,
      });

      expect(analytics.getLlmListTransactions).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ transfersOnly: true }),
      );
      expect(result.summary).toContain("Transfers: inbound 500.00");
    });

    it("list_transactions resolves account names to IDs", async () => {
      await service.execute(userId, "list_transactions", {
        accountNames: ["Checking"],
      });

      expect(accounts.resolveAccountFilter).toHaveBeenCalledWith(userId, [
        "Checking",
      ]);
      expect(analytics.getLlmListTransactions).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ accountIds: ["acc-1"] }),
      );
    });

    it("list_transactions surfaces a did-you-mean error for an unknown account name", async () => {
      const result = await service.execute(userId, "list_transactions", {
        accountNames: ["Chekcing"],
      });

      expect(result.isError).toBe(true);
      expect(result.summary).toContain("Unknown account: Chekcing");
      // The unknown name short-circuits before any data query runs.
      expect(analytics.getLlmListTransactions).not.toHaveBeenCalled();
    });

    it("list_transactions resolves category names via analytics helper", async () => {
      await service.execute(userId, "list_transactions", {
        categoryNames: ["Groceries"],
      });

      expect(analytics.resolveLlmCategoryIds).toHaveBeenCalledWith(userId, [
        "Groceries",
      ]);
      expect(analytics.getLlmListTransactions).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ categoryIds: ["cat-1"] }),
      );
    });

    it("list_transactions resolves payee names via payees.findByName", async () => {
      await service.execute(userId, "list_transactions", {
        payeeNames: ["Walmart"],
      });

      expect(payees.findByName).toHaveBeenCalledWith(userId, "Walmart");
      expect(analytics.getLlmListTransactions).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ payeeIds: ["payee-1"] }),
      );
    });

    it("list_transactions errors with a did-you-mean hint when a category name cannot be resolved", async () => {
      analytics.resolveLlmCategoryIds.mockResolvedValueOnce({
        categoryIds: [],
        unresolved: ["Grocries"],
        suggestions: ["Groceries"],
      });

      const result = await service.execute(userId, "list_transactions", {
        categoryNames: ["Grocries"],
      });

      expect(result.isError).toBe(true);
      expect(result.summary).toContain("Unknown category: Grocries");
      expect(result.summary).toContain("Did you mean 'Groceries'?");
      expect(analytics.getLlmListTransactions).not.toHaveBeenCalled();
    });

    it("list_transactions errors when a payee name cannot be resolved", async () => {
      const result = await service.execute(userId, "list_transactions", {
        payeeNames: ["Ghost"],
      });

      expect(result.isError).toBe(true);
      expect(result.summary).toContain("Ghost");
      expect(analytics.getLlmListTransactions).not.toHaveBeenCalled();
    });

    it("list_accounts delegates to accounts.getLlmAccounts", async () => {
      const result = await service.execute(userId, "list_accounts", {});

      expect(accounts.getLlmAccounts).toHaveBeenCalledWith(userId, {
        accountNames: undefined,
        accountIds: undefined,
        nameQuery: undefined,
        status: "open",
        accountTypes: undefined,
      });
      expect(result.sources[0].type).toBe("accounts");
      expect(result.summary).toContain("Net worth");
    });

    it("list_accounts passes status, accountTypes, accountIds, and nameQuery through", async () => {
      await service.execute(userId, "list_accounts", {
        status: "closed",
        accountTypes: ["CHEQUING", "SAVINGS"],
        accountIds: ["11111111-1111-4111-8111-111111111111"],
        nameQuery: "sav",
      });

      expect(accounts.getLlmAccounts).toHaveBeenCalledWith(userId, {
        accountNames: undefined,
        accountIds: ["11111111-1111-4111-8111-111111111111"],
        nameQuery: "sav",
        status: "closed",
        accountTypes: ["CHEQUING", "SAVINGS"],
      });
    });

    it("list_accounts supports 'all' status", async () => {
      await service.execute(userId, "list_accounts", { status: "all" });

      expect(accounts.getLlmAccounts).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ status: "all" }),
      );
    });

    it("list_categories delegates to categoriesService.getLlmCategories", async () => {
      const result = await service.execute(userId, "list_categories", {});

      expect(categories.getLlmCategories).toHaveBeenCalledWith(userId, {
        type: undefined,
        search: undefined,
      });
      expect(result.sources[0].type).toBe("categories");
      expect(result.summary).toContain("categor");
    });

    it("list_categories passes type and search through", async () => {
      await service.execute(userId, "list_categories", {
        type: "expense",
        search: "groc",
      });

      expect(categories.getLlmCategories).toHaveBeenCalledWith(userId, {
        type: "expense",
        search: "groc",
      });
    });

    it("generate_report type net_worth_history delegates to netWorthService.getLlmHistory", async () => {
      const result = await service.execute(userId, "generate_report", {
        type: "net_worth_history",
      });

      expect(netWorth.getLlmHistory).toHaveBeenCalledWith(
        userId,
        undefined,
        undefined,
      );
      expect(result.sources[0].type).toBe("net_worth");
      // data must be the bare array returned by getLlmHistory so it matches the
      // MCP server's generate_report net_worth_history payload exactly.
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

    it("list_investment_transactions delegates to investmentTransactions.getLlmInvestmentTransactions", async () => {
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
        "list_investment_transactions",
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

    it("list_investment_transactions resolves account names to IDs", async () => {
      await service.execute(userId, "list_investment_transactions", {
        accountNames: ["Checking"],
      });

      expect(accounts.resolveAccountFilter).toHaveBeenCalledWith(userId, [
        "Checking",
      ]);
      expect(
        investmentTransactions.getLlmInvestmentTransactions,
      ).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ accountIds: ["acc-1"] }),
      );
    });

    it("list_investment_transactions handles all-dates summary", async () => {
      const result = await service.execute(
        userId,
        "list_investment_transactions",
        {},
      );

      expect(result.sources[0].dateRange).toBe("all dates");
    });

    it("list_investment_transactions defaults groupBy to 'security' when omitted", async () => {
      await service.execute(userId, "list_investment_transactions", {});

      expect(
        investmentTransactions.getLlmInvestmentTransactions,
      ).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ groupBy: "security" }),
      );
    });

    it("list_capital_gains delegates to investmentTransactions.getLlmCapitalGains", async () => {
      const result = await service.execute(userId, "list_capital_gains", {
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

    it("list_capital_gains resolves account names and defaults groupBy to 'month'", async () => {
      await service.execute(userId, "list_capital_gains", {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        accountNames: ["Checking"],
      });

      expect(accounts.resolveAccountFilter).toHaveBeenCalledWith(userId, [
        "Checking",
      ]);
      expect(investmentTransactions.getLlmCapitalGains).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          accountIds: ["acc-1"],
          groupBy: "month",
        }),
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

    it("list_upcoming_bills delegates to scheduledTransactions.getLlmUpcomingBillsAndDeposits", async () => {
      const result = await service.execute(userId, "list_upcoming_bills", {});

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

    it("list_upcoming_bills passes through days, kind, and resolves account names", async () => {
      await service.execute(userId, "list_upcoming_bills", {
        days: 7,
        kind: "bill",
        accountNames: ["Checking"],
      });

      expect(accounts.resolveAccountFilter).toHaveBeenCalledWith(userId, [
        "Checking",
      ]);
      expect(
        scheduledTransactions.getLlmUpcomingBillsAndDeposits,
      ).toHaveBeenCalledWith(userId, {
        days: 7,
        kind: "bill",
        accountIds: ["acc-1"],
      });
    });

    it("list_payees returns all payees when no search is given", async () => {
      const result = await service.execute(userId, "list_payees", {});

      expect(payees.findAll).toHaveBeenCalledWith(userId);
      expect(payees.search).not.toHaveBeenCalled();
      expect(result.sources[0].type).toBe("payees");
      expect(result.summary).toContain("2 payees");
    });

    it("list_payees uses the search index when a query is given", async () => {
      const result = await service.execute(userId, "list_payees", {
        search: "wal",
      });

      expect(payees.search).toHaveBeenCalledWith(userId, "wal", 50);
      expect(result.summary).toContain('matching "wal"');
    });

    it("generate_report delegates to the matching built-in report", async () => {
      const result = await service.execute(userId, "generate_report", {
        type: "spending_by_category",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(builtInReports.getSpendingByCategory).toHaveBeenCalledWith(
        userId,
        "2026-01-01",
        "2026-01-31",
      );
      expect(result.sources[0].type).toBe("report");
      expect(result.summary).toContain("spending_by_category");
    });

    it("generate_report type spending_anomalies delegates to getSpendingAnomalies", async () => {
      const result = await service.execute(userId, "generate_report", {
        type: "spending_anomalies",
        months: 6,
      });

      expect(builtInReports.getSpendingAnomalies).toHaveBeenCalledWith(
        userId,
        6,
      );
      expect(result.sources[0].type).toBe("anomalies");
      expect(result.summary).toContain("2 spending anomalies");
    });

    it("generate_report type month_comparison delegates to getMonthlyComparison", async () => {
      const result = await service.execute(userId, "generate_report", {
        type: "month_comparison",
        month: "2026-04",
      });

      expect(builtInReports.getMonthlyComparison).toHaveBeenCalledWith(
        userId,
        "2026-04",
      );
      expect(result.sources[0].type).toBe("monthly_comparison");
      expect(result.summary).toContain("April 2026 vs March 2026");
    });

    it("calculate runs locally without hitting any service", async () => {
      const result = await service.execute(userId, "calculate", {
        operation: "sum",
        values: [1, 2, 3],
      });

      expect(analytics.getLlmListTransactions).not.toHaveBeenCalled();
      expect(accounts.getLlmAccounts).not.toHaveBeenCalled();
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
      const result = await service.execute(userId, "list_transactions", {
        startDate: "not-a-date",
        endDate: "2026-01-31",
      });

      expect(result.isError).toBe(true);
      expect(result.summary).toContain("Invalid input");
      expect(analytics.getLlmListTransactions).not.toHaveBeenCalled();
    });

    it("applies default date range when startDate and endDate are omitted", async () => {
      const result = await service.execute(userId, "list_transactions", {});

      expect(result.isError).toBeUndefined();
      expect(analytics.getLlmListTransactions).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          endDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      );
    });

    it("allows valid input and delegates to the analytics service", async () => {
      const result = await service.execute(userId, "list_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(result.isError).toBeUndefined();
      expect(analytics.getLlmListTransactions).toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("wraps thrown errors in a safe error result", async () => {
      analytics.getLlmListTransactions.mockRejectedValueOnce(new Error("boom"));

      const result = await service.execute(userId, "list_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(result.data).toEqual({
        error: "An error occurred while retrieving data.",
      });
      expect(result.summary).toContain("Error executing list_transactions");
      expect(result.isError).toBe(true);
    });
  });

  describe("manage_transactions (create, human-in-the-loop)", () => {
    it("single create returns a signed pending action and never persists", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "create",
        items: [
          {
            accountName: "Checking",
            amount: -12.5,
            date: "2026-01-15",
            payeeName: "Starbucks",
            categoryName: "Dining",
          },
        ],
      });

      expect(transactions.previewCreate).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ accountId: "acc-1", amount: -12.5 }),
      );
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
        payeeId: "payee-1",
      });
    });

    it("single create errors on an unknown account", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "create",
        items: [{ accountName: "Ghost", amount: -1, date: "2026-01-15" }],
      });
      expect(result.isError).toBe(true);
      expect(result.pendingAction).toBeUndefined();
    });

    it("single transfer (toAccountName present) builds a create_transfer card", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "create",
        items: [
          {
            fromAccountName: "Checking",
            toAccountName: "Savings",
            amount: 100,
            date: "2026-01-15",
          },
        ],
      });
      expect(transfer.previewCreateTransfer).toHaveBeenCalled();
      expect(result.pendingAction?.type).toBe("create_transfer");
    });

    it("single create with splits builds a create_transaction card carrying resolved splits", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "create",
        items: [
          {
            accountName: "Checking",
            amount: -100,
            date: "2026-01-15",
            splits: [
              { categoryName: "Groceries", amount: -60 },
              { categoryName: "Household", amount: -40, memo: "soap" },
            ],
          },
        ],
      });

      expect(splitService.validateSplits).toHaveBeenCalledWith(
        expect.any(Array),
        -100,
      );
      expect(transactions.create).toBeUndefined();
      expect(result.pendingAction?.type).toBe("create_transaction");
      const descriptor = result.pendingAction?.descriptor as {
        categoryId: string | null;
        splits?: Array<{
          categoryId: string;
          amount: number;
          memo: string | null;
        }>;
      };
      expect(descriptor.categoryId).toBeNull();
      expect(descriptor.splits).toEqual([
        { categoryId: "cat-1", amount: -60, memo: null },
        { categoryId: "cat-1", amount: -40, memo: "soap" },
      ]);
      expect(result.pendingAction?.preview.splits).toHaveLength(2);
      expect(result.summary).toContain("split transaction");
    });

    it("single update with splits builds an update_transaction card with splits", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "update",
        items: [
          {
            transactionId: "11111111-1111-4111-8111-111111111111",
            splits: [
              { categoryName: "Groceries", amount: -20 },
              { categoryName: "Household", amount: -10 },
            ],
          },
        ],
      });

      expect(splitService.validateSplits).toHaveBeenCalled();
      expect(result.pendingAction?.type).toBe("update_transaction");
      const descriptor = result.pendingAction?.descriptor as {
        categoryId: string | null;
        splits?: Array<{ categoryId: string; amount: number }>;
      };
      expect(descriptor.categoryId).toBeNull();
      expect(descriptor.splits).toHaveLength(2);
    });

    it("rejects an invalid split sum surfaced by validateSplits", async () => {
      splitService.validateSplits.mockImplementationOnce(() => {
        throw new Error("Split amounts must sum to the transaction amount");
      });
      const result = await service.execute(userId, "manage_transactions", {
        operation: "create",
        items: [
          {
            accountName: "Checking",
            amount: -100,
            date: "2026-01-15",
            splits: [
              { categoryName: "Groceries", amount: -60 },
              { categoryName: "Household", amount: -10 },
            ],
          },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.pendingAction).toBeUndefined();
    });

    it("rejects splits mixed into a multi-row batch", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "create",
        items: [
          {
            accountName: "Checking",
            amount: -100,
            date: "2026-01-15",
            splits: [
              { categoryName: "Groceries", amount: -60 },
              { categoryName: "Household", amount: -40 },
            ],
          },
          { accountName: "Checking", amount: -20, date: "2026-01-16" },
        ],
      });
      expect(result.isError).toBe(true);
    });

    it("bulk create (>= 6 items) builds one create_transactions card", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "create",
        items: Array.from({ length: 6 }, (_, i) => ({
          accountName: "Checking",
          amount: -10 - i,
          date: "2026-01-15",
        })),
      });
      expect(result.pendingActions).toHaveLength(1);
      expect(result.pendingActions?.[0].type).toBe("create_transactions");
    });

    it("create of 2-5 items stays per-item by default", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "create",
        items: [
          { accountName: "Checking", amount: -10, date: "2026-01-15" },
          { accountName: "Checking", amount: -20, date: "2026-01-16" },
        ],
      });
      expect(result.pendingActions).toHaveLength(2);
      expect(
        result.pendingActions?.every((a) => a.type === "create_transaction"),
      ).toBe(true);
    });

    it("create of 5 items stays per-item just below the bulk threshold", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "create",
        items: Array.from({ length: 5 }, (_, i) => ({
          accountName: "Checking",
          amount: -10 - i,
          date: "2026-01-15",
        })),
      });
      expect(result.pendingActions).toHaveLength(5);
      expect(
        result.pendingActions?.every((a) => a.type === "create_transaction"),
      ).toBe(true);
    });

    it("individual mode forces one card per row at 6+ items", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "create",
        items: Array.from({ length: 6 }, (_, i) => ({
          accountName: "Checking",
          amount: -10 - i,
          date: "2026-01-15",
        })),
        approvalMode: "individual",
      });
      expect(result.pendingActions).toHaveLength(6);
      expect(
        result.pendingActions?.every((a) => a.type === "create_transaction"),
      ).toBe(true);
    });

    it("bulk create (>= 6 items) splits standard and transfer rows into two cards", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "create",
        items: [
          ...Array.from({ length: 5 }, (_, i) => ({
            accountName: "Checking",
            amount: -10 - i,
            date: "2026-01-15",
          })),
          {
            fromAccountName: "Checking",
            toAccountName: "Savings",
            amount: 100,
            date: "2026-01-16",
          },
        ],
      });
      const types = (result.pendingActions ?? []).map((a) => a.type).sort();
      expect(types).toEqual(["batch_actions", "create_transactions"]);
    });

    it("errors when none of the bulk create rows can be prepared", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "create",
        items: [
          { accountName: "Ghost", amount: -10, date: "2026-01-15" },
          { accountName: "Ghost", amount: -20, date: "2026-01-16" },
        ],
      });
      expect(result.isError).toBe(true);
    });

    it("does not leak the signature into the LLM-facing data", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "create",
        items: [{ accountName: "Checking", amount: -12.5, date: "2026-01-15" }],
      });
      expect(JSON.stringify(result.data)).not.toContain("signature-abc");
      expect((result.data as { status: string }).status).toBe("preview_shown");
    });
  });

  describe("manage_transactions (update, human-in-the-loop)", () => {
    const TXID = "11111111-1111-4111-8111-111111111111";

    it("category-only change resolves the category and signs an update card", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "update",
        items: [{ transactionId: TXID, categoryName: "Dining" }],
      });

      expect(transactions.previewUpdate).toHaveBeenCalledWith(
        userId,
        TXID,
        expect.objectContaining({ categoryId: "cat-1" }),
      );
      expect(result.pendingAction?.type).toBe("update_transaction");
      expect(JSON.stringify(result.data)).not.toContain("signature-abc");
    });

    it("auto-detects a transfer and builds an update_transfer card", async () => {
      transactions.findOne.mockResolvedValueOnce({
        id: TXID,
        isTransfer: true,
        linkedTransactionId: "tx-2",
      });
      const result = await service.execute(userId, "manage_transactions", {
        operation: "update",
        items: [{ transactionId: TXID, amount: 100 }],
      });
      expect(transfer.previewUpdateTransfer).toHaveBeenCalled();
      expect(result.pendingAction?.type).toBe("update_transfer");
    });

    it("surfaces a 4xx preview error", async () => {
      transactions.previewUpdate.mockRejectedValueOnce(
        new BadRequestException("Split transactions can't be edited here."),
      );
      const result = await service.execute(userId, "manage_transactions", {
        operation: "update",
        items: [{ transactionId: TXID, amount: -5 }],
      });
      expect(result.isError).toBe(true);
    });

    const TXID2 = "22222222-2222-4222-8222-222222222222";

    it("bulk update (>= 6 items) builds one batch_actions card", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "update",
        items: Array.from({ length: 6 }, (_, i) => ({
          transactionId: TXID,
          amount: -5 - i,
        })),
      });
      expect(result.pendingAction?.type).toBe("batch_actions");
      expect(
        (result.pendingAction?.descriptor as { operation?: string }).operation,
      ).toBe("update");
    });

    it("update of 2-5 items stays per-item by default", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "update",
        items: [
          { transactionId: TXID, amount: -5 },
          { transactionId: TXID2, amount: -6 },
        ],
      });
      expect(result.pendingActions).toHaveLength(2);
    });

    it("individual update returns one card per item", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "update",
        items: [
          { transactionId: TXID, amount: -5 },
          { transactionId: TXID2, amount: -6 },
        ],
        approvalMode: "individual",
      });
      expect(result.pendingActions).toHaveLength(2);
    });

    it("bulk update errors when none can be prepared", async () => {
      transactions.previewUpdate.mockRejectedValue(
        new BadRequestException("nope"),
      );
      const result = await service.execute(userId, "manage_transactions", {
        operation: "update",
        items: [
          { transactionId: TXID, amount: -5 },
          { transactionId: TXID2, amount: -6 },
        ],
        approvalMode: "individual",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("manage_transactions (delete, human-in-the-loop)", () => {
    const TXID = "11111111-1111-4111-8111-111111111111";

    it("single delete signs a delete card", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "delete",
        items: [{ transactionId: TXID }],
      });
      expect(transactions.previewDelete).toHaveBeenCalledWith(userId, TXID);
      expect(result.pendingAction?.type).toBe("delete_transaction");
    });

    it("bulk delete (>= 6 items) builds one batch_actions card", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "delete",
        items: Array.from({ length: 6 }, () => ({
          transactionId: "11111111-1111-4111-8111-111111111111",
        })),
      });
      expect(result.pendingAction?.type).toBe("batch_actions");
    });

    it("delete of 2-5 items stays per-item by default", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "delete",
        items: [
          { transactionId: "11111111-1111-4111-8111-111111111111" },
          { transactionId: "22222222-2222-4222-8222-222222222222" },
        ],
      });
      expect(result.pendingActions).toHaveLength(2);
    });

    it("individual delete returns one card per item", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "delete",
        items: [
          { transactionId: "11111111-1111-4111-8111-111111111111" },
          { transactionId: "22222222-2222-4222-8222-222222222222" },
        ],
        approvalMode: "individual",
      });
      expect(result.pendingActions).toHaveLength(2);
    });

    it("individual delete errors when none can be prepared", async () => {
      transactions.previewDelete.mockRejectedValue(
        new BadRequestException("nope"),
      );
      const result = await service.execute(userId, "manage_transactions", {
        operation: "delete",
        items: [
          { transactionId: "11111111-1111-4111-8111-111111111111" },
          { transactionId: "22222222-2222-4222-8222-222222222222" },
        ],
        approvalMode: "individual",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("manage_investment_transactions (create, human-in-the-loop)", () => {
    it("single create resolves names and returns a signed pending action", async () => {
      const result = await service.execute(
        userId,
        "manage_investment_transactions",
        {
          operation: "create",
          items: [
            {
              accountName: "Brokerage",
              action: "BUY",
              date: "2026-01-15",
              security: "AAPL",
              quantity: 10,
              price: 150,
              commission: 9.99,
            },
          ],
        },
      );

      expect(
        investmentTransactions.prepareCreateInvestmentSingle,
      ).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          accountName: "Brokerage",
          action: "BUY",
          date: "2026-01-15",
          securityQuery: "AAPL",
          quantity: 10,
          price: 150,
          commission: 9.99,
        }),
      );
      expect(result.pendingAction?.type).toBe("create_investment_transaction");
      expect(result.pendingAction?.signature).toBe("signature-abc");
      expect(result.pendingAction?.preview).toMatchObject({
        accountName: "Brokerage",
        investmentAction: "BUY",
        symbol: "AAPL",
        totalAmount: 1509.99,
      });
      expect(JSON.stringify(result.data)).not.toContain("signature-abc");
    });

    it("forwards an explicit exchangeRate to the create prep (issue #744)", async () => {
      await service.execute(userId, "manage_investment_transactions", {
        operation: "create",
        items: [
          {
            accountName: "Brokerage",
            action: "BUY",
            date: "2026-01-15",
            security: "AAPL",
            quantity: 10,
            price: 150,
            exchangeRate: 4.2514,
          },
        ],
      });

      expect(
        investmentTransactions.prepareCreateInvestmentSingle,
      ).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ exchangeRate: 4.2514 }),
      );
    });

    it("single create surfaces a 4xx preview error without a pending action", async () => {
      investmentTransactions.prepareCreateInvestmentSingle.mockRejectedValueOnce(
        new BadRequestException(
          '"Apple" matches multiple securities. Use the exact ticker symbol.',
        ),
      );
      const result = await service.execute(
        userId,
        "manage_investment_transactions",
        {
          operation: "create",
          items: [
            {
              accountName: "Brokerage",
              action: "BUY",
              date: "2026-01-15",
              security: "Apple",
              quantity: 1,
              price: 1,
            },
          ],
        },
      );
      expect(result.isError).toBe(true);
      expect(result.summary).toContain("multiple securities");
      expect(result.pendingAction).toBeUndefined();
    });

    it("bulk create (>= 6 items) builds one create_investment_transactions card", async () => {
      investmentTransactions.prepareCreateInvestmentBulk.mockResolvedValueOnce({
        okPreviews: Array.from({ length: 6 }, () => ({
          ...createInvestmentPreview,
        })),
        okIndex: [0, 1, 2, 3, 4, 5],
        previewRows: Array.from({ length: 6 }, () => ({
          status: "ok",
          accountName: "Brokerage",
        })),
        skipped: [],
      });
      const result = await service.execute(
        userId,
        "manage_investment_transactions",
        {
          operation: "create",
          items: Array.from({ length: 6 }, (_, i) => ({
            accountName: "Brokerage",
            action: "BUY",
            date: "2026-01-15",
            security: "AAPL",
            quantity: 10 + i,
            price: 150,
          })),
        },
      );

      expect(result.pendingAction?.type).toBe("create_investment_transactions");
      const descriptor = result.pendingAction?.descriptor;
      if (descriptor?.type !== "create_investment_transactions")
        throw new Error("expected create_investment_transactions descriptor");
      expect(descriptor.rows).toHaveLength(6);
      expect(JSON.stringify(result.data)).not.toContain("signature-abc");
    });

    it("bulk create (individual mode) builds one card per ok row", async () => {
      investmentTransactions.prepareCreateInvestmentBulk.mockResolvedValueOnce({
        okPreviews: [
          { ...createInvestmentPreview },
          { ...createInvestmentPreview, transactionDate: "2026-01-16" },
        ],
        okIndex: [0, 1],
        previewRows: [
          { status: "ok", accountName: "Brokerage" },
          { status: "ok", accountName: "Brokerage" },
        ],
        skipped: [],
      });
      const result = await service.execute(
        userId,
        "manage_investment_transactions",
        {
          operation: "create",
          items: [
            {
              accountName: "Brokerage",
              action: "BUY",
              date: "2026-01-15",
              security: "AAPL",
              quantity: 10,
              price: 150,
            },
            {
              accountName: "Brokerage",
              action: "BUY",
              date: "2026-01-16",
              security: "AAPL",
              quantity: 5,
              price: 151,
            },
          ],
          approvalMode: "individual",
        },
      );

      expect(result.pendingActions).toHaveLength(2);
      expect(
        result.pendingActions?.every(
          (a) => a.type === "create_investment_transaction",
        ),
      ).toBe(true);
    });

    it("bulk create errors when no row resolves", async () => {
      investmentTransactions.prepareCreateInvestmentBulk.mockResolvedValueOnce({
        okPreviews: [],
        okIndex: [],
        previewRows: [{ status: "error", error: "Unknown account: Ghost" }],
        skipped: [{ index: 0, reason: "Unknown account: Ghost" }],
      });
      const result = await service.execute(
        userId,
        "manage_investment_transactions",
        {
          operation: "create",
          items: [
            {
              accountName: "Ghost",
              action: "BUY",
              date: "2026-01-15",
              security: "AAPL",
              quantity: 1,
              price: 1,
            },
            {
              accountName: "Ghost",
              action: "BUY",
              date: "2026-01-16",
              security: "AAPL",
              quantity: 1,
              price: 1,
            },
          ],
        },
      );
      expect(result.isError).toBe(true);
      expect(result.pendingAction).toBeUndefined();
      expect(result.pendingActions).toBeUndefined();
    });

    it("rejects a batch over 25 items at the input schema", async () => {
      const items = Array.from({ length: 26 }, () => ({
        accountName: "Brokerage",
        action: "BUY",
        date: "2026-01-15",
        security: "AAPL",
        quantity: 1,
        price: 1,
      }));
      const result = await service.execute(
        userId,
        "manage_investment_transactions",
        { operation: "create", items },
      );
      expect(result.isError).toBe(true);
      expect(result.pendingAction).toBeUndefined();
      expect(
        investmentTransactions.prepareCreateInvestmentBulk,
      ).not.toHaveBeenCalled();
    });
  });

  describe("manage_investment_transactions (update, human-in-the-loop)", () => {
    const TXID = "11111111-1111-4111-8111-111111111111";

    it("single update returns a signed update pending action", async () => {
      const result = await service.execute(
        userId,
        "manage_investment_transactions",
        {
          operation: "update",
          items: [{ transactionId: TXID, action: "SELL", quantity: 5 }],
        },
      );

      expect(
        investmentTransactions.previewUpdateInvestmentTransaction,
      ).toHaveBeenCalledWith(
        userId,
        TXID,
        expect.objectContaining({ action: "SELL", quantity: 5 }),
      );
      expect(result.pendingAction?.type).toBe("update_investment_transaction");
      expect(result.pendingAction?.preview).toMatchObject({
        symbol: "AAPL",
        investmentAction: "SELL",
      });
    });

    it("single update surfaces a 4xx preview error", async () => {
      investmentTransactions.previewUpdateInvestmentTransaction.mockRejectedValueOnce(
        new BadRequestException("Investment transaction not found."),
      );
      const result = await service.execute(
        userId,
        "manage_investment_transactions",
        {
          operation: "update",
          items: [{ transactionId: TXID, quantity: 5 }],
        },
      );
      expect(result.isError).toBe(true);
      expect(result.pendingAction).toBeUndefined();
    });

    it("bulk update (>= 6 items) builds a batch update card", async () => {
      const result = await service.execute(
        userId,
        "manage_investment_transactions",
        {
          operation: "update",
          items: Array.from({ length: 6 }, () => ({
            transactionId: TXID,
            quantity: 5,
          })),
        },
      );
      expect(
        investmentTransactions.prepareUpdateInvestmentBulk,
      ).toHaveBeenCalled();
      expect(result.pendingAction?.type).toBe("batch_actions");
    });

    it("bulk update (individual mode) builds one card per row", async () => {
      const result = await service.execute(
        userId,
        "manage_investment_transactions",
        {
          operation: "update",
          items: [
            { transactionId: TXID, quantity: 5 },
            {
              transactionId: "22222222-2222-4222-8222-222222222222",
              quantity: 6,
            },
          ],
          approvalMode: "individual",
        },
      );
      expect(result.pendingActions).toHaveLength(2);
      expect(
        result.pendingActions?.every(
          (a) => a.type === "update_investment_transaction",
        ),
      ).toBe(true);
    });

    it("bulk update (individual mode) skips failing rows and surfaces the count", async () => {
      investmentTransactions.previewUpdateInvestmentTransaction
        .mockResolvedValueOnce({ ...updateInvestmentPreview })
        .mockRejectedValueOnce(new BadRequestException("bad row"));
      const result = await service.execute(
        userId,
        "manage_investment_transactions",
        {
          operation: "update",
          items: [
            { transactionId: TXID, quantity: 5 },
            {
              transactionId: "22222222-2222-4222-8222-222222222222",
              quantity: 6,
            },
          ],
          approvalMode: "individual",
        },
      );
      expect(result.pendingActions).toHaveLength(1);
      expect(result.summary).toContain("1 skipped");
    });

    it("bulk update (>= 6 items) errors when every row is skipped", async () => {
      investmentTransactions.prepareUpdateInvestmentBulk.mockResolvedValueOnce({
        okRows: [],
        okIndex: [],
        previewRows: [{ status: "error", error: "nope" }],
        skipped: [{ index: 0, reason: "nope" }],
      });
      const result = await service.execute(
        userId,
        "manage_investment_transactions",
        {
          operation: "update",
          items: Array.from({ length: 6 }, () => ({
            transactionId: TXID,
            quantity: 5,
          })),
        },
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("manage_investment_transactions (delete, human-in-the-loop)", () => {
    const TXID = "11111111-1111-4111-8111-111111111111";

    it("single delete returns a signed delete pending action", async () => {
      const result = await service.execute(
        userId,
        "manage_investment_transactions",
        { operation: "delete", items: [{ transactionId: TXID }] },
      );

      expect(
        investmentTransactions.previewDeleteInvestmentTransaction,
      ).toHaveBeenCalledWith(userId, TXID);
      expect(result.pendingAction?.type).toBe("delete_investment_transaction");
      expect(result.pendingAction?.preview).toMatchObject({ symbol: "AAPL" });
    });

    it("single delete surfaces a 4xx preview error", async () => {
      investmentTransactions.previewDeleteInvestmentTransaction.mockRejectedValueOnce(
        new BadRequestException("Investment transaction not found."),
      );
      const result = await service.execute(
        userId,
        "manage_investment_transactions",
        { operation: "delete", items: [{ transactionId: TXID }] },
      );
      expect(result.isError).toBe(true);
      expect(result.pendingAction).toBeUndefined();
    });

    it("bulk delete (>= 6 items) builds a batch delete card", async () => {
      const result = await service.execute(
        userId,
        "manage_investment_transactions",
        {
          operation: "delete",
          items: Array.from({ length: 6 }, () => ({ transactionId: TXID })),
        },
      );
      expect(
        investmentTransactions.prepareDeleteInvestmentBulk,
      ).toHaveBeenCalled();
      expect(result.pendingAction?.type).toBe("batch_actions");
    });

    it("bulk delete (individual mode) builds one card per row", async () => {
      const result = await service.execute(
        userId,
        "manage_investment_transactions",
        {
          operation: "delete",
          items: [
            { transactionId: TXID },
            { transactionId: "22222222-2222-4222-8222-222222222222" },
          ],
          approvalMode: "individual",
        },
      );
      expect(result.pendingActions).toHaveLength(2);
      expect(
        result.pendingActions?.every(
          (a) => a.type === "delete_investment_transaction",
        ),
      ).toBe(true);
    });

    it("bulk delete (bulk mode) errors when every row is skipped", async () => {
      investmentTransactions.prepareDeleteInvestmentBulk.mockResolvedValueOnce({
        okRows: [],
        okIndex: [],
        previewRows: [{ status: "error", error: "gone" }],
        skipped: [{ index: 0, reason: "gone" }],
      });
      const result = await service.execute(
        userId,
        "manage_investment_transactions",
        {
          operation: "delete",
          items: Array.from({ length: 6 }, () => ({ transactionId: TXID })),
        },
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("lookup_securities (read-only)", () => {
    it("returns the candidate list and a source, with no pending action", async () => {
      const result = await service.execute(userId, "lookup_securities", {
        query: "apple",
      });

      expect(securities.lookupSecuritiesForLlm).toHaveBeenCalledWith(userId, {
        query: "apple",
        exchange: undefined,
        provider: undefined,
      });
      expect(result.pendingAction).toBeUndefined();
      expect(result.isError).toBeFalsy();
      const data = result.data as { count: number };
      expect(data.count).toBe(2);
      expect(result.sources[0].type).toBe("security_lookup");
    });

    it("surfaces a 4xx lookup error", async () => {
      securities.lookupSecuritiesForLlm.mockRejectedValueOnce(
        new BadRequestException("Provide a ticker symbol or security name."),
      );
      const result = await service.execute(userId, "lookup_securities", {
        query: "x",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("manage_payees (human-in-the-loop)", () => {
    it("create returns a signed pending action", async () => {
      const result = await service.execute(userId, "manage_payees", {
        operation: "create",
        items: [{ name: "Acme", categoryName: "Dining" }],
      });

      expect(payees.previewCreatePayee).toHaveBeenCalledWith(userId, {
        name: "Acme",
        categoryName: "Dining",
      });
      expect(result.pendingAction?.type).toBe("create_payee");
      expect(result.pendingAction?.preview).toMatchObject({
        name: "Acme",
        categoryName: "Dining",
      });
    });

    it("update returns a signed pending action", async () => {
      const result = await service.execute(userId, "manage_payees", {
        operation: "update",
        items: [{ name: "Acme", newName: "Acme Inc" }],
      });

      expect(payees.previewUpdatePayee).toHaveBeenCalled();
      expect(result.pendingAction?.type).toBe("update_payee");
    });

    it("delete returns a signed pending action", async () => {
      const result = await service.execute(userId, "manage_payees", {
        operation: "delete",
        items: [{ name: "Walmart" }],
      });

      expect(payees.previewDeletePayee).toHaveBeenCalled();
      expect(result.pendingAction?.type).toBe("delete_payee");
    });

    it("bulk create returns one batch pending action", async () => {
      const result = await service.execute(userId, "manage_payees", {
        operation: "create",
        items: [{ name: "Acme", categoryName: "Dining" }, { name: "Beta" }],
      });

      expect(result.pendingAction?.type).toBe("batch_actions");
      expect(
        (result.pendingAction?.descriptor as { operation?: string }).operation,
      ).toBe("create_payee");
    });

    it("bulk update returns one batch pending action", async () => {
      const result = await service.execute(userId, "manage_payees", {
        operation: "update",
        items: [
          { name: "Acme", newName: "Acme Inc" },
          { name: "Beta", newName: "Beta Inc" },
        ],
      });
      expect(
        (result.pendingAction?.descriptor as { operation?: string }).operation,
      ).toBe("update_payee");
    });

    it("individual update returns one card per item", async () => {
      const result = await service.execute(userId, "manage_payees", {
        operation: "update",
        items: [
          { name: "Acme", newName: "Acme Inc" },
          { name: "Beta", newName: "Beta Inc" },
        ],
        approvalMode: "individual",
      });
      expect(result.pendingActions).toHaveLength(2);
    });

    it("bulk delete returns one batch pending action", async () => {
      const result = await service.execute(userId, "manage_payees", {
        operation: "delete",
        items: [{ name: "Acme" }, { name: "Beta" }],
      });
      expect(
        (result.pendingAction?.descriptor as { operation?: string }).operation,
      ).toBe("delete_payee");
    });

    it("individual delete returns one card per item", async () => {
      const result = await service.execute(userId, "manage_payees", {
        operation: "delete",
        items: [{ name: "Acme" }, { name: "Beta" }],
        approvalMode: "individual",
      });
      expect(result.pendingActions).toHaveLength(2);
    });

    it("bulk create reports skipped rows that fail to prepare", async () => {
      payees.previewCreatePayee
        .mockResolvedValueOnce({
          name: "Acme",
          defaultCategoryId: null,
          defaultCategoryName: null,
        })
        .mockRejectedValueOnce(new BadRequestException("dup"));

      const result = await service.execute(userId, "manage_payees", {
        operation: "create",
        items: [{ name: "Acme" }, { name: "Dup" }],
      });
      expect(result.pendingAction?.type).toBe("batch_actions");
      expect(result.summary).toContain("skipped");
    });

    it("errors when no payee could be prepared", async () => {
      payees.previewCreatePayee.mockRejectedValue(
        new BadRequestException("dup"),
      );
      const result = await service.execute(userId, "manage_payees", {
        operation: "create",
        items: [{ name: "A" }, { name: "B" }],
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("manage_securities (human-in-the-loop)", () => {
    it("create looks the security up and returns a signed pending action", async () => {
      const result = await service.execute(userId, "manage_securities", {
        operation: "create",
        items: [{ query: "AAPL" }],
      });

      expect(securities.previewCreateSecurity).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ query: "AAPL" }),
      );
      expect(result.pendingAction?.type).toBe("create_security");
      expect(result.pendingAction?.signature).toBe("signature-abc");
      expect(result.pendingAction?.descriptor).toMatchObject({
        type: "create_security",
        symbol: "AAPL",
        name: "Apple Inc.",
        exchange: "NASDAQ",
        currencyCode: "USD",
      });
      expect(result.pendingAction?.preview).toMatchObject({
        symbol: "AAPL",
        securityName: "Apple Inc.",
        securityType: "STOCK",
        exchange: "NASDAQ",
        securityCurrency: "USD",
      });
    });

    it("update returns a signed update_security pending action", async () => {
      const result = await service.execute(userId, "manage_securities", {
        operation: "update",
        items: [{ symbol: "AAPL", isFavourite: true }],
      });
      expect(securities.previewUpdateSecurity).toHaveBeenCalled();
      expect(result.pendingAction?.type).toBe("update_security");
    });

    it("delete returns a signed delete_security pending action", async () => {
      const result = await service.execute(userId, "manage_securities", {
        operation: "delete",
        items: [{ symbol: "AAPL" }],
      });
      expect(securities.previewDeleteSecurity).toHaveBeenCalled();
      expect(result.pendingAction?.type).toBe("delete_security");
    });

    it("bulk create returns one batch pending action", async () => {
      const result = await service.execute(userId, "manage_securities", {
        operation: "create",
        items: [{ query: "AAPL" }, { query: "MSFT" }],
      });
      expect(result.pendingAction?.type).toBe("batch_actions");
      expect(
        (result.pendingAction?.descriptor as { operation?: string }).operation,
      ).toBe("create_security");
    });

    it("bulk update returns one batch pending action", async () => {
      const result = await service.execute(userId, "manage_securities", {
        operation: "update",
        items: [
          { symbol: "AAPL", isFavourite: true },
          { symbol: "MSFT", isFavourite: true },
        ],
      });
      expect(
        (result.pendingAction?.descriptor as { operation?: string }).operation,
      ).toBe("update_security");
    });

    it("individual update returns one card per item", async () => {
      const result = await service.execute(userId, "manage_securities", {
        operation: "update",
        items: [
          { symbol: "AAPL", isFavourite: true },
          { symbol: "MSFT", isFavourite: true },
        ],
        approvalMode: "individual",
      });
      expect(result.pendingActions).toHaveLength(2);
    });

    it("bulk delete returns one batch pending action", async () => {
      const result = await service.execute(userId, "manage_securities", {
        operation: "delete",
        items: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
      });
      expect(
        (result.pendingAction?.descriptor as { operation?: string }).operation,
      ).toBe("delete_security");
    });

    it("individual delete returns one card per item", async () => {
      const result = await service.execute(userId, "manage_securities", {
        operation: "delete",
        items: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
        approvalMode: "individual",
      });
      expect(result.pendingActions).toHaveLength(2);
    });

    it("bulk create reports skipped securities that fail to resolve", async () => {
      securities.previewCreateSecurity
        .mockResolvedValueOnce({
          symbol: "AAPL",
          name: "Apple Inc.",
          securityType: "STOCK",
          exchange: "NASDAQ",
          currencyCode: "USD",
          isFavourite: false,
          quoteProvider: "yahoo",
          msnInstrumentId: null,
        })
        .mockRejectedValueOnce(new BadRequestException("not found"));

      const result = await service.execute(userId, "manage_securities", {
        operation: "create",
        items: [{ query: "AAPL" }, { query: "ZZZZ" }],
      });
      expect(result.pendingAction?.type).toBe("batch_actions");
      expect(result.summary).toContain("skipped");
    });

    it("errors when no security could be prepared", async () => {
      securities.previewCreateSecurity.mockRejectedValue(
        new BadRequestException("not found"),
      );
      const result = await service.execute(userId, "manage_securities", {
        operation: "create",
        items: [{ query: "A" }, { query: "B" }],
      });
      expect(result.isError).toBe(true);
    });

    it("errors when no security update could be prepared", async () => {
      securities.previewUpdateSecurity.mockRejectedValue(
        new BadRequestException("not found"),
      );
      const result = await service.execute(userId, "manage_securities", {
        operation: "update",
        items: [{ symbol: "A" }, { symbol: "B" }],
      });
      expect(result.isError).toBe(true);
    });

    it("errors when no security delete could be prepared", async () => {
      securities.previewDeleteSecurity.mockRejectedValue(
        new BadRequestException("not found"),
      );
      const result = await service.execute(userId, "manage_securities", {
        operation: "delete",
        items: [{ symbol: "A" }, { symbol: "B" }],
      });
      expect(result.isError).toBe(true);
    });

    it("surfaces a 4xx lookup failure as a tool error without a pending action", async () => {
      securities.previewCreateSecurity.mockRejectedValueOnce(
        new BadRequestException('No security found matching "ZZZZ".'),
      );

      const result = await service.execute(userId, "manage_securities", {
        operation: "create",
        items: [{ query: "ZZZZ" }],
      });

      expect(result.isError).toBe(true);
      expect(result.pendingAction).toBeUndefined();
    });
  });
});
