/**
 * The month grid, as strings.
 *
 * Every function here takes and returns `YYYY-MM-DD` or `YYYY-MM` and does its
 * arithmetic on integers. Nothing constructs a `Date`: a `Date` built from a
 * calendar date is an instant in the browser's zone, so `new Date('2026-03-01')`
 * is the last day of February for a reader west of UTC, and a grid built from
 * one silently loses or repeats a day at the month boundary. The calendar's
 * days are calendar days, so they are never anything but strings here.
 *
 * `docs/future-plans/calendar-view.md` section 4 defines the grid; the dates
 * this is tested against are the table in `docs/testing-contract.md`.
 */

/** `0` is Sunday, as `user_preferences.week_starts_on` numbers the week. */
export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Where a grid day sits relative to the day the server calls today. */
export type CalendarDayPosition = 'past' | 'today' | 'future';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const DAYS_IN_COMMON_YEAR_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in `month` (1-12) of `year`, leap years included. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_COMMON_YEAR_MONTH[month - 1];
}

/**
 * A well-formed calendar date that actually exists.
 *
 * The pattern alone accepts `2100-02-29`, which is why the day is also checked
 * against the month's real length: 2100 is divisible by 4 and is not a leap
 * year, and the string is the only place that can be caught.
 */
export function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return day <= daysInMonth(year, month);
}

/** A well-formed `YYYY-MM`. */
export function isCalendarMonth(value: string): boolean {
  return MONTH_PATTERN.test(value);
}

function requireDate(value: string, argument: string): [number, number, number] {
  if (!isCalendarDate(value)) {
    throw new Error(`${argument} must be a calendar date (YYYY-MM-DD), received "${value}"`);
  }
  return value.split('-').map(Number) as [number, number, number];
}

