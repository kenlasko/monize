import { z } from "zod";

/**
 * Output schemas for every MCP tool.
 *
 * Each export is a Zod raw shape (the same form accepted by `inputSchema` in
 * `registerTool`). When a tool declares an `outputSchema`, the MCP SDK requires
 * the tool to return `structuredContent` and validates it against the schema,
 * so these shapes describe the structured payload produced by `toolResult`.
 *
 * Schemas are intentionally tolerant: Zod strips undeclared keys by default, so
 * extra/relation/timestamp fields on entity payloads never fail validation, and
 * we only model the fields the tools meaningfully expose. Tools that return a
 * bare array have their payload wrapped under `items` by `toStructuredContent`.
 */

// Monetary and other decimal values arrive as JS numbers at runtime (the
// entity `numericTransformer` converts PostgreSQL decimals). NaN is allowed so
// a divide-by-zero percentage (which serializes to JSON null) never fails
// structured-output validation.
const num = z.number().or(z.nan());
const numNull = num.nullable();
const str = z.string();
const strNull = z.string().nullable();
const bool = z.boolean();

// ---------------------------------------------------------------------------
// accounts.tool.ts
// ---------------------------------------------------------------------------

export const getAccountsOutput = {
  items: z.array(
    z.object({
      id: str,
      name: str,
      accountType: str.optional(),
      currencyCode: str.optional(),
      currentBalance: numNull.optional(),
      openingBalance: numNull.optional(),
      creditLimit: numNull.optional(),
      isClosed: bool.optional(),
      futureTransactionsSum: numNull.optional(),
    }),
  ),
};

export const getAccountBalanceOutput = {
  id: str,
  name: str,
  type: str,
  currentBalance: numNull,
  creditLimit: numNull,
  currencyCode: str,
};

export const getAccountBalancesOutput = {
  accounts: z.array(
    z.object({
      name: str,
      type: str,
      balance: num,
      currency: str,
      isClosed: bool,
    }),
  ),
  totalAssets: num,
  totalLiabilities: num,
  netWorth: num,
  totalAccounts: num,
};

// ---------------------------------------------------------------------------
// net-worth.tool.ts
// ---------------------------------------------------------------------------

export const getNetWorthOutput = {
  totalAccounts: num,
  totalBalance: num,
  totalAssets: num,
  totalLiabilities: num,
  netWorth: num,
};

export const getNetWorthHistoryOutput = {
  items: z.array(
    z.object({
      month: str,
      assets: num,
      liabilities: num,
      netWorth: num,
    }),
  ),
};

// ---------------------------------------------------------------------------
// transactions.tool.ts
// ---------------------------------------------------------------------------

export const searchTransactionsOutput = {
  transactions: z.array(
    z.object({
      id: str,
      splitId: str.optional(),
      date: str,
      payeeName: strNull,
      categoryName: str.optional(),
      amount: num,
      accountName: str.optional(),
      description: strNull,
      status: str,
      isSplit: bool.optional(),
    }),
  ),
  total: num,
  hasMore: bool,
};

export const queryTransactionsOutput = {
  totalIncome: num,
  totalExpenses: num,
  netCashFlow: num,
  transactionCount: num,
  byCurrency: z
    .record(
      z.string(),
      z.object({
        totalIncome: num,
        totalExpenses: num,
        netCashFlow: num,
        transactionCount: num,
      }),
    )
    .optional(),
  breakdown: z.unknown().optional(),
};

export const getSpendingByCategoryOutput = {
  categories: z.array(
    z.object({
      category: str,
      amount: num,
      percentage: num,
      transactionCount: num,
    }),
  ),
  totalSpending: num,
};

export const getIncomeSummaryOutput = {
  items: z.array(
    z.object({
      label: str,
      amount: num,
      count: num,
    }),
  ),
  totalIncome: num,
  groupedBy: str,
};

export const comparePeriodsOutput = {
  period1: z.object({ start: str, end: str, total: num }),
  period2: z.object({ start: str, end: str, total: num }),
  totalChange: num,
  totalChangePercent: num,
  comparison: z.array(
    z.object({
      label: str,
      period1Amount: num,
      period2Amount: num,
      change: num,
      changePercent: num,
    }),
  ),
};

