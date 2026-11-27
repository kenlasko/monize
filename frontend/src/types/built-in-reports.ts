export interface CategorySpendingItem {
  categoryId: string | null;
  categoryName: string;
  color: string | null;
  /**
   * Spending in this category, in the response's `currency`. Rows that could
   * not be converted are in none of the figures, so when `missingCurrencies` is
   * non-empty this is the part that converted.
   */
  total: number;
  /** Share of the whole, calculated before monetary rounding when the categories form a composition. */
  percentage?: number;
}

export interface SpendingByCategoryResponse {
  /** Signed category totals and server-calculated shares. Older responses omit this flag. */
  netSpending?: true;
  /** Every reported category, largest first. The caller decides how many to draw. */
  data: CategorySpendingItem[];
  /**
   * Total spent, or `null` when a row could not be converted -- a missing rate
   * makes the total unknowable, never smaller. Render `knownSpending` through
   * `PartialTotal` in that case, never this under a caption saying "Total".
   */
  totalSpending: number | null;
  /** What `data` adds up to, rounded once (not the sum of its rounded rows); equals `totalSpending` when nothing was excluded. */
  knownSpending: number;
  /** Reporting currency every figure is expressed in. */
  currency: string;
  /** Source currencies with no rate into `currency`. Empty when complete. */
  missingCurrencies: string[];
  /** How many aggregate rows were left out, by any cause. */
  excludedCount: number;
}

/** Query parameters the Spending by Category report accepts beyond the window. */
export interface SpendingByCategoryParams extends ReportQueryParams {
  /** Restrict to these accounts; omit or leave empty for every account. */
  accountIds?: string[];
  /** Count a subcategory against its top-level ancestor. Defaults to true. */
  rollupToParent?: boolean;
  /**
   * Keep only rows tagged `tagKey:tagValue`
   * (`docs/specs/report-tag-key-breakdown.md` section 11.4). Send both or
   * neither; absent renders today's response unchanged.
   */
  tagKey?: string;
  tagValue?: string;
}

export interface PayeeSpendingItem {
  payeeId: string | null;
  payeeName: string;
  total: number;
  percentage?: number | null;
}

export interface SpendingByPayeeResponse {
  /** Rows that could not be converted are in none of the figures. */
  data: PayeeSpendingItem[];
  /**
   * Total spent, or `null` when a row could not be converted -- a missing rate
   * makes the total unknowable, never smaller. Render `knownSpending` through
   * `PartialTotal` in that case, never this under a caption saying "Total".
   */
  totalSpending: number | null;
  /** What `data` adds up to, rounded once (not the sum of its rounded rows); equals `totalSpending` when nothing was excluded. */
  knownSpending: number;
  /** Reporting currency every figure is expressed in. */
  currency: string;
  /** Source currencies with no rate into `currency`. Empty when complete. */
  missingCurrencies: string[];
  /** How many aggregate rows were left out, by any cause. */
  excludedCount: number;
}

export interface IncomeSourceItem {
  categoryId: string | null;
  categoryName: string;
  color: string | null;
  total: number;
  /**
   * The source's share of the income that converted, in percent, divided on
   * the server from the unrounded figures (rule 8). Optional: an older backend
   * mid-deploy sends none.
   */
  percentage?: number | null;
}

export interface IncomeBySourceResponse {
  /** Rows that could not be converted are in none of the figures. */
  data: IncomeSourceItem[];
  /**
   * Total income, or `null` when a row could not be converted -- a missing rate
   * makes the total unknowable, never smaller. Render `knownIncome` through
   * `PartialTotal` in that case, never this under a caption saying "Total".
   */
  totalIncome: number | null;
  /** What `data` adds up to, rounded once (not the sum of its rounded rows); equals `totalIncome` when nothing was excluded. */
  knownIncome: number;
  /** Reporting currency every figure is expressed in. */
  currency: string;
  /** Source currencies with no rate into `currency`. Empty when complete. */
  missingCurrencies: string[];
  /** How many aggregate rows were left out, by any cause. */
  excludedCount: number;
}

