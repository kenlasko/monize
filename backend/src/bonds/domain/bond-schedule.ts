import { assertNever } from "./assert-never";
import { daysBetween, parseYMD } from "./calendar-date";
import {
  buildCouponSchedule,
  CouponScheduleError,
  endOfMonthOf,
} from "./period-schedule";
import type { BondTerms } from "./bond-terms";
import {
  BondTermsError,
  date,
  exact,
  flag,
  integer,
  Json,
  object,
  oneOf,
  text,
} from "./terms-readers";

/** Periods counted from each lot's purchase date. */
export interface LotAnchoredSchedule {
  readonly anchor: "LOT_PURCHASE_DATE";
  readonly periodMonths: number;
  readonly periodCount: number;
  readonly rollDay: "ANCHOR_DAY_CLAMPED";
  readonly calendarId: string;
}

/** One period from the series' issue date to its maturity date, whatever the lot's purchase date. */
export interface IssueDateSchedule {
  readonly anchor: "ISSUE_DATE";
  readonly issueDate: string;
  readonly maturityDate: string;
  readonly periodCount: 1;
  readonly calendarId: string;
}

/**
 * Coupon dates fixed by the series, whatever the lot
 * (`docs/specs/bond-marketable-primitives.md` 5.1): interest accrues from
 * `datedDate`, the first coupon is paid on `firstCouponDate` (a regular date,
 * counted back from `maturityDate` in steps of `couponMonths`), and a lot holds
 * the periods that end after its purchase. `endOfMonth` makes every regular date
 * the last day of its month; `NEXT_BUSINESS_DAY` pays a coupon on the next
 * business day of `calendarId` when its date is not one, with no extra interest.
 */
export interface CouponDatesSchedule {
  readonly anchor: "COUPON_DATES";
  readonly datedDate: string;
  readonly firstCouponDate: string;
  readonly maturityDate: string;
  readonly couponMonths: 3 | 6 | 12;
  readonly endOfMonth: boolean;
  readonly paymentAdjustment: "NONE" | "NEXT_BUSINESS_DAY";
  readonly calendarId: string;
}

export type BondSchedule =
  LotAnchoredSchedule | IssueDateSchedule | CouponDatesSchedule;

/**
 * The length of the schedule in whole months of `periodMonths` and a period
 * count; a single issue-to-maturity period is its whole months, at least one; a
 * coupon schedule is its coupon months and its number of periods.
 */
export function scheduleMonthsOf(schedule: BondSchedule): {
  readonly periodMonths: number;
  readonly periodCount: number;
} {
  switch (schedule.anchor) {
    case "LOT_PURCHASE_DATE":
      return {
        periodMonths: schedule.periodMonths,
        periodCount: schedule.periodCount,
      };
    case "ISSUE_DATE": {
      const from = parseYMD(schedule.issueDate);
      const to = parseYMD(schedule.maturityDate);
      const whole =
        (to.year - from.year) * 12 +
        (to.month - from.month) -
        (to.day < from.day ? 1 : 0);
      return { periodMonths: whole < 1 ? 1 : whole, periodCount: 1 };
    }
    case "COUPON_DATES":
      return {
        periodMonths: schedule.couponMonths,
        periodCount: buildCouponSchedule(schedule).length,
      };
    default:
      return assertNever(schedule);
  }
}

/**
 * The exact length in days of a schedule dated by the series (`ISSUE_DATE`: the
 * issue to the maturity; `COUPON_DATES`: the dated date to the maturity), or null
 * for a schedule counted in months (`LOT_PURCHASE_DATE`): a discount bill of 4
 * weeks is 28 days, not "1 month".
 */
export function scheduleDaysOf(schedule: BondSchedule): number | null {
  switch (schedule.anchor) {
    case "LOT_PURCHASE_DATE":
      return null;
    case "ISSUE_DATE":
      return daysBetween(schedule.issueDate, schedule.maturityDate);
    case "COUPON_DATES":
      return daysBetween(schedule.datedDate, schedule.maturityDate);
    default:
      return assertNever(schedule);
  }
}

