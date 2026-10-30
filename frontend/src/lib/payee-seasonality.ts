import type { MonthlyTotal } from '@/types/transaction';

/** One calendar month's average across every year the payee was active in it. */
export interface SeasonalMonth {
  /** 1-12, January first. */
  month: number;
  /** Mean signed total for this calendar month, over the years that have one. */
  average: number;
  /** How many years contributed a figure for this calendar month. */
  years: number;
}

export interface Seasonality {
  months: SeasonalMonth[];
  /**
   * The calendar month the spending concentrates in, or null when it does not
   * concentrate anywhere. Null is the common case and the honest one: most
   * payees are billed evenly, and naming a "peak" for them would invent a
   * pattern out of noise.
   */
  peakMonth: number | null;
  /** The peak's average as a multiple of the typical month. */
  peakRatio: number | null;
  /** Distinct calendar years present in the data. */
  yearsCovered: number;
}

/**
 * How many distinct years of history it takes before a shape in the data is
 * worth calling seasonal. With one year every payee looks seasonal -- one
 * December is just one bill, not a December habit.
 */
export const MIN_YEARS_FOR_SEASONALITY = 2;

/**
 * How far above the typical month the busiest one has to sit before the panel
 * names it. A payee billed evenly still has a largest month; this is what keeps
 * that from being announced as a seasonal peak.
 */
const PEAK_RATIO_THRESHOLD = 1.5;

/** The median of a list of numbers. Empty list gives 0. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Reduce a payee's monthly history to a per-calendar-month profile: what a
 * typical January costs, a typical February, and so on.
 *
 * Averages per calendar month rather than summing, so a payee with three years
 * of history is not reported as spending three times as much in every month as
 * one with a single year. Months with no history at all are absent from `months`
 * rather than present as zero -- a month the payee has never been billed in is
 * not a month it costs nothing, and a zero would drag its average down.
 *
 * The median is the comparison point for the peak, not the mean: a single
 * enormous December pulls the mean up towards itself and so partly hides the
 * very spike being tested for.
 */
export function computeSeasonality(monthly: MonthlyTotal[]): Seasonality {
  const byCalendarMonth = new Map<number, number[]>();
  const years = new Set<string>();

  for (const row of monthly) {
    // 'YYYY-MM'; anything else is not a month key and is skipped rather than
    // parsed into NaN.
    const [yearPart, monthPart] = row.month.split('-');
    const monthNumber = Number(monthPart);
    if (!yearPart || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
      continue;
    }
    // Unknown (no rate) is not zero: it must not drag the month's average.
    if (row.total === null) continue;
    years.add(yearPart);
    const bucket = byCalendarMonth.get(monthNumber) ?? [];
    bucket.push(Number(row.total) || 0);
    byCalendarMonth.set(monthNumber, bucket);
  }

  const months: SeasonalMonth[] = [...byCalendarMonth.entries()]
    .map(([month, totals]) => ({
      month,
      average: totals.reduce((sum, value) => sum + value, 0) / totals.length,
      years: totals.length,
    }))
    .sort((a, b) => a.month - b.month);

  const yearsCovered = years.size;

  // Magnitudes, so the test works the same for a payee that pays the user.
  const magnitudes = months.map((m) => Math.abs(m.average)).filter((value) => value > 0);
  const typical = median(magnitudes);

  let peakMonth: number | null = null;
  let peakRatio: number | null = null;

  if (yearsCovered >= MIN_YEARS_FOR_SEASONALITY && typical > 0) {
    const busiest = months.reduce(
      (best, current) =>
        Math.abs(current.average) > Math.abs(best.average) ? current : best,
      months[0],
    );
    const ratio = Math.abs(busiest.average) / typical;
    if (ratio >= PEAK_RATIO_THRESHOLD) {
      peakMonth = busiest.month;
      peakRatio = ratio;
    }
  }

  return { months, peakMonth, peakRatio, yearsCovered };
}
