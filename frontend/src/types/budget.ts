export type BudgetType = 'MONTHLY' | 'ANNUAL' | 'PAY_PERIOD';
export type BudgetStrategy = 'FIXED' | 'ROLLOVER' | 'ZERO_BASED' | 'FIFTY_THIRTY_TWENTY';
export type RolloverType = 'NONE' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
export type CategoryGroup = 'NEED' | 'WANT' | 'SAVING';
export type AlertType =
  | 'PACE_WARNING'
  | 'THRESHOLD_WARNING'
  | 'THRESHOLD_CRITICAL'
  | 'OVER_BUDGET'
  | 'FLEX_GROUP_WARNING'
  | 'SEASONAL_SPIKE'
  | 'PROJECTED_OVERSPEND'
  | 'INCOME_SHORTFALL'
  | 'POSITIVE_MILESTONE';
export type AlertSeverity = 'info' | 'warning' | 'critical' | 'success';
export type PeriodStatus = 'OPEN' | 'CLOSED' | 'PROJECTED';
export type BudgetProfile = 'COMFORTABLE' | 'ON_TRACK' | 'AGGRESSIVE';

export interface BudgetConfig {
  includeTransfers?: boolean;
  excludedAccountIds?: string[];
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
    isIncome: boolean;
  } | null;
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

export interface BudgetAlert {
  id: string;
  userId: string;
  budgetId: string;
  budgetCategoryId: string | null;
  alertType: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  data: Record<string, unknown>;
  isRead: boolean;
  isEmailSent: boolean;
  periodStart: string;
  createdAt: string;
}

export interface BudgetPeriod {
  id: string;
  budgetId: string;
  periodStart: string;
  periodEnd: string;
  actualIncome: number;
  actualExpenses: number;
  totalBudgeted: number;
  status: PeriodStatus;
  periodCategories?: BudgetPeriodCategory[];
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
    isIncome: boolean;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryAnalysis {
  categoryId: string;
  categoryName: string;
  isIncome: boolean;
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
}

export interface UpdateBudgetCategoryData extends Partial<CreateBudgetCategoryData> {}

export interface CategoryBreakdown {
  budgetCategoryId: string;
  categoryId: string | null;
  categoryName: string;
  budgeted: number;
  spent: number;
  remaining: number;
  percentUsed: number;
  isIncome: boolean;
  percentage: number | null;
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
  categoryBreakdown: CategoryBreakdown[];
}

export interface UpcomingBill {
  id: string;
  name: string;
  amount: number;
  dueDate: string;
  categoryId: string | null;
}

export interface BudgetVelocity {
  dailyBurnRate: number;
  projectedTotal: number;
  budgetTotal: number;
  projectedVariance: number;
  safeDailySpend: number;
  daysElapsed: number;
  daysRemaining: number;
  totalDays: number;
  currentSpent: number;
  paceStatus: 'under' | 'on_track' | 'over';
  upcomingBills: UpcomingBill[];
  totalUpcomingBills: number;
  trulyAvailable: number;
}

// --- Report Types ---

export interface BudgetTrendPoint {
  month: string;
  budgeted: number;
  actual: number;
  variance: number;
  percentUsed: number;
}

export interface CategoryTrendDataPoint {
  month: string;
  budgeted: number;
  actual: number;
  variance: number;
  percentUsed: number;
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
  month: string;
  income: number;
  expenses: number;
  savings: number;
  savingsRate: number;
}

// Health Score History report types
export interface HealthScoreHistoryPoint {
  month: string;
  score: number;
  label: string;
}
