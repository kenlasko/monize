import type { CategoryType } from '@/lib/category-type';
export type BudgetType = 'MONTHLY' | 'ANNUAL' | 'PAY_PERIOD';
export type BudgetStrategy = 'FIXED' | 'ROLLOVER' | 'ZERO_BASED' | 'FIFTY_THIRTY_TWENTY' | 'BUCKET';
export type RolloverType = 'NONE' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
export type CategoryGroup = 'NEED' | 'WANT' | 'SAVING';
export type PeriodStatus = 'OPEN' | 'CLOSED' | 'PROJECTED';
export type BudgetProfile = 'COMFORTABLE' | 'ON_TRACK' | 'AGGRESSIVE';
export type BudgetBucketTargetType = 'PERCENT' | 'AMOUNT';
export type BudgetBucketIncomeSource = 'ACTUAL' | 'BASE_INCOME' | 'INCOME_LINES' | 'NONE';

export interface BudgetConfig {
  includeTransfers?: boolean;
  excludedAccountIds?: string[];
  /** Transfers in from the excluded accounts count as income (issue #2141). */
  transfersInAsIncome?: boolean;
  fiscalYearStart?: number;
  payFrequency?: 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY';
  payDayOfMonth?: number;
  alertDefaults?: {
    warnAt?: number;
    criticalAt?: number;
  };
}

export interface Budget {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  budgetType: BudgetType;
  periodStart: string;
  periodEnd: string | null;
  baseIncome: number | null;
  incomeLinked: boolean;
  strategy: BudgetStrategy;
  isActive: boolean;
  currencyCode: string;
  config: BudgetConfig;
  categories: BudgetCategory[];
  /** Present on the budget read; only a Bucket budget has any. */
  buckets?: BudgetBucket[];
  createdAt: string;
  updatedAt: string;
}

