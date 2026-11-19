import {
  CustomRecurrence,
  normalizeCustomRecurrence,
} from "../../../common/custom-recurrence";
import { addDaysYMD } from "../../../common/date-utils";
import { FREQUENCY_CYCLE_DAYS } from "../../../common/recurrence";
import { daysInMonth, formatYMD, parseYMD } from "../../../common/ymd-calendar";
import { FrequencyType } from "../../../scheduled-transactions/dto/create-scheduled-transaction.dto";

/**
 * Spec 5.10.2 and reference 11.2 / 11.4: a KMyMoney schedule's occurrence to a
 * Monize frequency, and KMyMoney's own date stepping (`MyMoneySchedule`:
 * `addMonths` clamping, `fixDate`, `addHalfMonths`).
 */

export const OCCURRENCE = {
  ONCE: 1,
  DAILY: 2,
  WEEKLY: 4,
  HALF_MONTH: 18,
  MONTHLY: 32,
  YEARLY: 16384,
} as const;

export interface NormalizedOccurrence {
  readonly base: number;
  readonly multiplier: number;
}

/** Legacy compound codes: base and the multiplier they stand for (reference 11.2). */
const LEGACY: ReadonlyMap<number, NormalizedOccurrence> = new Map([
  [8, { base: OCCURRENCE.WEEKLY, multiplier: 2 }],
  [16, { base: OCCURRENCE.WEEKLY, multiplier: 2 }],
  [20, { base: OCCURRENCE.WEEKLY, multiplier: 3 }],
  [30, { base: OCCURRENCE.DAILY, multiplier: 30 }],
  [64, { base: OCCURRENCE.WEEKLY, multiplier: 4 }],
  [126, { base: OCCURRENCE.WEEKLY, multiplier: 8 }],
  [128, { base: OCCURRENCE.MONTHLY, multiplier: 2 }],
  [256, { base: OCCURRENCE.MONTHLY, multiplier: 3 }],
  [4096, { base: OCCURRENCE.MONTHLY, multiplier: 3 }],
  [8192, { base: OCCURRENCE.MONTHLY, multiplier: 4 }],
  [1024, { base: OCCURRENCE.MONTHLY, multiplier: 6 }],
  [2048, { base: OCCURRENCE.YEARLY, multiplier: 2 }],
]);

const BASES: ReadonlySet<number> = new Set(Object.values(OCCURRENCE));

/** Base code and combined multiplier; null for an unknown code (an invalid schedule). */
export function normalizeOccurrence(
  code: number,
  multiplier: number,
): NormalizedOccurrence | null {
  const m = Math.max(1, Math.trunc(multiplier) || 1);
  if (BASES.has(code)) {
    return { base: code, multiplier: m };
  }
  const legacy = LEGACY.get(code);
  return legacy
    ? { base: legacy.base, multiplier: legacy.multiplier * m }
    : null;
}

export interface Cadence {
  readonly frequency: FrequencyType;
  readonly customRecurrence: CustomRecurrence | null;
  /** The exact interval cannot be expressed; the closest shorter one was used. */
  readonly approximate: boolean;
}

