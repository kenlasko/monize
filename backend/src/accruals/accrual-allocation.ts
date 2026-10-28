import { isCalendarDate } from "../common/validators/is-calendar-date.validator";
import {
  accrualAllocationQuantum,
  formatAccrualMoney,
  parseAccrualMoney,
} from "./accrual-money";

export const MAX_ACCRUAL_MONTHS = 600;
/**
 * How a period's recognition date lands within its month. Month-end is the
 * original, drift-free behaviour (computed fresh from the calendar each
 * time, never stepped from a prior date, so it never suffers the 29/30/31
 * drift of monize#1857). First-business-day is the newer option WMP asked
 * for, scoped to accrual recognition only -- the shared recurrence engine
 * behind #1857 is untouched.
 */
export type AccrualDateRule = "MONTH_END" | "FIRST_BUSINESS_DAY";
export type AccrualPeriod =
  | { readonly preset: "LTM" | "NTM"; readonly dateRule?: AccrualDateRule }
  | {
      readonly preset: "CUSTOM";
      readonly startMonth: string;
      readonly monthCount: number;
      readonly dateRule?: AccrualDateRule;
    };

export interface AccrualAllocation {
  readonly periodIndex: number;
  readonly recognitionDate: string;
  readonly amount: string;
}
export interface AccrualPlan {
  readonly startMonth: string;
  readonly monthCount: number;
  readonly amount: string;
  readonly allocations: readonly AccrualAllocation[];
}

function monthIndex(month: string): number {
  if (
    typeof month !== "string" ||
    !/^\d{4}-\d{2}$/.test(month) ||
    month.startsWith("0000") ||
    !isCalendarDate(`${month}-01`)
  ) {
    throw new Error("Invalid accrual month");
  }
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1;
}

function monthAt(index: number): string {
  const year = Math.floor(index / 12);
  if (year < 1 || year > 9999) throw new Error("Accrual month out of range");
  return `${String(year).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function monthEnd(index: number): string {
  const month = monthAt(index);
  const year = Math.floor(index / 12);
  const calendarMonth = (index % 12) + 1;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days =
    calendarMonth === 2
      ? leap
        ? 29
        : 28
      : [4, 6, 9, 11].includes(calendarMonth)
        ? 30
        : 31;
  return `${month}-${days}`;
}

/**
 * The first weekday (Mon-Fri) of the month, with no holiday calendar: day 1
 * if it falls Mon-Fri, otherwise the following Monday (day 2 or 3).
 */
function firstBusinessDay(index: number): string {
  const month = monthAt(index);
  const year = Math.floor(index / 12);
  const calendarMonth = (index % 12) + 1;
  // Civil-to-Julian-day-number (Howard Hinnant's algorithm), independent of
  // the host's Date/timezone handling -- the same determinism buildAccrualPlan
  // already relies on for monthEnd. Gives day 1's ISO weekday (1=Mon..7=Sun).
  const a = Math.floor((14 - calendarMonth) / 12);
  const y = year + 4800 - a;
  const m = calendarMonth + 12 * a - 3;
  const jdn =
    1 +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045;
  const day1Isodow = (jdn % 7) + 1;
  // Day 1 on a weekday is itself the first business day; a Saturday pushes
  // to day 3 (Monday), a Sunday to day 2 (Monday) -- the only two days a
  // month can ever start on and not already be a business day.
  const day = day1Isodow <= 5 ? 1 : day1Isodow === 6 ? 3 : 2;
  return `${month}-${String(day).padStart(2, "0")}`;
}

/** A bounded, deterministic plan shared by future preview and commit callers. */
export function buildAccrualPlan(
  paymentDate: string,
  amount: string,
  currencyDecimals: number,
  period: AccrualPeriod,
): AccrualPlan {
  if (!isCalendarDate(paymentDate) || paymentDate.startsWith("0000")) {
    throw new Error("Invalid accrual payment date");
  }
  const paymentMonth = monthIndex(paymentDate.slice(0, 7));
  let start: number;
  let count: number;
  if (period.preset === "CUSTOM") {
    start = monthIndex(period.startMonth);
    count = period.monthCount;
  } else if (period.preset === "LTM" || period.preset === "NTM") {
    start = paymentMonth - (period.preset === "LTM" ? 11 : 0);
    count = 12;
  } else {
    throw new Error("Invalid accrual preset");
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_ACCRUAL_MONTHS) {
    throw new Error("Invalid accrual month count");
  }
  const startMonth = monthAt(start);
  monthAt(start + count - 1);
  const units = parseAccrualMoney(amount);
  const quantum = accrualAllocationQuantum(units, currencyDecimals);
  const regular = (units / quantum / BigInt(count)) * quantum;
  const recognitionDateOf =
    period.dateRule === "FIRST_BUSINESS_DAY" ? firstBusinessDay : monthEnd;
  const allocations = Array.from({ length: count }, (_, periodIndex) => ({
    periodIndex,
    recognitionDate: recognitionDateOf(start + periodIndex),
    amount: formatAccrualMoney(
      periodIndex === count - 1 ? units - regular * BigInt(count - 1) : regular,
    ),
  }));
  return {
    startMonth,
    monthCount: count,
    amount: formatAccrualMoney(units),
    allocations,
  };
}
