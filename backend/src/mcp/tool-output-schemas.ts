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
// entity `numericTransformer` converts PostgreSQL decimals). Decimals may be
// null-equivalent: a divide-by-zero percentage produces NaN at runtime, which
// `toolResult` normalizes to null (NaN's JSON form) so it both passes
// structured-output validation and serializes. `num` must therefore accept
// null. It must NOT use `z.nan()`: the SDK serializes each tool's outputSchema
// to JSON Schema for `tools/list`, and `z.nan()` is unrepresentable there
// ("NaN cannot be represented in JSON Schema"), which fails the whole
// tools/list response and leaves every client showing zero tools.
const num = z.number().nullable();
const numNull = num;

// Every output object is loose. Tools return entity payloads that carry fields
// beyond the modeled subset (timestamps, foreign keys, relations). The SDK
// serializes each outputSchema to JSON Schema in OUTPUT mode for `tools/list`,
// where a default (strip) object becomes `additionalProperties: false`; the
// client then rejects the extra fields with an output-validation error. `.loose()`
// emits `additionalProperties: {}` so the real payloads validate. (The server
// side validates with Zod, which strips unknown keys -- the strictness only
// bites on the client.)
const looseObject = (shape: z.ZodRawShape) => z.object(shape).loose();
const str = z.string();
const strNull = z.string().nullable();
const bool = z.boolean();

// ---------------------------------------------------------------------------
// accounts.tool.ts
// ---------------------------------------------------------------------------

/**
 * Unified `list_accounts` tool output. Replaces get_accounts /
 * get_account_balance / get_account_balances: every account detail plus a
 * rollup summary (assets, liabilities, net worth, account count). Tolerant so
 * extra entity fields and the optional/nullable columns all validate.
 */
export const listAccountsOutput = {
  accounts: z.array(
    looseObject({
      id: str,
      name: str,
      type: str,
      subType: strNull.optional(),
      balance: num,
      currentBalance: numNull.optional(),
      creditLimit: numNull.optional(),
      interestRate: numNull.optional(),
      currency: str,
      isClosed: bool,
      excludeFromNetWorth: bool.optional(),
      institutionName: strNull.optional(),
      accountNumber: strNull.optional(),
    }),
  ),
  totalAssets: num,
  totalLiabilities: num,
  netWorth: num,
  totalAccounts: num,
  accountCount: num.optional(),
};

// ---------------------------------------------------------------------------
// net-worth.tool.ts
// ---------------------------------------------------------------------------

