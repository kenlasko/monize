/**
 * The Custom frequency's rule and its stepping (docs/specs/custom-recurrence.md).
 *
 * Mirrored in `frontend/src/lib/custom-recurrence.ts`; the two specs carry the
 * same case table so both layers produce the same slots for the same rule.
 * Everything here works on `YYYY-MM-DD` strings in UTC arithmetic, like
 * `recurrence.ts`.
 */

import { daysInMonth, formatYMD } from "./ymd-calendar";

export type CustomRecurrenceUnit = "WEEK" | "MONTH" | "YEAR";

export const CUSTOM_RECURRENCE_UNITS: readonly CustomRecurrenceUnit[] = [
  "WEEK",
  "MONTH",
  "YEAR",
];

export const CUSTOM_INTERVAL_MAX = 12;
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

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

function parse(ymd: string): { y: number; m: number; d: number } {
  const match = YMD.exec(ymd);
  if (!match) throw new Error(`Invalid YYYY-MM-DD date string: ${ymd}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function dayNumber(ymd: string): number {
  const { y, m, d } = parse(ymd);
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

function fromDayNumber(n: number): string {
  const date = new Date(n * MS_PER_DAY);
  return formatYMD(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
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
 * The first rule date strictly after `ymd`. The interval counts periods from
 * the one containing `startDate` (absent: `ymd`'s own period).
 */
export function nextCustomDate(
  ymd: string,
  rawRule: CustomRecurrence | null | undefined,
  startDate?: string | null,
): string {
  const rule = requireRule(rawRule);
  const anchor = startDate ?? ymd;
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
    const { y, m } = parse(ymd);
    const s = parse(anchor);
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
    const { y } = parse(ymd);
    const startYear = parse(anchor).y;
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

/** The first rule date on or after `startDate`. */
export function firstCustomDate(
  startDate: string,
  rule: CustomRecurrence | null | undefined,
): string {
  return nextCustomDate(
    fromDayNumber(dayNumber(startDate) - 1),
    rule,
    startDate,
  );
}

/** True when `ymd` is one of the rule's dates. */
export function isCustomDate(
  ymd: string,
  rule: CustomRecurrence | null | undefined,
  startDate?: string | null,
): boolean {
  return (
    nextCustomDate(
      fromDayNumber(dayNumber(ymd) - 1),
      rule,
      startDate ?? ymd,
    ) === ymd
  );
}

/** Mean occurrences per year (section 4). */
export function customOccurrencesPerYear(
  rawRule: CustomRecurrence | null | undefined,
): number {
  const result = normalizeCustomRecurrence(rawRule);
  if (!result.ok) return 0;
  const rule = result.rule;
  if (rule.unit === "WEEK") {
    return ((rule.weekdays?.length ?? 0) * 365.25) / 7 / rule.interval;
  }
  if (rule.unit === "MONTH") {
    return ((rule.monthDays?.length ?? 0) * 12) / rule.interval;
  }
  return (rule.dates?.length ?? 0) / rule.interval;
}

/**
 * The shortest gap, in days, between consecutive rule dates, walked over four
 * years so a leap year and every month length are seen. `0` without a rule.
 */
export function customMinGapDays(
  rawRule: CustomRecurrence | null | undefined,
  startDate = "2024-01-01",
): number {
  const result = normalizeCustomRecurrence(rawRule);
  if (!result.ok) return 0;
  const rule = result.rule;
  const end = dayNumber(startDate) + 4 * 366 * rule.interval;
  let prev = firstCustomDate(startDate, rule);
  let min = Number.POSITIVE_INFINITY;
  for (let guard = 0; guard < 1500; guard++) {
    const next = nextCustomDate(prev, rule, startDate);
    if (dayNumber(next) > end) break;
    min = Math.min(min, dayNumber(next) - dayNumber(prev));
    prev = next;
  }
  return Number.isFinite(min) ? min : 365 * rule.interval;
}