export interface MonthlyCategorySpending {
  categoryId: string | null;
  categoryName: string;
  color: string | null;
  total: number;
}

export interface MonthlySpendingItem {
  month: string;
  categories: MonthlyCategorySpending[];
  totalSpending: number;
}

export interface MonthlySpendingTrendResponse {
  /**
   * Each month's `totalSpending` and category `total` cover the rows that
   * converted only, so they stay numbers; `missingCurrencies` says what is out.
   */
  data: MonthlySpendingItem[];
  /** Reporting currency every figure is expressed in. */
  currency: string;
  /** Source currencies with no rate into `currency`. Empty when complete. */
  missingCurrencies: string[];
  /** How many aggregate rows were left out, by any cause. */
  excludedCount: number;
}

export interface MonthlyIncomeExpenseItem {
  month: string;
  income: number;
  expenses: number;
  net: number;
}

/** One bar of Income vs Expenses: a month or a week, with the dates it covers. */
export interface IncomeExpensePeriodItem {
  /** `YYYY-MM` for a month bucket, the week's first day for a week bucket. */
  period: string;
  /** First day the bar covers, inclusive. */
  periodStart: string;
  /** Last day the bar covers, inclusive. A drill-down uses the pair as-is. */
  periodEnd: string;
  /**
   * Money in over the period, in the response's `currency`. Rows that could not
   * be converted are in none of the figures, so when `missingCurrencies` is
   * non-empty this is the part that converted.
   */
  income: number;
  expenses: number;
  net: number;
}

/**
 * One bar of a tag-key bucket: the categorized figures plus the tagged
 * transfer flows that fell in the period (zero when none). The flows are never
 * part of `income`, `expenses` or `net`.
 */
export interface IncomeExpenseTagPeriodItem extends IncomeExpensePeriodItem {
  /** Tagged transfer legs in this period, positive side. */
  taggedInflows: number;
  /** Tagged transfer legs in this period, negative side, as a positive magnitude. */
  taggedOutflows: number;
  /**
   * The period's Balance with this bucket's flows (the All income and
   * expenses), the four aggregates folded and read once by the server; absent
   * from an older backend.
   */
  balance?: number;
  /** `balance` over what came in, two places; `null` when nothing came in. */
  balancePercent?: number | null;
}

export interface IncomeExpenseTotals {
  /**
   * Total over the window, or `null` when a row could not be converted -- a
   * missing rate makes the total unknowable, never smaller. Render the `known*`
   * figure through `PartialTotal` in that case.
   */
  income: number | null;
  expenses: number | null;
  net: number | null;
  /** The part that did convert; equals the field above when nothing was excluded. */
  knownIncome: number;
  knownExpenses: number;
  knownNet: number;
}

/**
 * The reserved id of the "untagged" value bucket
 * (`docs/specs/report-tag-key-breakdown.md` section 1.1, rule B2): rows
 * carrying no `K:*` tag for the requested key. Not a value a user can create --
 * render it from `reports.tagBreakdown.untagged`, never this id.
 */
export const UNTAGGED_TAG_BUCKET_ID = '__untagged__';

/**
 * One value bucket of a tag-key breakdown (Income vs Expenses / Cash Flow
 * only carry `taggedInflows`/`taggedOutflows`).
 *
 * `data`/`totals`/`missingCurrencies`/`excludedCount` are computed through the
 * exact same per-currency conversion and completeness path as the top-level
 * (All) figures: one bucket's missing rate never blanks another's.
 */
