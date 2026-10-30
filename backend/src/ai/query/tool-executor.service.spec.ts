import {
  SharedReviewService,
  SHARED_LEDGER_TOOLS,
} from "../../shared-expenses/shared-review.service";
import { sharedReviewProvider } from "../../shared-expenses/__fixtures__/shared-review";
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, HttpException } from "@nestjs/common";
import { ToolExecutorService } from "./tool-executor.service";
import { AccountsService } from "../../accounts/accounts.service";
import { CategoriesService } from "../../categories/categories.service";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { NetWorthService } from "../../net-worth/net-worth.service";
import { BudgetReportsService } from "../../budgets/budget-reports.service";
import { PortfolioService } from "../../securities/portfolio.service";
import { SecuritiesService } from "../../securities/securities.service";
import { BuiltInReportsService } from "../../built-in-reports/built-in-reports.service";
import { ExchangeRateService } from "../../currencies/exchange-rate.service";
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
import { AttachmentToolPrepService } from "../../attachments/attachment-tool-prep.service";
import { RelayAttachmentStore } from "../relay/relay-attachment.store";
import { AttachmentDto } from "./dto/ai-query.dto";
import { AiReviewWorkService } from "../../ai-review/ai-review-work.service";
import { EmailReceiptParserToolsService } from "../../email-receipts/parsers/email-receipt-parser-tools.service";
import { SeriesFetchError } from "../../bonds/bond-adapter";
import { BondSeriesService } from "../../bonds/bond-series.service";
import { WarrantiesService } from "../../warranties/warranties.service";
import { LlmWarrantyList } from "../../warranties/warranty-llm-shape";
import { TransactionRuleToolPrepService } from "../../transaction-rules/rule-tool-prep.service";

