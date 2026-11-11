import { CustomStepContext, nextCustomDate } from "./custom-recurrence";
import { daysInMonth, formatYMD } from "./ymd-calendar";

export { daysInMonth };

export type FrequencyType =
  | "ONCE"
  | "DAILY"
  | "WEEKLY"
  | "BIWEEKLY"
  | "EVERY4WEEKS"
  | "SEMIMONTHLY"
  | "MONTHLY"
  | "EVERY2MONTHS"
  | "QUARTERLY"
  | "EVERY4MONTHS"
  | "SEMIANNUAL"
  | "YEARLY"
  | "EVERY2YEARS"
  | "CUSTOM";

/**
 * Mean length of one cycle of each frequency, in days. `ONCE` is 0 -- it has no
 * cycle, and callers matching an observed or computed spacing must skip it.
 *
 * Means, not whole cycles: a value here is matched against a number of days, so
 * February and a 31-day month have to average out rather than round up. That is
 * why the calendar frequencies are written as fractions of `365.25` -- the
 * spellings are chosen so that a cadence expressed as "one <unit> divided by n
 * occurrences" lands on exactly one of these numbers rather than near it, which
 * is what lets a code table be matched by equality instead of by tolerance.
 *
 * This is the one place a frequency's length is written down. The `.mny`
 * importer reads it from both ends -- `bill-cadence.ts` matches observed
 * instance spacing against it, `mny-model.ts` matches Money's own recurrence
 * codes against it -- and the compiler forces a new frequency to declare one.
 */
export const FREQUENCY_CYCLE_DAYS: Record<FrequencyType, number> = {
  ONCE: 0,
  DAILY: 1,
  WEEKLY: 7,
  BIWEEKLY: 14,
  EVERY4WEEKS: 28,
  SEMIMONTHLY: 365.25 / 24,
  MONTHLY: 365.25 / 12,
  EVERY2MONTHS: 365.25 / 6,
  QUARTERLY: 365.25 / 4,
  EVERY4MONTHS: 365.25 / 3,
  SEMIANNUAL: 365.25 / 2,
  YEARLY: 365.25,
  EVERY2YEARS: 365.25 * 2,
  // No fixed cycle: `customOccurrencesPerYear` / `customMinGapDays` answer
  // from the rule (docs/specs/custom-recurrence.md section 4).
  CUSTOM: 0,
};

const YMD_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseYMD(ymd: string): { y: number; m: number; d: number } {
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

function addDays(ymd: string, days: number): string {
  const { y, m, d } = parseYMD(ymd);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return formatYMD(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
  );
}

/**
 * `ymd` plus `months`, with the day clamped to the target month's length --
 * 31 January plus one month is 28 February, never 3 March.
 *
 * Exported because a term end date is the same arithmetic on the same calendar:
 * `Date.setMonth(getMonth() + n)` OVERFLOWS instead, and on a UTC-midnight Date
 * its local accessors also shift the day west of Greenwich, so a mortgage's
 * stored term_end_date skipped February and differed by a day between
 * deployments.
 */
export function addMonthsClamped(
  ymd: string,
  months: number,
  anchorDay?: number,
): string {
  const { y, m, d: prevDay } = parseYMD(ymd);
  const d = anchorDay ?? prevDay;
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return formatYMD(ny, nm, nd);
}

function addYearsClamped(
  ymd: string,
  years: number,
  anchorDay?: number,
): string {
  const { y, m, d: prevDay } = parseYMD(ymd);
  const d = anchorDay ?? prevDay;
  const ny = y + years;
  const nd = Math.min(d, daysInMonth(ny, m));
  return formatYMD(ny, m, nd);
}

/**
 * The date after `ymd`. `anchorDay` is the day-of-month of the schedule's
 * `start_date`: a month-based step clamps to the month length but returns to
 * the anchor day afterwards (31 Jan -> 28 Feb -> 31 Mar). Without it the step
 * keeps the previous date's day, which drifts after a short month.
 *
 * `CUSTOM` steps by `custom.rule`, its periods counted from `custom.startDate`,
 * and throws without a valid rule (docs/specs/custom-recurrence.md section 3).
 */
export function calculateNextDueDate(
  ymd: string,
  frequency: FrequencyType,
  anchorDay?: number,
  custom?: CustomStepContext,
): string {
  switch (frequency) {
    case "ONCE":
      return ymd;
    case "DAILY":
      return addDays(ymd, 1);
    case "WEEKLY":
      return addDays(ymd, 7);
    case "BIWEEKLY":
      return addDays(ymd, 14);
    case "EVERY4WEEKS":
      return addDays(ymd, 28);
    case "SEMIMONTHLY": {
      const { y, m, d } = parseYMD(ymd);
      if (d <= 15) {
        return formatYMD(y, m, daysInMonth(y, m));
      }
      const total = y * 12 + m;
      const ny = Math.floor(total / 12);
      const nm = (total % 12) + 1;
      return formatYMD(ny, nm, 15);
    }
    case "MONTHLY":
      return addMonthsClamped(ymd, 1, anchorDay);
    case "EVERY2MONTHS":
      return addMonthsClamped(ymd, 2, anchorDay);
    case "QUARTERLY":
      return addMonthsClamped(ymd, 3, anchorDay);
    case "EVERY4MONTHS":
      return addMonthsClamped(ymd, 4, anchorDay);
    case "SEMIANNUAL":
      return addMonthsClamped(ymd, 6, anchorDay);
    case "YEARLY":
      return addYearsClamped(ymd, 1, anchorDay);
    case "EVERY2YEARS":
      return addYearsClamped(ymd, 2, anchorDay);
    case "CUSTOM":
      return nextCustomDate(
        ymd,
        custom?.rule,
        custom?.startDate ? ensureYMD(custom.startDate) : null,
      );
    default:
      return ymd;
  }
}

/**
 * Throw when a `CUSTOM` schedule reaches code that assumes a fixed cadence: the
 * loan-installment calendar, its pricing and its fees count periods per year
 * and step without a rule. The write path refuses Custom on a loan payment
 * (docs/specs/custom-recurrence.md section 5), so reaching this is a defect,
 * and an error beats a silent monthly default or a calendar of one slot.
 */
export function assertFixedCadence(
  frequency: string | null | undefined,
  where: string,
): void {
  if (frequency === "CUSTOM") {
    throw new Error(
      `${where}: a CUSTOM schedule has no fixed cadence and is never a loan installment schedule`,
    );
  }
}

/**
 * The anchor day for stepping from `current`: the `start_date`'s day when
 * `current` sits on it (or on it clamped by a short month), else `current`'s own
 * day because the user moved it. Undefined without a `start_date`.
 */
export function anchorDayOf(
  startDate: string | Date | null | undefined,
  current: string | Date,
): number | undefined {
  if (!startDate) return undefined;
  const { d: s } = parseYMD(ensureYMD(startDate));
  const { y, m, d } = parseYMD(ensureYMD(current));
  return d === Math.min(s, daysInMonth(y, m)) ? s : d;
}

export function ensureYMD(value: string | Date): string {
  if (typeof value === "string") {
    if (YMD_PATTERN.test(value)) return value;
    return value.split("T")[0];
  }
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, "0");
  const d = String(value.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
