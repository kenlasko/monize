export interface CategorySpendingComparisonItem {
  categoryId: string | null;
  categoryName: string;
  color: string | null;
  currentTotal: number;
  previousTotal: number;
  change: number;
  changePercent: number;
}

export interface MonthlyComparisonIncomeExpenses {
  currentMonth: string;
  previousMonth: string;
  currentIncome: number;
  previousIncome: number;
  incomeChange: number;
  incomeChangePercent: number;
  currentExpenses: number;
  previousExpenses: number;
  expensesChange: number;
  expensesChangePercent: number;
  currentSavings: number;
  previousSavings: number;
  savingsChange: number;
  savingsChangePercent: number;
}

export interface MonthlyComparisonNotes {
  savingsNote: string;
  incomeNote: string;
}

export interface CategorySpendingSnapshot {
  categoryId: string | null;
  categoryName: string;
  color: string | null;
  total: number;
}

export interface MonthlyComparisonExpenses {
  currentMonth: CategorySpendingSnapshot[];
  previousMonth: CategorySpendingSnapshot[];
  comparison: CategorySpendingComparisonItem[];
  currentTotal: number;
  previousTotal: number;
}

export interface TopCategoriesComparison {
  currentMonth: CategorySpendingSnapshot[];
  previousMonth: CategorySpendingSnapshot[];
}

export interface NetWorthMonthlyPoint {
  month: string;
  netWorth: number;
}

export interface MonthlyComparisonNetWorth {
  monthlyHistory: NetWorthMonthlyPoint[];
  currentNetWorth: number;
  previousNetWorth: number;
  netWorthChange: number;
  netWorthChangePercent: number;
}

export interface InvestmentAccountPerformance {
  accountId: string;
  accountName: string;
  currentValue: number;
  startValue: number;
  annualizedReturn: number;
}

export interface InvestmentTopMover {
  securityId: string;
  symbol: string;
  name: string;
  currentPrice: number;
  previousPrice: number;
  change: number;
  changePercent: number;
  marketValue: number | null;
}

export interface MonthlyComparisonInvestments {
  accountPerformance: InvestmentAccountPerformance[];
  topMovers: InvestmentTopMover[];
}

export interface MonthlyComparisonResponse {
  currentMonth: string;
  previousMonth: string;
  currentMonthLabel: string;
  previousMonthLabel: string;
  currency: string;
  incomeExpenses: MonthlyComparisonIncomeExpenses;
  notes: MonthlyComparisonNotes;
  expenses: MonthlyComparisonExpenses;
  topCategories: TopCategoriesComparison;
  netWorth: MonthlyComparisonNetWorth;
  investments: MonthlyComparisonInvestments;
}
