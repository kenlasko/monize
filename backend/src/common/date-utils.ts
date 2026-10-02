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
 * A `Date` at LOCAL midnight on the calendar day `value` names.
 *
 * The shape a TypeORM `date` COLUMN needs. `DateUtils.mixedDateToDateString`
 * serializes a `Date` with `getFullYear/getMonth/getDate` -- local components --
 * so a UTC-midnight `Date` (which is what `new Date("2026-01-31")` gives you)
 * is written to the column as 2026-01-30 anywhere west of Greenwich. Verified
 * against TypeORM's own helper; a local-midnight `Date` and a plain
 * `"YYYY-MM-DD"` string both round-trip correctly in every offset.
 *
 * This is the OPPOSITE requirement to `formatDateYMD`, which reads UTC
 * components, so the two cannot share a convention: which one applies is decided
 * by where the value is going, not by where it came from. A value bound for a
 * `date` column goes through here; a value bound for a YMD string in a response
 * or a DTO goes through `formatDateYMD`.
 *
 * Accepts either spelling of a calendar day: a `YYYY-MM-DD` string, an ISO
 * timestamp (the day is taken from it), or a `Date` already carrying one.
 */
export function localDateForColumn(value: string | Date): Date {
  const [year, month, day] = (
    typeof value === "string" ? value.split("T")[0] : formatDateYMD(value)
  )
    .split("-")
    .map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Format a Date object as YYYY-MM-DD using its LOCAL components.
 *
 * Use this for values derived from local-time arithmetic (e.g. `new Date()`
 * representing "now" in the server's local time, or a Date built from local
 * year/month/day). It is distinct from `formatDateYMD` (UTC components) and
 * from `todayYMD` (request-timezone aware) -- replacing inline local-time
 * `${d.getFullYear()}-...` template literals with this preserves their exact
 * behavior without pulling in UTC or request-timezone semantics.
 */
export function formatDateYMDLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
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
 * Compute today's date as YYYY-MM-DD in the given IANA timezone, or, with `at`,
 * the calendar date that instant falls on in that zone.
 * Returns null if the timezone is invalid.
 */
export function todayInTimezone(
  timezone: string,
  at: Date = new Date(),
): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(at);
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

/**
 * Add whole days to a `YYYY-MM-DD` string, returning `YYYY-MM-DD`.
 *
 * Arithmetic in UTC on purpose: the input carries no time and no zone, so a
 * local-time step would shift the day either side of a DST boundary.
 */
export function addDaysYMD(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}
