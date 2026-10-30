import { z } from "zod";

/**
 * Output schemas for every MCP tool.
 *
 * Each export is a LOOSE `z.object` (a schema instance, which `registerTool`
 * accepts alongside a raw shape). The distinction is not about what reaches the
 * caller: the server validates `structuredContent` with `safeParseAsync` and
 * then sends the handler's ORIGINAL object, so no field is ever stripped on the
 * way out. It is about the JSON Schema the CLIENT validates against with ajv --
 * a raw shape is wrapped in a strip-mode object, which serializes as
 * `additionalProperties: false` and makes the client reject the very fields the
 * tools return. `.loose()` emits `additionalProperties: {}`.
 *
 * That is also why these schemas are deliberately shallow. Every byte here is
 * serialized into `tools/list` and carried on every request, so a schema
 * declares what a model must be able to REASON about -- totals, completeness
 * flags, the currency a total is in, and ids it has to copy back -- and leaves
 * row-level columns to the payload itself, which arrives in full either way.
 */

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
/** A tool's whole output: loose, so a result branch need not be enumerated. */
const toolOutput = (shape: z.ZodRawShape) => z.object(shape).loose();
/** A row the model reads but never has to reason about field by field. */
const rows = () => z.array(looseObject({}));
const str = z.string();
const strNull = z.string().nullable();
const bool = z.boolean();
// Review context carries its status, counts and interpretation in the response.
// Like row-level diagnostics, its fields stay out of the repeated tools/list
// payload; the loose object still validates the full returned context.
const sharedReview = looseObject({}).optional();

// ---------------------------------------------------------------------------
// accounts.tool.ts
// ---------------------------------------------------------------------------

/**
 * Unified `list_accounts` tool output. Replaces get_accounts /
 * get_account_balance / get_account_balances: every account detail plus a
 * rollup summary (assets, liabilities, net worth, account count). Tolerant so
 * extra entity fields and the optional/nullable columns all validate.
 */
export const listAccountsOutput = toolOutput({
  sharedExpenses: sharedReview,
  // Each row carries `balance`/`currentBalance` in its own `currency` AND in
  // `defaultCurrency` (`balanceInDefaultCurrency`, `currentBalanceInDefaultCurrency`,
  // at `exchangeRate`); the description names them, and per the note above
  // row-level columns stay out of the schema -- three nullable numbers cost
  // ~340 bytes of `anyOf` on every request.
  accounts: rows(),
  totalAssets: num,
  totalLiabilities: num,
  netWorth: num,
  // The currency the three totals and every `*InDefaultCurrency` are in, and
  // the pairs a null converted figure is missing a rate for.
  defaultCurrency: str,
  missingRatePairs: z.array(str),
  totalAccounts: num,
  // A null total is withheld: `fxComplete` / `pricesComplete` say which repair
  // is open. `known*` subtotals stay undeclared (loose object).
  fxComplete: bool,
  pricesComplete: bool,
  valuationComplete: bool,
});

// ---------------------------------------------------------------------------
// transactions.tool.ts
// ---------------------------------------------------------------------------

export const comparePeriodsOutput = toolOutput({
  sharedExpenses: sharedReview,
  // Every figure is in `totalsCurrency`, each row converted at its own date. A
  // period `total` (and so `totalChange` / `totalChangePercent`) is null while
  // a pair has no rate; `knownSubtotal` (per period, undeclared like the
  // portfolio's return diagnostics: the tool is at its `tools/list` budget)
  // is what did convert. These flags are the contract, not decoration.
  period1: looseObject({ start: str, end: str, total: num }),
  period2: looseObject({ start: str, end: str, total: num }),
  totalChange: num,
  totalChangePercent: num,
  totalsCurrency: str,
  fxComplete: bool,
  missingRatePairs: z.array(str),
  comparison: rows(),
});

// A row a write refused, with the reason the user has to be told: a refusal
// the caller cannot act on is a refusal that ends the task.
const bulkSkippedRow = looseObject({ index: num, reason: str });

/**
 * Shared output envelope for the four `manage_*` tools. They all expose the same
 * result branches -- dry-run preview, a single created/updated/deleted entity,
 * bulk/individual results, and the relay branch -- and differ only in the fields
 * of the single-entity branch. Every field is optional and the object is loose,
 * so this superset envelope validates each tool's payloads; `entityFields`
 * supplies the per-tool single-entity columns.
 */
