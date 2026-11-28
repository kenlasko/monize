/**
 * What every renderer of the budget's totals is handed: the figures the page
 * already has, nothing derived here. `displayCurrency` lets a renderer that
 * sets a headline with `MoneyFigure` name the budget's currency; omitted, the
 * viewer's default currency is used.
 */
export interface BudgetSummaryViewProps {
  totalBudgeted: number;
  /**
   * `null` for a figure the server could not work out (a row had no exchange
   * rate to the budget currency): drawn as unknown, never as zero or as the
   * converted part. `totalIncome` is `null` on the same ground.
   */
  totalSpent: number | null;
  remaining: number | null;
  totalIncome: number | null;
  percentUsed: number | null;
  /** The translated cause shown beside an unknown figure. */
  partialReason?: string;
  daysRemaining: number;
  displayCurrency?: string;
  formatCurrency: (amount: number) => string;
}
