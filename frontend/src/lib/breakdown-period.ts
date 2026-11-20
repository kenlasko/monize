import { sumMoney } from './format';
import type { MonthlyCategoryBreakdownResponse } from '@/types/built-in-reports';

/**
 * The column width of the Monthly & Yearly Breakdown report: one calendar
 * month or one calendar year.
 *
 * The server answers in months only. A year column is the sum of the twelve
 * (or fewer) month figures already converted into the reporting currency, so a
 * yearly cell equals the total of the monthly cells it replaces, to the cent:
 * each month figure is converted at its own rows' rates before it is summed,
 * and summing converted figures is what the monthly Total column already does.
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

function rollUp(values: Record<string, number>, period: BreakdownPeriod): Record<string, number> {
  const parts = new Map<string, number[]>();
  for (const [month, value] of Object.entries(values)) {
    const key = periodKeyOf(month, period);
    parts.set(key, [...(parts.get(key) ?? []), value]);
  }
  return Object.fromEntries(Array.from(parts, ([key, list]) => [key, sumMoney(list)]));
}

/**
 * The breakdown answer re-keyed by column. Monthly returns the answer as it
 * came; yearly folds every row's months into years. The field names stay the
 * server's (`months`, `valuesByMonth`) so one table model draws both: in a
 * yearly answer they hold `YYYY` keys.
 */
export function breakdownByPeriod(
  response: MonthlyCategoryBreakdownResponse,
  period: BreakdownPeriod,
): MonthlyCategoryBreakdownResponse {
  if (period === 'month') return response;
  return {
    ...response,
    months: Array.from(new Set(response.months.map((m) => periodKeyOf(m, period)))).sort(),
    data: response.data.map((row) => ({ ...row, valuesByMonth: rollUp(row.valuesByMonth, period) })),
    transfers: (response.transfers ?? []).map((row) => ({
      ...row,
      valuesByMonth: rollUp(row.valuesByMonth, period),
    })),
  };
}