const manageToolOutput = (entityFields: z.ZodRawShape) =>
  toolOutput({
    // Dry-run / preview branch.
    dryRun: bool.optional(),
    operation: str.optional(),
    preview: z.object({}).loose().optional(),
    previews: z.array(looseObject({})).optional(),
    message: str.optional(),
    // Single created/updated/deleted entity (tool-specific) + common delete flag.
    ...entityFields,
    deleted: bool.optional(),
    // Bulk / individual branches.
    created: z.array(looseObject({})).optional(),
    results: z.array(looseObject({})).optional(),
    ids: z.array(str).optional(),
    count: num.optional(),
    skipped: z.array(bulkSkippedRow).optional(),
    // Relay branch: a confirmation card was shown in the web chat instead.
    status: str.optional(),
  });

/**
 * Unified `list_transactions` tool output. Replaces search_transactions /
 * query_transactions / get_transfers: a rich summary (income/expense/net,
 * per-currency totals, optional grouped breakdown, optional transfer rollup)
 * plus an optional raw transaction list that is only included when explicitly
 * requested. Tolerant so every branch validates.
 */
export const listTransactionsOutput = toolOutput({
  sharedExpenses: sharedReview,
  // The three totals are in `totalsCurrency` (each row converted at its own
  // date) and null while a pair has no rate; `knownIncomeSubtotal` and
  // `knownExpensesSubtotal` carry what did convert (undeclared: the tool is at
  // its `tools/list` budget) and `missingRatePairs` the pairs to repair.
  // `byCurrency` is the unconverted view, each entry in its own currency.
  totalIncome: num,
  totalExpenses: num,
  netCashFlow: num,
  totalsCurrency: str,
  fxComplete: bool,
  missingRatePairs: z.array(str),
  transactionCount: num.optional(),
  byCurrency: z.record(z.string(), looseObject({})).optional(),
  groupedBy: strNull.optional(),
  breakdown: z.unknown().optional(),
  transfers: looseObject({}).optional(),
  transactions: rows().optional(),
  total: num.optional(),
  hasMore: bool.optional(),
  truncatedTransactionList: bool.optional(),
});

/**
 * Tolerant output for the unified `manage_transactions` tool. See
 * `manageToolOutput` for the shared branch envelope; only the single-entity
 * fields are tool-specific.
 */
export const manageTransactionsOutput = manageToolOutput({
  id: str.optional(),
  date: str.optional(),
  amount: num.optional(),
  payeeId: strNull.optional(),
  payeeName: strNull.optional(),
  categoryId: strNull.optional(),
  // Files saved on the transaction by the direct (non-relay) confirm path.
  attachments: z.array(looseObject({ id: str, filename: str })).optional(),
});

// ---------------------------------------------------------------------------
// categories.tool.ts
// ---------------------------------------------------------------------------

export const getCategoriesOutput = toolOutput({
  // `qualifiedName` is the string every other tool accepts back, so the model
  // has to know it exists; the rest of a category row is read, not reasoned on.
  categories: z.array(looseObject({ id: str, qualifiedName: str })),
  totalCount: num,
});

// ---------------------------------------------------------------------------
// payees.tool.ts
// ---------------------------------------------------------------------------

export const getPayeesOutput = toolOutput({
  payees: z.array(looseObject({ id: str, name: str })),
  // How many matched the filters, against how many came back: a capped list
  // described as the whole one is a subtotal wearing a total's name.
  totalCount: num,
  truncated: bool,
});

/**
 * Tolerant output for the unified `manage_payees` tool. See `manageToolOutput`
 * for the shared branch envelope; only the single-entity fields are
 * tool-specific.
 */
export const managePayeesOutput = manageToolOutput({
  id: str.optional(),
  name: str.optional(),
});

// ---------------------------------------------------------------------------
// reports.tool.ts
// ---------------------------------------------------------------------------

/**
 * Unified `generate_report` output. The tool runs eight report types whose
 * payloads differ, so every field is optional and the object stays tolerant:
 * the five date-range aggregations return data/totals; 'month_comparison'
 * returns the current/previous-month bundle; 'spending_anomalies' returns
 * statistics/anomalies/counts; 'net_worth_history' returns a bare array of
 * monthly snapshots, wrapped under `items` by `toolResult`.
 */
