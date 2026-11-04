import { format, subDays, subMonths, subYears } from 'date-fns';
import { resolveRangePreset, type ResolveRangeOptions } from '@/lib/date-range';
import {
  previousCalendarDay,
  usesPriorCloseBaseline,
} from './portfolio-change-baseline';

/**
 * The window a Portfolio Value chart requests, per range.
 *
 * **A portfolio chart opens its series on the close its figures are measured
 * from.** The figures are the server's (`usePortfolioPeriodResult`), measured
 * over the window `backend/src/net-worth/portfolio-period-presets.util.ts`
 * resolves for the range, so this table mirrors that file day for day:
 * `periodStart` is where the period opens (`presetWindowStart`) and `start` is
 * the day it is measured from (`presetEarliestDate`) -- the day before the
 * period for a range measured from the prior close (`usesPriorCloseBaseline`),
 * the period's own first day otherwise. `portfolio-range-window.test.ts` and
 * `portfolio-period-presets.util.spec.ts` pin the two files to the same dates.
 *
 * Separate from `resolveRangePreset` on purpose. That function answers "what
 * period is the user asking about", and ten other reports depend on its
 * answer -- a spending report's 3M window must not move when a price chart's
 * does. A rule naming an exact day overrides month alignment, which is why
 * these do not consult `options.alignment`: "the same day a year earlier" has
 * no month-aligned reading.
 *
 * | Range | Period opens | Measured from |
 * |---|---|---|
 * | 1D | unchanged (`resolveRangePreset` widens the daily fallback to a week) | the day before |
 * | 1W | 7 days back | the day before |
 * | MTD | the 1st | the last day of the previous month |
 * | 1M, 3M, 2Y | 30 / 90 / 730 days back | the same day |
 * | 6M | the same day six months earlier | the same day |
 * | YTD | 31 December of the previous year | the same day |
 * | 1Y, 5Y | the same day one / five years earlier | the same day |
 * | All, custom | unchanged | the same day |
 *
 * A day is valued from the latest close on or before it, so a `start` on a
 * weekend carries the previous session's close; the point is dated by that
 * session once the server names it (`openingSessionDate`).
 */
export type PortfolioWindowStart =
  /** Take `resolveRangePreset`'s answer unchanged. */
  | { kind: 'inherit' }
  /** `days` calendar days before today. */
  | { kind: 'daysBefore'; days: number }
  /** The same day `months` earlier, clamped to the month's last day. */
  | { kind: 'monthsBefore'; months: number }
  /** The same day `years` earlier, so 29 February steps back to 28 February. */
  | { kind: 'yearsBefore'; years: number }
  /**
   * 31 December of the previous year. A year-end on a weekend or holiday
   * still carries the last session's close, and the period result's
   * `startPriceDate` names it.
   */
  | { kind: 'previousYearEnd' };

export const PORTFOLIO_WINDOW_STARTS: Readonly<
  Record<string, PortfolioWindowStart>
> = {
  '1d': { kind: 'inherit' },
  '1w': { kind: 'daysBefore', days: 7 },
  mtd: { kind: 'inherit' },
  '1m': { kind: 'daysBefore', days: 30 },
  '3m': { kind: 'daysBefore', days: 90 },
  '6m': { kind: 'monthsBefore', months: 6 },
  ytd: { kind: 'previousYearEnd' },
  '1y': { kind: 'yearsBefore', years: 1 },
  '2y': { kind: 'daysBefore', days: 730 },
  '5y': { kind: 'yearsBefore', years: 5 },
};

/**
 * The ranges a portfolio's value and performance are offered over: the
 * Investments page's value chart and the Investment Performance report show
 * the same buttons, so the same caption names the same window on both.
 */
export const PORTFOLIO_CHART_RANGES = [
  '1d',
  '1w',
  'mtd',
  '1m',
  '3m',
  'ytd',
  '1y',
  '2y',
  '5y',
  'all',
] as const;

export interface PortfolioRangeWindow {
  /**
   * The day the series is requested from: the close the figures are measured
   * from. Empty for a window with no start (All).
   */
  start: string;
  /**
   * The day the period the range names opens. Equal to `start` except on a
   * range measured from the prior close, where it is the day after.
   */
  periodStart: string;
  end: string;
}

function periodStartFor(
  rule: PortfolioWindowStart,
  base: string,
  now: Date,
): string {
  switch (rule.kind) {
    case 'inherit':
      return base;
    case 'daysBefore':
      return format(subDays(now, rule.days), 'yyyy-MM-dd');
    case 'monthsBefore':
      return format(subMonths(now, rule.months), 'yyyy-MM-dd');
    case 'yearsBefore':
      return format(subYears(now, rule.years), 'yyyy-MM-dd');
    case 'previousYearEnd':
      return `${now.getFullYear() - 1}-12-31`;
  }
}

/**
 * The window a Portfolio Value chart should request for `range`.
 *
 * Falls through to `resolveRangePreset` for every range with no rule of its
 * own, so an unrecognised range behaves exactly as it does everywhere else.
 */
export function resolvePortfolioRangeWindow(
  range: string,
  options: ResolveRangeOptions = {},
): PortfolioRangeWindow {
  return applyPortfolioWindowStart(
    range,
    resolveRangePreset(range, options),
    options,
  );
}

/**
 * Apply the portfolio rule on top of a window somebody else already resolved.
 *
 * The report and the Investments chart get their base window from
 * `useDateRange`, which also carries the user's custom start/end dates; taking
 * its answer rather than re-deriving one is what keeps a custom range custom.
 */
export function applyPortfolioWindowStart(
  range: string,
  base: { start: string; end: string },
  options: ResolveRangeOptions = {},
): PortfolioRangeWindow {
  const rule = PORTFOLIO_WINDOW_STARTS[range] ?? { kind: 'inherit' };
  const periodStart = periodStartFor(rule, base.start, options.now ?? new Date());
  const start =
    periodStart && usesPriorCloseBaseline(range)
      ? previousCalendarDay(periodStart)
      : periodStart;
  return { start, periodStart, end: base.end };
}
