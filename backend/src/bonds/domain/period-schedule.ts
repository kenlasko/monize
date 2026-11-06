import {
  addMonthsClamped,
  compareYMD,
  daysBetween,
  daysInMonth,
  formatYMD,
  parseYMD,
} from "./calendar-date";

/**
 * One regular coupon period (a "quasi-coupon period") an irregular period
 * overlaps, and the part of it the period accrues over: `from` to `to` inside
 * `start` to `end`.
 */
export interface QuasiPeriod {
  readonly start: string;
  readonly end: string;
  readonly from: string;
  readonly to: string;
}

/**
 * What a `COUPON_DATES` period is made of
 * (`docs/specs/bond-marketable-primitives.md` 5.1): `REGULAR` when its dates
 * are two consecutive regular coupon dates, `SHORT` or `LONG` for a first period
 * that starts after or before the regular date one step before the first coupon.
 */
export interface CouponPeriodInfo {
  readonly kind: "REGULAR" | "SHORT" | "LONG";
  readonly quasi: readonly QuasiPeriod[];
}

export interface SchedulePeriod {
  /** 1-based. */
  readonly index: number;
  readonly start: string;
  readonly end: string;
  /** Actual days, start inclusive, end exclusive (ACT or D in the letters). */
  readonly days: number;
  /** Set only by a `COUPON_DATES` schedule. */
  readonly coupon?: CouponPeriodInfo;
}

/**
 * Periods are anchored on the lot's purchase date (spec 2.3); every boundary is
 * computed from the purchase date, so a 31st does not drift down after February.
 * Maturity is `end` of the last period.
 */
export function buildSchedule(
  purchaseDate: string,
  periodCount: number,
  periodMonths: number,
): readonly SchedulePeriod[] {
  if (!Number.isInteger(periodCount) || periodCount < 1) {
    throw new RangeError(`Invalid period count: ${periodCount}`);
  }
  if (!Number.isInteger(periodMonths) || periodMonths < 1) {
    throw new RangeError(`Invalid period length in months: ${periodMonths}`);
  }
  return Array.from({ length: periodCount }, (_unused, i) => {
    const start = addMonthsClamped(purchaseDate, i * periodMonths);
    const end = addMonthsClamped(purchaseDate, (i + 1) * periodMonths);
    return { index: i + 1, start, end, days: daysBetween(start, end) };
  });
}

/** A single period from `start` to `end`, for a schedule that does not depend on the lot. */
export function singlePeriodSchedule(
  start: string,
  end: string,
): readonly SchedulePeriod[] {
  return [{ index: 1, start, end, days: daysBetween(start, end) }];
}

/** The dates a `COUPON_DATES` schedule is generated from. */
export interface CouponDates {
  readonly datedDate: string;
  readonly firstCouponDate: string;
  readonly maturityDate: string;
  readonly couponMonths: number;
  readonly endOfMonth: boolean;
}

/** What the regular coupon dates depend on: everything but the first coupon date. */
export type RegularDates = Omit<CouponDates, "firstCouponDate">;

/** More regular periods than any security has; a bound against a hostile document. */
export const MAX_COUPON_PERIODS = 1200;

/** The dates are not a coupon schedule; `field` names the schedule field at fault. */
export class CouponScheduleError extends RangeError {
  constructor(
    readonly field: "datedDate" | "firstCouponDate" | "maturityDate",
    detail: string,
  ) {
    super(detail);
    this.name = "CouponScheduleError";
  }
}

/** The last day of the month of `value`. */
export function endOfMonthOf(value: string): string {
  const { year, month } = parseYMD(value);
  return formatYMD(year, month, daysInMonth(year, month));
}

/**
 * The regular coupon date `steps` before the maturity: the maturity's day
 * clamped to the month, or the last day of the month. Always computed from the
 * maturity, never from the previous (clamped) date, so a 31st does not drift.
 */
function regularDateBefore(schedule: RegularDates, steps: number): string {
  const shifted = addMonthsClamped(
    schedule.maturityDate,
    -steps * schedule.couponMonths,
  );
  return schedule.endOfMonth ? endOfMonthOf(shifted) : shifted;
}

/**
 * Every regular coupon date from the last one on or before `datedDate` to the
 * maturity, oldest first.
 */
