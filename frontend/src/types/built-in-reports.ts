export interface CategorySpendingItem {
  categoryId: string | null;
  categoryName: string;
  color: string | null;
  total: number;
}

export interface SpendingByCategoryResponse {
  data: CategorySpendingItem[];
  totalSpending: number;
}

export interface PayeeSpendingItem {
  payeeId: string | null;
  payeeName: string;
  total: number;
}

export interface SpendingByPayeeResponse {
  data: PayeeSpendingItem[];
  totalSpending: number;
}

export interface IncomeSourceItem {
  categoryId: string | null;
  categoryName: string;
  color: string | null;
  total: number;
}

export interface IncomeBySourceResponse {
  data: IncomeSourceItem[];
  totalIncome: number;
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
  data: MonthlySpendingItem[];
}

export interface MonthlyIncomeExpenseItem {
  month: string;
  income: number;
  expenses: number;
  net: number;
}

export interface IncomeExpenseTotals {
  income: number;
  expenses: number;
  net: number;
}

export interface IncomeVsExpensesResponse {
  data: MonthlyIncomeExpenseItem[];
  totals: IncomeExpenseTotals;
}

export interface ReportQueryParams {
  startDate?: string;
  endDate: string;
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
  totals: {
    income: number;
    expenses: number;
    savings: number;
  };
}

export interface YearOverYearResponse {
  data: YearData[];
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
    weekendTotal: number;
    weekdayTotal: number;
    weekendCount: number;
    weekdayCount: number;
  };
  byDay: DaySpending[];
  byCategory: CategoryWeekendWeekday[];
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
    income: number;
    expenses: number;
    deductible: number;
  };
}

// Recurring expenses types
export interface RecurringExpenseItem {
  payeeName: string;
  payeeId: string | null;
  occurrences: number;
  totalAmount: number;
  averageAmount: number;
  lastTransactionDate: string;
  frequency: string;
  categoryName: string;
}

export interface RecurringExpensesResponse {
  data: RecurringExpenseItem[];
  summary: {
    totalRecurring: number;
    monthlyEstimate: number;
    uniquePayees: number;
  };
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
  month: string;
  label: string;
  total: number;
}

export interface BillPaymentHistoryResponse {
  billPayments: BillPaymentItem[];
  monthlyTotals: MonthlyBillTotal[];
  summary: {
    totalPaid: number;
    totalPayments: number;
    uniqueBills: number;
    monthlyAverage: number;
  };
}

// Uncategorized transactions types
export interface UncategorizedTransactionItem {
  id: string;
  transactionDate: string;
  amount: number;
  payeeName: string | null;
  description: string | null;
  accountName: string | null;
}

export interface UncategorizedTransactionsResponse {
  transactions: UncategorizedTransactionItem[];
  summary: {
    totalCount: number;
    expenseCount: number;
    expenseTotal: number;
    incomeCount: number;
    incomeTotal: number;
  };
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
