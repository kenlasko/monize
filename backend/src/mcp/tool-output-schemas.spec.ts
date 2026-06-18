import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { toolResult } from "./mcp-context";
import * as schemas from "./tool-output-schemas";

type RawShape = Record<string, z.ZodTypeAny>;

const scheduledItemSample = {
  id: "sc1",
  name: "Rent",
  accountId: "a1",
  accountName: "Checking",
  payeeName: null,
  categoryName: null,
  amount: -50,
  currency: "USD",
  frequency: "MONTHLY",
  nextDueDate: "2026-02-01",
  daysUntilDue: 5,
  isActive: true,
  autoPost: false,
  kind: "bill",
  description: null,
};

// Each case pairs an output schema with a representative payload, in the raw
// (pre-toolResult) form a tool handler would pass to toolResult. The payloads
// mirror the documented service return shapes, including null fields and
// undeclared entity fields (timestamps, relations) that must be tolerated.
const cases: Array<{ name: string; schema: RawShape; raw: unknown }> = [
  {
    name: "getAccountsOutput",
    schema: schemas.getAccountsOutput,
    raw: [
      {
        id: "a1",
        name: "Checking",
        accountType: "CHEQUING",
        currencyCode: "USD",
        currentBalance: 100.5,
        creditLimit: null,
        isClosed: false,
        futureTransactionsSum: 0,
        // Undeclared fields present on the real entity must be tolerated.
        transactions: [],
        userId: "u1",
      },
    ],
  },
  {
    name: "getAccountBalanceOutput",
    schema: schemas.getAccountBalanceOutput,
    raw: {
      id: "a1",
      name: "Checking",
      type: "CHEQUING",
      currentBalance: 100,
      creditLimit: null,
      currencyCode: "USD",
    },
  },
  {
    name: "getAccountBalancesOutput",
    schema: schemas.getAccountBalancesOutput,
    raw: {
      accounts: [
        {
          name: "Checking",
          type: "CHEQUING",
          balance: 1,
          currency: "USD",
          isClosed: false,
        },
      ],
      totalAssets: 1,
      totalLiabilities: 0,
      netWorth: 1,
      totalAccounts: 1,
    },
  },
  {
    name: "getNetWorthOutput",
    schema: schemas.getNetWorthOutput,
    raw: {
      totalAccounts: 1,
      totalBalance: 1,
      totalAssets: 1,
      totalLiabilities: 0,
      netWorth: 1,
    },
  },
  {
    name: "getNetWorthHistoryOutput",
    schema: schemas.getNetWorthHistoryOutput,
    raw: [{ month: "2026-01-01", assets: 1, liabilities: 0, netWorth: 1 }],
  },
  {
    name: "searchTransactionsOutput",
    schema: schemas.searchTransactionsOutput,
    raw: {
      transactions: [
        {
          id: "t1",
          date: "2026-01-01",
          payeeName: null,
          amount: -5,
          description: null,
          status: "CLEARED",
        },
      ],
      total: 1,
      hasMore: false,
    },
  },
  {
    name: "queryTransactionsOutput",
    schema: schemas.queryTransactionsOutput,
    raw: {
      totalIncome: 0,
      totalExpenses: 5,
      netCashFlow: -5,
      transactionCount: 1,
      byCurrency: {
        USD: {
          totalIncome: 0,
          totalExpenses: 5,
          netCashFlow: -5,
          transactionCount: 1,
        },
      },
      breakdown: { groupedBy: "category", groups: [] },
    },
  },
  {
    name: "getSpendingByCategoryOutput",
    schema: schemas.getSpendingByCategoryOutput,
    raw: {
      categories: [
        { category: "Food", amount: 5, percentage: 100, transactionCount: 1 },
      ],
      totalSpending: 5,
    },
  },
  {
    name: "getIncomeSummaryOutput",
    schema: schemas.getIncomeSummaryOutput,
    raw: {
      items: [{ label: "Salary", amount: 100, count: 1 }],
      totalIncome: 100,
      groupedBy: "category",
    },
  },
  {
    name: "comparePeriodsOutput (tolerates NaN percentage from divide-by-zero)",
    schema: schemas.comparePeriodsOutput,
    raw: {
      period1: { start: "2025-12-01", end: "2025-12-31", total: 0 },
      period2: { start: "2026-01-01", end: "2026-01-31", total: 5 },
      totalChange: 5,
      totalChangePercent: NaN,
      comparison: [
        {
          label: "Food",
          period1Amount: 0,
          period2Amount: 5,
          change: 5,
          changePercent: NaN,
        },
      ],
    },
  },
  {
    name: "getTransfersOutput",
    schema: schemas.getTransfersOutput,
    raw: {
      accounts: [
        {
          accountName: "Checking",
          currency: "USD",
          inbound: 5,
          outbound: 0,
          net: 5,
          transferCount: 1,
        },
      ],
      totalInbound: 5,
      totalOutbound: 0,
      transferCount: 1,
    },
  },
  {
    name: "createTransactionOutput (created branch)",
    schema: schemas.createTransactionOutput,
    raw: {
      id: "t1",
      date: "2026-01-01",
      amount: -5,
      payeeId: "p1",
      payeeName: "Store",
      payeeMatched: true,
      payeeCreated: false,
      status: "UNRECONCILED",
    },
  },
  {
    name: "createTransactionOutput (dry-run branch)",
    schema: schemas.createTransactionOutput,
    raw: {
      dryRun: true,
      preview: {
        accountId: "a1",
        accountName: "Checking",
        amount: -5,
        date: "2026-01-01",
        payeeId: null,
        payeeName: null,
        payeeMatched: false,
        payeeWillBeCreated: true,
        categoryId: null,
        description: null,
        currencyCode: "USD",
      },
      message: "preview only",
    },
  },
  {
    name: "categorizeTransactionOutput",
    schema: schemas.categorizeTransactionOutput,
    raw: {
      id: "t1",
      categoryId: "c1",
      message: "Transaction categorized successfully",
    },
  },
  {
    name: "createInvestmentTransactionOutput (created branch)",
    schema: schemas.createInvestmentTransactionOutput,
    raw: {
      id: "it1",
      action: "BUY",
      date: "2026-01-15",
      symbol: "AAPL",
      quantity: 10,
      price: 150,
      totalAmount: 1509.99,
    },
  },
  {
    name: "createInvestmentTransactionOutput (dry-run branch)",
    schema: schemas.createInvestmentTransactionOutput,
    raw: {
      dryRun: true,
      preview: {
        accountId: "a1",
        accountName: "Brokerage",
        action: "SELL",
        date: "2026-01-15",
        securityId: "sec-1",
        symbol: "AAPL",
        securityName: "Apple Inc.",
        securityCurrency: "USD",
        quantity: 5,
        price: 160,
        commission: 9.99,
        totalAmount: 790.01,
        exchangeRate: 1,
        cashAccountName: "Brokerage Cash",
        cashCurrency: "USD",
        cashAmount: 790.01,
        description: null,
      },
      message: "preview only",
    },
  },
  {
    name: "getCategoriesOutput",
    schema: schemas.getCategoriesOutput,
    raw: {
      categories: [
        {
          id: "c1",
          name: "Food",
          parentName: null,
          isIncome: false,
          transactionCount: 3,
        },
      ],
      totalCount: 1,
    },
  },
  {
    name: "getPayeesOutput",
    schema: schemas.getPayeesOutput,
    raw: [
      {
        id: "p1",
        name: "Amazon",
        defaultCategoryId: null,
        // notes is a nullable column; a payee without notes serializes as null
        // and must validate (this previously failed the whole tool response).
        notes: null,
        isActive: true,
        transactionCount: 2,
        lastUsedDate: null,
        aliasCount: 0,
        uncategorizedCount: 0,
      },
      {
        id: "p2",
        name: "Buon Gusto Restaurant",
        defaultCategoryId: "c1",
        notes: "Italian place downtown",
        isActive: true,
        transactionCount: 36,
        lastUsedDate: "2026-05-22",
        aliasCount: 0,
        uncategorizedCount: 0,
      },
    ],
  },
  {
    name: "createPayeeOutput",
    schema: schemas.createPayeeOutput,
    raw: { id: "p1", name: "Amazon", message: "Payee created successfully" },
  },
  {
    name: "generateReportOutput",
    schema: schemas.generateReportOutput,
    raw: {
      data: [{ categoryId: "c1", categoryName: "Food", color: null, total: 5 }],
      totalSpending: 5,
    },
  },
  {
    name: "monthlyComparisonOutput",
    schema: schemas.monthlyComparisonOutput,
    raw: {
      currentMonth: "2026-01",
      previousMonth: "2025-12",
      currentMonthLabel: "January 2026",
      previousMonthLabel: "December 2025",
      currency: "USD",
      incomeExpenses: { currentIncome: 100, savingsChangePercent: NaN },
      notes: { savingsNote: "x", incomeNote: "y" },
      expenses: { currentTotal: 5, previousTotal: 4, comparison: [] },
      topCategories: { currentMonth: [], previousMonth: [] },
      netWorth: { currentNetWorth: 1000, monthlyHistory: [] },
      investments: { accountPerformance: [], topMovers: [] },
    },
  },
  {
    name: "getAnomaliesOutput",
    schema: schemas.getAnomaliesOutput,
    raw: {
      statistics: { mean: 5, stdDev: 1 },
      anomalies: [
        {
          type: "large_transaction",
          severity: "high",
          title: "Large purchase",
          description: "Unusually large",
          amount: 500,
          transactionId: "t9",
          transactionDate: "2026-01-15",
          payeeName: null,
          categoryId: null,
          categoryName: null,
        },
      ],
      counts: { high: 1, medium: 0, low: 0 },
    },
  },
  {
    name: "getPortfolioSummaryOutput",
    schema: schemas.getPortfolioSummaryOutput,
    raw: {
      holdingCount: 1,
      totalCashValue: 0,
      totalHoldingsValue: 100,
      totalCostBasis: 80,
      totalPortfolioValue: 100,
      totalGainLoss: 20,
      totalGainLossPercent: 25,
      timeWeightedReturn: null,
      cagr: null,
      holdings: [
        {
          symbol: "AAPL",
          name: "Apple",
          securityType: "stock",
          currency: "USD",
          quantity: 1,
          averageCost: 80,
          costBasis: 80,
          marketValue: 100,
          gainLoss: 20,
          gainLossPercent: 25,
        },
      ],
      allocation: [
        {
          name: "Apple",
          symbol: "AAPL",
          type: "security",
          value: 100,
          percentage: 100,
        },
      ],
    },
  },
  {
    name: "queryInvestmentTransactionsOutput",
    schema: schemas.queryInvestmentTransactionsOutput,
    raw: {
      transactionCount: 1,
      totalAmount: 100,
      totalCommission: 0,
      totalQuantity: 1,
      actionCounts: { BUY: 1 },
      groupedBy: null,
      groups: null,
      transactions: [
        {
          transactionDate: "2026-01-01",
          action: "BUY",
          accountName: null,
          symbol: "AAPL",
          securityName: null,
          quantity: 1,
          price: 100,
          commission: 0,
          totalAmount: 100,
          currency: "USD",
          description: null,
        },
      ],
      truncatedTransactionList: false,
    },
  },
  {
    name: "getCapitalGainsOutput",
    schema: schemas.getCapitalGainsOutput,
    raw: {
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      totals: { realizedGain: 0, unrealizedGain: 20, totalCapitalGain: 20 },
      groupedBy: "month",
      entries: [
        {
          month: "2026-01",
          accountName: null,
          symbol: null,
          securityName: null,
          currency: null,
          startValue: 80,
          endValue: 100,
          realizedGain: 0,
          unrealizedGain: 20,
          totalCapitalGain: 20,
        },
      ],
      entryCount: 1,
      truncatedEntryList: false,
    },
  },
  {
    name: "getHoldingDetailsOutput",
    schema: schemas.getHoldingDetailsOutput,
    raw: [
      {
        id: "h1",
        accountId: "a1",
        securityId: "s1",
        quantity: 1,
        averageCost: 80,
      },
    ],
  },
  {
    name: "getUpcomingBillsOutput",
    schema: schemas.getUpcomingBillsOutput,
    raw: {
      daysWindow: 30,
      itemCount: 1,
      overdueCount: 0,
      totalUpcomingBills: 50,
      totalUpcomingDeposits: 0,
      items: [scheduledItemSample],
    },
  },
  {
    name: "getScheduledTransactionsOutput",
    schema: schemas.getScheduledTransactionsOutput,
    raw: {
      totalCount: 1,
      activeCount: 1,
      autoPostCount: 0,
      billCount: 1,
      depositCount: 0,
      items: [scheduledItemSample],
    },
  },
  {
    name: "calculateOutput",
    schema: schemas.calculateOutput,
    raw: {
      result: 50,
      formattedResult: "50%",
      operation: "percentage",
      label: "savings rate",
    },
  },
  {
    name: "getBudgetStatusOutput (success branch)",
    schema: schemas.getBudgetStatusOutput,
    raw: {
      budgetName: "Main",
      strategy: "envelope",
      period: { start: "2026-01-01", end: "2026-01-31" },
      totalBudgeted: 100,
      totalSpent: 50,
      totalIncome: 200,
      remaining: 50,
      percentUsed: 50,
      overBudgetCategories: [],
      nearLimitCategories: [],
      categoryCount: 3,
      velocity: {
        dailyBurnRate: 1,
        safeDailySpend: 2,
        projectedTotal: 80,
        projectedVariance: -20,
        daysRemaining: 10,
        paceStatus: "under",
      },
      healthScore: { score: 90, label: "Good" },
    },
  },
  {
    name: "getBudgetStatusOutput (not-found error branch)",
    schema: schemas.getBudgetStatusOutput,
    raw: { error: "No budget found", availableBudgets: ["Main", "Vacation"] },
  },
];