export const generateReportOutput = toolOutput({
  sharedExpenses: sharedReview,
  // Eight report types with different payloads. Loose, so each branch's own
  // fields travel without eight shapes being spelled out here.
  data: z.array(z.unknown()).optional(),
  totals: z.unknown().optional(),
  // Nullable on purpose: every date-range report withholds its total when a
  // row could not be converted (INV-FX-001), and sends `knownSpending` /
  // `knownIncome`, `missingCurrencies` and `excludedCount` beside it. Those are
  // not declared here -- they belong to individual branches, and the loose
  // object carries a branch's own fields to the model without eight shapes being
  // spelled out (and without the tools/list payload paying for every one of
  // them; `tools-list-budget.spec.ts` holds this tool to a byte ceiling).
  totalSpending: num.optional(),
  totalIncome: num.optional(),
  items: rows().optional(),
  currency: str.optional(),
  statistics: looseObject({ mean: num, stdDev: num }).optional(),
  anomalies: rows().optional(),
  counts: looseObject({ high: num, medium: num, low: num }).optional(),
});

// ---------------------------------------------------------------------------
// investments.tool.ts
// ---------------------------------------------------------------------------

export const getPortfolioSummaryOutput = toolOutput({
  holdingCount: num,
  // The completeness flags are the contract, not decoration: a model must be
  // able to tell a total from a subtotal, so they stay declared (RR2-007).
  fxComplete: bool,
  missingRatePairs: z.array(str),
  pricesComplete: bool,
  unpricedSymbols: z.array(str),
  valuationComplete: bool,
  totalCashValue: num,
  totalHoldingsValue: num,
  totalCostBasis: num,
  totalPortfolioValue: num,
  // `totalGainLoss` is over the holdings that have a value (value less THEIR
  // cost), a partial figure while `valuationComplete` is false. `gainCostBasis`
  // (the cost it is over) and `unpricedCostBasis` (the cost it leaves out)
  // reach the caller through the loose object rather than the schema, for the
  // same budget reason as the fields below (A26-M38).
  totalGainLoss: num,
  totalGainLossPercent: numNull,
  // `timeWeightedReturn` is the invested part's TWR since the first
  // transaction; `null` is withheld, never zero. It travels with
  // `timeWeightedReturnReasons` (the withheld cause) and
  // `timeWeightedReturnSince` (the close it is measured from), which reach the
  // caller through the loose object rather than the schema: declaring either
  // costs ~95 bytes of `tools/list` on every request and this tool is at its
  // budget (`tools-list-budget.spec.ts`).
  timeWeightedReturn: numNull,
  // `moneyWeightedReturn` is the same measure's second figure: the invested
  // part's annualised XIRR since the first transaction -- what the caller's own
  // money earned, each purchase, sale and distribution weighted by when it
  // happened -- with `moneyWeightedReturnReasons` beside it. Both are
  // UNDECLARED here and reach the caller through the loose object, for the
  // reason above: the tool is at its `tools/list` byte budget, which is
  // shrink-only.
  //
  // `returnDiagnostics` is undeclared for the same reason. It names and dates
  // what a withheld return is waiting for -- each security with no close, each
  // pair with no rate, each cash account with no balance, over the run of days
  // it covers -- so an answer says which holding to price rather than "not
  // available"; the loose object carries it whole.
  cagr: numNull,
  // securityId is the id an entity link must quote, so it is named here.
  holdings: z.array(looseObject({ securityId: str })),
  holdingsByAccount: z.array(
    looseObject({
      accountName: str,
      currency: str,
      // This account's own completeness: its totals are in ITS currency, the
      // top-level ones in the user's, so a global flag cannot speak for them.
      fxComplete: bool,
      missingRatePairs: z.array(str),
      pricesComplete: bool,
      valuationComplete: bool,
      holdings: z.array(looseObject({ securityId: str })),
    }),
  ),
  allocation: rows(),
  lookThrough: looseObject({}).optional(),
});

export const listInvestmentTransactionsOutput = toolOutput({
  transactionCount: num,
  totalAmount: num,
  totalCommission: num,
  // Distributions, cash and reinvested, keyed by the currency they are in.
  incomeByCurrency: z.record(z.string(), num),
  totalQuantity: num,
  actionCounts: z.record(z.string(), num),
  groupedBy: strNull,
  groups: rows().nullable(),
  transactions: rows(),
  truncatedTransactionList: bool,
});