export interface IncomeExpenseTagBucket {
  /** The tag's value, or `UNTAGGED_TAG_BUCKET_ID` for the reserved bucket. */
  value: string;
  /** True only for the reserved untagged bucket. */
  isUntagged: boolean;
  data: IncomeExpenseTagPeriodItem[];
  totals: IncomeExpenseTotals;
  /**
   * Window total of the per-period `taggedInflows` in `data`. Transfer legs
   * carrying this bucket's value, positive side. Never folded
   * into `income`, `expenses` or `net` -- a transfer is never income.
   */
  taggedInflows: number;
  /** Transfer legs carrying this bucket's value, negative side, as a positive magnitude. */
  taggedOutflows: number;
  /**
   * Source currencies with no usable rate into the report's currency, across
   * both this bucket's categorized rows and its tagged transfer legs.
   */
  missingCurrencies: string[];
  /** How many aggregate rows this bucket left out, by any cause. */
  excludedCount: number;
  /**
   * Provisional transfer legs (an imported estimate) inside `taggedInflows`
   * and `taggedOutflows`. Absent is no information and draws nothing.
   */
  provisionalCount?: number;
}

export interface IncomeVsExpensesResponse {
  /** Every bucket in the window, in order, including the empty ones. */
  data: IncomeExpensePeriodItem[];
  totals: IncomeExpenseTotals;
  /** Reporting currency every figure is expressed in. */
  currency: string;
  /** Source currencies with no rate into `currency`. Empty when complete. */
  missingCurrencies: string[];
  /** How many aggregate rows were left out, by any cause. */
  excludedCount: number;
  /**
   * The tag key the caller asked to break the report down by. Present only
   * when the request carried `tagKey` (absent otherwise, never `null`).
   */
  tagKey?: string;
  /**
   * One bucket per discovered value of `tagKey`, plus the reserved untagged
   * bucket (`UNTAGGED_TAG_BUCKET_ID`). Present only when `tagKey` was
   * supplied; the fields above keep describing the unpartitioned (All)
   * figure, so a caller ignoring this field still renders today's report.
   */
  buckets?: IncomeExpenseTagBucket[];
}

/** Query parameters Income vs Expenses accepts beyond the window. */
export interface IncomeVsExpensesParams extends ReportQueryParams {
  /** Restrict to these accounts; omit or leave empty for every account. */
  accountIds?: string[];
  /** Width of one bar. Defaults to month. */
  bucket?: 'month' | 'week' | 'year';
  /** Day a week bucket starts on, 0 = Sunday through 6 = Saturday. */
  weekStartsOn?: number;
  /**
   * The tagged-transfer boundary when `accountIds` is empty: the accounts the
   * picker offers (`lib/transfer-scope.ts`, spec 10.8.1). Bounds only the
   * tagged flows; income and expenses are not filtered by it.
   */
  transferScopeAccountIds?: string[];
  /**
   * Bare KEY of a `KEY:VALUE` tag (e.g. "scope") to break the report down by
   * (`docs/specs/report-tag-key-breakdown.md`). Absent renders today's
   * response unchanged.
   */
  tagKey?: string;
}

export interface ReportQueryParams {
  startDate?: string;
  endDate: string;
}

/** Query parameters Income by Source accepts beyond the window. */
export interface IncomeBySourceParams extends ReportQueryParams {
  /** Restrict to these accounts; omit or leave empty for every account. */
  accountIds?: string[];
}

/** Query parameters the Cash Flow report accepts beyond the window. */
export interface CashFlowParams extends ReportQueryParams {
  /** Restrict to these accounts; omit or leave empty for every account. */
  accountIds?: string[];
  /**
   * The tagged-transfer boundary when `accountIds` is empty: the accounts the
   * picker offers (`lib/transfer-scope.ts`, spec 10.8.1). Bounds only the
   * tagged flows; income and expenses are not filtered by it.
   */
  transferScopeAccountIds?: string[];
  /**
   * Bare KEY of a `KEY:VALUE` tag (e.g. "scope") to break the report down by
   * (`docs/specs/report-tag-key-breakdown.md`). Absent renders today's
   * response unchanged.
   */
  tagKey?: string;
}

