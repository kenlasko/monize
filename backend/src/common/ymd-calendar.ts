/**
 * Calendar arithmetic on `YYYY-MM-DD` parts, in UTC, shared by the fixed
 * frequencies (`recurrence.ts`) and the Custom rule (`custom-recurrence.ts`).
 * Its own module because `recurrence.ts` already imports `custom-recurrence.ts`.
 */

const YMD_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The year, month (1-12) and day of a `YYYY-MM-DD` string; throws on any other shape. */
export function parseYMD(ymd: string): { y: number; m: number; d: number } {
  const match = YMD_PATTERN.exec(ymd);
  if (!match) {
    throw new Error(`Invalid YYYY-MM-DD date string: ${ymd}`);
  }
  return {
    y: Number(match[1]),
    m: Number(match[2]),
    d: Number(match[3]),
  };
}

/** `YYYY-MM-DD` from a year, a month (1-12) and a day. */
export function formatYMD(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The days in `month` (1-12) of `year`. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
