/**
 * Pure date math for credit-card statement cycles. Kept free of any database
 * or entity dependency so the cycle boundaries can be unit tested in isolation.
 *
 * All dates are handled as `YYYY-MM-DD` strings in a fixed (UTC) frame to avoid
 * timezone drift -- matching how PostgreSQL DATE columns are read elsewhere.
 */

export interface StatementCycleDates {
  /** First day of the current (open) cycle -- the previous settlement day. */
  cycleStart: string;
  /** Last day of the current cycle -- the day before the next settlement. */
  cycleEnd: string;
  /** The most recent settlement day on or before today (statement close). */
  lastSettlementDate: string;
  /** The next settlement day on or after today (when the current cycle closes). */
  nextSettlementDate: string;
  /** Whole days from today until the next settlement (>= 0). */
  daysUntilSettlement: number;
  /** Next payment due date (first `dueDay` on or after today), or null. */
  paymentDueDate: string | null;
  /** Whole days from today until the next payment due date (>= 0), or null. */
  daysUntilPaymentDue: number | null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function ymd(year: number, month0: number, day: number): string {
  return `${year}-${pad2(month0 + 1)}-${pad2(day)}`;
}

/** Days in a given month (month0 is 0-based). */
export function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** Clamp a day-of-month to the last valid day of the target month. */
function clampDay(year: number, month0: number, day: number): number {
  return Math.min(Math.max(day, 1), daysInMonth(year, month0));
}

/** Parse `YYYY-MM-DD` into a UTC-midnight Date. */
function parseYmd(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Whole days between two `YYYY-MM-DD` dates (b - a), never negative below 0. */
function diffDays(a: string, b: string): number {
  const ms = parseYmd(b).getTime() - parseYmd(a).getTime();
  return Math.round(ms / 86_400_000);
}

/** Shift a `YYYY-MM-DD` date by a whole number of days. */
function addDays(date: string, days: number): string {
  const dt = parseYmd(date);
  dt.setUTCDate(dt.getUTCDate() + days);
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
}

/**
 * First occurrence of `dayOfMonth` that is on or after `from` (inclusive),
 * clamping the target day to each month's length.
 */
function nextDayOfMonthOnOrAfter(from: string, dayOfMonth: number): string {
  const dt = parseYmd(from);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth();
  const d = dt.getUTCDate();
  const thisMonth = clampDay(y, m, dayOfMonth);
  if (d <= thisMonth) return ymd(y, m, thisMonth);
  const nm = new Date(Date.UTC(y, m + 1, 1));
  return ymd(
    nm.getUTCFullYear(),
    nm.getUTCMonth(),
    clampDay(nm.getUTCFullYear(), nm.getUTCMonth(), dayOfMonth),
  );
}

/** The same day-of-month one calendar month before `date`. */
function oneMonthBefore(date: string, dayOfMonth: number): string {
  const dt = parseYmd(date);
  const prev = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() - 1, 1));
  const y = prev.getUTCFullYear();
  const m = prev.getUTCMonth();
  return ymd(y, m, clampDay(y, m, dayOfMonth));
}

/**
 * Compute the statement-cycle boundaries for a credit card given its
 * settlement day, optional payment due day, and today's date.
 *
 * The current (open) cycle runs from the previous settlement day up to the day
 * before the next settlement. `paymentDueDate` is the next `dueDay` on or after
 * today, so its countdown is always forward-looking.
 */
export function computeStatementCycle(
  settlementDay: number,
  dueDay: number | null,
  today: string,
): StatementCycleDates {
  const nextSettlementDate = nextDayOfMonthOnOrAfter(today, settlementDay);
  const lastSettlementDate = oneMonthBefore(nextSettlementDate, settlementDay);
  const cycleStart = lastSettlementDate;
  const cycleEnd = addDays(nextSettlementDate, -1);
  const daysUntilSettlement = diffDays(today, nextSettlementDate);

  let paymentDueDate: string | null = null;
  let daysUntilPaymentDue: number | null = null;
  if (dueDay != null) {
    paymentDueDate = nextDayOfMonthOnOrAfter(today, dueDay);
    daysUntilPaymentDue = diffDays(today, paymentDueDate);
  }

  return {
    cycleStart,
    cycleEnd,
    lastSettlementDate,
    nextSettlementDate,
    daysUntilSettlement,
    paymentDueDate,
    daysUntilPaymentDue,
  };
}
