/**
 * The Custom frequency's rule and its stepping (docs/specs/custom-recurrence.md).
 *
 * Mirrored in `frontend/src/lib/custom-recurrence.ts`; the two specs carry the
 * same case table so both layers produce the same slots for the same rule.
 * Everything here works on `YYYY-MM-DD` strings in UTC arithmetic, like
 * `recurrence.ts`.
 */

import { addDaysYMD, formatDateYMD } from "./date-utils";
import { daysInMonth, formatYMD, parseYMD } from "./ymd-calendar";

export type CustomRecurrenceUnit = "WEEK" | "MONTH" | "YEAR";

const CUSTOM_RECURRENCE_UNITS: readonly CustomRecurrenceUnit[] = [
  "WEEK",
  "MONTH",
  "YEAR",
];

const CUSTOM_INTERVAL_MAX = 12;
/** `-1` in `monthDays`: the month's last day, whatever its length. */
export const LAST_DAY_OF_MONTH = -1;

export interface CustomRecurrence {
  unit: CustomRecurrenceUnit;
  interval: number;
  /** WEEK: ISO weekdays, 1 = Monday ... 7 = Sunday. */
  weekdays?: number[];
  /** WEEK: 0 = Sunday ... 6 = Saturday; where a week begins when `interval > 1`. */
  weekStartsOn?: number;
  /** MONTH: 1-31, or `LAST_DAY_OF_MONTH`. */
  monthDays?: number[];
  /** YEAR: `MM-DD`. */
  dates?: string[];
}

/** What the stepper needs beside the date: the rule and the period anchor. */
export interface CustomStepContext {
  rule: CustomRecurrence | null | undefined;
  startDate?: string | null;
}

export type CustomRecurrenceError =
  | "notAnObject"
  | "unit"
  | "interval"
  | "weekdays"
  | "weekStartsOn"
  | "monthDays"
  | "dates"
  | "extraField";

export type NormalizeResult =
  | { ok: true; rule: CustomRecurrence }
  | { ok: false; error: CustomRecurrenceError };

const MM_DD = /^(\d{2})-(\d{2})$/;
/** Days per month in a leap year: the widest a `MM-DD` may be. */
const LEAP_MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const ALLOWED_FIELDS: Record<CustomRecurrenceUnit, readonly string[]> = {
  WEEK: ["unit", "interval", "weekdays", "weekStartsOn"],
  MONTH: ["unit", "interval", "monthDays"],
  YEAR: ["unit", "interval", "dates"],
};

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * The canonical rule for `raw`, or why it is not one. Only the unit's own field
 * is kept; arrays come back de-duplicated and sorted (`-1` last). Both the DTO
 * validator and the stepper go through here, so an accepted rule always steps.
 */
export function normalizeCustomRecurrence(raw: unknown): NormalizeResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "notAnObject" };
  }
  const input = raw as Record<string, unknown>;
  const unit = input.unit;
  if (
    typeof unit !== "string" ||
    !CUSTOM_RECURRENCE_UNITS.includes(unit as CustomRecurrenceUnit)
  ) {
    return { ok: false, error: "unit" };
  }
  const typedUnit = unit as CustomRecurrenceUnit;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS[typedUnit].includes(key)) {
      return { ok: false, error: "extraField" };
    }
  }
  const interval = input.interval ?? 1;
  if (!isInt(interval) || interval < 1 || interval > CUSTOM_INTERVAL_MAX) {
    return { ok: false, error: "interval" };
  }

  if (typedUnit === "WEEK") {
    const days = input.weekdays;
    if (
      !Array.isArray(days) ||
      days.length < 1 ||
      days.length > 7 ||
      !days.every((d) => isInt(d) && d >= 1 && d <= 7)
    ) {
      return { ok: false, error: "weekdays" };
    }
    const weekStartsOn = input.weekStartsOn ?? 1;
    if (!isInt(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) {
      return { ok: false, error: "weekStartsOn" };
    }
    return {
      ok: true,
      rule: {
        unit: "WEEK",
        interval,
        weekdays: uniqueSorted(days as number[]),
        weekStartsOn,
      },
    };
  }

  if (typedUnit === "MONTH") {
    const days = input.monthDays;
    if (
      !Array.isArray(days) ||
      days.length < 1 ||
      days.length > 32 ||
      !days.every(
        (d) => isInt(d) && ((d >= 1 && d <= 31) || d === LAST_DAY_OF_MONTH),
      )
    ) {
      return { ok: false, error: "monthDays" };
    }
    const sorted = uniqueSorted(days as number[]);
    const monthDays = sorted.includes(LAST_DAY_OF_MONTH)
      ? [...sorted.filter((d) => d !== LAST_DAY_OF_MONTH), LAST_DAY_OF_MONTH]
      : sorted;
    return { ok: true, rule: { unit: "MONTH", interval, monthDays } };
  }

  const dates = input.dates;
  if (
    !Array.isArray(dates) ||
    dates.length < 1 ||
    dates.length > 366 ||
    !dates.every((d) => {
      if (typeof d !== "string") return false;
      const match = MM_DD.exec(d);
      if (!match) return false;
      const month = Number(match[1]);
      const day = Number(match[2]);
      return (
        month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <= LEAP_MONTH_DAYS[month - 1]
      );
    })
  ) {
    return { ok: false, error: "dates" };
  }
  return {
    ok: true,
    rule: {
      unit: "YEAR",
      interval,
      dates: [...new Set(dates as string[])].sort(),
    },
  };
}

