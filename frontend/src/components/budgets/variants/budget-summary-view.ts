/**
 * What every renderer of the budget's totals is handed: the figures the page
 * already has, nothing derived here. `displayCurrency` lets a renderer that
 * sets a headline with `MoneyFigure` name the budget's currency; omitted, the
 * viewer's default currency is used.
 */
export interface BudgetSummaryViewProps {
  totalBudgeted: number;
  totalSpent: number;
  remaining: number;
  totalIncome: number;
  percentUsed: number;
  daysRemaining: number;
  displayCurrency?: string;
  formatCurrency: (amount: number) => string;
}
