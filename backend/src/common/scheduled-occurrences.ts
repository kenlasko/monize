import { Logger } from "@nestjs/common";
import { addDaysYMD } from "./date-utils";
import {
  CustomRecurrence,
  customStepper,
  normalizeCustomRecurrence,
} from "./custom-recurrence";
import {
  FrequencyType,
  anchorDayOf,
  calculateNextDueDate,
  ensureYMD,
} from "./recurrence";

/**
 * Hard bound on how many recurrence steps one schedule is walked in a single
 * expansion. A daily schedule over a five-year horizon is under 2000 steps, so
 * this is a runaway backstop (a frequency whose stepper failed to advance is
 * already caught by the monotonicity check) rather than a product limit.
 */
export const OCCURRENCE_WALK_GUARD = 2000;

const logger = new Logger("ScheduledOccurrences");

/**
 * How many days before today an occurrence that was neither posted nor skipped
 * still counts as owed (discussion #1784). Posting and skipping both advance
 * `next_due_date`, so nothing but the user's own record tells a bill that is
 * late apart from one paid by a plain transaction with its occurrence left
 * unposted. Past this window it is read as forgotten and left out, as every
 * projection did before, so a stale schedule moves a forecast by at most one
 * window's worth of occurrences instead of every slot since it went stale,
 * however long ago that was or wherever the walk guard stops. The cash-flow
 * forecast (`OVERDUE_CARRY_DAYS` in `frontend/src/lib/forecast.ts`) uses the
 * same window.
 */
export const OVERDUE_CARRY_DAYS = 31;

/** The earliest due date a projection anchored at `today` still treats as owed. */
export function overdueCarryFrom(today: string): string {
  return addDaysYMD(today, -OVERDUE_CARRY_DAYS);
}

/** A window bound is a calendar date, because that is what it is compared as. */
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function assertWindowDate(value: string, field: "from" | "through"): void {
  if (!YMD.test(value)) {
    throw new RangeError(
      `expandOccurrenceSlots: window.${field} must be a YYYY-MM-DD date, got ${JSON.stringify(value)}`,
    );
  }
}

/**
 * The half of a per-occurrence override that decides WHICH occurrence it is and
 * WHEN that occurrence falls. Deliberately not the amount: this module answers
 * occurrence identity, and the amount is the effective-amount service's answer.
 */
export interface OccurrenceOverrideInput {
  /**
   * The recurrence slot this override replaces. This -- not `overrideDate` -- is
   * the occurrence's identity, and since migration 168 the database says so:
   * `uq_sched_txn_overrides_occurrence` is
   * `UNIQUE (scheduled_transaction_id, original_date)`. It used to be keyed on
   * `override_date`, which permitted two overrides for one slot and left the
   * `byOriginal` map below picking whichever row it saw first. Keying an
   * override lookup on `overrideDate` silently misses every occurrence the user
   * moved.
   */
  originalDate: string | Date;
  /** The date the occurrence actually falls on. Equal to `originalDate` unless moved. */
  overrideDate: string | Date;
}

export interface OccurrenceScheduleInput {
  /** Names the schedule in a warning about a rule it cannot walk. */
  id?: string;
  frequency: FrequencyType;
  nextDueDate: string | Date;
  /** Anchors the day-of-month of month-based steps; absent steps from the previous slot's day. */
  startDate?: string | Date | null;
  /** The rule of a `CUSTOM` schedule; its periods count from `startDate`. */
  customRecurrence?: CustomRecurrence | null;
  endDate?: string | Date | null;
  occurrencesRemaining?: number | null;
}

export interface OccurrenceWindow {
  /**
   * Inclusive lower bound on the date the occurrence actually falls on. Omit to
   * include occurrences already overdue -- a bill whose due date has passed is
   * exactly what an upcoming-bills surface must still show.
   */
  from?: string;
  /** Inclusive upper bound on the date the occurrence actually falls on. */
  through: string;
  /**
   * Cap on how many occurrences of ONE schedule are returned, applied after
   * ordering by due date. `1` means "the next occurrence", which is what a
   * surface reporting one row per schedule wants.
   */
  maxOccurrences?: number;
}

