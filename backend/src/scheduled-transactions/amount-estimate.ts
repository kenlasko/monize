import { roundMoney } from "../common/round.util";

/**
 * The arithmetic behind an estimated scheduled amount (issue #2096,
 * docs/specs/scheduled-amount-estimate.md). Pure: the history arrives already
 * matched and converted into the schedule's currency, so every rule here is
 * testable without a database.
 */

/** How far back a payment still counts, in calendar months. */
export const ESTIMATE_HISTORY_MONTHS = 24;

/** How many of the newest payments the non-seasonal estimate averages. */
export const ESTIMATE_RECENT_PAYMENTS = 3;

/**
 * How many calendar months must hold a payment in BOTH years before a
 * year-over-year growth rate is read off them. Fewer is noise: one month's
 * difference is a bill, not a trend.
 */
export const ESTIMATE_MIN_GROWTH_MONTHS = 3;

/**
 * The bounds a year-over-year growth rate is clamped to. A rate outside them
 * is almost always a one-off (a catch-up bill, a cancelled month) rather than
 * a price change, and compounding it forward would run away.
 */
export const ESTIMATE_GROWTH_MIN = -0.5;
export const ESTIMATE_GROWTH_MAX = 1;

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
  /** The payments the estimate averages: same sign, inside the window. */
  payments: EstimatePayment[];
  /**
   * Whether the history covers two years, which is what makes a calendar
   * month's own payments a better guide than the latest ones.
   */
  seasonal: boolean;
  /** The year-over-year growth applied per year projected forward; 0 when none. */
  growthRate: number;
  /** Mean of the newest `ESTIMATE_RECENT_PAYMENTS` payments. */
  recentMean: number;
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
  const index = monthIndex(month) + count;
  const year = Math.floor(index / 12);
  const m = index - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

/**
 * The calendar date `count` months from `ymd`, the day clamped to the target
 * month's last day (31 March back one month is 28 or 29 February).
 */
export function shiftMonthsYMD(ymd: string, count: number): string {
  const target = shiftMonthKey(monthKeyOf(ymd), count);
  const year = Number(target.slice(0, 4));
  const month = Number(target.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(Number(ymd.slice(8, 10)), lastDay);
  return `${target}-${String(day).padStart(2, "0")}`;
}

/** The earliest date a payment may carry to count on `today`, exclusive. */
export function historyWindowStart(today: string): string {
  return shiftMonthsYMD(today, -ESTIMATE_HISTORY_MONTHS);
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * The year-over-year growth of the history, or 0 when it cannot be read.
 *
 * Compares each calendar month that holds a payment in both the latest twelve
 * months and the twelve before them: the ratio of the summed monthly means,
 * minus one. Matching on calendar months is what keeps a seasonal bill's
 * winter from reading as growth over the previous summer.
 */
export function yearOverYearGrowth(
  payments: EstimatePayment[],
  today: string,
): number {
  const yearStart = shiftMonthsYMD(today, -12);
  const latest = new Map<number, number[]>();
  const prior = new Map<number, number[]>();
  for (const p of payments) {
    const month = Number(p.date.slice(5, 7));
    const bucket = p.date > yearStart ? latest : prior;
    bucket.set(month, [...(bucket.get(month) ?? []), p.amount]);
  }
  let latestSum = 0;
  let priorSum = 0;
  let matched = 0;
  for (const [month, values] of latest) {
    const before = prior.get(month);
    if (!before) continue;
    latestSum += mean(values);
    priorSum += mean(before);
    matched++;
  }
  if (matched < ESTIMATE_MIN_GROWTH_MONTHS || priorSum === 0) return 0;
  const growth = latestSum / priorSum - 1;
  if (!Number.isFinite(growth)) return 0;
  return Math.min(ESTIMATE_GROWTH_MAX, Math.max(ESTIMATE_GROWTH_MIN, growth));
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

  const total = inWindow.reduce((sum, p) => sum + p.amount, 0);
  const sign =
    total !== 0
      ? Math.sign(total)
      : Math.sign(inWindow[inWindow.length - 1].amount);
  const payments = inWindow.filter((p) => Math.sign(p.amount) === sign);

  const yearStart = shiftMonthsYMD(today, -12);
  const seasonal =
    payments.some((p) => p.date <= yearStart) &&
    payments.some((p) => p.date > yearStart);
  const recent = payments.slice(-ESTIMATE_RECENT_PAYMENTS);

  return {
    payments,
    seasonal,
    growthRate: seasonal ? yearOverYearGrowth(payments, today) : 0,
    recentMean: mean(recent.map((p) => p.amount)),
    decimals,
  };
}

/** Which rule produced one month's estimate. */
export type EstimateBasis = "seasonal" | "recent";

/**
 * The per-occurrence estimate for an occurrence falling in `month`
 * (`YYYY-MM`), and the rule that produced it.
 *
 * Seasonal history with payments in the same calendar month: each such
 * payment projected forward by the growth rate for the whole years between
 * its month and `month`, then averaged. Otherwise the mean of the newest
 * payments. Rounded to the currency's entry places: an estimate is a figure a
 * person would have typed.
 */
export function estimateForMonth(
  profile: EstimateProfile,
  month: string,
): { amount: number; basis: EstimateBasis } {
  const calendarMonth = Number(month.slice(5, 7));
  const sameMonth = profile.seasonal
    ? profile.payments.filter(
        (p) => Number(p.date.slice(5, 7)) === calendarMonth,
      )
    : [];
  if (sameMonth.length === 0) {
    return {
      amount: roundMoney(profile.recentMean, profile.decimals),
      basis: "recent",
    };
  }
  const target = monthIndex(month);
  const projected = sameMonth.map((p) => {
    const years = Math.round((target - monthIndex(p.date)) / 12);
    return p.amount * Math.pow(1 + profile.growthRate, years);
  });
  return {
    amount: roundMoney(mean(projected), profile.decimals),
    basis: "seasonal",
  };
}