export const getCapitalGainsOutput = toolOutput({
  startDate: str,
  endDate: str,
  totals: looseObject({
    realizedGain: num,
    unrealizedGain: num,
    totalCapitalGain: num,
    // Read `fxComplete === false`: a figure is null while a pair has no rate.
    currency: str,
    fxComplete: bool,
    missingRatePairs: z.array(str),
  }),
  groupedBy: str,
  entries: rows(),
  entryCount: num,
  truncatedEntryList: bool,
});

export const lookupSecuritiesOutput = toolOutput({
  query: str,
  count: num,
  // alreadyAdded decides whether to offer adding it, so the model reasons on it.
  candidates: z.array(looseObject({ symbol: str, alreadyAdded: bool })),
});

/**
 * Tolerant output for the unified `manage_securities` tool. See
 * `manageToolOutput` for the shared branch envelope; only the single-entity
 * fields are tool-specific.
 */
export const manageSecuritiesOutput = manageToolOutput({
  id: str.optional(),
  symbol: str.optional(),
  name: str.optional(),
  securityType: strNull.optional(),
  exchange: strNull.optional(),
  currencyCode: str.optional(),
  isFavourite: bool.optional(),
  // list: the account queried and the securities held in it.
  account: str.optional(),
  securities: rows().optional(),
});

/**
 * Tolerant output for the unified `manage_investment_transactions` tool. See
 * `manageToolOutput` for the shared branch envelope; only the single-entity
 * fields are tool-specific.
 */
export const manageInvestmentTransactionsOutput = manageToolOutput({
  id: str.optional(),
  action: str.optional(),
  date: str.optional(),
  symbol: strNull.optional(),
  quantity: numNull.optional(),
  price: numNull.optional(),
  totalAmount: num.optional(),
});

// ---------------------------------------------------------------------------
// scheduled.tool.ts
// ---------------------------------------------------------------------------

export const getUpcomingBillsOutput = toolOutput({
  daysWindow: num,
  itemCount: num,
  overdueCount: num,
  // Null when anything in the bucket is unknown or unconvertible; the partial
  // sum then travels in the `known*Subtotal` beside it (issue #1247).
  totalUpcomingBills: numNull,
  totalUpcomingDeposits: numNull,
  // The currency BOTH totals are in. Items keep their own, so a total is only
  // readable alongside this field.
  totalsCurrency: str,
  knownUpcomingBillsSubtotal: num.optional(),
  knownUpcomingDepositsSubtotal: num.optional(),
  amountsComplete: bool,
  unknownAmountItems: z.array(str).optional(),
  missingRatePairs: z.array(str).optional(),
  // Per occurrence: its id (for an entity link), which way it posts, and
  // whether its amount is known at all.
  items: z.array(
    looseObject({
      id: str,
      kind: str,
      amount: numNull,
      amountComplete: bool,
      currency: str,
    }),
  ),
});

// ---------------------------------------------------------------------------
// calculate.tool.ts
// ---------------------------------------------------------------------------

export const calculateOutput = toolOutput({
  result: num,
  formattedResult: str,
  operation: str,
  label: str.optional(),
  // `convert` branch: the pair, the rate applied and the day it is from, so a
  // model quotes a converted figure with its currency and its rate date.
  fromCurrency: str.optional(),
  toCurrency: str.optional(),
  date: str.optional(),
  rate: num.optional(),
});

// ---------------------------------------------------------------------------
// budgets.tool.ts
// ---------------------------------------------------------------------------

export const getBudgetStatusOutput = toolOutput({
  sharedExpenses: sharedReview,
  budgetName: str.optional(),
  strategy: str.optional(),
  period: looseObject({ start: str, end: str }).optional(),
  totalBudgeted: num.optional(),
  totalSpent: num.optional(),
  totalIncome: num.optional(),
  remaining: num.optional(),
  percentUsed: num.optional(),
  overBudgetCategories: rows().optional(),
  nearLimitCategories: rows().optional(),
  categoryCount: num.optional(),
  velocity: looseObject({
    dailyBurnRate: num,
    // Null when an upcoming bill's amount is unknown (issue #1247);
    // upcomingBillsComplete says so rather than leaving a bare null.
    safeDailySpend: num,
    upcomingBillsComplete: bool,
    projectedTotal: num,
    projectedVariance: num,
    daysRemaining: num,
    paceStatus: str,
  }).optional(),
  healthScore: looseObject({ score: num, label: str }).optional(),
  // Not-found branch.
  error: str.optional(),
  availableBudgets: z.array(str).optional(),
});

