import { MONEY_SCALE, roundMoney, sumMoney } from "../common/round.util";
import { addMonthsClamped } from "../common/recurrence";

/**
 * The arithmetic behind an estimated scheduled amount (issue #2096,
 * docs/specs/scheduled-amount-estimate.md section 4). Pure: the history arrives
 * already matched and converted into the schedule's currency, so every rule
 * here is testable without a database.
 *
 * The model is a level, a seasonal index and a trend, each admitted only when
 * the history shows it:
 *
 *  - the LEVEL is the newest payments, so a price change since last year is
 *    the price from now on;
 *  - a calendar month's SEASONAL INDEX (its mean over its year's mean) shapes
 *    the level only when both years vary by month and agree on how;
 *  - a year-over-year GROWTH projects the level forward only when every
 *    calendar month moved by about the same ratio. A one-off price step moves
 *    some months and not others, so it is a new level, not a trend.
 */

/** How far back a payment still counts, in calendar months. */
export const ESTIMATE_HISTORY_MONTHS = 24;

/** How many of the newest payments the level averages. */
export const ESTIMATE_RECENT_PAYMENTS = 3;

/**
 * How many calendar months must hold a payment in BOTH years before a
 * year-over-year growth rate is read off them. Fewer is noise: one month's
 * difference is a bill, not a trend.
 */
export const ESTIMATE_MIN_GROWTH_MONTHS = 3;

/**
 * The most the per-month year-over-year ratios may scatter (their standard
 * deviation) for them to be read as one growth rate. A steady price trend
 * moves every month alike; a step leaves one group of months at 1 and the rest
 * at the new ratio, far wider than this.
 */
export const ESTIMATE_GROWTH_MAX_DISPERSION = 0.1;

/**
 * The bounds a year-over-year growth rate is clamped to. A rate outside them
 * is almost always a one-off (a catch-up bill, a cancelled month) rather than
 * a price change, and compounding it forward would run away.
 */
export const ESTIMATE_GROWTH_MIN = -0.5;
export const ESTIMATE_GROWTH_MAX = 1;

/**
 * How many calendar months each year, and both years together, must hold a
 * payment before a seasonal pattern is looked for: a quarterly bill's four.
 */
export const ESTIMATE_SEASONAL_MIN_MONTHS = 4;

/**
 * How far a month's index must stand from 1 (its share above or below the
 * year's mean) in each year for that year to vary by season at all. A flat
 * bill's billing noise stays under it.
 */
export const ESTIMATE_SEASONAL_MIN_SPREAD = 0.1;

/**
 * How closely the two years' monthly indexes must agree (their correlation)
 * for the pattern to be a season rather than two unrelated years: a price step
 * in one year is a pattern that year alone shows.
 */
export const ESTIMATE_SEASONAL_MIN_CORRELATION = 0.6;

/** One matched payment, signed, in the schedule's currency. */
export interface EstimatePayment {
  /** `YYYY-MM-DD`. */
  date: string;
  amount: number;
}

/**
 * Everything the estimate for any month is derived from. Built once per
 * schedule; `estimateForMonth` answers per occurrence.
 */
export interface EstimateProfile {
  /** The payments the estimate reads: same sign, inside the window. */
  payments: EstimatePayment[];
  /** Whether the history varies by calendar month, the same way both years. */
  seasonal: boolean;
  /**
   * Calendar month (1-12) -> its seasonal index, averaged over the years that
   * hold it. Empty when not seasonal; a month it lacks has index 1.
   */
  seasonalIndex: ReadonlyMap<number, number>;
  /**
   * The newest payments' mean, with their months' seasonal index taken out:
   * what a month of index 1 costs at the latest price.
   */
  level: number;
  /** Months since year 0 of the newest payment, where the level stands. */
  levelMonth: number;
  /** The year-over-year growth projected forward from the level; 0 when none. */
  growthRate: number;
  /** The places every estimate is rounded to: the currency's entry places. */
  decimals: number;
}

/** `YYYY-MM` of a `YYYY-MM-DD`. */
export function monthKeyOf(ymd: string): string {
  return ymd.slice(0, 7);
}

/** Months since year 0 of a `YYYY-MM` or `YYYY-MM-DD`. */
function monthIndex(ymdOrMonth: string): number {
  const year = Number(ymdOrMonth.slice(0, 4));
  const month = Number(ymdOrMonth.slice(5, 7));
  return year * 12 + (month - 1);
}

