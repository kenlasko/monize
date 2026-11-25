
/**
 * The column width of the Monthly & Yearly Breakdown report: one calendar
 * month or one calendar year.
 *
 * The server answers in either width (`period`), folding a year's months as
 * aggregates before it reads the year, so a yearly cell is one rounding of its
 * rows rather than the sum of twelve monthly readings (issue #2413).
 */
export type BreakdownPeriod = 'month' | 'year';

export const BREAKDOWN_PERIODS: readonly BreakdownPeriod[] = ['month', 'year'];

/** A stored value that is not a known period (a corrupted entry) reads as monthly. */
export function asBreakdownPeriod(value: unknown): BreakdownPeriod {
  return value === 'year' ? 'year' : 'month';
}

/** The column a `YYYY-MM` month falls in: itself, or its `YYYY` year. */
export function periodKeyOf(month: string, period: BreakdownPeriod): string {
  return period === 'year' ? month.slice(0, 4) : month;
}

/** The column today falls in, which is still in progress. */
export function currentPeriodKey(period: BreakdownPeriod, now: Date): string {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return periodKeyOf(month, period);
}

/**
 * Snap a window's start down to the first day of its column, so the leading
 * column is a whole month or a whole year rather than a partial one labelled as
 * if it were whole. An empty start ("all") stays empty.
 */
export function alignPeriodStart(start: string, period: BreakdownPeriod): string {
  if (!start) return '';
  return period === 'year' ? `${start.slice(0, 4)}-01-01` : `${start.slice(0, 7)}-01`;
}

/** How many whole calendar years each yearly preset spans before the current one. */
const YEARLY_PRESET_YEARS: Readonly<Record<string, number>> = { '2y': 2, '5y': 5, '10y': 10 };

/**
 * The start of a yearly window: 1 January N years back for an N-year preset,
 * so 5Y in 2026 is 2021-2025 (plus 2026 when the current year is included).
 * Counted in calendar years, never from the day-level preset's lookback,
 * which in a leap year can land on 1 January of the year after the one meant.
 * Any other range ("all", "custom") snaps its resolved start to its year.
 */
export function yearlyWindowStart(range: string, resolvedStart: string, now: Date): string {
  const years = YEARLY_PRESET_YEARS[range];
  if (years !== undefined) return `${now.getFullYear() - years}-01-01`;
  return alignPeriodStart(resolvedStart, 'year');
}

/** The first and last day (`YYYY-MM-DD`, inclusive) a column covers. */
export function periodBounds(key: string, period: BreakdownPeriod): { start: string; end: string } {
  if (period === 'year') return { start: `${key}-01-01`, end: `${key}-12-31` };
  const [year, month] = key.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return { start: `${key}-01`, end: `${key}-${String(lastDay).padStart(2, '0')}` };
}

/** The day before a `YYYY-MM-DD` date, as `YYYY-MM-DD`. */
function dayBefore(ymd: string): string {
  const [year, month, day] = ymd.split('-').map(Number);
  const date = new Date(year, month - 1, day - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * The last day the breakdown asks the server for. The column in progress is
 * left out unless the reader includes it, by ending the window the day before
 * it opens rather than dropping its column from the answer: the server's row,
 * section and group totals and its averages are then over exactly the columns
 * shown (issue #2413). `null` when nothing before the column in progress is in
 * the window, so there is nothing to ask for.
 */
export function breakdownRequestEnd(
  rangeEnd: string,
  start: string,
  period: BreakdownPeriod,
  includeCurrentPeriod: boolean,
  now: Date,
): string | null {
  if (includeCurrentPeriod) return rangeEnd;
  const lastFinished = dayBefore(periodBounds(currentPeriodKey(period, now), period).start);
  const end = rangeEnd < lastFinished ? rangeEnd : lastFinished;
  return start && end < start ? null : end;
}