/** Query parameters Monthly Breakdown accepts beyond the window. */
export interface MonthlyCategoryBreakdownParams extends ReportQueryParams {
  /** Restrict to these accounts; omit or leave empty for every account. */
  accountIds?: string[];
  /** Column width; the server folds a year's months before it reads them. Defaults to month. */
  period?: 'month' | 'year';
}

/**
 * A line of the breakdown's figures: one per column, the window's total and
 * its average, each read once by the server from the cells' aggregates (issue
 * #2413). Never rebuilt from the cells: a sum of rounded cells sits a unit off.
 */
export interface MonthlyBreakdownFigures {
  valuesByMonth: Record<string, number>;
  total: number;
  /** The total over the columns listed, divided before it is read. */
  average: number;
}

/** A section: the rows sharing a `sectionKey`, in the section's own sign convention. */
export interface MonthlyBreakdownSection extends MonthlyBreakdownFigures {
  key: string;
  isIncome: boolean;
}

// Monthly category breakdown types
export interface MonthlyBreakdownCategoryRow {
  categoryId: string | null;
  categoryName: string;
  parentId: string | null;
  parentName: string | null;
  parentIsIncome: boolean | null;
  isIncome: boolean;
  valuesByMonth: Record<string, number>;
  depositTotal: number;
  withdrawalTotal: number;
  /** The section the row draws under (`MonthlyBreakdownSection.key`). */
  sectionKey: string;
  /** The row's columns summed once by the server, in the row's own convention. */
  total: number;
  /** `total` over the columns listed, divided before it is read. */
  average: number;
}

/**
 * A row of the breakdown's Transfers group: the legs holding one Transfer
 * category (`kind: 'category'`, a parent's roll-up when `isSubtotal`), or every
 * other leg on one account (`kind: 'account'`, the default when absent).
 */
export interface MonthlyBreakdownTransferRow {
  kind?: 'category' | 'account';
  accountId: string | null;
  accountName: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  parentId?: string | null;
  parentName?: string | null;
  /** A parent's roll-up: its legs are on the other rows, and outside the group total. */
  isSubtotal?: boolean;
  direction: 'from' | 'to';
  valuesByMonth: Record<string, number>;
  /** The row's columns summed once by the server, signed as its cells are. */
  total: number;
  average: number;
}

export interface MonthlyCategoryBreakdownResponse {
  /** The column width; `months` holds `YYYY-MM` or `YYYY` keys. */
  period: 'month' | 'year';
  months: string[];
  data: MonthlyBreakdownCategoryRow[];
  transfers: MonthlyBreakdownTransferRow[];
  sections: MonthlyBreakdownSection[];
  /** The bottom lines, each folded from the sections' aggregates. */
  summary: {
    /** Money in positive. */
    income: MonthlyBreakdownFigures;
    /** Money out positive. */
    expenses: MonthlyBreakdownFigures;
    balance: MonthlyBreakdownFigures;
    transfers: MonthlyBreakdownFigures;
    overall: MonthlyBreakdownFigures;
  };
  /** Reporting currency every figure is expressed in. */
  currency: string;
  /** Source currencies with no rate into `currency`. Empty when complete. */
  missingCurrencies: string[];
  /** How many aggregate rows were left out, by any cause. */
  excludedCount: number;
  /**
   * Provisional transfer legs (an imported estimate) inside the transfer rows.
   * Absent is no information and draws nothing.
   */
  provisionalCount?: number;
}

// Year-over-year types
export interface YearMonthData {
  month: number;
  income: number;
  expenses: number;
  savings: number;
}

export interface YearData {
  year: number;
  months: YearMonthData[];
  /**
   * A year's total is `null` when a row of THAT year could not be converted;
   * the `known*` figure is the part that did and goes through `PartialTotal`.
   */
  totals: {
    income: number | null;
    expenses: number | null;
    savings: number | null;
    knownIncome: number;
    knownExpenses: number;
    knownSavings: number;
  };
}