function regularDates(schedule: RegularDates): readonly string[] {
  const dates: string[] = [];
  for (let steps = 0; steps <= MAX_COUPON_PERIODS; steps += 1) {
    const date = regularDateBefore(schedule, steps);
    dates.push(date);
    if (compareYMD(date, schedule.datedDate) <= 0) return dates.reverse();
  }
  throw new CouponScheduleError(
    "datedDate",
    `more than ${MAX_COUPON_PERIODS} coupon periods`,
  );
}

/**
 * The first coupon date of a security whose source says only how long its first
 * period is: the first regular date after the dated date, or the one after that
 * for a long first coupon (the dated date then falls just before a regular date,
 * which the first payment skips). A short first coupon is the first regular date.
 */
export function firstRegularCouponDate(
  schedule: RegularDates,
  firstPeriod: "NORMAL" | "SHORT" | "LONG",
): string {
  const regular = regularDates(schedule);
  // regular[0] is on or before the dated date; regular[1] is the first after it.
  const index = firstPeriod === "LONG" ? 2 : 1;
  if (index >= regular.length) {
    throw new CouponScheduleError(
      "maturityDate",
      "no regular coupon date after the dated date",
    );
  }
  return regular[index];
}

function periodOf(
  index: number,
  start: string,
  end: string,
  coupon: CouponPeriodInfo,
): SchedulePeriod {
  return { index, start, end, days: daysBetween(start, end), coupon };
}

/**
 * The periods of a `COUPON_DATES` schedule (spec 5.1), whatever the lot: regular
 * dates are generated backwards from the maturity; period 1 runs from the dated
 * date to the first coupon date and is `REGULAR`, `SHORT` or `LONG` by where the
 * dated date falls against the regular date before the first coupon, with the
 * regular periods it overlaps as its quasi-coupon periods; every later period
 * runs between two regular dates. Throws `CouponScheduleError` when the first
 * coupon date is not a regular date.
 */
export function buildCouponSchedule(
  schedule: CouponDates,
): readonly SchedulePeriod[] {
  const { datedDate, firstCouponDate, maturityDate } = schedule;
  if (
    compareYMD(datedDate, firstCouponDate) >= 0 ||
    compareYMD(firstCouponDate, maturityDate) > 0
  ) {
    throw new CouponScheduleError(
      "firstCouponDate",
      "must be after the dated date and not after the maturity date",
    );
  }
  const regular = regularDates(schedule);
  const firstAt = regular.indexOf(firstCouponDate);
  if (firstAt < 1) {
    throw new CouponScheduleError(
      "firstCouponDate",
      "must be a regular coupon date, counted back from the maturity date",
    );
  }
  const quasi: QuasiPeriod[] = [];
  for (let i = 0; i < firstAt; i += 1) {
    if (compareYMD(regular[i + 1], datedDate) <= 0) continue;
    quasi.push({
      start: regular[i],
      end: regular[i + 1],
      from: compareYMD(regular[i], datedDate) < 0 ? datedDate : regular[i],
      to: regular[i + 1],
    });
  }
  const before = regular[firstAt - 1];
  const kind =
    datedDate === before
      ? "REGULAR"
      : compareYMD(datedDate, before) > 0
        ? "SHORT"
        : "LONG";
  const periods = [periodOf(1, datedDate, firstCouponDate, { kind, quasi })];
  for (let i = firstAt; i + 1 < regular.length; i += 1) {
    const [start, end] = [regular[i], regular[i + 1]];
    periods.push(
      periodOf(periods.length + 1, start, end, {
        kind: "REGULAR",
        quasi: [{ start, end, from: start, to: end }],
      }),
    );
  }
  return periods;
}

/**
 * The periods a lot bought on `purchaseDate` holds: those whose end is after it
 * (the coupon of the period it was bought in is paid in full), numbered from 1.
 * A purchase on or after the maturity keeps the last period, so the lot has a
 * maturity to be valued against.
 */
export function couponLotPeriods(
  schedule: CouponDates,
  purchaseDate: string,
): readonly SchedulePeriod[] {
  const all = buildCouponSchedule(schedule);
  const held = all.filter((p) => compareYMD(p.end, purchaseDate) > 0);
  return (held.length > 0 ? held : all.slice(-1)).map((p, i) => ({
    ...p,
    index: i + 1,
  }));
}
