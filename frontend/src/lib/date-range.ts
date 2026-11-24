import {
  format,
  subMonths,
  subDays,
  subYears,
  subWeeks,
  startOfMonth,
} from 'date-fns';

export type DateRangeAlignment = 'day' | 'month';

export interface ResolveRangeOptions {
  /** Whether the start boundary snaps to the start of the month. Default 'day'. */
  alignment?: DateRangeAlignment;
  /** Custom start date (YYYY-MM-DD); only used when range === 'custom'. */
  startDate?: string;
  /** Custom end date (YYYY-MM-DD); only used when range === 'custom'. */
  endDate?: string;
  /** Injectable "now" for deterministic tests. Defaults to the current date. */
  now?: Date;
  /**
   * The user's day (YYYY-MM-DD, `useFinancialToday()`). Wins over `now`: every
   * preset is anchored on it, not on the browser's calendar.
   */
  today?: string;
}

/**
 * The anchor the date-fns arithmetic runs on. With `today` it is local noon of
 * that calendar day: date-fns reads and writes in the browser's zone, so noon
 * keeps `format`, `subDays` and `startOfMonth` on that day across any DST shift
 * (a midnight anchor can slide a day).
 */
export function rangeAnchor({ now, today }: Pick<ResolveRangeOptions, 'now' | 'today'>): Date {
  if (!today) return now ?? new Date();
  const [y, m, d] = today.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

/**
 * Resolve a preset range key (e.g. '3m', '1y', 'ytd', 'all', 'custom') into a
 * concrete { start, end } pair. Extracted from useDateRange so config-driven
 * consumers (dashboard widgets) can resolve a stored range without the hook's
 * localStorage/state machinery. End date is always today, matching the reports:
 * data only exists up to today, so snapping to end-of-month just produced a
 * flat-line tail. Month alignment affects the start date only.
 */
export function resolveRangePreset(
  range: string,
  options: ResolveRangeOptions = {},
): { start: string; end: string } {
  const { alignment = 'day', startDate = '', endDate = '' } = options;
  const now = rangeAnchor(options);

  if (range === 'custom') {
    return { start: startDate, end: endDate };
  }

  const isMonth = alignment === 'month';
  const end = format(now, 'yyyy-MM-dd');

  let start: string;

  switch (range) {
    case '1d':
      // '1d' is an intraday-only preset; when a chart falls back to daily
      // snapshots a single day is one point, so widen to a week.
      start = format(subWeeks(now, 1), 'yyyy-MM-dd');
      break;
    case '1w':
      start = format(subWeeks(now, 1), 'yyyy-MM-dd');
      break;
    case 'mtd':
      start = format(startOfMonth(now), 'yyyy-MM-dd');
      break;
    case '1m':
      start = format(subDays(now, 30), 'yyyy-MM-dd');
      break;
    case '3m':
      start = format(subDays(now, 90), 'yyyy-MM-dd');
      break;
    case '6m':
      start = isMonth
        ? format(startOfMonth(subMonths(now, 5)), 'yyyy-MM-dd')
        : format(subMonths(now, 6), 'yyyy-MM-dd');
      break;
    case '1y':
      start = format(subYears(now, 1), 'yyyy-MM-dd');
      break;
    case '2y':
      // Rolling 2 years = last 730 days; same shape regardless of alignment.
      start = format(subDays(now, 730), 'yyyy-MM-dd');
      break;
    case '5y':
      start = isMonth
        ? format(startOfMonth(subMonths(now, 59)), 'yyyy-MM-dd')
        : format(subYears(now, 5), 'yyyy-MM-dd');
      break;
    case '10y':
      start = isMonth
        ? format(startOfMonth(subMonths(now, 119)), 'yyyy-MM-dd')
        : format(subYears(now, 10), 'yyyy-MM-dd');
      break;
    case 'ytd':
      start = `${now.getFullYear()}-01-01`;
      break;
    case 'all':
      start = '';
      break;
    default:
      start = format(subMonths(now, 3), 'yyyy-MM-dd');
  }

  return { start, end };
}