// ---------------------------------------------------------------------------
// rules.tool.ts
// ---------------------------------------------------------------------------

/**
 * `manage_transaction_rules`: one tool, several result branches, so every field
 * is optional. list returns `rules` with `totalCount`/`truncated`; test returns
 * the counts and `rows` (the first changes); a committed write returns `id`
 * (`deleted` for a delete); a card shown in the web chat returns `status`.
 */
export const manageTransactionRulesOutput = toolOutput({
  rules: z.array(looseObject({ id: str, name: str })).optional(),
  totalCount: num.optional(),
  truncated: bool.optional(),
  rule: str.optional(),
  matchedCount: num.optional(),
  conditionMatchedCount: num.optional(),
  scanned: num.optional(),
  skippedCount: num.optional(),
  rows: rows().optional(),
  id: str.optional(),
  deleted: bool.optional(),
  status: str.optional(),
  message: str.optional(),
});

// ---------------------------------------------------------------------------
// ai-review.tool.ts
// ---------------------------------------------------------------------------

const reviewRequest = looseObject({ id: str, status: str });

/**
 * `ai_review_requests`: list returns `requests`; claim returns the `request`
 * (null when nothing is pending) with its `transaction` rows (or, for a parser
 * draft request, its `emailReceipts`); submit returns
 * the `proposal` card preview and `status: "proposed"`; reject returns the
 * `request` in its new status.
 */
export const aiReviewRequestsOutput = toolOutput({
  requests: z.array(reviewRequest).optional(),
  totalCount: num.optional(),
  truncated: bool.optional(),
  request: reviewRequest.nullable().optional(),
  transaction: rows().optional(),
  proposal: looseObject({}).optional(),
  status: str.optional(),
  message: str.optional(),
});

// ---------------------------------------------------------------------------
// email-receipt-parsers.tool.ts
// ---------------------------------------------------------------------------

/**
 * `email_receipt_parsers`: test returns `valid` (false lists `errors`),
 * `unknownCategoryIds`, one entry per email in `emails` and `allComplete`;
 * categories returns the `categories` and `truncated`; save_draft returns the
 * `parserId` and whether the request is now proposed (`requestProposed`). Only
 * what a model must reason about is declared; the rest rides in the payload.
 */
export const emailReceiptParsersOutput = toolOutput({
  valid: bool.optional(),
  allComplete: bool.optional(),
  parserId: str.optional(),
  message: str.optional(),
});

// ---------------------------------------------------------------------------
// bond-series.tool.ts
// ---------------------------------------------------------------------------

/**
 * `fetch_bond_series` and `enter_bond_series_manually`: the catalog instrument
 * and whether this call stored it. `termsProvider` says where the terms came
 * from (the official host, or `manual`).
 */
export const bondSeriesOutput = toolOutput({
  id: str,
  seriesCode: str,
  created: bool,
  termsProvider: str,
});

// ---------------------------------------------------------------------------
// warranties.tool.ts
// ---------------------------------------------------------------------------

/**
 * `list_warranties`: the day `status` and `daysLeft` are about, and how many
 * rows matched against how many came back. The rows are display columns.
 */
export const listWarrantiesOutput = toolOutput({
  today: str,
  warranties: rows(),
  total: num,
});

// ---------------------------------------------------------------------------
// relay.tool.ts
// ---------------------------------------------------------------------------

export const getNextPromptOutput = toolOutput({
  hasPrompt: bool,
  // True when the user has gone inactive long enough that the agent should stop
  // polling and exit (only set alongside hasPrompt:false).
  stop: bool.optional(),
  promptId: str.optional(),
  prompt: str.optional(),
  // How to run a relay turn. Returned only with a claimed prompt, so a client
  // that never relays does not carry it in every request's tool list.
  guidance: str.optional(),
  history: rows().optional(),
  // Each ref points at a `monize-attachment://<id>` resource the agent reads.
  attachments: z.array(looseObject({ id: str, uri: str })).optional(),
});

export const postResponseOutput = toolOutput({
  delivered: bool,
});

export const reportProgressOutput = toolOutput({
  delivered: bool,
});
