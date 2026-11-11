import { addDaysYMD, formatMonthKey } from "@/common/date-utils";
import { addMonthsClamped, daysInMonth } from "@/common/recurrence";
import { isCalendarDate } from "@/common/validators/is-calendar-date.validator";

export { addMonthsClamped, daysInMonth };

const YMD_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export interface CalendarParts {
  year: number;
  month: number;
  day: number;
}

export function isValidYMD(value: unknown): value is string {
  return isCalendarDate(value);
}

export function parseYMD(value: string): CalendarParts {
  if (!isValidYMD(value)) {
    throw new RangeError(`Not a calendar date (YYYY-MM-DD): ${String(value)}`);
  }
  const match = YMD_PATTERN.exec(value)!;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

export function formatYMD(year: number, month: number, day: number): string {
  const p = (n: number, width: number) => String(n).padStart(width, "0");
  return `${p(year, 4)}-${p(month, 2)}-${p(day, 2)}`;
}

function toUtcMs(value: string): number {
  const { year, month, day } = parseYMD(value);
  return Date.UTC(year, month - 1, day);
}

/** Actual days from `from` (inclusive) to `to` (exclusive); negative if `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / MS_PER_DAY);
}

/**
 * Orders two dates that are already known to be valid `YYYY-MM-DD` strings: the
 * form sorts as text, so this is a plain comparison. It does not validate (the
 * hot path of a price series compares thousands of times); validate once at the
 * boundary with `isValidYMD` or `parseYMD`.
 */
export function compareYMD(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function addDays(value: string, days: number): string {
  parseYMD(value);
  return addDaysYMD(value, days);
}

/** Day of week, 0 = Sunday .. 6 = Saturday. */
export function dayOfWeek(value: string): number {
  return new Date(toUtcMs(value)).getUTCDay();
}

export function firstOfMonth(value: string): string {
  const { year, month } = parseYMD(value);
  return formatYMD(year, month, 1);
}

/** `YYYY-MM` of the month `months` before the month of `value`. */
export function monthKeyBefore(value: string, months: number): string {
  const { year, month } = parseYMD(value);
  const index = year * 12 + (month - 1) - months;
  return formatMonthKey(Math.floor(index / 12), (index % 12) + 1);
}

/** Every `YYYY-MM` from `from` to `to` inclusive, oldest first; empty when `to` is before `from`. */
export function enumerateMonthKeys(from: string, to: string): string[] {
  const start = parseYMD(`${from}-01`);
  const end = parseYMD(`${to}-01`);
  const last = end.year * 12 + (end.month - 1);
  const keys: string[] = [];
  for (let i = start.year * 12 + (start.month - 1); i <= last; i += 1) {
    keys.push(formatMonthKey(Math.floor(i / 12), (i % 12) + 1));
  }
  return keys;
}
