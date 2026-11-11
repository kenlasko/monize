/**
 * What the scheduled-transaction form works out about a Custom rule while it
 * is being edited (docs/specs/custom-recurrence.md sections 1 and 5): the
 * rule a fresh Custom choice starts from, the date the pattern lands on first,
 * and the edited occurrences a save would delete because they no longer fall
 * on the schedule.
 */
import {
  CustomRecurrence,
  CustomRecurrenceUnit,
  nextCustomDate,
  normalizeCustomRecurrence,
} from './custom-recurrence';
import { advanceSchedule, isOneTime, localYmd, SteppableSchedule } from './frequency';
import { parseLocalDate } from './utils';

const MS_PER_DAY = 86_400_000;
/** Ten years of daily slots: more than any override list reaches. */
const MAX_SLOTS = 3700;

function dayBefore(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d) - MS_PER_DAY);
  return prev.toISOString().slice(0, 10);
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of a `YYYY-MM-DD`. */
function isoWeekdayOf(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

/**
 * The rule a unit starts from when the user first picks it: the start date's
 * own weekday, day of the month or date of the year, every period.
 */
export function defaultCustomRecurrence(
  unit: CustomRecurrenceUnit,
  startDate: string,
  weekStartsOn: number,
): CustomRecurrence {
  const ymd = startDate.slice(0, 10);
  if (unit === 'WEEK') {
    return { unit, interval: 1, weekdays: [isoWeekdayOf(ymd)], weekStartsOn };
  }
  if (unit === 'MONTH') {
    return { unit, interval: 1, monthDays: [Number(ymd.slice(8, 10))] };
  }
  return { unit, interval: 1, dates: [ymd.slice(5, 10)] };
}

/** True when `ymd` is a real `YYYY-MM-DD`, which a half-typed date field is not. */
function isYmd(ymd: string | null | undefined): ymd is string {
  return !!ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd.slice(0, 10)) && !Number.isNaN(Date.parse(ymd.slice(0, 10)));
}

/**
 * The first rule date on or after `fromDate`, its periods counted from
 * `periodStart` (the schedule's start date; a new schedule's is the date being
 * typed). `null` while the rule or the date is incomplete.
 */
export function customDateOnOrAfter(
  fromDate: string | null | undefined,
  rule: CustomRecurrence | null | undefined,
  periodStart?: string | null,
): string | null {
  if (!isYmd(fromDate) || !normalizeCustomRecurrence(rule).ok) return null;
  const from = fromDate.slice(0, 10);
  const anchor = isYmd(periodStart) ? periodStart.slice(0, 10) : from;
  return nextCustomDate(dayBefore(from), rule, anchor);
}

export interface OrphanCheckSchedule extends SteppableSchedule {
  /** The first slot the schedule will post, as the form holds it. */
  nextDueDate: string;
}

/**
 * The `originalDate`s of `overrides` that are not a slot of `schedule`, in
 * date order: the edited occurrences a save deletes (spec section 5). Empty
 * while the schedule cannot be walked (an incomplete rule or date), since the
 * form refuses that save anyway.
 */
export function orphanedOverrideDates(
  schedule: OrphanCheckSchedule,
  overrides: readonly { originalDate: string }[],
): string[] {
  const dates = [...new Set(overrides.map((o) => o.originalDate.slice(0, 10)))].sort();
  if (dates.length === 0 || !isYmd(schedule.nextDueDate)) return [];

  let first = schedule.nextDueDate.slice(0, 10);
  if (schedule.frequency === 'CUSTOM') {
    const snapped = customDateOnOrAfter(first, schedule.customRecurrence, schedule.startDate ?? first);
    if (!snapped) return [];
    first = snapped;
  }

  const last = dates[dates.length - 1];
  const slots = new Set<string>();
  let cursor = parseLocalDate(first);
  for (let i = 0; i < MAX_SLOTS; i++) {
    const key = localYmd(cursor);
    if (key > last) break;
    slots.add(key);
    if (isOneTime(schedule.frequency)) break;
    cursor = advanceSchedule(cursor, schedule);
  }
  return dates.filter((d) => !slots.has(d));
}

/**
 * The `scheduledTransactions` message key saying why `rule` cannot be saved,
 * or `null` when it can. The editor shows it live and the form's schema
 * refuses the save with it, so the two never disagree.
 */
export function customRecurrenceErrorKey(rule: CustomRecurrence | null | undefined): string | null {
  const result = normalizeCustomRecurrence(rule);
  if (result.ok) return null;
  if (result.error === 'interval') return 'customRecurrence.errors.interval';
  if (rule && (result.error === 'weekdays' || result.error === 'monthDays' || result.error === 'dates')) {
    return `customRecurrence.errors.noDays.${rule.unit}`;
  }
  return 'customRecurrence.errors.invalid';
}

/** Two rules that mean the same schedule, compared in canonical form. */
export function sameCustomRecurrence(
  a: CustomRecurrence | null | undefined,
  b: CustomRecurrence | null | undefined,
): boolean {
  const na = normalizeCustomRecurrence(a);
  const nb = normalizeCustomRecurrence(b);
  if (!na.ok || !nb.ok) return !na.ok && !nb.ok && JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return JSON.stringify(na.rule) === JSON.stringify(nb.rule);
}