function requireMonth(value: string, argument: string): [number, number] {
  if (!isCalendarMonth(value)) {
    throw new Error(`${argument} must be a calendar month (YYYY-MM), received "${value}"`);
  }
  return value.split('-').map(Number) as [number, number];
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function toDateString(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Days from 1970-01-01, by Howard Hinnant's civil-calendar algorithm.
 *
 * Only ever used to answer "which weekday is this", which is why it is not
 * exported: the grid is built by stepping days, not by converting back.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const shiftedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** The weekday of a calendar date, `0` Sunday through `6` Saturday. */
export function dayOfWeek(date: string): WeekStart {
  const [year, month, day] = requireDate(date, 'date');
  // 1970-01-01 was a Thursday, so the epoch offset is 4.
  return (((daysFromCivil(year, month, day) % 7) + 11) % 7) as WeekStart;
}

/** The day after `date`, rolling the month and the year. */
function nextDay(year: number, month: number, day: number): [number, number, number] {
  if (day < daysInMonth(year, month)) return [year, month, day + 1];
  if (month < 12) return [year, month + 1, 1];
  return [year + 1, 1, 1];
}

/** The day before `date`, rolling the month and the year. */
function previousDay(year: number, month: number, day: number): [number, number, number] {
  if (day > 1) return [year, month, day - 1];
  if (month > 1) return [year, month - 1, daysInMonth(year, month - 1)];
  return [year - 1, 12, 31];
}

/**
 * The whole weeks covering `month`, from the `weekStartsOn` day on or before
 * its 1st to the day before the next `weekStartsOn` day after its last.
 *
 * That is 35 or 42 days for almost every month, and 28 for a non-leap February
 * whose 1st falls on the week start -- four whole weeks already cover it, and
 * padding a fifth would put a week in the grid that neither the month nor the
 * week-completion rule asks for.
 */
export function monthGridDays(month: string, weekStartsOn: WeekStart): string[] {
  const [year, monthNumber] = requireMonth(month, 'month');

  const leading = (dayOfWeek(toDateString(year, monthNumber, 1)) - weekStartsOn + 7) % 7;
  const length = leading + daysInMonth(year, monthNumber);
  const total = Math.ceil(length / 7) * 7;

  let cursor: [number, number, number] = [year, monthNumber, 1];
  for (let step = 0; step < leading; step++) cursor = previousDay(...cursor);

  const days: string[] = [];
  for (let index = 0; index < total; index++) {
    days.push(toDateString(...cursor));
    cursor = nextDay(...cursor);
  }
  return days;
}

/**
 * `date` moved by `delta` whole days, in either direction, across month and
 * year ends.
 *
 * Integer arithmetic on the civil calendar, like everything else here: a
 * millisecond offset would be a day short or a day long across a daylight-saving
 * boundary, and the calendar's days are calendar days.
 */
export function shiftDate(date: string, delta: number): string {
  let cursor = requireDate(date, 'date');
  for (let step = 0; step < Math.abs(delta); step++) {
    cursor = delta > 0 ? nextDay(...cursor) : previousDay(...cursor);
  }
  return toDateString(...cursor);
}

/**
 * Inclusive whole days from `from` to `to`; `1` when they are the same day and
 * negative when `to` is the earlier of the two.
 */
export function calendarDaysBetween(from: string, to: string): number {
  const [fromYear, fromMonth, fromDay] = requireDate(from, 'from');
  const [toYear, toMonth, toDay] = requireDate(to, 'to');
  const span =
    daysFromCivil(toYear, toMonth, toDay) - daysFromCivil(fromYear, fromMonth, fromDay);
  return span >= 0 ? span + 1 : span - 1;
}

/**
 * Weekday labels rotated so the first is `weekStartsOn`.
 *
 * `common.weekdaysMin` is stored Sunday-first in every locale, so the rotation
 * is the only thing standing between a Monday-start user and a grid whose
 * headers disagree with its columns.
 */
export function rotateWeekdayLabels<T>(labels: readonly T[], weekStartsOn: WeekStart): T[] {
  return labels.map((_, index) => labels[(index + weekStartsOn) % labels.length]);
}

/** `month` moved by `delta` months, in either direction, across year ends. */
export function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = requireMonth(month, 'month');
  const zeroBased = year * 12 + (monthNumber - 1) + delta;
  const monthIndex = ((zeroBased % 12) + 12) % 12;
  return `${String((zeroBased - monthIndex) / 12).padStart(4, '0')}-${pad2(monthIndex + 1)}`;
}

/**
 * Months, numbered from `0001-01` as page 1, and back again.
 *
 * A swipe across the grid turns the month the way a swipe turns a register page,
 * and `useSwipeToPaginate` asks for the page it is on out of how many there are.
 * The months ARE those pages: `0001-01` to `9999-12`, the same range
 * `parseMonthInput` accepts, so every month a reader can type is a page the
 * gesture can reach and neither end of the range can be stepped off.
 */
export const CALENDAR_MONTH_PAGES = 9999 * 12;

/** `month` as its page number, 1 for `0001-01`. */
export function monthPageNumber(month: string): number {
  const [year, monthNumber] = requireMonth(month, 'month');
  return (year - 1) * 12 + monthNumber;
}

/** The month page `page` numbers, the inverse of {@link monthPageNumber}. */
export function monthFromPageNumber(page: number): string {
  if (!Number.isInteger(page) || page < 1 || page > CALENDAR_MONTH_PAGES) {
    throw new Error(
      `page must be a month page between 1 and ${CALENDAR_MONTH_PAGES}, received "${page}"`,
    );
  }
  const zeroBased = page - 1;
  const monthIndex = zeroBased % 12;
  return `${String((zeroBased - monthIndex) / 12 + 1).padStart(4, '0')}-${pad2(monthIndex + 1)}`;
}

/** The `YYYY-MM` a calendar date belongs to. */
export function monthOf(date: string): string {
  requireDate(date, 'date');
  return date.slice(0, 7);
}

/**
 * Where `date` sits relative to `today`.
 *
 * `today` has no default on purpose (design I2): the calendar's "projected"
 * captions are decided by the day the server is having, and a helper that
 * could fall back to the browser clock is a helper that eventually does.
 */
export function classifyCalendarDay(date: string, today: string): CalendarDayPosition {
  requireDate(date, 'date');
  requireDate(today, 'today');
  if (date < today) return 'past';
  if (date > today) return 'future';
  return 'today';
}