describe("ToolExecutorService", () => {
  let service: ToolExecutorService;
  let sharedReview: jest.Mocked<Pick<SharedReviewService, "annotate">>;
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
  let exchangeRates: { convertOnDate: jest.Mock };
  let bondSeries: { fetchSeries: jest.Mock };
  let warranties: {
    getLlmWarranties: jest.MockedFunction<
      WarrantiesService["getLlmWarranties"]
    >;
  };
  let attachmentPrep: Record<string, jest.Mock>;
  let attachmentStore: Record<string, jest.Mock>;

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
        knownIncomeSubtotal: 5000,
        knownExpensesSubtotal: 3000,
        totalsCurrency: "USD",
        fxComplete: true,
        missingRatePairs: [],
        transactionCount: 45,
        groupedBy: "none",
        groups: null,
        transfers: null,
        perCurrency: [],
      }),
      getLlmPeriodComparison: jest.fn().mockResolvedValue({
        period1: {
          start: "2025-12-01",
          end: "2025-12-31",
          total: 3000,
          knownSubtotal: 3000,
        },
        period2: {
          start: "2026-01-01",
          end: "2026-01-31",
          total: 3500,
          knownSubtotal: 3500,
        },
        totalChange: 500,
        totalChangePercent: 16.67,
        totalsCurrency: "USD",
        fxComplete: true,
        missingRatePairs: [],
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
            balanceInDefaultCurrency: 5000,
            currentBalanceInDefaultCurrency: 5000,
            exchangeRate: 1,
          },
          {
            id: "acc-2",
            name: "Euro Savings",
            type: "SAVINGS",
            balance: 1000,
            currentBalance: 1000,
            currency: "EUR",
            balanceInDefaultCurrency: 1085.5,
            currentBalanceInDefaultCurrency: 1085.5,
            exchangeRate: 1.0855,
          },
          {
            id: "acc-3",
            name: "Yen Cash",
            type: "CASH",
            balance: 20000,
            currentBalance: 20000,
            currency: "JPY",
            balanceInDefaultCurrency: null,
            currentBalanceInDefaultCurrency: null,
            exchangeRate: null,
          },
        ],
        totalAssets: 20000,
        totalLiabilities: 1200,
        netWorth: 18800,
        knownAssetsSubtotal: 20000,
        knownLiabilitiesSubtotal: 1200,
        knownNetWorthSubtotal: 18800,
        fxComplete: true,
        pricesComplete: true,
        valuationComplete: true,
        unpricedSecurityIds: [],
        unpricedSymbols: [],
        defaultCurrency: "USD",
        missingRatePairs: ["JPY->USD"],
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
        incomeByCurrency: {},
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
          realizedGainComplete: true,
          realizedGainKnownSubtotal: null,
          currency: "CAD",
          fxComplete: true,
          missingRatePairs: [],
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
            realizedGainComplete: true,
            realizedGainKnownSubtotal: null,
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
        // The real method always returns these two: they are what tells the
        // model whether the totals beside them are complete (recheck RR2-007).
        // A mock without them describes a shape the service cannot produce.
        fxComplete: true,
        missingRatePairs: [],
        pricesComplete: true,
        unpricedSymbols: [],
        valuationComplete: true,
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
        totalsCurrency: "USD",
        amountsComplete: true,
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
      getLlmPayees: jest.fn().mockResolvedValue({
        payees: [
          { id: "payee-1", name: "Walmart" },
          { id: "payee-2", name: "Starbucks" },
        ],
        totalCount: 2,
        truncated: false,
      }),
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

    warranties = {
      getLlmWarranties: jest.fn().mockResolvedValue(warrantyList()),
    };

    bondSeries = {
      fetchSeries: jest.fn().mockResolvedValue({
        id: "i1",
        seriesCode: "EDO1036",
        termsProvider: "obligacjeskarbowe.pl",
        created: true,
      }),
    };
    exchangeRates = {
      convertOnDate: jest.fn().mockResolvedValue({
        amount: 1500,
        fromCurrency: "CAD",
        toCurrency: "USD",
        date: "2026-09-01",
        rate: 0.7325,
        convertedAmount: 1098.75,
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
        netWorth: {
          monthlyHistory: [],
          currentNetWorth: 52000,
          previousNetWorth: 50000,
          knownCurrentNetWorth: 52000,
          knownPreviousNetWorth: 50000,
          netWorthChange: 2000,
          netWorthChangePercent: 4,
          fxComplete: true,
          missingRatePairs: [],
        },
      }),
    };

    attachmentPrep = {
      prepareAttachments: jest.fn().mockResolvedValue([
        {
          filename: "receipt.png",
          contentType: "image/png",
          byteSize: 10,
          sha256: "sha-1",
        },
      ]),
    };
    attachmentStore = {
      store: jest.fn().mockResolvedValue([{ id: "fresh-1" }]),
      get: jest.fn(),
      releaseForPrompt: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        sharedReviewProvider(),
        ToolExecutorService,
        { provide: AttachmentToolPrepService, useValue: attachmentPrep },
        { provide: RelayAttachmentStore, useValue: attachmentStore },
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
        { provide: ExchangeRateService, useValue: exchangeRates },
        // Exercised in tool-executor.transaction-rules.spec.ts.
        { provide: AiReviewWorkService, useValue: {} },
        { provide: EmailReceiptParserToolsService, useValue: {} },
        { provide: BondSeriesService, useValue: bondSeries },
        { provide: WarrantiesService, useValue: warranties },
        { provide: TransactionRuleToolPrepService, useValue: {} },
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
    sharedReview = module.get(SharedReviewService);
  });

  it.each(SHARED_LEDGER_TOOLS)(
    "%s carries the common personal-review context",
    async (name) => {
      const context = {
        pendingCount: 2,
        unavailableGroupCount: 0,
        status: "REVIEW_REQUIRED",
      };
      sharedReview.annotate.mockImplementation(async (_user, data) => ({
        ...(Array.isArray(data) ? { items: data } : (data as object)),
        sharedExpenses: context,
      }));
      const input =
        name === "generate_report" ? { type: "income_vs_expenses" } : {};
      const result = await service.execute(userId, name, input);
      expect(result.isError).toBeUndefined();
      expect(sharedReview.annotate).toHaveBeenCalledWith(
        userId,
        expect.anything(),
      );
      expect(result.data).toMatchObject({ sharedExpenses: context });
    },
  );

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
        knownIncomeSubtotal: 0,
        knownExpensesSubtotal: 0,
        totalsCurrency: "USD",
        fxComplete: true,
        missingRatePairs: [],
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

    it("list_accounts names the currency of every figure and quotes a foreign account in both", async () => {
      const result = await service.execute(userId, "list_accounts", {});

      expect(result.summary).toContain("Net worth: 18800.00 USD");
      expect(result.summary).toContain("Assets: 20000.00 USD");
      expect(result.summary).toContain(
        "Euro Savings: 1000.00 EUR = 1085.50 USD",
      );
      expect(result.summary).toContain(
        "Yen Cash: 20000.00 JPY = unknown (no rate)",
      );
      expect(result.summary).toContain("No exchange rate for: JPY->USD");
      // The USD account is not listed as foreign.
      expect(result.summary).not.toContain("Checking:");
    });

    it("list_accounts withholds a net worth that is a subtotal and says why and where to fix it", async () => {
      const complete = await accounts.getLlmAccounts();
      accounts.getLlmAccounts.mockResolvedValueOnce({
        ...complete,
        totalAssets: null,
        netWorth: null,
        knownAssetsSubtotal: 1000,
        knownNetWorthSubtotal: 1000,
        fxComplete: false,
        pricesComplete: false,
        valuationComplete: false,
        missingRatePairs: ["ZZZ->USD"],
        unpricedSecurityIds: ["sec-abc"],
        unpricedSymbols: ["ABC"],
        accounts: [
          {
            ...complete.accounts[0],
            id: "acc-4",
            name: "Broker",
            type: "INVESTMENT",
            currency: "CAD",
            balance: null,
            knownBalanceSubtotal: 50,
            valuationComplete: false,
            balanceInDefaultCurrency: null,
          },
        ],
      });

      const result = await service.execute(userId, "list_accounts", {});

      expect(result.isError).toBeFalsy();
      expect(result.summary).toContain(
        "Net worth: withheld (incomplete: no exchange rate for ZZZ->USD; no price for ABC); known subtotal 1000.00 USD",
      );
      expect(result.summary).toContain(
        "Assets: withheld (incomplete: no exchange rate for ZZZ->USD; no price for ABC); known subtotal 1000.00 USD",
      );
      // Liabilities converted completely, so they stay a total.
      expect(result.summary).toContain("Liabilities: 1200.00 USD");
      expect(result.summary).toContain("Currencies page");
      expect(result.summary).toContain("price history");
      expect(result.summary).toContain(
        "Broker: unknown (holdings not priced); known subtotal 50.00 CAD",
      );
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

    it("list_transactions names the currency of its totals", async () => {
      analytics.getLlmListTransactions.mockResolvedValueOnce({
        totalIncome: 0,
        totalExpenses: 7650,
        netCashFlow: -7650,
        knownIncomeSubtotal: 0,
        knownExpensesSubtotal: 7650,
        totalsCurrency: "PLN",
        fxComplete: true,
        missingRatePairs: [],
        transactionCount: 2,
        groupedBy: "none",
      });

      const result = await service.execute(userId, "list_transactions", {});

      expect(result.summary).toContain("Expenses: 7650.00 PLN");
      expect(result.summary).not.toContain("withheld");
    });

    it("list_transactions says the totals are withheld, naming the pair and the fix", async () => {
      analytics.getLlmListTransactions.mockResolvedValueOnce({
        totalIncome: null,
        totalExpenses: null,
        netCashFlow: null,
        knownIncomeSubtotal: 0,
        knownExpensesSubtotal: 4000,
        totalsCurrency: "PLN",
        fxComplete: false,
        missingRatePairs: ["USD->PLN"],
        transactionCount: 2,
        groupedBy: "none",
      });

      const result = await service.execute(userId, "list_transactions", {});

      expect(result.summary).toContain(
        "Totals withheld: no exchange rate for USD->PLN; add it under Currencies.",
      );
      expect(result.summary).toContain("expenses 4000.00 PLN");
      expect(result.summary).not.toContain("Expenses: ");
    });

    it("compare_periods names the currency of its totals", async () => {
      analytics.getLlmPeriodComparison.mockResolvedValueOnce({
        period1: {
          start: "2026-08-01",
          end: "2026-08-31",
          total: 400,
          knownSubtotal: 400,
        },
        period2: {
          start: "2026-09-01",
          end: "2026-09-30",
          total: 7650,
          knownSubtotal: 7650,
        },
        totalChange: 7250,
        totalChangePercent: 1812.5,
        totalsCurrency: "PLN",
        fxComplete: true,
        missingRatePairs: [],
        comparison: [],
      });

      const result = await service.execute(userId, "compare_periods", {});

      expect(result.summary).toContain("400.00 PLN");
      expect(result.summary).toContain("7650.00 PLN");
      expect(result.summary).toContain("Change: +7250.00 PLN (+1812.5%)");
    });

    it("compare_periods says the totals are withheld, naming the pair and the fix", async () => {
      analytics.getLlmPeriodComparison.mockResolvedValueOnce({
        period1: {
          start: "2026-08-01",
          end: "2026-08-31",
          total: 400,
          knownSubtotal: 400,
        },
        period2: {
          start: "2026-09-01",
          end: "2026-09-30",
          total: null,
          knownSubtotal: 4000,
        },
        totalChange: null,
        totalChangePercent: null,
        totalsCurrency: "PLN",
        fxComplete: false,
        missingRatePairs: ["USD->PLN"],
        comparison: [],
      });

      const result = await service.execute(userId, "compare_periods", {});

      expect(result.summary).toContain(
        "Totals withheld: no exchange rate for USD->PLN; add it under Currencies.",
      );
      expect(result.summary).toContain("4000.00 PLN");
      expect(result.summary).not.toContain("Change:");
      expect(result.summary).not.toContain("null");
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

      expect(portfolio.getLlmSummary).toHaveBeenCalledWith(userId, undefined, {
        includeLookThrough: false,
      });
      expect(result.sources[0].type).toBe("portfolio");
    });

    it("get_portfolio_summary requests the look-through when asked", async () => {
      portfolio.getLlmSummary.mockResolvedValueOnce({
        holdingCount: 1,
        fxComplete: true,
        missingRatePairs: [],
        pricesComplete: true,
        unpricedSymbols: [],
        valuationComplete: true,
        totalPortfolioValue: 1000,
        totalGainLoss: 100,
        totalGainLossPercent: 10,
        // The real method always returns this array; without it the per-account
        // completeness note could not be built at all.
        holdingsByAccount: [],
        lookThrough: {
          totalPortfolioValue: 1000,
          byCountry: {
            items: [{ name: "United States", value: 750, percentage: 75 }],
            unclassifiedValue: 250,
            unclassifiedPercentage: 25,
          },
          byAssetClass: {
            items: [{ name: "Equity", value: 600, percentage: 60 }],
            unclassifiedValue: 400,
            unclassifiedPercentage: 40,
          },
        },
      });

      const result = await service.execute(userId, "get_portfolio_summary", {
        includeLookThrough: true,
      });

      expect(portfolio.getLlmSummary).toHaveBeenCalledWith(userId, undefined, {
        includeLookThrough: true,
      });
      expect(result.summary).toContain("1 country");
      expect(result.summary).toContain("1 asset class");
    });

    it("get_portfolio_summary tells the model when the totals are incomplete", async () => {
      // The model reads the summary line before the payload, so an unconvertible
      // component has to be described there. Flagging it only inside `data` let
      // the assistant quote a subtotal as a settled balance (recheck RR2-007).
      portfolio.getLlmSummary.mockResolvedValueOnce({
        holdingCount: 2,
        fxComplete: false,
        missingRatePairs: ["EUR->USD"],
        pricesComplete: true,
        unpricedSymbols: [],
        valuationComplete: false,
        totalCashValue: 100,
        totalHoldingsValue: 0,
        totalCostBasis: 0,
        totalPortfolioValue: 100,
        totalGainLoss: 0,
        totalGainLossPercent: 0,
        gainCostBasis: 0,
        unpricedCostBasis: 0,
        timeWeightedReturn: null,
        cagr: null,
        holdings: [],
        holdingsByAccount: [],
        allocation: [],
      });

      const result = await service.execute(userId, "get_portfolio_summary", {});

      expect(result.summary).toContain("INCOMPLETE");
      expect(result.summary).toContain("EUR->USD");
      expect((result.data as { fxComplete: boolean }).fxComplete).toBe(false);
    });

    it("get_portfolio_summary says the gain is over the priced holdings only, naming the symbol and the excluded cost (A26-M38)", async () => {
      portfolio.getLlmSummary.mockResolvedValueOnce({
        holdingCount: 2,
        fxComplete: true,
        missingRatePairs: [],
        pricesComplete: false,
        unpricedSymbols: ["XYZ"],
        valuationComplete: false,
        totalCashValue: 0,
        totalHoldingsValue: 100000,
        totalCostBasis: 130000,
        gainCostBasis: 80000,
        unpricedCostBasis: 50000,
        totalPortfolioValue: 100000,
        totalGainLoss: 20000,
        totalGainLossPercent: 25,
        timeWeightedReturn: null,
        cagr: null,
        holdings: [],
        holdingsByAccount: [],
        allocation: [],
      });

      const result = await service.execute(userId, "get_portfolio_summary", {});

      expect(result.summary).toContain("priced holdings only");
      expect(result.summary).toContain("XYZ");
      expect(result.summary).toContain("50000.00");
    });

    it("list_investment_transactions delegates to investmentTransactions.getLlmInvestmentTransactions", async () => {
      investmentTransactions.getLlmInvestmentTransactions.mockResolvedValueOnce(
        {
          transactionCount: 3,
          totalAmount: 2325,
          totalCommission: 19.98,
          incomeByCurrency: {},
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
              incomeByCurrency: {},
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

    it("list_capital_gains says the realized gain is unknown and gives the known part", async () => {
      (
        investmentTransactions.getLlmCapitalGains as jest.Mock
      ).mockResolvedValueOnce({
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        totals: {
          realizedGain: null,
          realizedGainComplete: false,
          realizedGainKnownSubtotal: 15,
          currency: "CAD",
          fxComplete: false,
          missingRatePairs: ["USD->CAD"],
          unrealizedGain: null,
          totalCapitalGain: null,
        },
        groupedBy: "month",
        entries: [],
        entryCount: 0,
        truncatedEntryList: false,
      });

      const result = await service.execute(userId, "list_capital_gains", {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
      });

      expect(result.summary).toContain("realized unknown (known part 15.00");
      expect(result.summary).toContain("capital gains unknown CAD");
      expect(result.summary).toContain("no exchange rate for USD->CAD");
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
      // The currency travels with the figure. A total is expressed in the
      // reader's default while each item keeps its own settlement currency, so
      // two bare numbers in the line a model quotes is how a CAD figure came to
      // be read as USD (issue #1247 re-audit).
      expect(result.summary).toContain("Bills: 1200.00 USD");
      expect(result.summary).toContain("Deposits: 3000.00 USD");
      expect(result.summary).toContain("1 overdue");
    });

    it("list_upcoming_bills says which cause withheld a total", async () => {
      // Two different repairs: an unresolvable occurrence amount is a schedule
      // to look at, a missing rate is a rate to add. One sentence for both sent
      // the reader to the wrong one.
      scheduledTransactions.getLlmUpcomingBillsAndDeposits.mockResolvedValue({
        daysWindow: 30,
        itemCount: 2,
        overdueCount: 0,
        totalUpcomingBills: null,
        totalUpcomingDeposits: 0,
        totalsCurrency: "USD",
        knownUpcomingBillsSubtotal: 500,
        amountsComplete: false,
        unknownAmountItems: ["Monthly ETF buy"],
        missingRatePairs: ["CAD->USD"],
        items: [],
      });

      const result = await service.execute(userId, "list_upcoming_bills", {});

      expect(result.summary).toContain(
        "unknown (subtotal of the items that resolved: 500.00)",
      );
      expect(result.summary).toContain("Monthly ETF buy");
      expect(result.summary).toContain("No exchange rate for CAD->USD");
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

    it("list_payees reads the shared payee query", async () => {
      const result = await service.execute(userId, "list_payees", {});

      expect(payees.getLlmPayees).toHaveBeenCalledWith(userId, {});
      expect(result.sources[0].type).toBe("payees");
      expect(result.summary).toContain("2 payees");
    });

    it("list_payees passes the search, sort, limit and presence filters down", async () => {
      // Same method the MCP tool calls, so both surfaces answer alike.
      const input = {
        search: "wal",
        sortBy: "transactionCount",
        limit: 5,
        hasEmail: false,
      };
      const result = await service.execute(userId, "list_payees", input);

      expect(payees.getLlmPayees).toHaveBeenCalledWith(userId, input);
      expect(result.summary).toContain('matching "wal"');
    });

    it("list_payees says a truncated list is only part of the matches", async () => {
      payees.getLlmPayees.mockResolvedValueOnce({
        payees: [{ id: "p1", name: "Walmart" }],
        totalCount: 9,
        truncated: true,
      });

      const result = await service.execute(userId, "list_payees", { limit: 1 });

      expect(result.summary).toContain("1 payee");
      expect(result.summary).toContain("of 9 matching");
    });

    it("list_warranties reads the shared warranty method, unnarrowed", async () => {
      // Same method the MCP tool calls, so both surfaces answer alike; no
      // account scope, because a delegate reaches the assistant only with
      // READ on every account (DelegateRequiresFullScope).
      const result = await service.execute(userId, "list_warranties", {});

      expect(warranties.getLlmWarranties).toHaveBeenCalledWith(userId, {});
      expect(result.data).toEqual(warrantyList());
      expect(result.sources[0].type).toBe("warranties");
      expect(result.summary).toBe("2 warranties as of 2026-10-21.");
    });

    it("list_warranties passes the filters down and says a capped list is part of the matches", async () => {
      warranties.getLlmWarranties.mockResolvedValueOnce({
        ...warrantyList(),
        warranties: warrantyList().warranties.slice(0, 1),
        total: 5,
      });
      const input = { status: "expiring", q: "laptop", limit: "1" };

      const result = await service.execute(userId, "list_warranties", input);

      expect(warranties.getLlmWarranties).toHaveBeenCalledWith(userId, {
        status: "expiring",
        q: "laptop",
        limit: 1,
      });
      expect(result.summary).toBe(
        '1 warranty expiring matching "laptop" (of 5) as of 2026-10-21.',
      );
    });

    it("list_warranties refuses a limit above the cap before reading", async () => {
      const result = await service.execute(userId, "list_warranties", {
        limit: 51,
      });

      expect(warranties.getLlmWarranties).not.toHaveBeenCalled();
      expect(result.summary).toContain("Invalid input for list_warranties");
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

    it("generate_report names the missing rate and where to fix it in the summary (INV-FX-001)", async () => {
      builtInReports.getSpendingByCategory.mockResolvedValueOnce({
        data: [],
        totalSpending: null,
        knownSpending: 50,
        currency: "USD",
        missingCurrencies: ["JPY", "CHF"],
        excludedCount: 2,
      });

      const result = await service.execute(userId, "generate_report", {
        type: "spending_by_category",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(result.summary).toContain(
        "Total withheld: no exchange rate for JPY->USD, CHF->USD; add it under Currencies.",
      );
      // The payload is the report's own, untouched (MCP parity).
      expect(
        (result.data as { totalSpending: unknown }).totalSpending,
      ).toBeNull();
    });

    it("generate_report adds no withheld clause when every row converted", async () => {
      builtInReports.getSpendingByCategory.mockResolvedValueOnce({
        data: [],
        totalSpending: 0,
        currency: "USD",
        missingCurrencies: [],
        excludedCount: 0,
      });

      const result = await service.execute(userId, "generate_report", {
        type: "spending_by_category",
      });

      expect(result.summary).not.toContain("withheld");
    });

    it("generate_report spending_anomalies names the currencies it left out", async () => {
      builtInReports.getSpendingAnomalies.mockResolvedValueOnce({
        statistics: {},
        anomalies: [],
        counts: {},
        currency: "USD",
        missingCurrencies: ["JPY"],
        excludedCount: 3,
      });

      const result = await service.execute(userId, "generate_report", {
        type: "spending_anomalies",
      });

      expect(result.summary).toContain(
        "Transactions in those currencies were left out of the analysis: no exchange rate for JPY->USD; add it under Currencies.",
      );
    });

    it("generate_report spending_anomalies defaults to the report's own window and threshold", async () => {
      const result = await service.execute(userId, "generate_report", {
        type: "spending_anomalies",
      });

      expect(builtInReports.getSpendingAnomalies).toHaveBeenCalledWith(
        userId,
        2,
        6,
      );
      expect(result.summary).toContain("over the last 6 months");
    });

    it("generate_report type spending_anomalies delegates to getSpendingAnomalies", async () => {
      const result = await service.execute(userId, "generate_report", {
        type: "spending_anomalies",
        months: 6,
      });

      // Months are the window, never the z-score threshold (A26-M34): the
      // threshold is the Reports page's own default.
      expect(builtInReports.getSpendingAnomalies).toHaveBeenCalledWith(
        userId,
        2,
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
      expect(result.summary).not.toContain("withheld");
    });

    it("month_comparison says net worth is withheld for an incomplete month and names the pairs", async () => {
      const complete = await builtInReports.getMonthlyComparison();
      builtInReports.getMonthlyComparison.mockResolvedValueOnce({
        ...complete,
        netWorth: {
          ...complete.netWorth,
          currentNetWorth: null,
          netWorthChange: null,
          netWorthChangePercent: null,
          fxComplete: false,
          missingRatePairs: ["ZZZ->USD"],
        },
      });

      const result = await service.execute(userId, "generate_report", {
        type: "month_comparison",
        month: "2026-04",
      });

      expect(result.summary).toContain("April 2026 vs March 2026");
      expect(result.summary).toContain(
        "Net worth is withheld for an incomplete month: no exchange rate for ZZZ->USD",
      );
    });

    it("calculate runs locally without hitting any service", async () => {
      const result = await service.execute(userId, "calculate", {
        operation: "sum",
        values: [1, 2, 3],
      });

      expect(analytics.getLlmListTransactions).not.toHaveBeenCalled();
      expect(accounts.getLlmAccounts).not.toHaveBeenCalled();
      expect(exchangeRates.convertOnDate).not.toHaveBeenCalled();
      expect(result.sources[0].type).toBe("calculation");
    });

    it("calculate convert prices the amount through ExchangeRateService", async () => {
      const result = await service.execute(userId, "calculate", {
        operation: "convert",
        values: [1500],
        fromCurrency: "CAD",
        toCurrency: "USD",
        date: "2026-09-01",
      });

      expect(exchangeRates.convertOnDate).toHaveBeenCalledWith(
        1500,
        "CAD",
        "USD",
        "2026-09-01",
      );
      expect(result.isError).toBeUndefined();
      expect(result.data).toEqual({
        result: 1098.75,
        formattedResult: "1098.75 USD",
        operation: "convert",
        amount: 1500,
        fromCurrency: "CAD",
        toCurrency: "USD",
        date: "2026-09-01",
        rate: 0.7325,
      });
      // The line a model quotes carries both sides, the rate and its date.
      expect(result.summary).toBe(
        "Calculated convert: 1500.00 CAD = 1098.75 USD at 0.7325 (CAD->USD, rate as of 2026-09-01)",
      );
      expect(result.sources[0].type).toBe("calculation");
    });

    it("calculate convert is an error when no rate exists", async () => {
      exchangeRates.convertOnDate.mockResolvedValue(null);

      const result = await service.execute(userId, "calculate", {
        operation: "convert",
        values: [100],
        fromCurrency: "CAD",
        toCurrency: "XXX",
        date: "2026-09-01",
      });

      expect(result.isError).toBe(true);
      expect(result.summary).toContain(
        "No exchange rate is available for CAD->XXX",
      );
    });

    it("calculate convert without a currency pair is refused before any lookup", async () => {
      const result = await service.execute(userId, "calculate", {
        operation: "convert",
        values: [100],
      });

      expect(result.isError).toBe(true);
      expect(exchangeRates.convertOnDate).not.toHaveBeenCalled();
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
      // The accompanying splits are what permit this edit on an existing
      // split transaction (Truth table B) -- previewUpdate must know.
      expect(transactions.previewUpdate).toHaveBeenCalledWith(
        userId,
        "11111111-1111-4111-8111-111111111111",
        expect.objectContaining({ splitsAccompany: true }),
      );
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

    it("accepts splits on several rows of one update batch", async () => {
      // Recategorizing one line inside 17 split transactions is the request
      // this exists for. It used to be refused outright, which left the model
      // with no way to do what was asked -- and it narrated progress towards
      // it instead of saying so.
      const result = await service.execute(userId, "manage_transactions", {
        operation: "update",
        items: [
          {
            transactionId: "11111111-1111-4111-8111-111111111111",
            splits: [
              { categoryName: "Automobile: Accessories", amount: -60 },
              { categoryName: "Groceries", amount: -40 },
            ],
          },
          {
            transactionId: "22222222-2222-4222-8222-222222222222",
            splits: [
              { categoryName: "Automobile: Accessories", amount: -30 },
              { categoryName: "Groceries", amount: -20 },
            ],
          },
        ],
      });

      expect(result.isError).toBeUndefined();
      // Under six rows the default is one card per row; each carries its own
      // complete set, which the builder used to drop on this path.
      expect(result.pendingActions).toHaveLength(2);
      for (const action of result.pendingActions ?? []) {
        const descriptor = action.descriptor as {
          categoryId: string | null;
          splits?: Array<{ categoryId: string; amount: number }>;
        };
        expect(descriptor.splits).toHaveLength(2);
        expect(descriptor.categoryId).toBeNull();
      }
    });

    it("tells the model why every row was refused, not to check the ids", async () => {
      // The reported failure: 17 category-only edits on split transactions.
      // Each row is correctly refused -- a split's categories live on its
      // lines -- but the tool answered "check each transactionId", which was
      // the one thing that was right. The model concluded the task was
      // impossible and gave up instead of reading the lines and resending.
      transactions.previewUpdate.mockRejectedValue(
        new BadRequestException(
          "This is a split transaction: its categories live on its split lines, not on the parent. Read the transaction's current split lines first, then resend the update with the complete splits array.",
        ),
      );

      const result = await service.execute(userId, "manage_transactions", {
        operation: "update",
        items: Array.from({ length: 17 }, (_, i) => ({
          transactionId: `1111111${i % 10}-1111-4111-8111-11111111111${i % 10}`,
          categoryName: "Automobile: Accessories",
        })),
      });

      expect(result.isError).toBe(true);
      expect(result.summary).toContain("All 17 rows failed the same way");
      expect(result.summary).toContain("split lines");
      expect(result.summary).toContain("complete splits array");
      // The misleading advice is gone: the ids were never the problem.
      expect(result.summary).not.toContain("Check each transactionId");
    });

    it("carries per-row splits into one bulk card at six rows or more", async () => {
      const result = await service.execute(userId, "manage_transactions", {
        operation: "update",
        items: Array.from({ length: 6 }, (_, i) => ({
          transactionId: `1111111${i}-1111-4111-8111-111111111111`,
          splits: [
            { categoryName: "Automobile: Accessories", amount: -60 },
            { categoryName: "Groceries", amount: -40 },
          ],
        })),
      });

      expect(result.isError).toBeUndefined();
      const descriptor = result.pendingAction?.descriptor as {
        operation: string;
        rows: Array<{
          categoryId: string | null;
          splits?: Array<{ categoryId: string; amount: number }>;
        }>;
      };
      expect(descriptor.operation).toBe("update");
      expect(descriptor.rows).toHaveLength(6);
      for (const row of descriptor.rows) {
        expect(row.splits).toHaveLength(2);
        expect(row.categoryId).toBeNull();
      }
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

  describe("manage_transactions (attachments)", () => {
    const TXID = "11111111-1111-4111-8111-111111111111";
    const PNG_B64 = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
    ]).toString("base64");

    const chatAttachments: AttachmentDto[] = [
      {
        kind: "image",
        mediaType: "image/png",
        filename: "receipt.png",
        data: PNG_B64,
      },
      {
        kind: "text",
        mediaType: "text/csv",
        filename: "data.csv",
        data: Buffer.from("a,b\n1,2").toString("base64"),
      },
    ];

    function createItem(attachments: Array<string | number>) {
      return {
        operation: "create",
        items: [
          {
            accountName: "Checking",
            amount: -12.5,
            date: "2026-01-15",
            attachments,
          },
        ],
      };
    }

    it("resolves a filename ref, parks the bytes, and carries refs on the signed card", async () => {
      const result = await service.execute(
        userId,
        "manage_transactions",
        createItem(["Receipt.PNG"]),
        { attachments: chatAttachments },
      );

      expect(attachmentPrep.prepareAttachments).toHaveBeenCalledWith(
        userId,
        [expect.objectContaining({ filename: "receipt.png" })],
        undefined,
      );
      expect(attachmentStore.store).toHaveBeenCalledWith(userId, [
        expect.objectContaining({ filename: "receipt.png" }),
      ]);
      expect(result.pendingAction?.type).toBe("create_transaction");
      expect(result.pendingAction?.descriptor).toMatchObject({
        attachments: [
          {
            attachmentRefId: "fresh-1",
            filename: "receipt.png",
            contentType: "image/png",
            byteSize: 10,
            sha256: "sha-1",
          },
        ],
      });
      expect(result.pendingAction?.preview.attachments).toEqual([
        { filename: "receipt.png", contentType: "image/png", byteSize: 10 },
      ]);
      expect(result.summary).toContain("receipt.png");
    });

    it("resolves a 1-based index ref", async () => {
      const result = await service.execute(
        userId,
        "manage_transactions",
        createItem([1]),
        { attachments: chatAttachments },
      );
      expect(result.pendingAction?.preview.attachments).toHaveLength(1);
    });

    it("errors when no files are attached to the message", async () => {
      const result = await service.execute(
        userId,
        "manage_transactions",
        createItem(["receipt.png"]),
        { attachments: [] },
      );
      expect(result.isError).toBe(true);
      expect(result.summary).toContain("No files are attached");
    });

    it("errors on an unknown filename, listing the available files", async () => {
      const result = await service.execute(
        userId,
        "manage_transactions",
        createItem(["missing.jpg"]),
        { attachments: chatAttachments },
      );
      expect(result.isError).toBe(true);
      expect(result.summary).toContain("missing.jpg");
      expect(result.summary).toContain("receipt.png");
    });

    it("errors on an out-of-range index", async () => {
      const result = await service.execute(
        userId,
        "manage_transactions",
        createItem([5]),
        { attachments: chatAttachments },
      );
      expect(result.isError).toBe(true);
      expect(result.summary).toContain("out of range");
    });

    it("rejects a text/csv chat file", async () => {
      const result = await service.execute(
        userId,
        "manage_transactions",
        createItem(["data.csv"]),
        { attachments: chatAttachments },
      );
      expect(result.isError).toBe(true);
      expect(result.summary).toContain("only images and PDFs");
      expect(attachmentStore.store).not.toHaveBeenCalled();
    });

    it("rejects attachments on a multi-row batch", async () => {
      const result = await service.execute(
        userId,
        "manage_transactions",
        {
          operation: "create",
          items: [
            {
              accountName: "Checking",
              amount: -1,
              date: "2026-01-15",
              attachments: ["receipt.png"],
            },
            { accountName: "Checking", amount: -2, date: "2026-01-15" },
          ],
        },
        { attachments: chatAttachments },
      );
      expect(result.isError).toBe(true);
      expect(result.summary).toContain("one at a time");
    });

    it("surfaces prep failures (e.g. attachment cap) as tool errors", async () => {
      attachmentPrep.prepareAttachments.mockRejectedValueOnce(
        new BadRequestException(
          "This transaction already has the maximum of 10 attachments",
        ),
      );
      const result = await service.execute(
        userId,
        "manage_transactions",
        createItem(["receipt.png"]),
        { attachments: chatAttachments },
      );
      expect(result.isError).toBe(true);
      expect(result.summary).toContain("maximum of 10");
    });

    it("attachments-only update passes the transaction id to the cap check and signs an update card", async () => {
      const result = await service.execute(
        userId,
        "manage_transactions",
        {
          operation: "update",
          items: [{ transactionId: TXID, attachments: ["receipt.png"] }],
        },
        { attachments: chatAttachments },
      );

      expect(attachmentPrep.prepareAttachments).toHaveBeenCalledWith(
        userId,
        [expect.objectContaining({ filename: "receipt.png" })],
        TXID,
      );
      expect(result.pendingAction?.type).toBe("update_transaction");
      expect(result.pendingAction?.descriptor).toMatchObject({
        attachments: [expect.objectContaining({ attachmentRefId: "fresh-1" })],
      });
    });

    it("rejects attachments when the updated transaction is a transfer", async () => {
      transactions.findOne.mockResolvedValueOnce({
        id: TXID,
        isTransfer: true,
        linkedTransactionId: "tx-2",
      });
      const result = await service.execute(
        userId,
        "manage_transactions",
        {
          operation: "update",
          items: [
            { transactionId: TXID, amount: 100, attachments: ["receipt.png"] },
          ],
        },
        { attachments: chatAttachments },
      );
      expect(result.isError).toBe(true);
      expect(result.summary).toContain("transfer");
      expect(attachmentStore.store).not.toHaveBeenCalled();
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

    it("surfaces the actionable resend-splits refusal of a category/amount change on an existing split", async () => {
      // previewUpdate refuses a category or amount change on an existing
      // split unless a complete splits array accompanies it (Truth table B);
      // the actionable message must reach the model verbatim so it can read
      // the lines and resend the full set.
      transactions.previewUpdate.mockRejectedValueOnce(
        new BadRequestException(
          "This is a split transaction: its amount must equal the sum of its split lines. Resend the update with both the new amount and the complete splits array summing to it.",
        ),
      );
      const result = await service.execute(userId, "manage_transactions", {
        operation: "update",
        items: [{ transactionId: TXID, amount: -5 }],
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.data)).toContain("complete splits array");
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

    it("prepares a batch containing a split parent when its row has only parent fields", async () => {
      // A split parent inside a batch (no splits on any row) is fine as long
      // as its row changes only parent fields: the preview arrives with
      // categoryId null and the amount unchanged, and the batch card carries
      // no category for it.
      transactions.previewUpdate.mockResolvedValue({
        transactionId: "tx-1",
        accountId: "acc-1",
        accountName: "Checking",
        amount: -100,
        transactionDate: "2026-02-01",
        payeeId: "payee-1",
        payeeName: "New Payee",
        payeeMatched: true,
        payeeWillBeCreated: false,
        categoryId: null,
        categoryName: null,
        description: null,
        currencyCode: "USD",
      });
      const result = await service.execute(userId, "manage_transactions", {
        operation: "update",
        items: Array.from({ length: 6 }, () => ({
          transactionId: TXID,
          payeeName: "New Payee",
        })),
      });
      expect(result.isError).toBeFalsy();
      expect(result.pendingAction?.type).toBe("batch_actions");
      const descriptor = result.pendingAction?.descriptor as {
        rows: Array<{ categoryId: string | null; amount: number }>;
      };
      expect(descriptor.rows).toHaveLength(6);
      expect(descriptor.rows[0].categoryId).toBeNull();
      expect(descriptor.rows[0].amount).toBe(-100);
      // No splits accompany any batch row.
      expect(transactions.previewUpdate).toHaveBeenCalledWith(
        userId,
        TXID,
        expect.objectContaining({ splitsAccompany: false }),
      );
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
        search: "apple",
      });

      // The tool's input field is `search`; the service contract keeps `query`.
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
        search: "x",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("fetch_bond_series (reference data, no card)", () => {
    it("fetches through the service for the country and series code, with no pending action", async () => {
      const result = await service.execute(userId, "fetch_bond_series", {
        countryCode: "PL",
        seriesCode: "EDO1036",
      });

      expect(bondSeries.fetchSeries).toHaveBeenCalledWith(
        userId,
        "PL",
        "EDO1036",
      );
      expect(result.pendingAction).toBeUndefined();
      expect(result.isError).toBeFalsy();
      expect(result.data).toMatchObject({ created: true });
      expect(result.summary).toMatch(/Stored bond series EDO1036/);
      expect(result.sources[0].type).toBe("bond_series");
    });

    it("says nothing was fetched for a series that was already stored", async () => {
      bondSeries.fetchSeries.mockResolvedValueOnce({
        id: "i1",
        seriesCode: "EDO1036",
        termsProvider: "PL_MF",
        created: false,
      });
      const result = await service.execute(userId, "fetch_bond_series", {
        countryCode: "PL",
        seriesCode: "EDO1036",
      });
      expect(result.summary).toMatch(/already in the catalog/);
    });

    it("refuses a value the model was never to supply, before any fetch", async () => {
      const result = await service.execute(userId, "fetch_bond_series", {
        countryCode: "PL",
        seriesCode: "EDO1036/../x",
      });
      expect(result.isError).toBe(true);
      expect(bondSeries.fetchSeries).not.toHaveBeenCalled();
    });

    it("relays a refusal in its translated words, as a tool error", async () => {
      bondSeries.fetchSeries.mockRejectedValueOnce(
        new SeriesFetchError("SOURCE_UNAVAILABLE", {
          series: "EDO1036",
          country: "PL",
        }),
      );
      const result = await service.execute(userId, "fetch_bond_series", {
        countryCode: "PL",
        seriesCode: "EDO1036",
      });
      expect(result.isError).toBe(true);
      expect(result.summary).toBe(
        "The official source for series EDO1036 could not be read right now; try again later",
      );
    });

    it("relays the per-user rate limit (429) in its translated words", async () => {
      bondSeries.fetchSeries.mockRejectedValueOnce(
        new HttpException(
          {
            message: "At most 10 bond series can be fetched per minute.",
            errorCode: "SERIES_FETCH_RATE_LIMITED",
          },
          429,
        ),
      );
      const result = await service.execute(userId, "fetch_bond_series", {
        countryCode: "PL",
        seriesCode: "EDO1036",
      });
      expect(result.isError).toBe(true);
      expect(result.summary).toBe(
        "At most 10 bond series can be fetched per minute.",
      );
    });

    it("gives a generic error for anything that is not a refusal", async () => {
      bondSeries.fetchSeries.mockRejectedValueOnce(new Error("db down"));
      const result = await service.execute(userId, "fetch_bond_series", {
        countryCode: "PL",
        seriesCode: "EDO1036",
      });
      expect(result.isError).toBe(true);
      expect(result.summary).toBe("Could not fetch the bond series.");
    });
  });

  describe("manage_payees (human-in-the-loop)", () => {
    it("create returns a signed pending action", async () => {
      const result = await service.execute(userId, "manage_payees", {
        operation: "create",
        items: [{ name: "Acme", categoryName: "Dining" }],
      });

      expect(payees.previewCreatePayee).toHaveBeenCalledWith(
        userId,
        { name: "Acme", categoryName: "Dining" },
        // A single new payee is looked up before its card, when enabled.
        { lookupContact: true },
      );
      expect(result.pendingAction?.type).toBe("create_payee");
      expect(result.pendingAction?.preview).toMatchObject({
        name: "Acme",
        categoryName: "Dining",
      });
    });

    it("carries a website onto the confirmation card", async () => {
      payees.previewCreatePayee.mockResolvedValueOnce({
        name: "Acme",
        defaultCategoryId: null,
        defaultCategoryName: null,
        website: "https://acme.com",
      });

      const result = await service.execute(userId, "manage_payees", {
        operation: "create",
        items: [{ name: "Acme", website: "acme.com" }],
      });

      expect(payees.previewCreatePayee).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ website: "acme.com" }),
        { lookupContact: true },
      );
      // The card shows the normalised address, and the signed descriptor
      // carries it so approving actually writes it.
      expect(result.pendingAction?.preview).toMatchObject({
        website: "https://acme.com",
      });
      expect(result.pendingAction?.descriptor).toMatchObject({
        website: "https://acme.com",
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

  describe("manage_securities list", () => {
    it("lists the securities held in the resolved account", async () => {
      accounts.resolveBrokerageByNameOrId = jest.fn().mockResolvedValue({
        match: { id: "acc-3", name: "Brokerage", currencyCode: "USD" },
        candidates: [],
      });
      const held = { symbol: "AAPL", quantity: 5 };
      securities.listSecuritiesInAccount = jest.fn().mockResolvedValue([held]);

      const result = await service.execute(userId, "manage_securities", {
        operation: "list",
        accountName: "Brokerage",
      });

      expect(securities.listSecuritiesInAccount).toHaveBeenCalledWith(
        userId,
        "acc-3",
      );
      expect(result.isError).toBeUndefined();
      expect(result.pendingAction).toBeUndefined();
      expect(result.data).toMatchObject({
        operation: "list",
        account: "Brokerage",
        count: 1,
        securities: [held],
      });
    });

    it("errors without an accountName", async () => {
      const result = await service.execute(userId, "manage_securities", {
        operation: "list",
      });
      expect(result.isError).toBe(true);
    });

    it("errors on an unknown account", async () => {
      accounts.resolveBrokerageByNameOrId = jest
        .fn()
        .mockResolvedValue({ match: undefined, candidates: [] });
      const result = await service.execute(userId, "manage_securities", {
        operation: "list",
        accountName: "Nope",
      });
      expect(result.isError).toBe(true);
    });

    it("rejects a write operation with no items", async () => {
      const result = await service.execute(userId, "manage_securities", {
        operation: "create",
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

    it("update forwards a manual asset allocation as decimals", async () => {
      await service.execute(userId, "manage_securities", {
        operation: "update",
        items: [
          {
            symbol: "VBAL",
            assetWeightings: [
              { name: "Equity", weight: 60 },
              { name: "Fixed Income", weight: 40 },
            ],
          },
        ],
      });

      expect(securities.previewUpdateSecurity).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          assetWeightings: [
            { name: "Equity", weight: 0.6 },
            { name: "Fixed Income", weight: 0.4 },
          ],
        }),
      );
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

/** What `WarrantiesService.getLlmWarranties` answers: a dated and a lifetime row. */
function warrantyList(): LlmWarrantyList {
  const row = {
    id: "w-1",
    name: "Laptop",
    vendorName: "Best Buy",
    warrantyKind: "manufacturer" as const,
    purchaseDate: "2026-10-01",
    expiresOn: "2026-11-01",
    isLifetime: false,
    status: "expiring" as const,
    daysLeft: 11,
    purchasePrice: 1499.99,
    currencyCode: "CAD",
    serialNumbers: ["SN-1"],
    linkedTransactionId: "tx-1",
    openClaimCount: 0,
    documentCount: 1,
    archived: false as const,
  };
  return {
    today: "2026-10-21",
    windowDays: 30,
    warranties: [
      row,
      {
        ...row,
        id: "w-2",
        name: "Cast iron pan",
        expiresOn: null,
        isLifetime: true,
        status: "lifetime",
        daysLeft: null,
        linkedTransactionId: null,
      },
    ],
    total: 2,
  };
}