/** The `YYYY-MM` `count` months after `month` (negative goes back). */
export function shiftMonthKey(month: string, count: number): string {
  return monthKeyOf(addMonthsClamped(`${month}-01`, count));
}

/**
 * The earliest date a payment may carry to count on `today`, exclusive: the
 * same day `ESTIMATE_HISTORY_MONTHS` back, clamped to that month's end.
 */
export function historyWindowStart(today: string): string {
  return addMonthsClamped(today, -ESTIMATE_HISTORY_MONTHS);
}

/** An exact sum at the column's scale, so no float drift decides a sign. */
function total(values: number[]): number {
  return sumMoney(values, MONEY_SCALE);
}

function mean(values: number[]): number {
  return roundMoney(total(values) / values.length, MONEY_SCALE);
}

/** Calendar-month offset (0 = today's month) -> the payments in it. */
function byMonthOffset(
  payments: EstimatePayment[],
  today: string,
): Map<number, number[]> {
  const current = monthIndex(today);
  const byOffset = new Map<number, number[]>();
  for (const p of payments) {
    const offset = current - monthIndex(p.date);
    if (offset < 0 || offset >= 24) continue;
    const list = byOffset.get(offset);
    if (list) list.push(p.amount);
    else byOffset.set(offset, [p.amount]);
  }
  return byOffset;
}

/** Population standard deviation. */
function stdev(values: number[]): number {
  const m = values.reduce((a, v) => a + v, 0) / values.length;
  return Math.sqrt(
    values.reduce((a, v) => a + (v - m) * (v - m), 0) / values.length,
  );
}

/**
 * The year-over-year growth of the history, or 0 when it is not a trend.
 *
 * Each calendar month of the latest twelve (offsets 0 to 11 from today's
 * month) is compared with the same month a year earlier (offset + 12): the
 * same calendar month, so a seasonal bill's winter never reads as growth over
 * the previous summer, and the current month is never pooled across two years.
 * The rate is the ratio of the summed monthly means minus one, and only when
 * at least `ESTIMATE_MIN_GROWTH_MONTHS` months compare and their ratios agree
 * within `ESTIMATE_GROWTH_MAX_DISPERSION`: a price step is a new level, which
 * the recent payments already carry, not a rate to compound.
 */
export function yearOverYearGrowth(
  payments: EstimatePayment[],
  today: string,
): number {
  const byOffset = byMonthOffset(payments, today);
  const latestMeans: number[] = [];
  const priorMeans: number[] = [];
  const ratios: number[] = [];
  for (let offset = 0; offset < 12; offset++) {
    const latest = byOffset.get(offset);
    const prior = byOffset.get(offset + 12);
    if (!latest || !prior) continue;
    const a = mean(latest);
    const b = mean(prior);
    latestMeans.push(a);
    priorMeans.push(b);
    if (b !== 0) ratios.push(a / b);
  }
  const priorSum = total(priorMeans);
  if (latestMeans.length < ESTIMATE_MIN_GROWTH_MONTHS || priorSum === 0) {
    return 0;
  }
  if (stdev(ratios) > ESTIMATE_GROWTH_MAX_DISPERSION) return 0;
  const growth = total(latestMeans) / priorSum - 1;
  if (!Number.isFinite(growth)) return 0;
  return Math.min(ESTIMATE_GROWTH_MAX, Math.max(ESTIMATE_GROWTH_MIN, growth));
}

/** Pearson correlation, or null when either side does not vary. */
function correlation(xs: number[], ys: number[]): number | null {
  const sx = stdev(xs);
  const sy = stdev(ys);
  if (sx === 0 || sy === 0) return null;
  const mx = xs.reduce((a, v) => a + v, 0) / xs.length;
  const my = ys.reduce((a, v) => a + v, 0) / ys.length;
  const cov =
    xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.length;
  return cov / (sx * sy);
}

/**
 * The seasonal index by calendar month, or `null` when the history does not
 * vary by season.
 *
 * Each year (offsets 0 to 11, and 12 to 23) gets its own index: a calendar
 * month's mean over the mean of that year's monthly means, so a price change
 * between the years cancels out. It is a season only when each year holds
 * `ESTIMATE_SEASONAL_MIN_MONTHS` months, both vary by at least
 * `ESTIMATE_SEASONAL_MIN_SPREAD`, and the months both years hold agree with a
 * correlation of `ESTIMATE_SEASONAL_MIN_CORRELATION`. A flat bill does not
 * vary; a price step in one year varies in that year alone.
 */