// --- calendar arithmetic on YYYY-MM-DD, UTC -------------------------------

const MS_PER_DAY = 86_400_000;

function dayNumber(ymd: string): number {
  const { y, m, d } = parseYMD(ymd);
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

function fromDayNumber(n: number): string {
  return formatDateYMD(new Date(n * MS_PER_DAY));
}

/** `n mod k` that is never negative. */
function mod(n: number, k: number): number {
  return ((n % k) + k) % k;
}

/** ISO weekday (1 = Monday) of a day number. 1970-01-01 was a Thursday. */
function isoWeekday(n: number): number {
  return mod(n + 3, 7) + 1;
}

/** JS weekday (0 = Sunday) of a day number. */
function jsWeekday(n: number): number {
  return mod(n + 4, 7);
}

/** The rule's dates in month `m` of year `y`, ascending, collisions merged. */
function monthDates(y: number, m: number, monthDays: number[]): string[] {
  const len = daysInMonth(y, m);
  const days = new Set(
    monthDays.map((d) => (d === LAST_DAY_OF_MONTH ? len : Math.min(d, len))),
  );
  return [...days].sort((a, b) => a - b).map((d) => formatYMD(y, m, d));
}

/** The rule's dates in year `y`, ascending; 29 February clamps to the 28th. */
function yearDates(y: number, dates: string[]): string[] {
  const out = new Set<string>();
  for (const md of dates) {
    const [mm, dd] = md.split("-").map(Number);
    out.add(formatYMD(y, mm, Math.min(dd, daysInMonth(y, mm))));
  }
  return [...out].sort();
}

function requireRule(
  rule: CustomRecurrence | null | undefined,
): CustomRecurrence {
  const result = normalizeCustomRecurrence(rule);
  if (!result.ok) {
    throw new Error(
      `CUSTOM frequency without a valid rule (${result.error}); a schedule that cannot step would repeat one date`,
    );
  }
  return result.rule;
}

/**
 * The stepper over an already-normalized `rule`: the first rule date strictly
 * after `ymd`, periods counted from `anchor`'s. The exported entry points
 * normalize once and call this, so the rule is checked once per call or walk,
 * never once per day scanned.
 */
function stepAfter(
  ymd: string,
  rule: CustomRecurrence,
  anchor: string,
): string {
  const after = dayNumber(ymd);

  if (rule.unit === "WEEK") {
    const weekdays = new Set(rule.weekdays);
    const startN = dayNumber(anchor);
    const weekStart =
      startN - mod(jsWeekday(startN) - (rule.weekStartsOn ?? 1), 7);
    // One full active week lies within interval weeks of any day, plus the rest
    // of the current one.
    const limit = 7 * (rule.interval + 1);
    for (let n = after + 1; n <= after + limit; n++) {
      const week = Math.floor((n - weekStart) / 7);
      if (mod(week, rule.interval) === 0 && weekdays.has(isoWeekday(n))) {
        return fromDayNumber(n);
      }
    }
  } else if (rule.unit === "MONTH") {
    const { y, m } = parseYMD(ymd);
    const s = parseYMD(anchor);
    const startIndex = s.y * 12 + (s.m - 1);
    for (let k = 0; k <= rule.interval + 1; k++) {
      const index = y * 12 + (m - 1) + k;
      if (mod(index - startIndex, rule.interval) !== 0) continue;
      const yy = Math.floor(index / 12);
      const mm = mod(index, 12) + 1;
      for (const date of monthDates(yy, mm, rule.monthDays ?? [])) {
        if (date > ymd) return date;
      }
    }
  } else {
    const { y } = parseYMD(ymd);
    const startYear = parseYMD(anchor).y;
    for (let k = 0; k <= rule.interval + 1; k++) {
      const yy = y + k;
      if (mod(yy - startYear, rule.interval) !== 0) continue;
      for (const date of yearDates(yy, rule.dates ?? [])) {
        if (date > ymd) return date;
      }
    }
  }
  // Unreachable for a normalized rule: every unit has a date within the bounds.
  throw new Error(
    `nextCustomDate: no date after ${ymd} for ${JSON.stringify(rule)}`,
  );
}

/**
 * The first rule date strictly after `ymd`. The interval counts periods from
 * the one containing `startDate` (absent: `ymd`'s own period).
 */
export function nextCustomDate(
  ymd: string,
  rawRule: CustomRecurrence | null | undefined,
  startDate?: string | null,
): string {
  return stepAfter(ymd, requireRule(rawRule), startDate ?? ymd);
}

/**
 * `ymd` when it is one of the rule's dates, else the first rule date after it;
 * the interval's periods count from the one containing `startDate` (absent:
 * `ymd`'s own). The date a write snaps `next_due_date` to (spec section 5).
 */
export function customDateOnOrAfter(
  ymd: string,
  rawRule: CustomRecurrence | null | undefined,
  startDate?: string | null,
): string {
  return stepAfter(addDaysYMD(ymd, -1), requireRule(rawRule), startDate ?? ymd);
}

/**
 * One rule's stepper for a walk: the rule is normalized here, once, and each
 * call is `nextCustomDate(ymd, rule, startDate)` without normalizing again.
 * Throws without a valid rule, as `nextCustomDate` does.
 */
export function customStepper(
  rawRule: CustomRecurrence | null | undefined,
  startDate?: string | null,
): (ymd: string) => string {
  const rule = requireRule(rawRule);
  return (ymd) => stepAfter(ymd, rule, startDate ?? ymd);
}

/** Four calendar years, one of them a leap year: every month length is seen. */
const CADENCE_YEARS = [2024, 2025, 2026, 2027];

/**
 * Mean occurrences per year (section 4), counting distinct dates: days of the
 * month or dates of the year that land on one date in a short month or a
 * common year are one occurrence, so `[31, -1]` is 12 a year, not 24. Weekdays
 * cannot collide, so a weekly rule is its weekday count over the mean year.
 * `0` without a valid rule.
 */
export function customOccurrencesPerYear(
  rawRule: CustomRecurrence | null | undefined,
): number {
  const result = normalizeCustomRecurrence(rawRule);
  if (!result.ok) return 0;
  const rule = result.rule;
  if (rule.unit === "WEEK") {
    return ((rule.weekdays?.length ?? 0) * 365.25) / 7 / rule.interval;
  }
  let count = 0;
  for (const y of CADENCE_YEARS) {
    if (rule.unit === "MONTH") {
      for (let m = 1; m <= 12; m++) {
        count += monthDates(y, m, rule.monthDays ?? []).length;
      }
    } else {
      count += yearDates(y, rule.dates ?? []).length;
    }
  }
  return count / CADENCE_YEARS.length / rule.interval;
}

/** Bound on `customMinGapDays`'s memo: a user has few distinct rules. */
const MIN_GAP_MEMO_LIMIT = 64;
const minGapMemo = new Map<string, number>();

/**
 * The shortest gap, in days, between consecutive rule dates, walked over four
 * years so a leap year and every month length are seen. `0` without a rule.
 * Memoized per canonical rule and start date: the trade match asks it of every
 * Custom schedule it weighs, and the answer never changes.
 */
export function customMinGapDays(
  rawRule: CustomRecurrence | null | undefined,
  startDate = "2024-01-01",
): number {
  const result = normalizeCustomRecurrence(rawRule);
  if (!result.ok) return 0;
  const rule = result.rule;
  const key = `${startDate}|${JSON.stringify(rule)}`;
  const known = minGapMemo.get(key);
  if (known !== undefined) return known;

  const end = dayNumber(startDate) + 4 * 366 * rule.interval;
  let prev = stepAfter(addDaysYMD(startDate, -1), rule, startDate);
  let prevN = dayNumber(prev);
  let min = Number.POSITIVE_INFINITY;
  for (let guard = 0; guard < 1500; guard++) {
    const next = stepAfter(prev, rule, startDate);
    const nextN = dayNumber(next);
    if (nextN > end) break;
    min = Math.min(min, nextN - prevN);
    prev = next;
    prevN = nextN;
  }
  const gap = Number.isFinite(min) ? min : 365 * rule.interval;

  if (minGapMemo.size >= MIN_GAP_MEMO_LIMIT) {
    // Oldest first: a Map iterates in insertion order.
    minGapMemo.delete(minGapMemo.keys().next().value as string);
  }
  minGapMemo.set(key, gap);
  return gap;
}