/** One named pot of a Bucket-strategy budget. */
export interface BudgetBucket {
  id: string;
  budgetId: string;
  name: string;
  targetType: BudgetBucketTargetType;
  /** A percent of bucket income (PERCENT) or an amount per period (AMOUNT). */
  targetValue: number;
  carryOver: boolean;
  carryCap: number | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBudgetBucketData {
  name: string;
  targetType: BudgetBucketTargetType;
  targetValue: number;
  carryOver?: boolean;
  carryCap?: number;
  sortOrder?: number;
}

export interface UpdateBudgetBucketData {
  name?: string;
  targetType?: BudgetBucketTargetType;
  targetValue?: number;
  carryOver?: boolean;
  /** `null` clears the cap. */
  carryCap?: number | null;
  sortOrder?: number;
}

/** One bucket in `GET /budgets/:id/reports/bucket-status`. */
export interface BudgetBucketStatus {
  bucketId: string;
  name: string;
  targetType: BudgetBucketTargetType;
  targetValue: number;
  carryOver: boolean;
  carryCap: number | null;
  /** `null` when a PERCENT target meets an unknown income. */
  allocated: number | null;
  carriedIn: number;
  planned: number;
  spent: number;
  /** `null` when `allocated` is. */
  available: number | null;
  /** `null` when `allocated` is. */
  percentUsed: number | null;
  lineCount: number;
}

export interface BudgetBucketStatusResult {
  periodStart: string;
  periodEnd: string;
  currencyCode: string;
  /** `null` when unknown. */
  income: number | null;
  incomeSource: BudgetBucketIncomeSource;
  /** `null` when any bucket's allocation is unknown; see `knownAllocated`. */
  totalAllocated: number | null;
  /** The partial sum of the known allocations, always a number. */
  knownAllocated: number;
  /** `null` when income or `totalAllocated` is. */
  unallocated: number | null;
  buckets: BudgetBucketStatus[];
  unassigned: { planned: number; spent: number; lineCount: number };
}

/** One bucket's row in a budget period (carry received, figures frozen at close). */
export interface BudgetPeriodBucket {
  id: string;
  budgetPeriodId: string;
  /** `null` once the bucket is deleted. */
  bucketId: string | null;
  bucketName: string;
  targetType: BudgetBucketTargetType;
  targetValue: number;
  incomeBasis: number | null;
  allocatedAmount: number | null;
  carryIn: number;
  actualAmount: number;
  carryOut: number;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetCategory {
  id: string;
  budgetId: string;
  categoryId: string | null;
  category: {
    id: string;
    name: string;
    categoryType: CategoryType;
    parentId?: string | null;
    parent?: { id: string; name: string } | null;
  } | null;
  bucketId: string | null;
  transferAccountId: string | null;
  transferAccount: {
    id: string;
    name: string;
    accountType: string;
  } | null;
  isTransfer: boolean;
  categoryGroup: CategoryGroup | null;
  amount: number;
  isIncome: boolean;
  rolloverType: RolloverType;
  rolloverCap: number | null;
  flexGroup: string | null;
  alertWarnPercent: number;
  alertCriticalPercent: number;
  notes: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetPeriod {
  id: string;
  budgetId: string;
  periodStart: string;
  periodEnd: string;
  /** Total Budget Funding, frozen at the close. */
  actualIncome: number;
  /**
   * The Transfer Funding part of `actualIncome`, frozen at the close; `null`
   * for an open period and one closed before it was recorded (unknown).
   */
  transferFunding?: number | string | null;
  /** Actual Income, `actualIncome` less `transferFunding`; `null` with it. */
  categoryIncome?: number | null;
  actualExpenses: number;
  totalBudgeted: number;
  status: PeriodStatus;
  periodCategories?: BudgetPeriodCategory[];
  periodBuckets?: BudgetPeriodBucket[];
  createdAt: string;
  updatedAt: string;
}

export interface BudgetPeriodCategory {
  id: string;
  budgetPeriodId: string;
  budgetCategoryId: string;
  categoryId: string | null;
  budgetedAmount: number;
  rolloverIn: number;
  actualAmount: number;
  effectiveBudget: number;
  rolloverOut: number;
  budgetCategory?: BudgetCategory;
  category?: {
    id: string;
    name: string;
    categoryType: CategoryType;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryAnalysis {
  categoryId: string;
  categoryName: string;
  isIncome: boolean;
  /** A `transfer` suggestion is a Transfer category's outgoing line. */
  categoryType?: CategoryType;
  average: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
  stdDev: number;
  monthlyAmounts: number[];
  monthlyOccurrences: number;
  isFixed: boolean;
  seasonalMonths: number[];
  suggested: number;
}

export interface TransferAnalysis {
  accountId: string;
  accountName: string;
  accountType: string;
  average: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
  stdDev: number;
  monthlyAmounts: number[];
  monthlyOccurrences: number;
  isFixed: boolean;
  seasonalMonths: number[];
  suggested: number;
}

export interface GenerateBudgetRequest {
  analysisMonths: 3 | 6 | 12;
  strategy?: BudgetStrategy;
  profile?: BudgetProfile;
}

export interface GenerateBudgetResponse {
  categories: CategoryAnalysis[];
  transfers: TransferAnalysis[];
  /** Per source account, the monthly net of the transfers in from it. */
  incomeTransfers: TransferAnalysis[];
  estimatedMonthlyIncome: number;
  totalBudgeted: number;
  totalTransfers: number;
  projectedMonthlySavings: number;
  analysisWindow: {
    startDate: string;
    endDate: string;
    months: number;
  };
}

export interface ApplyBudgetCategoryData {
  categoryId?: string;
  transferAccountId?: string;
  isTransfer?: boolean;
  amount: number;
  isIncome?: boolean;
  categoryGroup?: CategoryGroup;
  rolloverType?: RolloverType;
  rolloverCap?: number;
  flexGroup?: string;
  alertWarnPercent?: number;
  alertCriticalPercent?: number;
  notes?: string;
  sortOrder?: number;
  /** Names a bucket of the request's `buckets` by its `key`. */
  bucketKey?: string;
}

/** A bucket in a wizard apply; `key` is client-chosen, unique in the request. */
export interface ApplyBudgetBucketData extends CreateBudgetBucketData {
  key: string;
}

export interface ApplyGeneratedBudgetData {
  name: string;
  description?: string;
  budgetType?: BudgetType;
  periodStart: string;
  periodEnd?: string;
  baseIncome?: number;
  incomeLinked?: boolean;
  strategy?: BudgetStrategy;
  currencyCode: string;
  config?: Record<string, unknown>;
  categories: ApplyBudgetCategoryData[];
  buckets?: ApplyBudgetBucketData[];
}

export interface CreateBudgetData {
  name: string;
  description?: string;
  budgetType?: BudgetType;
  periodStart: string;
  periodEnd?: string;
  baseIncome?: number;
  incomeLinked?: boolean;
  strategy?: BudgetStrategy;
  currencyCode: string;
  config?: Record<string, unknown>;
}

export interface UpdateBudgetData extends Partial<CreateBudgetData> {}

export interface CreateBudgetCategoryData {
  categoryId: string;
  categoryGroup?: CategoryGroup;
  amount: number;
  isIncome?: boolean;
  rolloverType?: RolloverType;
  rolloverCap?: number;
  flexGroup?: string;
  alertWarnPercent?: number;
  alertCriticalPercent?: number;
  notes?: string;
  sortOrder?: number;
  /** A bucket UUID, or `null` to unassign. */
  bucketId?: string | null;
}

export interface UpdateBudgetCategoryData extends Partial<CreateBudgetCategoryData> {}

/** A line counting transfers in from `transferAccountId` as income. */
export interface CreateTransferIncomeLineData {
  transferAccountId: string;
  amount: number;
  rolloverType?: RolloverType;
  notes?: string;
}

export interface CategoryBreakdown {
  budgetCategoryId: string;
  categoryId: string | null;
  categoryName: string;
  budgeted: number;
  spent: number;
  remaining: number;
  percentUsed: number;
  isIncome: boolean;
  /** A transfer line: savings out, or transfer income when `isIncome`. */
  isTransfer: boolean;
  /**
   * An income line whose actual is Transfer Funding: a transfer income line or
   * one on a Transfer category. Absent is no information.
   */
  isTransferFunding?: boolean;
  percentage: number | null;
  /**
   * Provisional transfer legs (an imported estimate) inside `spent`; 0 on a
   * category line. Absent is no information.
   */
  provisionalCount?: number;
}

export interface BudgetSummary {
  budget: Budget;
  totalBudgeted: number;
  totalSpent: number;
  totalIncome: number;
  remaining: number;
  percentUsed: number;
  incomeLinked: boolean;
  actualIncome: number | null;
  /**
   * Actual Income: the income lines on an Income or Expense category. With
   * `transferFunding` it makes `totalIncome`, Total Budget Funding
   * (docs/specs/transfer-categories.md section 6.2).
   */
  categoryIncome: number;
  /**
   * Transfer Funding: transfer income lines, income lines on a Transfer
   * category and `outsideTransferIncome`. Never income.
   */
  transferFunding: number;
  /**
   * Income from transfers in from the excluded accounts (`transfersInAsIncome`),
   * included in `totalIncome`; `0` with the option off.
   */
  outsideTransferIncome: number;
  categoryBreakdown: CategoryBreakdown[];
  /**
   * Provisional transfer legs (an imported estimate) inside the transfer
   * lines' actuals and `outsideTransferIncome`, each counted once. The figures
   * include them; absent is no information.
   */
  provisionalCount?: number;
  /** The current period the figures were read for (not the budget's start). */
  periodStart: string;
  periodEnd: string;
}

export interface UpcomingBill {
  id: string;
  name: string;
  /**
   * What this occurrence would cost today, as a positive magnitude, from the
   * server's effective-amount contract. `null` when it cannot be determined --
   * never the persisted snapshot (issue #1247). This is the part that counts
   * toward the budget; a row prints `amountDue`.
   */
  amount: number | null;
  /**
   * The whole occurrence, as a positive magnitude: what is DUE, as the bills
   * page prints it. `null` when unknown. A split's untracked transfer lines are
   * in it and not in `amount`.
   */
  amountDue: number | null;
  /** A schedule left at 0 because the amount is not known until it arrives (issue #1124). */
  isReminder: boolean;
  /**
   * The currency `amount` is in -- the occurrence's own settlement currency,
   * which need not be the budget's. Half of what the amount means: formatting a
   * figure without it prints a CAD bill under a USD symbol.
   */
  currencyCode: string;
  amountComplete: boolean;
  dueDate: string;
  categoryId: string | null;
}

export interface BudgetVelocity {
  dailyBurnRate: number | null;
  projectedTotal: number | null;
  budgetTotal: number;
  projectedVariance: number | null;
  /** `null` when `trulyAvailable` is unknown -- it is derived from it. */
  safeDailySpend: number | null;
  daysElapsed: number;
  daysRemaining: number;
  totalDays: number;
  currentSpent: number;
  projectionMissingRatePairs?: string[];
  paceStatus: 'under' | 'on_track' | 'over' | null;
  upcomingBills: UpcomingBill[];
  /**
   * `null` when any upcoming bill's current amount is unknown (issue #1247):
   * `knownUpcomingBillsSubtotal` then holds what did resolve, and
   * `upcomingBillsComplete` is false. Render the null as unavailable; a
   * `?? 0` here is the defect this field exists to prevent.
   */
  totalUpcomingBills: number | null;
  knownUpcomingBillsSubtotal: number;
  upcomingBillsComplete: boolean;
  /**
   * The currency pairs a bill could not be converted through, so a withheld
   * total can say why. Empty when the shortfall was an occurrence with no
   * resolvable amount at all -- that one has no pair to name.
   */
  upcomingBillsMissingRates: string[];
  /** `null` when the upcoming-bills total is unknown. */
  trulyAvailable: number | null;
}

// --- Report Types ---

/**
 * Whether a trend point's `actual` is the whole figure. `false` when a row of
 * a live month had no exchange rate to the budget's currency: `actual` is then
 * the converted part and `missingRatePairs` names what to add. Absent on a
 * closed period, whose stored figure carries no completeness either way; read
 * it as `=== false` (`trendPartialPairs`).
 */
export interface TrendPointCompleteness {
  valuationComplete?: boolean;
  /** `"JPY->CAD"` for each pair with no rate behind a partial figure. */
  missingRatePairs?: string[];
}

export interface BudgetTrendPoint {
  monthKey: string;
  budgeted: number;
  actual: number;
  variance: number;
  percentUsed: number;
  /** See `TrendPointCompleteness`. */
  valuationComplete?: boolean;
  missingRatePairs?: string[];
}

export interface CategoryTrendDataPoint {
  monthKey: string;
  budgeted: number;
  actual: number;
  variance: number;
  percentUsed: number;
  /** See `TrendPointCompleteness`. */
  valuationComplete?: boolean;
  missingRatePairs?: string[];
}

export interface CategoryTrendSeries {
  categoryId: string;
  categoryName: string;
  data: CategoryTrendDataPoint[];
}

export interface HealthScoreBreakdown {
  baseScore: number;
  overBudgetDeductions: number;
  underBudgetBonus: number;
  trendBonus: number;
  essentialWeightPenalty: number;
}

export interface HealthScoreCategoryDetail {
  categoryId: string;
  categoryName: string;
  percentUsed: number;
  impact: number;
  categoryGroup: string | null;
}

export interface HealthScoreResult {
  score: number;
  label: string;
  breakdown: HealthScoreBreakdown;
  categoryScores: HealthScoreCategoryDetail[];
}

export interface SeasonalMonthlyAverage {
  month: number;
  monthName: string;
  average: number;
}

export interface SeasonalPattern {
  categoryId: string;
  categoryName: string;
  monthlyAverages: SeasonalMonthlyAverage[];
  highMonths: number[];
  typicalMonthlySpend: number;
}

export interface FlexGroupCategory {
  categoryId: string;
  categoryName: string;
  budgeted: number;
  spent: number;
  percentUsed: number;
}

export interface FlexGroupStatus {
  groupName: string;
  totalBudgeted: number;
  totalSpent: number;
  remaining: number;
  percentUsed: number;
  categories: FlexGroupCategory[];
}

// Dashboard widget types
export interface DashboardBudgetSummary {
  budgetId: string;
  budgetName: string;
  totalBudgeted: number;
  totalSpent: number;
  remaining: number;
  percentUsed: number;
  safeDailySpend: number;
  daysRemaining: number;
  topCategories: Array<{
    categoryName: string;
    budgeted: number;
    spent: number;
    remaining: number;
    percentUsed: number;
  }>;
}

// Transaction list budget context
export interface CategoryBudgetStatus {
  budgeted: number;
  spent: number;
  remaining: number;
  percentUsed: number;
}

// Savings Rate report types
export interface SavingsRatePoint {
  /**
   * The month as structure (`YYYY-MM`), the way `BudgetTrendPoint` carries it.
   * Render it through `useDateFormat().formatMonth` (a table column) or
   * `useChartMonthFormat()` (a chart axis) and sort on this value: the server
   * used to send a `Mmm YYYY` label, which was English everywhere and sorted
   * alphabetically.
   */
  monthKey: string;
  income: number;
  expenses: number;
  savings: number;
  savingsRate: number;
}

// Health Score History report types
export interface HealthScoreHistoryPoint {
  /** `YYYY-MM` -- see `SavingsRatePoint.monthKey`. */
  monthKey: string;
  score: number;
  label: string;
}