export interface YearOverYearResponse {
  /** Months are only the part that converted when `missingCurrencies` is non-empty. */
  data: YearData[];
  /** Reporting currency every figure is expressed in. */
  currency: string;
  /** Source currencies with no rate into `currency`. Empty when complete. */
  missingCurrencies: string[];
  /** How many aggregate rows were left out, by any cause. */
  excludedCount: number;
}

// Weekend vs weekday types
export interface DaySpending {
  dayOfWeek: number;
  total: number;
  count: number;
}

export interface CategoryWeekendWeekday {
  categoryId: string | null;
  categoryName: string;
  weekendTotal: number;
  weekdayTotal: number;
}

export interface WeekendVsWeekdayResponse {
  summary: {
    /** `null` when a row could not be converted; see `knownWeekendTotal`. */
    weekendTotal: number | null;
    weekdayTotal: number | null;
    /** The part that did convert; render through `PartialTotal` when the field above is `null`. */
    knownWeekendTotal: number;
    knownWeekdayTotal: number;
    /**
     * Each side's share of the week's spending in percent, divided from the
     * unrounded sums; `null` with the totals, absent from an older backend.
     */
    weekendShare?: number | null;
    weekdayShare?: number | null;
    /** Each side's mean per transaction from the unrounded sum; `null` with the totals. */
    weekendAverage?: number | null;
    weekdayAverage?: number | null;
    /** The weekend's mean less the weekday's, subtracted before it is read. */
    averageDifference?: number | null;
    weekendCount: number;
    weekdayCount: number;
  };
  byDay: DaySpending[];
  byCategory: CategoryWeekendWeekday[];
  /** Reporting currency every figure is expressed in. */
  currency: string;
  /** Source currencies with no rate into `currency`. Empty when complete. */
  missingCurrencies: string[];
  /** How many aggregate rows were left out, by any cause. */
  excludedCount: number;
}

// Spending anomalies types
export type AnomalyType = 'large_transaction' | 'category_spike' | 'unusual_payee';
export type AnomalySeverity = 'high' | 'medium' | 'low';

export interface SpendingAnomaly {
  type: AnomalyType;
  severity: AnomalySeverity;
  title: string;
  description: string;
  amount?: number;
  transactionId?: string;
  transactionDate?: string;
  payeeName?: string;
  categoryId?: string;
  categoryName?: string;
  currentPeriodAmount?: number;
  previousPeriodAmount?: number;
  percentChange?: number;
}

export interface SpendingAnomaliesResponse {
  statistics: {
    mean: number;
    stdDev: number;
  };
  anomalies: SpendingAnomaly[];
  counts: {
    high: number;
    medium: number;
    low: number;
  };
  /** Reporting currency every figure is expressed in. */
  currency: string;
  /** Source currencies with no rate into `currency`. Empty when complete. */
  missingCurrencies: string[];
  /** How many aggregate rows were left out, by any cause. */
  excludedCount: number;
}

// Tax summary types
export interface CategoryTotal {
  name: string;
  total: number;
}

export interface TaxSummaryResponse {
  incomeBySource: CategoryTotal[];
  deductibleExpenses: CategoryTotal[];
  allExpenses: CategoryTotal[];
  totals: {
    /** `null` when a row could not be converted; see the `known*` figure. */
    income: number | null;
    expenses: number | null;
    deductible: number | null;
    /** The part that did convert; render through `PartialTotal` when the field above is `null`. */
    knownIncome: number;
    knownExpenses: number;
    knownDeductible: number;
  };
  /** Reporting currency every figure is expressed in. */
  currency: string;
  /** Source currencies with no rate into `currency`. Empty when complete. */
  missingCurrencies: string[];
  /** How many aggregate rows were left out, by any cause. */
  excludedCount: number;
}

// Recurring expenses types
export const RECURRING_EXPENSE_FREQUENCIES = [
  'WEEKLY',
  'BIWEEKLY',
  'MONTHLY',
  'OCCASIONAL',
  'IRREGULAR',
] as const;

export type RecurringExpenseFrequency = (typeof RECURRING_EXPENSE_FREQUENCIES)[number];