export const getTransfersOutput = {
  accounts: z.array(
    z.object({
      accountName: str,
      currency: str,
      inbound: num,
      outbound: num,
      net: num,
      transferCount: num,
    }),
  ),
  totalInbound: num,
  totalOutbound: num,
  transferCount: num,
};

export const createTransactionOutput = {
  // Dry-run preview branch.
  dryRun: bool.optional(),
  preview: z
    .object({
      accountId: str.optional(),
      accountName: str.optional(),
      amount: num.optional(),
      date: str.optional(),
      payeeName: strNull.optional(),
      categoryId: strNull.optional(),
      description: strNull.optional(),
      currencyCode: str.optional(),
    })
    .optional(),
  message: str.optional(),
  // Created-transaction branch.
  id: str.optional(),
  date: str.optional(),
  amount: num.optional(),
  payeeName: strNull.optional(),
  status: str.optional(),
};

export const categorizeTransactionOutput = {
  id: str,
  categoryId: strNull,
  message: str,
};

// ---------------------------------------------------------------------------
// categories.tool.ts
// ---------------------------------------------------------------------------

export const getCategoriesOutput = {
  categories: z.array(
    z.object({
      id: str,
      name: str,
      parentName: strNull,
      isIncome: bool,
      transactionCount: num,
    }),
  ),
  totalCount: num,
};

// ---------------------------------------------------------------------------
// payees.tool.ts
// ---------------------------------------------------------------------------

export const getPayeesOutput = {
  items: z.array(
    z.object({
      id: str,
      name: str,
      defaultCategoryId: strNull.optional(),
      notes: str.optional(),
      isActive: bool.optional(),
      transactionCount: num.optional(),
      lastUsedDate: strNull.optional(),
      aliasCount: num.optional(),
      uncategorizedCount: num.optional(),
    }),
  ),
};

export const createPayeeOutput = {
  id: str,
  name: str,
  message: str,
};

// ---------------------------------------------------------------------------
// reports.tool.ts
// ---------------------------------------------------------------------------

export const generateReportOutput = {
  data: z.array(z.unknown()).optional(),
  totals: z.unknown().optional(),
  totalSpending: num.optional(),
  totalIncome: num.optional(),
};

export const monthlyComparisonOutput = {
  currentMonth: str.optional(),
  previousMonth: str.optional(),
  currentMonthLabel: str.optional(),
  previousMonthLabel: str.optional(),
  currency: str.optional(),
  incomeExpenses: z.record(z.string(), z.unknown()).optional(),
  notes: z.record(z.string(), z.unknown()).optional(),
  expenses: z.record(z.string(), z.unknown()).optional(),
  topCategories: z.record(z.string(), z.unknown()).optional(),
  netWorth: z.record(z.string(), z.unknown()).optional(),
  investments: z.record(z.string(), z.unknown()).optional(),
};

export const getAnomaliesOutput = {
  statistics: z.object({ mean: num, stdDev: num }),
  anomalies: z.array(
    z.object({
      type: str,
      severity: str,
      title: str,
      description: str,
      amount: num.optional(),
      transactionId: str.optional(),
      transactionDate: str.optional(),
      payeeName: strNull.optional(),
      categoryId: strNull.optional(),
      categoryName: strNull.optional(),
      currentPeriodAmount: num.optional(),
      previousPeriodAmount: num.optional(),
      percentChange: num.optional(),
    }),
  ),
  counts: z.object({ high: num, medium: num, low: num }),
};

// ---------------------------------------------------------------------------
// investments.tool.ts
// ---------------------------------------------------------------------------

export const getPortfolioSummaryOutput = {
  holdingCount: num,
  totalCashValue: num,
  totalHoldingsValue: num,
  totalCostBasis: num,
  totalPortfolioValue: num,
  totalGainLoss: num,
  totalGainLossPercent: numNull,
  timeWeightedReturn: numNull,
  cagr: numNull,
  holdings: z.array(
    z.object({
      symbol: str,
      name: str,
      securityType: str,
      currency: str,
      quantity: num,
      averageCost: numNull,
      costBasis: num,
      marketValue: numNull,
      gainLoss: numNull,
      gainLossPercent: numNull,
    }),
  ),
  allocation: z.array(
    z.object({
      name: str,
      symbol: strNull,
      type: str,
      value: num,
      percentage: num,
    }),
  ),
};