export function seasonalIndex(
  payments: EstimatePayment[],
  today: string,
): Map<number, number> | null {
  const byOffset = byMonthOffset(payments, today);
  const current = monthIndex(today);
  const calendarMonth = (offset: number) =>
    ((((current - offset) % 12) + 12) % 12) + 1;
  const yearIndex = (from: number): Map<number, number> => {
    const means = new Map<number, number>();
    for (let offset = from; offset < from + 12; offset++) {
      const list = byOffset.get(offset);
      if (list) means.set(calendarMonth(offset), mean(list));
    }
    const yearMean = mean([...means.values()]);
    const index = new Map<number, number>();
    if (means.size === 0 || yearMean === 0) return index;
    for (const [month, value] of means) index.set(month, value / yearMean);
    return index;
  };
  const latest = yearIndex(0);
  const prior = yearIndex(12);
  const varies = (index: Map<number, number>) =>
    index.size >= ESTIMATE_SEASONAL_MIN_MONTHS &&
    Math.max(...[...index.values()].map((v) => Math.abs(v - 1))) >=
      ESTIMATE_SEASONAL_MIN_SPREAD;
  if (!varies(latest) || !varies(prior)) return null;
  const shared = [...latest.keys()].filter((m) => prior.has(m));
  if (shared.length < ESTIMATE_SEASONAL_MIN_MONTHS) return null;
  const agreement = correlation(
    shared.map((m) => latest.get(m)!),
    shared.map((m) => prior.get(m)!),
  );
  if (agreement === null || agreement < ESTIMATE_SEASONAL_MIN_CORRELATION) {
    return null;
  }
  const index = new Map<number, number>();
  for (let month = 1; month <= 12; month++) {
    const values = [latest.get(month), prior.get(month)].filter(
      (v): v is number => v !== undefined,
    );
    if (values.length > 0) {
      index.set(month, values.reduce((a, v) => a + v, 0) / values.length);
    }
  }
  return index;
}

/**
 * The profile an estimate is read from, or `null` when no payment counts.
 *
 * Only payments on the history's dominant side of zero count: a refund from
 * the same biller is not a bill, and averaging it in would shrink every month.
 * The dominant side is the sign of the window's sum (the newest payment's when
 * the sum is zero). A zero payment carries no information about the amount
 * and is dropped as well.
 */
export function buildEstimateProfile(
  history: EstimatePayment[],
  today: string,
  decimals: number,
): EstimateProfile | null {
  const windowStart = historyWindowStart(today);
  const inWindow = history
    .filter((p) => p.date > windowStart && p.date <= today)
    .filter((p) => Number.isFinite(p.amount) && p.amount !== 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (inWindow.length === 0) return null;

  const sum = total(inWindow.map((p) => p.amount));
  const sign =
    sum !== 0
      ? Math.sign(sum)
      : Math.sign(inWindow[inWindow.length - 1].amount);
  const payments = inWindow.filter((p) => Math.sign(p.amount) === sign);

  const index = seasonalIndex(payments, today);
  const indexOf = (date: string) => index?.get(Number(date.slice(5, 7))) ?? 1;
  const recent = payments.slice(-ESTIMATE_RECENT_PAYMENTS);

  return {
    payments,
    seasonal: index !== null,
    seasonalIndex: index ?? new Map(),
    level: mean(recent.map((p) => p.amount / indexOf(p.date))),
    levelMonth: monthIndex(recent[recent.length - 1].date),
    growthRate: yearOverYearGrowth(payments, today),
    decimals,
  };
}

/** Which rule produced one month's estimate. */
export type EstimateBasis = "seasonal" | "recent";

/**
 * The per-occurrence estimate for an occurrence falling in `month`
 * (`YYYY-MM`), and the rule that produced it: the level, times the month's
 * seasonal index when the history is seasonal and holds that month, grown by
 * the trend for the months between the newest payment and `month`. Rounded to
 * the currency's entry places: an estimate is a figure a person would have
 * typed.
 */
export function estimateForMonth(
  profile: EstimateProfile,
  month: string,
): { amount: number; basis: EstimateBasis } {
  const index = profile.seasonalIndex.get(Number(month.slice(5, 7)));
  const monthsAhead = Math.max(0, monthIndex(month) - profile.levelMonth);
  const grown =
    profile.level *
    (index ?? 1) *
    Math.pow(1 + profile.growthRate, monthsAhead / 12);
  return {
    amount: roundMoney(grown, profile.decimals),
    basis: index !== undefined ? "seasonal" : "recent",
  };
}
