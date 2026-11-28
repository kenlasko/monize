/**
 * What every renderer of the budget's totals is handed: the figures the page
 * already has, nothing derived here. `displayCurrency` lets a renderer that
 * sets a headline with `MoneyFigure` name the budget's currency; omitted, the
 * viewer's default currency is used.
 */
export interface BudgetSummaryViewProps {
  /** `null` when the budget derives from income with no exchange rate (`budgetedComplete` is `false`). */
  totalBudgeted: number | null;
  /**
   * `null` for a figure the server could not work out (a row had no exchange
   * rate to the budget currency): drawn as unknown, never as zero or as the
   * converted part. `totalIncome` is `null` on the same ground.
   */
  totalSpent: number | null;
  remaining: number | null;
  totalIncome: number | null;
  percentUsed: number | null;
  /** The translated cause shown beside an unknown SPENT figure (the expense pairs). */
  partialReason?: string;
  /** The cause beside an unknown budget, what is left or the income (the income pairs). */
  incomeReason?: string;
  daysRemaining: number;
  displayCurrency?: string;
  formatCurrency: (amount: number) => string;
}