export interface RecurringExpenseItem {
  payeeName: string;
  payeeId: string | null;
  occurrences: number;
  totalAmount: number;
  averageAmount: number;
  lastTransactionDate: string;
  frequency: RecurringExpenseFrequency;
  categoryName: string | null;
}

/** Look-back windows the recurring expenses analysis accepts; `6m` is its default. */
export const RECURRING_EXPENSE_RANGES = ['6m', '1y', '2y', '5y', 'all'] as const;

export type RecurringExpenseRange = (typeof RECURRING_EXPENSE_RANGES)[number];

export interface RecurringExpensesResponse {
  data: RecurringExpenseItem[];
  summary: {
    /** `null` when a row could not be converted; see `knownTotalRecurring`. */
    totalRecurring: number | null;
    /** The part of `totalRecurring` that converted. */
    knownTotalRecurring: number;
    /** totalRecurring spread over `monthCount` months; `null` when it is. */
    monthlyEstimate: number | null;
    /** The part of `monthlyEstimate` that converted. */
    knownMonthlyEstimate: number;
    /** Months the window covers (for `all`, since the first matching payment). */
    monthCount: number;
    uniquePayees: number;
  };
  /** Reporting currency every figure is expressed in. */
  currency: string;
  /** Source currencies with no rate into `currency`. Empty when complete. */
  missingCurrencies: string[];
  /** How many aggregate rows were left out, by any cause. */
  excludedCount: number;
}

// Bill payment history types
export interface BillPaymentItem {
  scheduledTransactionId: string;
  scheduledTransactionName: string;
  payeeName: string;
  totalPaid: number;
  paymentCount: number;
  averagePayment: number;
  lastPaymentDate: string | null;
}

export interface MonthlyBillTotal {
  /**
   * The month as structure (`YYYY-MM`), and the only form the server sends. It
   * used to ship a `label` beside this, formatted `en-US` on the server; a
   * month a person reads is rendered here instead, through their own date or
   * chart formatter.
   */
  month: string;
  total: number;
}

export interface BillPaymentHistoryResponse {
  billPayments: BillPaymentItem[];
  monthlyTotals: MonthlyBillTotal[];
  summary: {
    /** `null` when a row could not be converted; see `knownTotalPaid`. */
    totalPaid: number | null;
    /** The part of `totalPaid` that converted. */
    knownTotalPaid: number;
    totalPayments: number;
    uniqueBills: number;
    /** `null` when `totalPaid` is; see `knownMonthlyAverage`. */
    monthlyAverage: number | null;
    /** The part of `monthlyAverage` that converted. */
    knownMonthlyAverage: number;
  };
  /** Reporting currency every figure is expressed in. */
  currency: string;
  /** Source currencies with no rate into `currency`. Empty when complete. */
  missingCurrencies: string[];
  /** How many aggregate rows were left out, by any cause. */
  excludedCount: number;
}

// Uncategorized transactions types
export interface UncategorizedTransactionItem {
  id: string;
  transactionDate: string;
  /**
   * In `currencyCode`: converted into the report currency when a rate exists,
   * otherwise the original amount in the row's own currency.
   */
  amount: number;
  /** The currency `amount` is in; format the row with it, never the report's. */
  currencyCode: string;
  payeeName: string | null;
  description: string | null;
  accountName: string | null;
  accountId: string;
}

export interface UncategorizedTransactionsResponse {
  transactions: UncategorizedTransactionItem[];
  summary: {
    totalCount: number;
    expenseCount: number;
    /** `null` when a row could not be converted; see `knownExpenseTotal`. */
    expenseTotal: number | null;
    knownExpenseTotal: number;
    incomeCount: number;
    incomeTotal: number | null;
    knownIncomeTotal: number;
    currencyCode: string;
  };
  /** Reporting currency the summary totals are expressed in. */
  currency: string;
  /** Source currencies with no rate; their rows stay listed in their own currency. */
  missingCurrencies: string[];
  /** How many summary rows (one per currency group) were left out of the totals. */
  excludedCount: number;
}

