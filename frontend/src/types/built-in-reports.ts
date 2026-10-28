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
}

export interface SpendingByCategoryResponse {
  /** Every net-spent category, largest first. The caller decides how many to draw. */
  data: CategorySpendingItem[];
  /**
   * Total spent, or `null` when a row could not be converted -- a missing rate
   * makes the total unknowable, never smaller. Render `knownSpending` through
   * `PartialTotal` in that case, never this under a caption saying "Total".
   */
  totalSpending: number | null;
  /** Sum of `data`; equals `totalSpending` when nothing was excluded. */
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
  /** Sum of `data`; equals `totalSpending` when nothing was excluded. */
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
  /** Sum of `data`; equals `totalIncome` when nothing was excluded. */
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
  bucket?: 'month' | 'week';
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
  basis?: 'cash' | 'accrual';
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
}

export interface MonthlyBreakdownTransferRow {
  accountId: string;
  accountName: string;
  direction: 'from' | 'to';
  valuesByMonth: Record<string, number>;
}

export interface MonthlyCategoryBreakdownResponse {
  months: string[];
  data: MonthlyBreakdownCategoryRow[];
  transfers: MonthlyBreakdownTransferRow[];
  /** Reporting currency every figure is expressed in. */
  currency: string;
  /** Source currencies with no rate into `currency`. Empty when complete. */
  missingCurrencies: string[];
  /** How many aggregate rows were left out, by any cause. */
  excludedCount: number;
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
export interface DuplicateTransactionItem {
  id: string;
  transactionDate: string;
  amount: number;
  payeeName: string | null;
  description: string | null;
  accountName: string | null;
}

export interface DuplicateGroup {
  key: string;
  transactions: DuplicateTransactionItem[];
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface DuplicateTransactionsResponse {
  groups: DuplicateGroup[];
  summary: {
    totalGroups: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    potentialSavings: number;
  };
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
}
