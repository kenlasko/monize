/**
 * Calendar arithmetic on `YYYY-MM-DD` parts, in UTC, shared by the fixed
 * frequencies (`recurrence.ts`) and the Custom rule (`custom-recurrence.ts`).
 * Its own module because `recurrence.ts` already imports `custom-recurrence.ts`.
 */

/** `YYYY-MM-DD` from a year, a month (1-12) and a day. */
export function formatYMD(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The days in `month` (1-12) of `year`. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