// Duplicate transactions types
export type DuplicateConfidence = 'very_high' | 'high' | 'medium' | 'low';

export type DuplicateReasonCode =
  | 'same_date_amount_payee_category'
  | 'same_date_amount_payee'
  | 'same_date_amount'
  | 'same_payee_amount_within_days'
  | 'same_amount_within_days';

export interface DuplicateTransactionItem {
  id: string;
  transactionDate: string;
  amount: number;
  /** The account's currency, which `amount` is in. */
  currencyCode: string;
  accountId: string;
  payeeName: string | null;
  description: string | null;
  accountName: string | null;
  categoryId: string | null;
  /** Full category path ("Parent: Child"); null when uncategorized or split. */
  categoryName: string | null;
  isSplit: boolean;
  status: string | null;
}

export interface DuplicateGroup {
  key: string;
  transactions: DuplicateTransactionItem[];
  /** English rendering of `reasonCode`, kept for API consumers. */
  reason: string;
  reasonCode: DuplicateReasonCode;
  /** The widest date gap the sensitivity allowed, in days. */
  windowDays: number;
  confidence: DuplicateConfidence;
}

export interface DuplicateTransactionsResponse {
  groups: DuplicateGroup[];
  summary: {
    totalGroups: number;
    veryHighCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    /**
     * What the extra copies come to in `currency`, each copy converted at the
     * rate its own row recorded, else its date's market rate; `null` while a
     * copy's currency has no rate, `knownPotentialSavings` carrying what
     * converted.
     */
    potentialSavings: number | null;
    knownPotentialSavings: number;
  };
  /** The reporting currency of the summary's figures. */
  currency: string;
  missingCurrencies: string[];
  excludedCount: number;
}

// Cash Flow Sankey types (docs/specs/sankey-cash-flow.md section 6)
export type CashFlowSankeyDepth = 1 | 2;

export interface CashFlowSankeyParams extends ReportQueryParams {
  /** The cash-flow scope; absent or empty means the server's default. */
  accountIds?: string[];
  depth?: CashFlowSankeyDepth;
}

export type CashFlowSankeyNodeKind =
  | 'income'
  | 'hub'
  | 'expense'
  | 'child'
  | 'class'
  | 'inflow'
  | 'account'
  | 'uncategorized'
  | 'residual';

export interface CashFlowSankeyNode {
  /**
   * Stable: `income:<categoryId>`, `hub`, `expense:<categoryId>`,
   * `child:<categoryId>`, `class:savings|debt|other_accounts`,
   * `inflow:savings|borrowed|other_accounts`, `account:<accountId>` or
   * `account:unlinked`, `uncategorized:income|expense`,
   * `residual:unspent|deficit`.
   */
  id: string;
  kind: CashFlowSankeyNodeKind;
  expenseRefund?: boolean;
  label: string;
  categoryId: string | null;
  parentCategoryId: string | null;
  accountId: string | null;
  color: string | null;
  /** `null` while any component could not be converted. */
  total: number | null;
  knownTotal: number;
}

export interface CashFlowSankeyLink {
  source: string;
  target: string;
  amount: number | null;
  knownAmount: number;
}

export interface CashFlowSankeyResponse {
  startDate: string;
  endDate: string;
  currency: string;
  scopeAccountIds: string[];
  nodes: CashFlowSankeyNode[];
  links: CashFlowSankeyLink[];
  totals: {
    income: number | null;
    inflows: number | null;
    expenses: number | null;
    outflows: number | null;
    unspent: number | null;
    deficit: number | null;
  };
  knownTotals: {
    income: number;
    inflows: number;
    expenses: number;
    outflows: number;
  };
  missingCurrencies: string[];
  excludedCount: number;
  /**
   * Provisional transfer legs (an imported estimate) inside the transfer flows
   * that converted. Absent is no information and draws nothing.
   */
  provisionalCount?: number;
}