export const getNetWorthHistoryOutput = {
  items: z.array(
    looseObject({
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

export const comparePeriodsOutput = {
  period1: looseObject({ start: str, end: str, total: num }),
  period2: looseObject({ start: str, end: str, total: num }),
  totalChange: num,
  totalChangePercent: num,
  comparison: z.array(
    looseObject({
      label: str,
      period1Amount: num,
      period2Amount: num,
      change: num,
      changePercent: num,
    }),
  ),
};

const bulkSkippedRow = looseObject({ index: num, reason: str });

export const createTransactionsOutput = {
  // Dry-run / preview branch: resolved rows + the rows that could not resolve.
  dryRun: bool.optional(),
  preview: z
    .object({
      rows: z.array(looseObject({})).optional(),
      skipped: z.array(bulkSkippedRow).optional(),
    })
    .loose()
    .optional(),
  message: str.optional(),
  // Created branch: ids of the rows created best-effort plus any skipped.
  created: z.array(looseObject({})).optional(),
  ids: z.array(str).optional(),
  count: num.optional(),
  skipped: z.array(bulkSkippedRow).optional(),
  // Relay branch: a confirmation card was shown in the web chat instead.
  status: str.optional(),
};

/**
 * Unified `list_transactions` tool output. Replaces search_transactions /
 * query_transactions / get_transfers: a rich summary (income/expense/net,
 * per-currency totals, optional grouped breakdown, optional transfer rollup)
 * plus an optional raw transaction list that is only included when explicitly
 * requested. Tolerant so every branch validates.
 */
export const listTransactionsOutput = {
  totalIncome: num.optional(),
  totalExpenses: num.optional(),
  netCashFlow: num.optional(),
  transactionCount: num.optional(),
  byCurrency: z
    .record(
      z.string(),
      looseObject({
        totalIncome: num,
        totalExpenses: num,
        netCashFlow: num,
        transactionCount: num,
      }),
    )
    .optional(),
  groupedBy: strNull.optional(),
  breakdown: z.unknown().optional(),
  // get_transfers rollup branch (transfersOnly).
  transfers: z.object({}).loose().optional(),
  // Raw transaction list branch (includeTransactions).
  transactions: z.array(looseObject({})).optional(),
  total: num.optional(),
  hasMore: bool.optional(),
  truncatedTransactionList: bool.optional(),
};

/**
 * Tolerant output for the unified `manage_transactions` tool. The tool has many
 * result branches (dry-run preview, single created/updated/deleted, per-item
 * results in individual mode, bulk count/skipped, and the relay branch), so ALL
 * fields are optional and the object is loose.
 */
export const manageTransactionsOutput = {
  // Dry-run preview branch (per-item previews + skipped rows).
  dryRun: bool.optional(),
  operation: str.optional(),
  preview: z.object({}).loose().optional(),
  previews: z.array(looseObject({})).optional(),
  message: str.optional(),
  // Single created/updated/deleted branch.
  id: str.optional(),
  date: str.optional(),
  amount: num.optional(),
  payeeId: strNull.optional(),
  payeeName: strNull.optional(),
  categoryId: strNull.optional(),
  deleted: bool.optional(),
  // Bulk / individual branches.
  created: z.array(looseObject({})).optional(),
  results: z.array(looseObject({})).optional(),
  ids: z.array(str).optional(),
  count: num.optional(),
  skipped: z.array(bulkSkippedRow).optional(),
  // Relay branch: a confirmation card was shown in the web chat instead.
  status: str.optional(),
};

// ---------------------------------------------------------------------------
// categories.tool.ts
// ---------------------------------------------------------------------------

export const getCategoriesOutput = {
  categories: z.array(
    looseObject({
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
    looseObject({
      id: str,
      name: str,
      defaultCategoryId: strNull.optional(),
      // notes is a nullable column -- a payee without notes serializes as null,
      // which must pass output validation (was rejected by a non-null string).
      notes: strNull.optional(),
      isActive: bool.optional(),
      transactionCount: num.optional(),
      lastUsedDate: strNull.optional(),
      aliasCount: num.optional(),
      uncategorizedCount: num.optional(),
    }),
  ),
};

/**
 * Tolerant output for the unified `manage_payees` tool. Like
 * manage_transactions it has many result branches (dry-run preview, single
 * created/updated/deleted, bulk count/skipped, and the relay branch), so ALL
 * fields are optional and the object is loose.
 */
export const managePayeesOutput = {
  // Dry-run preview branch (per-item previews + skipped rows).
  dryRun: bool.optional(),
  operation: str.optional(),
  previews: z.array(looseObject({})).optional(),
  message: str.optional(),
  // Single created/updated/deleted branch.
  id: str.optional(),
  name: str.optional(),
  deleted: bool.optional(),
  // Bulk branch.
  ids: z.array(str).optional(),
  count: num.optional(),
  skipped: z.array(bulkSkippedRow).optional(),
  // Relay branch: a confirmation card was shown in the web chat instead.
  status: str.optional(),
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
  statistics: looseObject({ mean: num, stdDev: num }),
  anomalies: z.array(
    looseObject({
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
  counts: looseObject({ high: num, medium: num, low: num }),
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
    looseObject({
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
    looseObject({
      name: str,
      symbol: strNull,
      type: str,
      value: num,
      percentage: num,
    }),
  ),
};

export const listInvestmentTransactionsOutput = {
  transactionCount: num,
  totalAmount: num,
  totalCommission: num,
  totalQuantity: num,
  actionCounts: z.record(z.string(), num),
  groupedBy: strNull,
  groups: z
    .array(
      looseObject({
        key: str,
        transactionCount: num,
        totalQuantity: num,
        totalAmount: num,
        totalCommission: num,
      }),
    )
    .nullable(),
  transactions: z.array(
    looseObject({
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
  totals: looseObject({
    realizedGain: num,
    unrealizedGain: num,
    totalCapitalGain: num,
  }),
  groupedBy: str,
  entries: z.array(
    looseObject({
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
    looseObject({
      id: str,
      accountId: str,
      securityId: str,
      quantity: num,
      averageCost: numNull,
    }),
  ),
};

export const lookupSecuritiesOutput = {
  query: str,
  count: num,
  candidates: z.array(
    looseObject({
      symbol: str,
      name: str,
      exchange: strNull,
      securityType: strNull,
      currencyCode: strNull,
      provider: strNull,
      alreadyAdded: bool,
    }),
  ),
};

/**
 * Tolerant output for the unified `manage_securities` tool. Like
 * manage_transactions it has many result branches (dry-run preview, single
 * created/updated/deleted, bulk count/skipped, and the relay branch), so ALL
 * fields are optional and the object is loose.
 */
export const manageSecuritiesOutput = {
  // Dry-run preview branch (per-item previews + skipped rows).
  dryRun: bool.optional(),
  operation: str.optional(),
  previews: z.array(looseObject({})).optional(),
  message: str.optional(),
  // Single created/updated/deleted branch.
  id: str.optional(),
  symbol: str.optional(),
  name: str.optional(),
  securityType: strNull.optional(),
  exchange: strNull.optional(),
  currencyCode: str.optional(),
  isFavourite: bool.optional(),
  deleted: bool.optional(),
  // Bulk branch.
  ids: z.array(str).optional(),
  count: num.optional(),
  skipped: z.array(bulkSkippedRow).optional(),
  // Relay branch: a confirmation card was shown in the web chat instead.
  status: str.optional(),
};

/**
 * Tolerant output for the unified `manage_investment_transactions` tool. Like
 * manage_transactions it has many result branches (single created/updated/
 * deleted preview, bulk one-card, individual per-item cards, and the relay
 * branch), so ALL fields are optional and the object is loose.
 */
export const manageInvestmentTransactionsOutput = {
  operation: str.optional(),
  preview: z.object({}).loose().optional(),
  previews: z.array(looseObject({})).optional(),
  message: str.optional(),
  id: str.optional(),
  action: str.optional(),
  date: str.optional(),
  symbol: strNull.optional(),
  quantity: numNull.optional(),
  price: numNull.optional(),
  totalAmount: num.optional(),
  deleted: bool.optional(),
  created: z.array(looseObject({})).optional(),
  results: z.array(looseObject({})).optional(),
  ids: z.array(str).optional(),
  count: num.optional(),
  skipped: z.array(bulkSkippedRow).optional(),
  // Relay branch: a confirmation card was shown in the web chat instead.
  status: str.optional(),
};

// ---------------------------------------------------------------------------
// scheduled.tool.ts
// ---------------------------------------------------------------------------

const scheduledItem = looseObject({
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
  period: looseObject({ start: str, end: str }).optional(),
  totalBudgeted: num.optional(),
  totalSpent: num.optional(),
  totalIncome: num.optional(),
  remaining: num.optional(),
  percentUsed: num.optional(),
  overBudgetCategories: z
    .array(
      looseObject({
        category: str,
        budgeted: num,
        spent: num,
        percentUsed: num,
      }),
    )
    .optional(),
  nearLimitCategories: z
    .array(
      looseObject({
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
  healthScore: looseObject({ score: num, label: str }).optional(),
  // Not-found error branch.
  error: str.optional(),
  availableBudgets: z.array(str).optional(),
};

// ---------------------------------------------------------------------------
// relay.tool.ts
// ---------------------------------------------------------------------------

export const getNextPromptOutput = {
  hasPrompt: bool,
  // Present only when hasPrompt is true.
  promptId: str.optional(),
  prompt: str.optional(),
  history: z.array(looseObject({ role: str, content: str })).optional(),
};

export const postResponseOutput = {
  delivered: bool,
};

export const reportProgressOutput = {
  delivered: bool,
};
