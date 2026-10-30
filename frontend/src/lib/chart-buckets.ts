import { addMonths, format, lastDayOfMonth } from 'date-fns';
import { MonthlyTotal } from '@/types/transaction';

/**
 * Time granularity for the transactions "Monthly Totals" bar chart. The chart
 * rolls the backend's per-month rows up to the coarsest useful bucket so a
 * sparse, irregular payment series is spaced by real elapsed time rather than
 * by "successive months that happened to have a transaction".
 */
export type Granularity = 'month' | 'quarter' | 'year';

export interface BucketedPoint {
  granularity: Granularity;
  /** Stable, sortable id: '2024-03' | '2024-Q1' | '2024'. */
  key: string;
  /** First day of the period, local YYYY-MM-DD. */
  periodStart: string;
  /** Last day of the period, local YYYY-MM-DD. */
  periodEnd: string;
  /** Signed sum for the period (0 for gap-filled empty periods). */
  total: number;
  /** Transaction count for the period (0 for gap-filled empty periods). */
  count: number;
  /** True when a month in the period is missing a rate, so total is partial. */
  partial?: boolean;
}

const GRANULARITY_MONTHS: Record<Granularity, number> = {
  month: 1,
  quarter: 3,
  year: 12,
};

// Finest-first, mirroring the spirit of TICK_STEP_MONTHS in chart-time-axis.ts.
const GRANULARITY_ORDER: readonly Granularity[] = ['month', 'quarter', 'year'];

/**
 * Target number of bars. selectGranularity picks the finest granularity whose
 * estimated bucket count stays at or below this, so long spans collapse to
 * quarters or years instead of dozens of thin monthly bars.
 */
export const TARGET_BUCKETS = 24;

// Integer ten-thousandths, matching the backend roundMoney / decimal(20,4).
const SCALE = 10000;

function spanMonthsBetween(minMonth: string, maxMonth: string): number {
  const [minY, minM] = minMonth.split('-').map(Number);
  const [maxY, maxM] = maxMonth.split('-').map(Number);
  return (maxY - minY) * 12 + (maxM - minM);
}

/**
 * Pick the coarsest-enough granularity for a set of 'YYYY-MM' month keys:
 * short spans stay monthly, medium spans go quarterly, multi-year spans
 * collapse to yearly. This is a selection heuristic only -- the exact bucket
 * count comes from bucketMonthlyTotals, which aligns to period boundaries.
 */
export function selectGranularity(
  months: string[],
  target: number = TARGET_BUCKETS,
): Granularity {
  if (months.length <= 1) return 'month';
  let min = months[0];
  let max = months[0];
  for (const m of months) {
    if (m < min) min = m;
    if (m > max) max = m;
  }
  const spanMonths = spanMonthsBetween(min, max);
  for (const granularity of GRANULARITY_ORDER) {
    const estimatedBuckets =
      Math.floor(spanMonths / GRANULARITY_MONTHS[granularity]) + 1;
    if (estimatedBuckets <= target) return granularity;
  }
  return 'year';
}

interface PeriodInfo {
  key: string;
  /** Local Date at the first day of the period (midnight). */
  startDate: Date;
  periodStart: string;
}

function periodInfoForMonth(monthKey: string, granularity: Granularity): PeriodInfo {
  const [year, month] = monthKey.split('-').map(Number); // month is 1-12
  if (granularity === 'year') {
    return {
      key: `${year}`,
      startDate: new Date(year, 0, 1),
      periodStart: `${year}-01-01`,
    };
  }
  if (granularity === 'quarter') {
    const quarterIndex = Math.floor((month - 1) / 3); // 0-3
    const startDate = new Date(year, quarterIndex * 3, 1);
    return {
      key: `${year}-Q${quarterIndex + 1}`,
      startDate,
      periodStart: format(startDate, 'yyyy-MM-dd'),
    };
  }
  return {
    key: monthKey,
    startDate: new Date(year, month - 1, 1),
    periodStart: `${monthKey}-01`,
  };
}

function periodEndFor(startDate: Date, granularity: Granularity): string {
  if (granularity === 'year') {
    return `${startDate.getFullYear()}-12-31`;
  }
  if (granularity === 'quarter') {
    // Last day of the third month of the quarter.
    return format(lastDayOfMonth(addMonths(startDate, 2)), 'yyyy-MM-dd');
  }
  return format(lastDayOfMonth(startDate), 'yyyy-MM-dd');
}

function monthKeyFor(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Roll per-month totals up to the given granularity and gap-fill every period
 * from the first populated period to the last, so empty periods render as
 * zero-height bars at their true time position. Totals are accumulated in
 * integer ten-thousandths to avoid float drift, then divided back once.
 */
export function bucketMonthlyTotals(
  data: MonthlyTotal[],
  granularity: Granularity,
): BucketedPoint[] {
  if (data.length === 0) return [];

  const accumulator = new Map<
    string,
    {
      startDate: Date;
      periodStart: string;
      cents: number;
      count: number;
      partial: boolean;
    }
  >();

  for (const datum of data) {
    const { key, startDate, periodStart } = periodInfoForMonth(datum.month, granularity);
    const partial = datum.total === null;
    const cents = Math.round((datum.total ?? datum.knownSubtotal ?? 0) * SCALE);
    const existing = accumulator.get(key);
    if (existing) {
      existing.cents += cents;
      existing.count += datum.count;
      existing.partial ||= partial;
    } else {
      accumulator.set(key, {
        startDate,
        periodStart,
        cents,
        count: datum.count,
        partial,
      });
    }
  }

  const startTimes = [...accumulator.values()].map((v) => v.startDate.getTime());
  const minStart = new Date(Math.min(...startTimes));
  const maxStart = new Date(Math.max(...startTimes));
  const step = GRANULARITY_MONTHS[granularity];

  const points: BucketedPoint[] = [];
  for (
    let cursor = minStart;
    cursor.getTime() <= maxStart.getTime();
    cursor = addMonths(cursor, step)
  ) {
    const { key, startDate, periodStart } = periodInfoForMonth(
      monthKeyFor(cursor),
      granularity,
    );
    const bucket = accumulator.get(key);
    points.push({
      granularity,
      key,
      periodStart,
      periodEnd: periodEndFor(startDate, granularity),
      total: bucket ? bucket.cents / SCALE : 0,
      count: bucket ? bucket.count : 0,
      ...(bucket?.partial && { partial: true }),
    });
  }

  return points;
}

/**
 * Number of elapsed periods (including empty gap periods) spanned by the data
 * at the given granularity. Used as the denominator for the "per-period"
 * average so it reflects time elapsed, not just periods that had activity.
 */
export function countElapsedPeriods(
  data: MonthlyTotal[],
  granularity: Granularity,
): number {
  return bucketMonthlyTotals(data, granularity).length;
}