export interface ExpandedOccurrence<O> {
  /** The recurrence slot -- the occurrence's identity (see `originalDate` above). */
  originalDate: string;
  /** The date it falls on: the override's date when one moved it, else `originalDate`. */
  dueDate: string;
  /** The override governing this occurrence, or null when it runs on the base template. */
  override: O | null;
  /** True when an override moved this occurrence off its recurrence slot. */
  moved: boolean;
}

/**
 * Expand one schedule's recurrence into the occurrences that fall inside
 * `window`, applying each per-occurrence override's date move.
 *
 * This is the single place a scheduled recurrence is walked over a window and
 * matched against its overrides (issue #1247). It exists because occurrence
 * *selection* was distributed even after the effective-amount arithmetic was
 * centralized: every consumer still had to know that the identity is
 * `originalDate`, that `overrideDate` moves the occurrence, and how the two
 * interact with the window -- and the budget alert path got it wrong by keying
 * the lookup on `overrideDate`, so a moved occurrence read the base template.
 *
 * Two window subtleties the callers used to get wrong, both of them tested:
 *
 *  - **An override can move an occurrence INTO the window from beyond it.** The
 *    walk therefore runs past `through` as far as the furthest recurrence slot
 *    whose override lands inside, instead of stopping at `through` and losing it.
 *  - **An override can move an occurrence OUT of the window.** Filtering is on
 *    the date the occurrence actually falls on, never on the recurrence slot.
 *
 * `maxOccurrences` is applied after ordering by `dueDate`, so "the next
 * occurrence" is the next one to actually happen -- not the earliest recurrence
 * slot, which a backward move can push behind a later one.
 */
