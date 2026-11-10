import { MONEY_SCALE, roundMoney, sumMoney } from "../common/round.util";
import { addMonthsClamped } from "../common/recurrence";

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

/**
 * The year-over-year growth of the history, or 0 when it cannot be read.
 *
 * Buckets each payment by how many calendar months before today's it falls:
 * 0 to 11 is the latest year, 12 to 23 the year before, and a month is
 * compared with the one exactly twelve months earlier -- the same calendar
 * month, a year apart, so a seasonal bill's winter never reads as growth over
 * the previous summer and the current month's payments are never pooled across
 * two years. The rate is the ratio of the summed monthly means over the months
 * both years hold, minus one.
 */
export function yearOverYearGrowth(
  payments: EstimatePayment[],
  today: string,
): number {
  const current = monthIndex(today);
  const byOffset = new Map<number, number[]>();
  for (const p of payments) {
    const offset = current - monthIndex(p.date);
    if (offset < 0 || offset >= 24) continue;
    byOffset.set(offset, [...(byOffset.get(offset) ?? []), p.amount]);
  }
  const latestMeans: number[] = [];
  const priorMeans: number[] = [];
  for (let offset = 0; offset < 12; offset++) {
    const latest = byOffset.get(offset);
    const prior = byOffset.get(offset + 12);
    if (!latest || !prior) continue;
    latestMeans.push(mean(latest));
    priorMeans.push(mean(prior));
  }
  const priorSum = total(priorMeans);
  if (latestMeans.length < ESTIMATE_MIN_GROWTH_MONTHS || priorSum === 0) {
    return 0;
  }
  const growth = total(latestMeans) / priorSum - 1;
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

  const sum = total(inWindow.map((p) => p.amount));
  const sign =
    sum !== 0
      ? Math.sign(sum)
      : Math.sign(inWindow[inWindow.length - 1].amount);
  const payments = inWindow.filter((p) => Math.sign(p.amount) === sign);

  const yearStart = addMonthsClamped(today, -12);
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
