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
    name: "listAccountsOutput",
    schema: schemas.listAccountsOutput,
    raw: {
      accounts: [
        {
          id: "a1",
          name: "Checking",
          type: "CHEQUING",
          subType: null,
          balance: 100.5,
          currentBalance: 100.5,
          creditLimit: null,
          interestRate: null,
          currency: "USD",
          isClosed: false,
          excludeFromNetWorth: false,
          institutionName: null,
          accountNumber: null,
          // Undeclared fields present on the real entity must be tolerated.
          userId: "u1",
        },
      ],
      totalAssets: 100.5,
      totalLiabilities: 0,
      netWorth: 100.5,
      totalAccounts: 1,
    },
  },
  {
    name: "listTransactionsOutput (summary branch)",
    schema: schemas.listTransactionsOutput,
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
      groupedBy: "category",
      breakdown: { groupedBy: "category", groups: [] },
    },
  },
  {
    name: "listTransactionsOutput (transfers rollup branch)",
    schema: schemas.listTransactionsOutput,
    raw: {
      totalIncome: 0,
      totalExpenses: 0,
      netCashFlow: 0,
      transactionCount: 2,
      groupedBy: "none",
      transfers: {
        totalInbound: 5,
        totalOutbound: 0,
        net: 5,
        accounts: [],
      },
    },
  },
  {
    name: "listTransactionsOutput (includeTransactions branch)",
    schema: schemas.listTransactionsOutput,
    raw: {
      totalIncome: 0,
      totalExpenses: 5,
      netCashFlow: -5,
      transactionCount: 1,
      groupedBy: "none",
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
      truncatedTransactionList: false,
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
    name: "manageTransactionsOutput (single created branch)",
    schema: schemas.manageTransactionsOutput,
    raw: { id: "t1", date: "2026-01-01", count: 1 },
  },
  {
    name: "manageTransactionsOutput (single deleted branch)",
    schema: schemas.manageTransactionsOutput,
    raw: { id: "t1", deleted: true, count: 1 },
  },
  {
    name: "manageTransactionsOutput (bulk branch)",
    schema: schemas.manageTransactionsOutput,
    raw: {
      ids: ["t1", "t2"],
      count: 2,
      skipped: [{ index: 2, reason: "Unknown account: Foo" }],
    },
  },
  {
    name: "manageTransactionsOutput (dry-run branch)",
    schema: schemas.manageTransactionsOutput,
    raw: {
      dryRun: true,
      operation: "create",
      previews: [
        {
          status: "ok",
          accountName: "Checking",
          amount: -5,
          currencyCode: "USD",
          transactionDate: "2026-01-01",
        },
        {
          status: "error",
          accountName: "Nope",
          error: "Unknown account: Nope",
        },
      ],
      skipped: [{ index: 1, reason: "Unknown account: Nope" }],
      message: "preview only",
    },
  },
  {
    name: "manageTransactionsOutput (relay branch)",
    schema: schemas.manageTransactionsOutput,
    raw: { status: "preview_shown" },
  },
  {
    name: "manageInvestmentTransactionsOutput (single created branch)",
    schema: schemas.manageInvestmentTransactionsOutput,
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
    name: "manageInvestmentTransactionsOutput (single deleted branch)",
    schema: schemas.manageInvestmentTransactionsOutput,
    raw: { id: "it1", deleted: true },
  },
  {
    name: "manageInvestmentTransactionsOutput (bulk branch)",
    schema: schemas.manageInvestmentTransactionsOutput,
    raw: {
      ids: ["it1", "it2"],
      count: 2,
      skipped: [{ index: 2, reason: "Unknown account: Foo" }],
    },
  },
  {
    name: "manageInvestmentTransactionsOutput (dry-run branch with null symbol/price)",
    schema: schemas.manageInvestmentTransactionsOutput,
    raw: {
      dryRun: true,
      operation: "update",
      preview: {
        transactionId: "it1",
        symbol: null,
        quantity: null,
        price: null,
      },
      message: "preview only",
    },
  },
  {
    name: "manageInvestmentTransactionsOutput (relay branch)",
    schema: schemas.manageInvestmentTransactionsOutput,
    raw: { status: "preview_shown" },
  },
  {
    name: "lookupSecuritiesOutput",
    schema: schemas.lookupSecuritiesOutput,
    raw: {
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
          exchange: null,
          securityType: null,
          currencyCode: null,
          provider: null,
          alreadyAdded: true,
        },
      ],
    },
  },
  {
    name: "manageSecuritiesOutput (single created branch)",
    schema: schemas.manageSecuritiesOutput,
    raw: {
      id: "sec1",
      symbol: "AAPL",
      name: "Apple Inc.",
      securityType: "STOCK",
      exchange: "NASDAQ",
      currencyCode: "USD",
      isFavourite: false,
      count: 1,
    },
  },
  {
    name: "manageSecuritiesOutput (dry-run branch)",
    schema: schemas.manageSecuritiesOutput,
    raw: {
      dryRun: true,
      operation: "create",
      previews: [{ status: "ok", symbol: "AAPL", securityName: "Apple Inc." }],
      skipped: [],
      message: "This is a preview.",
    },
  },
  {
    name: "manageSecuritiesOutput (bulk branch)",
    schema: schemas.manageSecuritiesOutput,
    raw: {
      ids: ["sec1", "sec2"],
      count: 2,
      skipped: [{ index: 2, reason: 'No security matches "X"' }],
    },
  },
  {
    name: "manageSecuritiesOutput (relay branch)",
    schema: schemas.manageSecuritiesOutput,
    raw: { status: "preview_shown" },
  },
  {
    name: "createTransactionsOutput (created branch)",
    schema: schemas.createTransactionsOutput,
    raw: {
      created: [{ id: "t1", date: "2026-01-01", amount: -5 }],
      ids: ["t1"],
      count: 1,
      skipped: [{ index: 1, reason: "Unknown account" }],
    },
  },
  {
    name: "createTransactionsOutput (dry-run branch)",
    schema: schemas.createTransactionsOutput,
    raw: {
      dryRun: true,
      preview: {
        rows: [{ status: "ok", amount: -5 }],
        skipped: [],
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
    name: "managePayeesOutput (single created branch)",
    schema: schemas.managePayeesOutput,
    raw: { id: "p1", name: "Amazon", count: 1 },
  },
  {
    name: "managePayeesOutput (bulk branch)",
    schema: schemas.managePayeesOutput,
    raw: {
      ids: ["p1", "p2"],
      count: 2,
      skipped: [{ index: 2, reason: 'Payee "x" not found' }],
    },
  },
  {
    name: "generateReportOutput (aggregation type)",
    schema: schemas.generateReportOutput,
    raw: {
      data: [{ categoryId: "c1", categoryName: "Food", color: null, total: 5 }],
      totalSpending: 5,
    },
  },
  {
    name: "generateReportOutput (month_comparison type)",
    schema: schemas.generateReportOutput,
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
    name: "generateReportOutput (net_worth_history type)",
    schema: schemas.generateReportOutput,
    // Bare array -> toolResult wraps it under `items`.
    raw: [{ month: "2026-01-01", assets: 1, liabilities: 0, netWorth: 1 }],
  },
  {
    name: "generateReportOutput (spending_anomalies type)",
    schema: schemas.generateReportOutput,
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
      holdingsByAccount: [
        {
          accountName: "TFSA",
          currency: "USD",
          cashBalance: 0,
          totalCostBasis: 80,
          totalMarketValue: 100,
          totalGainLoss: 20,
          totalGainLossPercent: 25,
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
    name: "listInvestmentTransactionsOutput",
    schema: schemas.listInvestmentTransactionsOutput,
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
  {
    name: "getNextPromptOutput (claimed branch)",
    schema: schemas.getNextPromptOutput,
    raw: {
      hasPrompt: true,
      promptId: "p1",
      prompt: "Categorise this invoice",
      history: [{ role: "user", content: "hi" }],
    },
  },
  {
    name: "getNextPromptOutput (with attachments)",
    schema: schemas.getNextPromptOutput,
    raw: {
      hasPrompt: true,
      promptId: "p1",
      prompt: "What is in this image?",
      history: [],
      attachments: [
        {
          id: "att-1",
          filename: "chart.png",
          mediaType: "image/png",
          kind: "image",
          uri: "monize-attachment://att-1",
        },
      ],
    },
  },
  {
    name: "getNextPromptOutput (empty branch)",
    schema: schemas.getNextPromptOutput,
    raw: { hasPrompt: false },
  },
  {
    name: "postResponseOutput",
    schema: schemas.postResponseOutput,
    raw: { delivered: true },
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
        name: "list_accounts",
        schema: schemas.listAccountsOutput,
        raw: rawFor(schemas.listAccountsOutput),
      },
      {
        name: "list_transactions",
        schema: schemas.listTransactionsOutput,
        raw: rawFor(schemas.listTransactionsOutput),
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