export const queryInvestmentTransactionsOutput = {
  transactionCount: num,
  totalAmount: num,
  totalCommission: num,
  totalQuantity: num,
  actionCounts: z.record(z.string(), num),
  groupedBy: strNull,
  groups: z
    .array(
      z.object({
        key: str,
        transactionCount: num,
        totalQuantity: num,
        totalAmount: num,
        totalCommission: num,
      }),
    )
    .nullable(),
  transactions: z.array(
    z.object({
      transactionDate: str,
      action: str,
      accountName: strNull,
      symbol: strNull,
      securityName: strNull,
      quantity: numNull,
      price: numNull,
      commission: num,
      totalAmount: num,
      currency: strNull,
      description: strNull,
    }),
  ),
  truncatedTransactionList: bool,
};

export const getCapitalGainsOutput = {
  startDate: str,
  endDate: str,
  totals: z.object({
    realizedGain: num,
    unrealizedGain: num,
    totalCapitalGain: num,
  }),
  groupedBy: str,
  entries: z.array(
    z.object({
      month: strNull,
      accountName: strNull,
      symbol: strNull,
      securityName: strNull,
      currency: strNull,
      startValue: num,
      endValue: num,
      realizedGain: num,
      unrealizedGain: num,
      totalCapitalGain: num,
    }),
  ),
  entryCount: num,
  truncatedEntryList: bool,
};

export const getHoldingDetailsOutput = {
  items: z.array(
    z.object({
      id: str,
      accountId: str,
      securityId: str,
      quantity: num,
      averageCost: numNull,
    }),
  ),
};

// ---------------------------------------------------------------------------
// scheduled.tool.ts
// ---------------------------------------------------------------------------

const scheduledItem = z.object({
  id: str,
  name: str,
  accountId: str,
  accountName: str,
  payeeName: strNull,
  categoryName: strNull,
  amount: num,
  currency: str,
  frequency: str,
  nextDueDate: str,
  daysUntilDue: num,
  isActive: bool,
  autoPost: bool,
  kind: str,
  description: strNull,
});

export const getUpcomingBillsOutput = {
  daysWindow: num,
  itemCount: num,
  overdueCount: num,
  totalUpcomingBills: num,
  totalUpcomingDeposits: num,
  items: z.array(scheduledItem),
};

export const getScheduledTransactionsOutput = {
  totalCount: num,
  activeCount: num,
  autoPostCount: num,
  billCount: num,
  depositCount: num,
  items: z.array(scheduledItem),
};

// ---------------------------------------------------------------------------
// calculate.tool.ts
// ---------------------------------------------------------------------------

export const calculateOutput = {
  result: num,
  formattedResult: str,
  operation: str,
  label: str.optional(),
};

// ---------------------------------------------------------------------------
// budgets.tool.ts
// ---------------------------------------------------------------------------

export const getBudgetStatusOutput = {
  // Success branch (all optional so the not-found error branch validates too).
  budgetName: str.optional(),
  strategy: str.optional(),
  period: z.object({ start: str, end: str }).optional(),
  totalBudgeted: num.optional(),
  totalSpent: num.optional(),
  totalIncome: num.optional(),
  remaining: num.optional(),
  percentUsed: num.optional(),
  overBudgetCategories: z
    .array(
      z.object({
        category: str,
        budgeted: num,
        spent: num,
        percentUsed: num,
      }),
    )
    .optional(),
  nearLimitCategories: z
    .array(
      z.object({
        category: str,
        budgeted: num,
        spent: num,
        remaining: num,
        percentUsed: num,
      }),
    )
    .optional(),
  categoryCount: num.optional(),
  velocity: z
    .object({
      dailyBurnRate: num,
      safeDailySpend: num,
      projectedTotal: num,
      projectedVariance: num,
      daysRemaining: num,
      paceStatus: str,
    })
    .optional(),
  healthScore: z.object({ score: num, label: str }).optional(),
  // Not-found error branch.
  error: str.optional(),
  availableBudgets: z.array(str).optional(),
};