describe("tool-output-schemas", () => {
  // Validate exactly what the MCP SDK's server-side validateToolOutput receives:
  // toolResult sanitizes + builds structuredContent, then the tool's outputSchema
  // (wrapped as a Zod object) must accept it.
  describe("structuredContent acceptance", () => {
    it.each(cases)(
      "$name validates against its output schema",
      ({ schema, raw }) => {
        const result = toolResult(raw);
        const parsed = z.object(schema).safeParse(result.structuredContent);
        if (!parsed.success) {
          throw new Error(JSON.stringify(parsed.error.issues, null, 2));
        }
        expect(parsed.success).toBe(true);
      },
    );
  });

  // End-to-end through the real SDK request path: a tool declaring outputSchema
  // and returning toolResult(...) must round-trip without an output-validation
  // error and surface structuredContent to the client.
  describe("end-to-end via InMemoryTransport", () => {
    const rawFor = (schema: RawShape): unknown => {
      const found = cases.find((c) => c.schema === schema);
      if (!found) throw new Error("no sample for schema");
      return found.raw;
    };

    const e2eTools: Array<{ name: string; schema: RawShape; raw: unknown }> = [
      {
        name: "get_accounts",
        schema: schemas.getAccountsOutput,
        raw: rawFor(schemas.getAccountsOutput),
      },
      {
        name: "get_net_worth",
        schema: schemas.getNetWorthOutput,
        raw: rawFor(schemas.getNetWorthOutput),
      },
      {
        name: "calculate",
        schema: schemas.calculateOutput,
        raw: rawFor(schemas.calculateOutput),
      },
      {
        name: "get_budget_status",
        schema: schemas.getBudgetStatusOutput,
        raw: rawFor(schemas.getBudgetStatusOutput),
      },
    ];

    it("returns validated structured content for tools that declare an output schema", async () => {
      const server = new McpServer(
        { name: "monize-test", version: "0.0.0" },
        { capabilities: { tools: {} } },
      );

      for (const tool of e2eTools) {
        server.registerTool(
          tool.name,
          {
            description: tool.name,
            inputSchema: {},
            outputSchema: tool.schema,
          },
          () => toolResult(tool.raw),
        );
      }

      const client = new Client(
        { name: "test-client", version: "0.0.0" },
        { capabilities: {} },
      );
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      try {
        // tools/list serializes every outputSchema to JSON Schema. An
        // unrepresentable node (e.g. z.nan()) throws and fails the whole
        // response, leaving clients with zero tools -- assert it succeeds and
        // lists all registered tools.
        const listed = await client.listTools();
        expect(listed.tools.map((t) => t.name).sort()).toEqual(
          e2eTools.map((t) => t.name).sort(),
        );

        for (const tool of e2eTools) {
          const res = await client.callTool({ name: tool.name, arguments: {} });
          expect(res.isError).toBeFalsy();
          expect(res.structuredContent).toBeDefined();
        }
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
});
