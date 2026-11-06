import {
  addDays,
  dayOfWeek,
  daysInMonth,
  formatYMD,
  parseYMD,
} from "../../domain/calendar-date";
import { BusinessDayCalendar } from "../../domain/business-day-calendar";

/** The calendar id the US terms name in `schedule.calendarId`. */
export const US_CALENDAR_ID = "US";

const SUNDAY = 0;
const MONDAY = 1;
const THURSDAY = 4;
const SATURDAY = 6;

/** The `n`-th (1-based) `weekday` of a month. */
function nthWeekday(
  year: number,
  month: number,
  weekday: number,
  n: number,
): string {
  const offset = (weekday - dayOfWeek(formatYMD(year, month, 1)) + 7) % 7;
  return formatYMD(year, month, 1 + offset + 7 * (n - 1));
}

/** The last `weekday` of a month. */
function lastWeekday(year: number, month: number, weekday: number): string {
  const last = daysInMonth(year, month);
  const back = (dayOfWeek(formatYMD(year, month, last)) - weekday + 7) % 7;
  return formatYMD(year, month, last - back);
}

/**
 * The Federal Reserve Bank holidays of one year as the Banks observe them
 * (docs/specs/us-treasury-securities.md section 5): a holiday on a Sunday is
 * observed on the Monday after; a holiday on a Saturday is not observed on the
 * Friday before, the Banks are open. Juneteenth is a holiday from 2022.
 */
export function usHolidays(year: number): ReadonlySet<string> {
  const actual = [
    formatYMD(year, 1, 1),
    nthWeekday(year, 1, MONDAY, 3),
    nthWeekday(year, 2, MONDAY, 3),
    lastWeekday(year, 5, MONDAY),
    ...(year >= 2022 ? [formatYMD(year, 6, 19)] : []),
    formatYMD(year, 7, 4),
    nthWeekday(year, 9, MONDAY, 1),
    nthWeekday(year, 10, MONDAY, 2),
    formatYMD(year, 11, 11),
    nthWeekday(year, 11, THURSDAY, 4),
    formatYMD(year, 12, 25),
  ];
  return new Set(
    actual
      .filter((day) => dayOfWeek(day) !== SATURDAY)
      .map((day) => (dayOfWeek(day) === SUNDAY ? addDays(day, 1) : day)),
  );
}

export function isUsBusinessDay(date: string): boolean {
  const weekday = dayOfWeek(date);
  if (weekday === SUNDAY || weekday === SATURDAY) return false;
  return !usHolidays(parseYMD(date).year).has(date);
}

export const usCalendar: BusinessDayCalendar = {
  id: US_CALENDAR_ID,
  isBusinessDay: isUsBusinessDay,
};
