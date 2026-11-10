import { todayYMD } from "../common/date-utils";

/**
 * Shared utility for computing budget period date ranges.
 * Centralizes the period date calculation used across multiple budget services.
 */

export interface PeriodDateRange {
  periodStart: string;
  periodEnd: string;
}

/**
 * Returns the start and end dates for the current calendar month
 * in YYYY-MM-DD format, using the request's (or cron's) timezone via
 * `todayYMD()` rather than the server's UTC clock -- otherwise the current
 * period flips a day early or late for anyone not on UTC.
 */
export function getCurrentMonthPeriodDates(): PeriodDateRange {
  const [year, month] = todayYMD().split("-").map(Number);
  return getMonthPeriodDates(year, month - 1);
}

/**
 * Returns the start and end dates for a specific calendar month.
 * @param year - Full year (e.g. 2026)
 * @param monthIndex - Zero-based month index (0 = January, 11 = December)
 */
export function getMonthPeriodDates(
  year: number,
  monthIndex: number,
): PeriodDateRange {
  const month = monthIndex + 1;
  const lastDay = new Date(year, month, 0).getDate();

  const periodStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const periodEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  return { periodStart, periodEnd };
}

/**
 * Returns the start and end dates for the previous calendar month
 * relative to today, in the request's (or cron's) timezone (see
 * `getCurrentMonthPeriodDates`).
 */
export function getPreviousMonthPeriodDates(): PeriodDateRange {
  const [year, month] = todayYMD().split("-").map(Number);
  // `month` is 1-based; `Date.UTC(year, month - 2, 1)` steps back one month
  // using pure calendar arithmetic (rolling the year at January), with no
  // dependency on the server's own timezone.
  const prevMonth = new Date(Date.UTC(year, month - 2, 1));
  return getMonthPeriodDates(
    prevMonth.getUTCFullYear(),
    prevMonth.getUTCMonth(),
  );
}

/**
 * The calendar month after the one `periodEnd` (YYYY-MM-DD) falls in: the
 * period that follows a closed one. Derived from the closed period, never from
 * the wall clock, so a close before the period ends (or a cron that runs late)
 * still opens the next month rather than colliding with the month it closed
 * (audit A26-L38).
 */
export function getFollowingMonthPeriodDates(
  periodEnd: string,
): PeriodDateRange {
  const [year, month] = periodEnd.split("-").map(Number);
  // `month` is 1-based, so as a zero-based index it already names the next one.
  const next = new Date(Date.UTC(year, month, 1));
  return getMonthPeriodDates(next.getUTCFullYear(), next.getUTCMonth());
}

/**
 * Parses a YYYY-MM string and returns the corresponding period dates.
 * Returns null if the format is invalid.
 */
export function parsePeriodFromYYYYMM(
  yearMonth: string,
): PeriodDateRange | null {
  const match = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!match) return null;

  const year = parseInt(match[1], 10);
  const monthIndex = parseInt(match[2], 10) - 1;

  if (monthIndex < 0 || monthIndex > 11) return null;

  return getMonthPeriodDates(year, monthIndex);
}
