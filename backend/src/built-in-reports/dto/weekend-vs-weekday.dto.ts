export class DaySpending {
  dayOfWeek: number; // 0=Sun, 6=Sat
  total: number;
  count: number;
}

export class CategoryWeekendWeekday {
  categoryId: string | null;
  categoryName: string;
  weekendTotal: number;
  weekdayTotal: number;
}

export class WeekendWeekdaySummary {
  /**
   * Spending on weekends and on weekdays, or `null` when any row could not be
   * converted into {@link WeekendVsWeekdayResponse.currency} -- a missing rate
   * makes the total unknowable, never smaller. The `known*` fields carry the
   * part that did convert.
   */
  weekendTotal: number | null;
  weekdayTotal: number | null;
  knownWeekendTotal: number;
  knownWeekdayTotal: number;
  /**
   * Each side's share of the week's spending in percent, divided from the
   * unrounded sums, never from the two rounded totals; `null` with the totals
   * while a row could not be converted, 0 when nothing was spent.
   */
  weekendShare: number | null;
  weekdayShare: number | null;
  /**
   * Each side's mean per transaction, divided from the unrounded sum and read
   * once; 0 over no transactions, `null` with the totals.
   */
  weekendAverage: number | null;
  weekdayAverage: number | null;
  /**
   * The weekend's mean less the weekday's, subtracted before it is read:
   * positive when weekends cost more per transaction. `null` with the totals.
   */
  averageDifference: number | null;
  /** Transactions that converted; an excluded row is in no count either. */
  weekendCount: number;
  weekdayCount: number;
}

export class WeekendVsWeekdayResponse {
  summary: WeekendWeekdaySummary;
  /** Per-day and per-category figures are only the rows that converted. */
  byDay: DaySpending[];
  byCategory: CategoryWeekendWeekday[];

  /** Reporting currency every figure above is expressed in. */
  currency: string;

  /**
   * Source currencies with no usable rate into {@link currency}, so their rows
   * are in none of the figures above. Empty when the report is complete.
   */
  missingCurrencies: string[];

  /** How many aggregate rows were left out, by any cause. */
  excludedCount: number;
}