/** ISO weekday (1 Monday to 7 Sunday) of a date. */
export function isoWeekday(date: string): number {
  const { y, m, d } = parseYMD(date);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

function monthDay(date: string): string {
  return date.slice(5, 10);
}

/** The frequency with the largest cycle not longer than `days` (never missing an occurrence). */
function approximateByDays(days: number): FrequencyType {
  let best: FrequencyType = FrequencyType.DAILY;
  let bestCycle = 0;
  for (const [frequency, cycle] of Object.entries(FREQUENCY_CYCLE_DAYS)) {
    if (cycle > 0 && cycle <= days && cycle > bestCycle) {
      best = frequency as FrequencyType;
      bestCycle = cycle;
    }
  }
  return best;
}

function exact(frequency: FrequencyType): Cadence {
  return { frequency, customRecurrence: null, approximate: false };
}

function approximate(frequency: FrequencyType): Cadence {
  return { frequency, customRecurrence: null, approximate: true };
}

function custom(rule: CustomRecurrence, fallback: Cadence): Cadence {
  const normalized = normalizeCustomRecurrence(rule);
  return normalized.ok
    ? {
        frequency: FrequencyType.CUSTOM,
        customRecurrence: normalized.rule,
        approximate: false,
      }
    : fallback;
}

const MONTHLY_STANDARD: ReadonlyMap<number, FrequencyType> = new Map([
  [1, FrequencyType.MONTHLY],
  [2, FrequencyType.EVERY2MONTHS],
  [3, FrequencyType.QUARTERLY],
  [4, FrequencyType.EVERY4MONTHS],
  [6, FrequencyType.SEMIANNUAL],
  [12, FrequencyType.YEARLY],
  [24, FrequencyType.EVERY2YEARS],
]);

function monthly(m: number, due: string, lastDay: boolean): Cadence {
  const fallbackDays = (m * 365.25) / 12;
  const fallback = approximate(approximateByDays(fallbackDays));
  if (lastDay && m <= 12) {
    return custom({ unit: "MONTH", interval: m, monthDays: [-1] }, fallback);
  }
  const standard = MONTHLY_STANDARD.get(m);
  if (standard) {
    return exact(standard);
  }
  if (m === 5 || (m >= 7 && m <= 11)) {
    return custom(
      { unit: "MONTH", interval: m, monthDays: [parseYMD(due).d] },
      fallback,
    );
  }
  if (m % 12 === 0 && m >= 36 && m <= 144) {
    return custom(
      { unit: "YEAR", interval: m / 12, dates: [monthDay(due)] },
      fallback,
    );
  }
  return fallback;
}

/** Spec 5.10.2, for a schedule whose next due date is `due`. */
export function cadenceFor(
  occurrence: NormalizedOccurrence,
  due: string,
  lastDayInMonth: boolean,
): Cadence {
  const { base, multiplier: m } = occurrence;
  switch (base) {
    case OCCURRENCE.ONCE:
      return exact(FrequencyType.ONCE);
    case OCCURRENCE.DAILY: {
      const weekly: Record<number, FrequencyType> = {
        1: FrequencyType.DAILY,
        7: FrequencyType.WEEKLY,
        14: FrequencyType.BIWEEKLY,
        28: FrequencyType.EVERY4WEEKS,
      };
      if (weekly[m]) {
        return exact(weekly[m]);
      }
      if (m % 7 === 0 && m <= 84) {
        return custom(
          {
            unit: "WEEK",
            interval: m / 7,
            weekdays: [isoWeekday(due)],
            weekStartsOn: 1,
          },
          approximate(approximateByDays(m)),
        );
      }
      return approximate(approximateByDays(m));
    }
    case OCCURRENCE.WEEKLY: {
      const standard: Record<number, FrequencyType> = {
        1: FrequencyType.WEEKLY,
        2: FrequencyType.BIWEEKLY,
        4: FrequencyType.EVERY4WEEKS,
      };
      if (standard[m]) {
        return exact(standard[m]);
      }
      if (m === 3 || (m >= 5 && m <= 12)) {
        return custom(
          {
            unit: "WEEK",
            interval: m,
            weekdays: [isoWeekday(due)],
            weekStartsOn: 1,
          },
          approximate(approximateByDays(m * 7)),
        );
      }
      return approximate(approximateByDays(m * 7));
    }
    case OCCURRENCE.HALF_MONTH:
      if (m === 1) {
        return exact(FrequencyType.SEMIMONTHLY);
      }
      return m % 2 === 0
        ? monthly(m / 2, due, lastDayInMonth)
        : approximate(FrequencyType.SEMIMONTHLY);
    case OCCURRENCE.MONTHLY:
      return monthly(m, due, lastDayInMonth);
    default: {
      // Yearly
      if (m === 1) return exact(FrequencyType.YEARLY);
      if (m === 2) return exact(FrequencyType.EVERY2YEARS);
      if (m >= 3 && m <= 12) {
        return custom(
          { unit: "YEAR", interval: m, dates: [monthDay(due)] },
          approximate(FrequencyType.EVERY2YEARS),
        );
      }
      return approximate(FrequencyType.EVERY2YEARS);
    }
  }
}

// ---------------------------------------------------------------------------
// KMyMoney's own date stepping (reference 11.4)
// ---------------------------------------------------------------------------

/** Qt's `QDate::addMonths`: the day is clamped to the target month's length. */
export function addMonths(date: string, months: number): string {
  const { y, m, d } = parseYMD(date);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return formatYMD(year, month, Math.min(d, daysInMonth(year, month)));
}

export function lastDayOf(date: string): string {
  const { y, m } = parseYMD(date);
  return formatYMD(y, m, daysInMonth(y, m));
}

/** `MyMoneySchedule::addHalfMonths` for a positive multiplier. */
function addHalfMonths(date: string, multiplier: number): string {
  let current = date;
  let d = parseYMD(current).d;
  if (d <= 12) {
    const months = Math.floor(multiplier / 2);
    return multiplier % 2 === 0
      ? addMonths(current, months)
      : addDaysYMD(addMonths(current, months), 15);
  }
  for (let i = 0; i < multiplier; i += 1) {
    if (d <= 13) {
      current = addDaysYMD(current, 15);
    } else {
      const { y, m } = parseYMD(current);
      const dm = daysInMonth(y, m);
      if (d === 14) {
        current = addDaysYMD(current, dm < 30 ? dm - d : 15);
      } else if (d === 15) {
        current = addDaysYMD(current, dm - d);
      } else if (d === dm) {
        current = addMonths(addDaysYMD(current, 15 - d), 1);
      } else {
        current = addMonths(addDaysYMD(current, -15), 1);
      }
    }
    d = parseYMD(current).d;
  }
  return current;
}

/** `MyMoneySchedule::fixDate`: restore the start date's day where the month has it. */
function fixDate(
  date: string,
  startDate: string,
  lastDayInMonth: boolean,
): string {
  const start = lastDayInMonth ? lastDayOf(startDate) : startDate;
  const wanted = parseYMD(start).d;
  const { y, m, d } = parseYMD(date);
  return d !== wanted && wanted <= daysInMonth(y, m)
    ? formatYMD(y, m, wanted)
    : date;
}

/** The occurrence after `due`, or null for a Once schedule. */
export function stepOccurrence(
  due: string,
  occurrence: NormalizedOccurrence,
  startDate: string,
  lastDayInMonth: boolean,
): string | null {
  const { base, multiplier: m } = occurrence;
  switch (base) {
    case OCCURRENCE.DAILY:
      return addDaysYMD(due, m);
    case OCCURRENCE.WEEKLY:
      return addDaysYMD(due, 7 * m);
    case OCCURRENCE.HALF_MONTH:
      return addHalfMonths(due, m);
    case OCCURRENCE.MONTHLY:
      return fixDate(addMonths(due, m), startDate, lastDayInMonth);
    case OCCURRENCE.YEARLY:
      return fixDate(addMonths(due, 12 * m), startDate, lastDayInMonth);
    default:
      return null;
  }
}

const MAX_STEPS = 200_000;

/** The first occurrence after `lastPayment`, stepped from `startDate`; null when none. */
export function firstOccurrenceAfter(
  lastPayment: string,
  startDate: string,
  occurrence: NormalizedOccurrence,
  lastDayInMonth: boolean,
): string | null {
  let due: string | null = startDate;
  for (let steps = 0; due !== null && steps < MAX_STEPS; steps += 1) {
    if (due > lastPayment) {
      return due;
    }
    due = stepOccurrence(due, occurrence, startDate, lastDayInMonth);
  }
  return null;
}
