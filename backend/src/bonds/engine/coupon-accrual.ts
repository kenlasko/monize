import { compareYMD, daysBetween } from "../domain/calendar-date";
import { ExactDecimal } from "../domain/exact-decimal";
import { CouponPeriodInfo } from "../domain/period-schedule";
import type { UnitFigure } from "./rounding";

/**
 * The part of a `COUPON_DATES` period the accrual `ACTUAL_ACTUAL_ICMA` works on
 * (`docs/specs/bond-marketable-primitives.md` 5.2).
 */

/** A day range inside a period: what a period is asked to accrue between two days. */
export interface CouponAccrualPeriod {
  readonly start: string;
  readonly end: string;
  readonly coupon?: CouponPeriodInfo;
}

/**
 * The periods' worth of coupons earned from `from` to `to` inside `period`: for
 * each quasi-coupon period the period overlaps, the days elapsed of its days.
 * A regular period has one, so the whole period is exactly 1; a short first
 * period is days(dated, first) / days(quasi); a long one is the elapsed part of
 * the earlier quasi-period plus the whole of the later one; inside a long period
 * the elapsed fractions of each quasi-period entered add up (31 CFR 356 App. B
 * I.D, example 2: 44 of 181 days plus 81 of 184).
 */
export function quasiFractions(
  period: CouponAccrualPeriod,
  from: string,
  to: string,
): ExactDecimal {
  if (period.coupon === undefined) {
    throw new RangeError("ACTUAL_ACTUAL_ICMA needs a COUPON_DATES period");
  }
  let total = ExactDecimal.ZERO;
  for (const part of period.coupon.quasi) {
    const lo = compareYMD(from, part.from) > 0 ? from : part.from;
    const hi = compareYMD(to, part.to) < 0 ? to : part.to;
    if (compareYMD(hi, lo) <= 0) continue;
    total = total.add(
      ExactDecimal.ratio(
        daysBetween(lo, hi),
        daysBetween(part.start, part.end),
      ),
    );
  }
  return total;
}

/**
 * Which per-unit rounding a period's coupon takes (spec 5.3): a short or long
 * first coupon is rounded per unit to `unitDecimals` like an accrued interest; a
 * regular coupon is exact (`par x rate / F`) until the holding is rounded.
 */
export function couponFigure(period: CouponAccrualPeriod): UnitFigure {
  return period.coupon !== undefined && period.coupon.kind !== "REGULAR"
    ? "ACCRUED"
    : "AMOUNT";
}