/** A `COUPON_DATES` schedule: every field required, the dates ordered and the first coupon date a regular one. */
function parseCouponDates(value: unknown, path: string): CouponDatesSchedule {
  const s = object(value, path, [
    "anchor",
    "datedDate",
    "firstCouponDate",
    "maturityDate",
    "couponMonths",
    "endOfMonth",
    "paymentAdjustment",
    "calendarId",
  ]);
  const datedDate = date(s.datedDate, `${path}.datedDate`);
  const firstCouponDate = date(s.firstCouponDate, `${path}.firstCouponDate`);
  const maturityDate = date(s.maturityDate, `${path}.maturityDate`);
  if (datedDate >= firstCouponDate) {
    throw new BondTermsError(
      `${path}.firstCouponDate`,
      "must be after the dated date",
    );
  }
  if (firstCouponDate > maturityDate) {
    throw new BondTermsError(
      `${path}.maturityDate`,
      "must not be before the first coupon date",
    );
  }
  const couponMonths = integer(s.couponMonths, `${path}.couponMonths`, 1);
  if (couponMonths !== 3 && couponMonths !== 6 && couponMonths !== 12) {
    throw new BondTermsError(`${path}.couponMonths`, "must be one of 3, 6, 12");
  }
  const endOfMonth = flag(s.endOfMonth, `${path}.endOfMonth`);
  if (endOfMonth && endOfMonthOf(maturityDate) !== maturityDate) {
    throw new BondTermsError(
      `${path}.maturityDate`,
      "must be the last day of its month when endOfMonth is true",
    );
  }
  const schedule: CouponDatesSchedule = {
    anchor: "COUPON_DATES",
    datedDate,
    firstCouponDate,
    maturityDate,
    couponMonths,
    endOfMonth,
    paymentAdjustment: oneOf(s.paymentAdjustment, `${path}.paymentAdjustment`, [
      "NONE",
      "NEXT_BUSINESS_DAY",
    ] as const),
    calendarId: text(s.calendarId, `${path}.calendarId`),
  };
  try {
    buildCouponSchedule(schedule);
  } catch (error) {
    if (error instanceof CouponScheduleError) {
      throw new BondTermsError(`${path}.${error.field}`, error.message);
    }
    throw error;
  }
  return schedule;
}

export function parseSchedule(value: unknown, path: string): BondSchedule {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BondTermsError(path, "must be an object");
  }
  const anchor = oneOf((value as Json).anchor, `${path}.anchor`, [
    "LOT_PURCHASE_DATE",
    "ISSUE_DATE",
    "COUPON_DATES",
  ] as const);
  if (anchor === "COUPON_DATES") return parseCouponDates(value, path);
  if (anchor === "ISSUE_DATE") {
    const s = object(value, path, [
      "anchor",
      "issueDate",
      "maturityDate",
      "periodCount",
      "calendarId",
    ]);
    const issueDate = date(s.issueDate, `${path}.issueDate`);
    const maturityDate = date(s.maturityDate, `${path}.maturityDate`);
    if (issueDate >= maturityDate) {
      throw new BondTermsError(
        `${path}.maturityDate`,
        "must be after the issue date",
      );
    }
    return {
      anchor,
      issueDate,
      maturityDate,
      periodCount: exact(s.periodCount, `${path}.periodCount`, 1),
      calendarId: text(s.calendarId, `${path}.calendarId`),
    };
  }
  const s = object(value, path, [
    "anchor",
    "periodMonths",
    "periodCount",
    "rollDay",
    "calendarId",
  ]);
  const periodMonths = integer(s.periodMonths, `${path}.periodMonths`, 1);
  if (periodMonths > 12 || 12 % periodMonths !== 0) {
    throw new BondTermsError(`${path}.periodMonths`, "must divide 12");
  }
  return {
    anchor,
    periodMonths,
    periodCount: integer(s.periodCount, `${path}.periodCount`, 1),
    rollDay: oneOf(s.rollDay, `${path}.rollDay`, [
      "ANCHOR_DAY_CLAMPED",
    ] as const),
    calendarId: text(s.calendarId, `${path}.calendarId`),
  };
}

/** The first period of a coupon schedule is regular, short or long (`buildCouponSchedule`). */
function firstPeriodIsRegular(schedule: CouponDatesSchedule): boolean {
  return buildCouponSchedule(schedule)[0].coupon?.kind === "REGULAR";
}

/**
 * What a schedule anchor needs of the accrual, the rate rule and the
 * capitalization beside it. A coupon schedule pays each period's interest at its
 * end (capitalization `NONE`) and is not a discount; `ACTUAL_ACTUAL_ICMA` needs a
 * coupon schedule, and `ACTUAL_DAYS_IN_PERIOD` on one needs a regular first
 * period (it has no rule for a short or long one).
 */
export function assertScheduleConsistent(
  terms: Pick<
    BondTerms,
    "schedule" | "accrual" | "capitalization" | "rateRule"
  >,
): void {
  const { schedule, accrual, capitalization, rateRule } = terms;
  if (
    accrual.type === "ACTUAL_ACTUAL_ICMA" &&
    schedule.anchor !== "COUPON_DATES"
  ) {
    throw new BondTermsError(
      "terms.accrual",
      "ACTUAL_ACTUAL_ICMA needs a COUPON_DATES schedule",
    );
  }
  if (schedule.anchor !== "COUPON_DATES") return;
  if (rateRule.type === "ZERO_COUPON_DISCOUNT") {
    throw new BondTermsError(
      "terms.schedule.anchor",
      "a COUPON_DATES schedule is not for a ZERO_COUPON_DISCOUNT instrument",
    );
  }
  if (capitalization.type !== "NONE") {
    throw new BondTermsError(
      "terms.capitalization",
      "a COUPON_DATES schedule pays each coupon at its date (capitalization NONE)",
    );
  }
  if (
    accrual.type === "ACTUAL_DAYS_IN_PERIOD" &&
    !firstPeriodIsRegular(schedule)
  ) {
    throw new BondTermsError(
      "terms.accrual",
      "a short or long first period needs ACTUAL_ACTUAL_ICMA",
    );
  }
}
