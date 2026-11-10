/**
 * The calendar arithmetic of a payroll deduction rule's reset, mirrored from
 * `backend/src/payroll-deductions/payroll-deduction-period.ts`
 * (docs/specs/payroll-deductions.md decision 4 and section 11), as pure
 * functions over `YYYY-MM-DD` strings. The form uses it to name the current
 * and next periods before the server has answered for a new rule.
 */

/** How long before a reset the next period's figures open, in calendar months. */
export const NEXT_PERIOD_WINDOW_MONTHS = 2;

export interface PayrollPeriod {
  periodStart: string;
  periodEnd: string;
  nextResetOn: string;
}

const pad = (value: number) => String(value).padStart(2, '0');

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The anniversary of `resetDate`'s month and day in `year`, a 29 February clamped. */
export function anniversaryInYear(resetDate: string, year: number): string {
  const [, month, day] = resetDate.split('-').map(Number);
  return `${year}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`;
}

function previousDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d - 1));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** The period containing `asOf` for a rule anchored on `resetDate`. */
export function payrollPeriodOf(resetDate: string, asOf: string): PayrollPeriod {
  const year = Number(asOf.slice(0, 4));
  const thisYear = anniversaryInYear(resetDate, year);
  const periodStart = thisYear <= asOf ? thisYear : anniversaryInYear(resetDate, year - 1);
  const nextResetOn = anniversaryInYear(resetDate, Number(periodStart.slice(0, 4)) + 1);
  return { periodStart, periodEnd: previousDay(nextResetOn), nextResetOn };
}

/** `ymd` moved back by `months` calendar months, the day clamped to the month. */
function subtractMonths(ymd: string, months: number): string {
  const [year, month, day] = ymd.split('-').map(Number);
  const index = year * 12 + (month - 1) - months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${y}-${pad(m)}-${pad(Math.min(day, daysInMonth(y, m)))}`;
}

/**
 * Whether `today` falls in the months before `nextResetOn` in which the reset
 * reminder asks for the next period's figures (decision 8).
 */
export function nextPeriodWindowOpen(nextResetOn: string, today: string): boolean {
  return today >= subtractMonths(nextResetOn, NEXT_PERIOD_WINDOW_MONTHS) && today < nextResetOn;
}
