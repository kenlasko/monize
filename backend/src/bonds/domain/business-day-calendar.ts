import { addDays } from "./calendar-date";

/** A country's working-day rule; supplied by an adapter, never known to the engine. */
export interface BusinessDayCalendar {
  readonly id: string;
  isBusinessDay(ymd: string): boolean;
}

/** The n-th business day strictly before `date` (n >= 1). */
export function nthBusinessDayBefore(
  calendar: BusinessDayCalendar,
  date: string,
  n: number,
): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`Invalid business day count: ${n}`);
  }
  let cursor = date;
  let counted = 0;
  while (counted < n) {
    cursor = addDays(cursor, -1);
    if (calendar.isBusinessDay(cursor)) counted += 1;
  }
  return cursor;
}

/** A calendar with no business day in this many days is not a calendar. */
const MAX_SEARCH_DAYS = 366;

/** `date` when it is a business day, else the next business day after it. */
export function nextBusinessDayOnOrAfter(
  calendar: BusinessDayCalendar,
  date: string,
): string {
  let cursor = date;
  for (let i = 0; i <= MAX_SEARCH_DAYS; i += 1) {
    if (calendar.isBusinessDay(cursor)) return cursor;
    cursor = addDays(cursor, 1);
  }
  throw new RangeError(
    `Calendar ${calendar.id} has no business day within ${MAX_SEARCH_DAYS} days of ${date}`,
  );
}
