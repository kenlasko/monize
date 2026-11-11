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
  customDateOnOrAfter,
  normalizeCustomRecurrence,
} from './custom-recurrence';
import { dayOfWeek } from './calendar-month';
import { advanceSchedule, isOneTime, localYmd } from './frequency';
import { parseLocalDate } from './utils';
import type { FrequencyType } from '@/types/scheduled-transaction';

/**
 * The server's `OCCURRENCE_WALK_GUARD` (`backend/src/common/scheduled-occurrences.ts`):
 * how many slots its orphan check walks before it stops and keeps whatever lies
 * beyond, so the form names exactly the overrides that save deletes.
 */
const OCCURRENCE_WALK_GUARD = 2000;

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
    return { unit, interval: 1, weekdays: [dayOfWeek(ymd) || 7], weekStartsOn };
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

/** The schedule as stored, before the edit: what the server compares the save against. */
export interface StoredSchedule {
  frequency: FrequencyType;
  nextDueDate: string;
  startDate?: string | null;
  customRecurrence?: CustomRecurrence | null;
}

/** The schedule as the form holds it. */
export interface EditedSchedule {
  frequency: FrequencyType;
  /** The due date as typed. */
  nextDueDate: string | null | undefined;
  customRecurrence?: CustomRecurrence | null;
}

/**
 * True when a Custom save re-snaps the due date onto the pattern: on a create,
 * and on an update that changes the rule (a schedule moving to Custom has had
 * none). The form has no start-date field, so the server's third trigger, a
 * changed start date, cannot arise from it.
 */
function snapsOnSave(edited: EditedSchedule, stored: StoredSchedule | undefined): boolean {
  return (
    !stored ||
    stored.frequency !== 'CUSTOM' ||
    !sameCustomRecurrence(edited.customRecurrence, stored.customRecurrence)
  );
}

/**
 * The `next_due_date` the server stores for this save (spec section 5): the
 * first rule date on or after the typed date when the save snaps, its periods
 * counted from the stored start date (a new schedule's is the typed date),
 * else the typed date as it is, even off the pattern. `null` while the date
 * or the rule is incomplete, since the form refuses that save.
 */
export function savedNextDueDate(edited: EditedSchedule, stored?: StoredSchedule): string | null {
  if (!isYmd(edited.nextDueDate)) return null;
  const typed = edited.nextDueDate.slice(0, 10);
  if (edited.frequency !== 'CUSTOM') return typed;
  if (!normalizeCustomRecurrence(edited.customRecurrence).ok) return null;
  if (!snapsOnSave(edited, stored)) return typed;
  const periodStart = isYmd(stored?.startDate) ? stored.startDate.slice(0, 10) : typed;
  return customDateOnOrAfter(typed, edited.customRecurrence, periodStart);
}

/**
 * True when `ymd` is one of the rule's dates, periods counted from the stored
 * start date (a new schedule's is `ymd`). `false` for an incomplete rule.
 */
export function isOnCustomPattern(
  ymd: string,
  rule: CustomRecurrence | null | undefined,
  periodStart?: string | null,
): boolean {
  if (!normalizeCustomRecurrence(rule).ok) return false;
  return customDateOnOrAfter(ymd, rule, isYmd(periodStart) ? periodStart.slice(0, 10) : ymd) === ymd;
}

/**
 * True when the save changes the pattern, which is what makes the server
 * delete orphaned overrides: the frequency, or a Custom schedule's rule.
 */
function patternChanges(edited: EditedSchedule, stored: StoredSchedule): boolean {
  return (
    edited.frequency !== stored.frequency ||
    (edited.frequency === 'CUSTOM' && !sameCustomRecurrence(edited.customRecurrence, stored.customRecurrence))
  );
}

/**
 * The `originalDate`s, in date order, of the overrides the server deletes on
 * this save (spec section 5): only when the pattern changes; of the overrides
 * dated on or after the earlier of the stored and the saved due date, each one
 * that is not a slot of the new schedule walked from the saved due date. The
 * walk stops after `OCCURRENCE_WALK_GUARD` slots, as the server's does, and an
 * override beyond it is kept, not named. Empty while the edit is incomplete.
 *
 * `overrides` must hold every override from that earlier date on. A schedule's
 * `futureOverrides` starts at its stored due date, so it falls short only when
 * the edit moves the due date earlier.
 */
export function orphanedOverrideDates(
  edited: EditedSchedule,
  stored: StoredSchedule,
  overrides: readonly { originalDate: string }[],
): string[] {
  if (!patternChanges(edited, stored)) return [];
  const cursor = savedNextDueDate(edited, stored);
  if (!cursor || !isYmd(stored.nextDueDate)) return [];
  const storedCursor = stored.nextDueDate.slice(0, 10);
  const from = storedCursor < cursor ? storedCursor : cursor;
  const candidates = [...new Set(overrides.map((o) => o.originalDate.slice(0, 10)))]
    .filter((d) => d >= from)
    .sort();
  if (candidates.length === 0) return [];

  const through = candidates[candidates.length - 1];
  const schedule = {
    frequency: edited.frequency,
    startDate: stored.startDate,
    customRecurrence: edited.frequency === 'CUSTOM' ? edited.customRecurrence : null,
  };
  const slots: string[] = [];
  let slot = cursor;
  while (slot <= through && slots.length < OCCURRENCE_WALK_GUARD) {
    slots.push(slot);
    if (isOneTime(schedule)) break;
    const next = localYmd(advanceSchedule(parseLocalDate(slot), schedule));
    if (next <= slot) break;
    slot = next;
  }
  const held = new Set(slots);
  const walkedThrough = slots.length >= OCCURRENCE_WALK_GUARD ? slots[slots.length - 1] : through;
  return candidates.filter((d) => !held.has(d) && d <= walkedThrough);
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