export function expandOccurrenceSlots<O extends OccurrenceOverrideInput>(
  schedule: OccurrenceScheduleInput,
  overrides: readonly O[],
  window: OccurrenceWindow,
): ExpandedOccurrence<O>[] {
  // The window is compared as text, so a bound that is not a date fails OPEN
  // rather than closed: `"2026-08-26" <= "NaN-NaN-NaN"` is true (digits sort
  // before letters), so every slot passed both the walk condition and the
  // filter, and the caller got "due today" for a bill years away. That is how an
  // unbounded `reminderDaysBefore` overflowing `addDaysYMD` turned into a daily
  // reminder for every one of a user's manual bills. Refuse the input instead:
  // no caller has a meaning for a non-date window, and a silent all-match is the
  // worst of the three possible answers.
  assertWindowDate(window.through, "through");
  if (window.from !== undefined) assertWindowDate(window.from, "from");

  // One override per slot, which the database now enforces
  // (`uq_sched_txn_overrides_occurrence`, migration 168). The first-wins guard
  // stays: this function is also handed override lists a caller assembled, and
  // silently overwriting would make the answer depend on array order.
  const byOriginal = new Map<string, O>();
  for (const override of overrides) {
    const key = ensureYMD(override.originalDate as string);
    if (!byOriginal.has(key)) byOriginal.set(key, override);
  }

  // How far the recurrence has to be walked: past `through` when an override
  // moved a later slot's occurrence back into the window.
  let walkThrough = window.through;
  for (const [originalDate, override] of byOriginal) {
    const dueDate = ensureYMD(override.overrideDate as string);
    if (dueDate <= window.through && originalDate > walkThrough) {
      walkThrough = originalDate;
    }
  }

  // Every override, by slot, so the walk can ask what the slots it has NOT
  // reached could still produce. `suffixMinDueDate[i]` is the earliest date any
  // override from `sortedSlots[i]` onwards moves its occurrence to.
  const sortedSlots = [...byOriginal.keys()].sort();
  const suffixMinDueDate: string[] = new Array(sortedSlots.length);
  for (let i = sortedSlots.length - 1; i >= 0; i -= 1) {
    const own = ensureYMD(
      byOriginal.get(sortedSlots[i])!.overrideDate as string,
    );
    const later = suffixMinDueDate[i + 1];
    suffixMinDueDate[i] = later !== undefined && later < own ? later : own;
  }
  let slotCursor = 0;

  const found: ExpandedOccurrence<O>[] = [];
  const endDate = schedule.endDate ? ensureYMD(schedule.endDate) : null;
  let remaining = schedule.occurrencesRemaining ?? Number.POSITIVE_INFINITY;
  let slot = ensureYMD(schedule.nextDueDate);
  let guard = 0;
  const step = stepperFor(schedule);

  while (
    slot <= walkThrough &&
    remaining > 0 &&
    guard++ < OCCURRENCE_WALK_GUARD
  ) {
    if (endDate && slot > endDate) break;
    const override = byOriginal.get(slot) ?? null;
    const dueDate = override
      ? ensureYMD(override.overrideDate as string)
      : slot;
    if (
      dueDate <= window.through &&
      (window.from === undefined || dueDate >= window.from)
    ) {
      found.push({
        originalDate: slot,
        dueDate,
        override,
        moved: dueDate !== slot,
      });
    }
    remaining -= 1;
    if (step === null) break;
    const next = step(slot);
    // A stepper that fails to advance would loop until the guard; stopping here
    // keeps a malformed frequency from silently emitting the same date 2000 times.
    if (next <= slot) break;
    slot = next;

    // Stop once no unwalked slot can enter the answer.
    //
    // `maxOccurrences` is applied after ordering by due date, so the walk used to
    // run to the end of the window and throw most of its work away: the AI
    // forecast asks for one occurrence over a ten-year horizon, which is 3,650
    // steps for a daily schedule -- past `OCCURRENCE_WALK_GUARD`, so the "bounded
    // horizon" was really the runaway backstop doing the bounding, silently.
    //
    // An unwalked slot's occurrence falls on the slot itself or on the date an
    // override moved it to, so the earliest it can be is
    // `min(next slot, earliest override date at or after that slot)`. Once
    // `maxOccurrences` occurrences already fall on or before that floor, nothing
    // further can displace them, and an override reaching back into the window
    // from beyond the horizon is exactly what the floor accounts for.
    if (window.maxOccurrences !== undefined) {
      while (
        slotCursor < sortedSlots.length &&
        sortedSlots[slotCursor] < slot
      ) {
        slotCursor += 1;
      }
      const pendingOverride = suffixMinDueDate[slotCursor];
      const floor =
        pendingOverride !== undefined && pendingOverride < slot
          ? pendingOverride
          : slot;
      const settled = found.filter((o) => o.dueDate <= floor).length;
      if (settled >= window.maxOccurrences) break;
    }
  }

  const ordered = found.sort((a, b) =>
    a.dueDate === b.dueDate
      ? a.originalDate.localeCompare(b.originalDate)
      : a.dueDate.localeCompare(b.dueDate),
  );
  return window.maxOccurrences === undefined
    ? ordered
    : ordered.slice(0, window.maxOccurrences);
}

/**
 * How one schedule steps from a slot to the next, or `null` when it has no
 * next slot. A Custom rule is normalized once for the whole walk. A Custom row
 * whose rule is missing or invalid -- a defect the write path refuses, so only
 * a row written past it -- yields its cursor slot alone, as a one-time
 * schedule would, with a warning: one broken row must not take a whole user's
 * forecast, or a cross-user cron, down with it. Posting or skipping that row
 * still refuses (`calculateNextDueDate` throws), so it is never settled on a
 * guess.
 */
function stepperFor(
  schedule: OccurrenceScheduleInput,
): ((slot: string) => string) | null {
  if (schedule.frequency === "ONCE") return null;
  const startDate = schedule.startDate ? ensureYMD(schedule.startDate) : null;
  if (schedule.frequency === "CUSTOM") {
    const result = normalizeCustomRecurrence(schedule.customRecurrence);
    if (!result.ok) {
      logger.warn(
        `Scheduled transaction ${schedule.id ?? "(unknown)"} is CUSTOM without a valid recurrence rule (${result.error}); expanding its next occurrence only`,
      );
      return null;
    }
    return customStepper(result.rule, startDate);
  }
  const frequency = schedule.frequency;
  return (slot) =>
    calculateNextDueDate(
      slot,
      frequency,
      anchorDayOf(schedule.startDate, slot),
    );
}
