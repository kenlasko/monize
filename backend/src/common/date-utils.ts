import { getRequestTimezone } from "./request-context";

/**
 * Format a Date object as YYYY-MM-DD string using UTC components.
 * Replaces the common `date.toISOString().split("T")[0]` pattern.
 * Uses UTC so that dates originating from ISO strings or database
 * DATE columns (which are parsed as UTC midnight) are not shifted
 * by the local timezone offset.
 */
export function formatDateYMD(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * True iff the given string is a non-empty, well-formed IANA timezone name.
 * Lets us reject the "browser" sentinel and obvious junk before persisting
 * or scheduling against it.
 */
export function isValidIanaTimezone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "browser") return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute today's date as YYYY-MM-DD in the given IANA timezone.
 * Returns null if the timezone is invalid.
 */
export function todayInTimezone(timezone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    if (!y || !m || !d) return null;
    return `${y}-${m}-${d}`;
  } catch {
    return null;
  }
}

/**
 * Return today's date as a YYYY-MM-DD string.
 * If a request-scoped timezone is set (via RequestContextInterceptor),
 * returns today in that timezone. Otherwise falls back to the server's
 * local date.
 */
export function todayYMD(): string {
  const tz = getRequestTimezone();
  if (tz) {
    const inTz = todayInTimezone(tz);
    if (inTz) return inTz;
  }
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Return the last day of the given month as YYYY-MM-DD.
 * Month is 1-based (1 = January, 12 = December).
 * Uses local date components because the Date is constructed
 * from local year/month values.
 */
export function getMonthEndYMD(year: number, month: number): string {
  // Day 0 of the *next* month gives the last day of `month`
  const lastDay = new Date(year, month, 0);
  const y = lastDay.getFullYear();
  const m = String(lastDay.getMonth() + 1).padStart(2, "0");
  const d = String(lastDay.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Return a YYYY-MM formatted string for the given year and month.
 * Month is 1-based (1 = January, 12 = December).
 */
export function formatMonthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Check if a transaction date is in the future (after today).
 * Future-dated transactions should not affect current account balances.
 */
export function isTransactionInFuture(transactionDate: string): boolean {
  return transactionDate > todayYMD();
}
