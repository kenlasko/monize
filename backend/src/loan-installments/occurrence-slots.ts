import {
  anchorDayOf,
  assertFixedCadence,
  calculateNextDueDate,
  FrequencyType,
} from "../common/recurrence";
import { addDaysYMD } from "../common/date-utils";
import {
  calendarPaymentNumber,
  MortgageMethodTerms,
} from "../accounts/mortgage-installment.util";
import { periodsPerYearForStoredFrequency } from "../accounts/payment-frequency.util";

/**
 * The slot calendar of a scheduled loan payment and the selection of the slot
 * a bank row paid (`docs/specs/loan-installment-settlement.md` section 6).
 * Pure: dates are `YYYY-MM-DD` strings compared as text, stepped with
 * `calculateNextDueDate`, the function `post()` advances the cursor with, so
 * the slot a settlement claims and the slot a bill post would claim share one
 * key (INV-LOAN-008).
 *
 * The calendar is built around the cursor (`next_due_date`, spec decision 20),
 * not drawn from `start_date` alone: the cursor can be edited apart from the
 * start date and the frequency, and a calendar that did not hold it would key
 * a settlement and a post of one installment on two dates.
 */

/** The schedule columns the calendar is drawn from. */
export interface SlotCalendarSchedule {
  readonly startDate: string;
  readonly nextDueDate: string;
  /** The stored cadence; a value outside `FrequencyType` does not step and gives a single slot. */
  readonly frequency: string;
  readonly endDate: string | null;
  readonly occurrencesRemaining: number | null;
}

/** One slot: an occurrence's identity and the dates it answers for. */
export interface OccurrenceSlot {
  /** The slot's own date: the claim key, `original_due_date`. */
  readonly date: string;
  /** The slot's ordinal on the schedule's calendar (the first slot = 1). */
  readonly ordinal: number;
  /** The first date the slot answers for, inclusive. */
  readonly periodStart: string;
  /** The first date the slot no longer answers for (exclusive). */
  readonly periodEnd: string;
  /** True for the schedule's `next_due_date`: claiming it advances the cursor. */
  readonly isCursor: boolean;
}

/** A calendar date range, inclusive at both ends. */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

/** `[t - daysAfter, t + daysBefore]`: the slots a row dated `t` may pay (spec section 2). */
export function settlementWindow(
  rowDate: string,
  window: { readonly daysBefore: number; readonly daysAfter: number },
): DateRange {
  return {
    from: addDaysYMD(rowDate, -window.daysAfter),
    to: addDaysYMD(rowDate, window.daysBefore),
  };
}

/** The next slot date, or null when the cadence does not move the date forward (`ONCE`, an unknown value). */
function stepForward(
  date: string,
  frequency: string,
  startDate: string,
): string | null {
  assertFixedCadence(frequency, "occurrenceSlotsInRange");
  const next = calculateNextDueDate(
    date,
    frequency as FrequencyType,
    anchorDayOf(startDate, date),
  );
  return next > date ? next : null;
}

/** A slot's period end: the next calendar date, or the day after for a cadence that does not step. */
function periodEndOf(
  date: string,
  frequency: string,
  startDate: string,
): string {
  return stepForward(date, frequency, startDate) ?? addDaysYMD(date, 1);
}

/**
 * The slots of the schedule whose dates fall inside `range`, with their
 * periods (spec section 6.1):
 *
 * 1. the cursor (`next_due_date`) and the dates stepped from it, bounded by
 *    `end_date` and by `occurrences_remaining` (the cursor counts as one; a
 *    cursor already past the end, or with none remaining, is no slot);
 * 2. history: `start_date` and each date stepped from it while the step
 *    stays on or before the cursor -- the start-calendar date whose next step
 *    passes the cursor is the installment the cursor stands for;
 * 3. periods: a history slot `D` answers for `[D, next(D))`, the cursor for
 *    `[h, next(cursor))` where `h` is the end of the last history period
 *    (the start date when there is none, the cursor itself when the start
 *    date is after it), a later slot `f` for `[f, next(f))`.
 *
 * `ONCE`, and any cadence that does not move forward, gives the single slot
 * `next_due_date`. Only slots dated inside `range` are returned; their
 * ordinals still count from the first slot of the calendar. The whole
 * history is walked to count them, which is bounded by the cursor.
 */
export function occurrenceSlotsInRange(
  schedule: SlotCalendarSchedule,
  range: DateRange,
): OccurrenceSlot[] {
  const { frequency } = schedule;
  const cursor = schedule.nextDueDate;
  const slots: OccurrenceSlot[] = [];

  // History, from the start date up to (not including) the cursor's installment.
  const history: string[] = [];
  let historyEnd = schedule.startDate > cursor ? cursor : schedule.startDate;
  if (schedule.startDate <= cursor) {
    let date = schedule.startDate;
    for (;;) {
      const next = stepForward(date, frequency, schedule.startDate);
      if (next === null || next > cursor) break;
      history.push(date);
      historyEnd = next;
      date = next;
    }
  }
  history.forEach((date, index) => {
    const periodEnd = periodEndOf(date, frequency, schedule.startDate);
    if (date >= range.from && date <= range.to) {
      slots.push({
        date,
        ordinal: index + 1,
        periodStart: date,
        periodEnd,
        isCursor: false,
      });
    }
  });

  // The cursor and the slots after it. A cursor past `end_date`, or with no
  // occurrence remaining, is a schedule that has run out: nothing is due.
  if (
    (schedule.endDate !== null && cursor > schedule.endDate) ||
    (schedule.occurrencesRemaining !== null &&
      schedule.occurrencesRemaining <= 0)
  ) {
    return slots;
  }
  let ordinal = history.length + 1;
  const cursorPeriodEnd = periodEndOf(cursor, frequency, schedule.startDate);
  if (cursor >= range.from && cursor <= range.to) {
    slots.push({
      date: cursor,
      ordinal,
      periodStart: historyEnd,
      periodEnd: cursorPeriodEnd,
      isCursor: true,
    });
  }
  let remaining =
    schedule.occurrencesRemaining === null
      ? null
      : Math.max(0, schedule.occurrencesRemaining - 1);
  let date = cursor;
  for (;;) {
    if (remaining !== null && remaining <= 0) break;
    const next = stepForward(date, frequency, schedule.startDate);
    if (next === null || next > range.to) break;
    if (schedule.endDate !== null && next > schedule.endDate) break;
    ordinal += 1;
    if (remaining !== null) remaining -= 1;
    if (next >= range.from) {
      slots.push({
        date: next,
        ordinal,
        periodStart: next,
        periodEnd: periodEndOf(next, frequency, schedule.startDate),
        isCursor: false,
      });
    }
    date = next;
  }
  return slots;
}

/**
 * `prev(D)`: the latest slot of the schedule's calendar dated before `date`,
 * or null when `date` is the first slot or precedes it
 * (`docs/specs/scheduled-loan-installment-pricing.md` section 7.3). The
 * calendar is the one above, built around the cursor with history stepped
 * from `start_date`, so it holds no posting date: an occurrence posted late
 * or moved by an override does not change which installment a rate change
 * first applies to. A schedule without a start date has no calendar to read
 * and answers null, which the advancement reads as "not newly applying".
 */
export function precedingSlotDate(
  schedule: SlotCalendarSchedule,
  date: string,
): string | null {
  if (!schedule.startDate || !schedule.nextDueDate) return null;
  const from =
    schedule.startDate < schedule.nextDueDate
      ? schedule.startDate
      : schedule.nextDueDate;
  if (from >= date) return null;
  let previous: string | null = null;
  for (const slot of occurrenceSlotsInRange(schedule, { from, to: date })) {
    if (slot.date < date && (previous === null || slot.date > previous)) {
      previous = slot.date;
    }
  }
  return previous;
}

/**
 * The span of dates the periods of `slots` cover, `[from, to)`, or null for
 * no slots. A facts loader reads the schedule's claims over it, because a
 * claim occupies the slot whose period holds its `original_due_date`, which
 * may be a date the calendar no longer holds (spec section 6.1, item 4).
 */
export function periodSpan(
  slots: readonly OccurrenceSlot[],
): { from: string; to: string } | null {
  if (slots.length === 0) return null;
  let from = slots[0].periodStart;
  let to = slots[0].periodEnd;
  for (const slot of slots) {
    if (slot.periodStart < from) from = slot.periodStart;
    if (slot.periodEnd > to) to = slot.periodEnd;
  }
  return { from, to };
}

/** Whether a claim dated `claimDate` occupies `slot`: its date lies in the slot's period. */
export function slotIsOccupiedBy(
  slot: OccurrenceSlot,
  claimDate: string,
): boolean {
  return claimDate >= slot.periodStart && claimDate < slot.periodEnd;
}

/** Whole days between two `YYYY-MM-DD` dates, as a magnitude. */
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.abs(
    Math.round(
      (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000,
    ),
  );
}

export type SlotSelection =
  | { readonly kind: "selected"; readonly slot: OccurrenceSlot }
  /** No slot in the window (spec section 6.2, step 1). */
  | { readonly kind: "none_in_window" }
  /** Every slot in the window is claimed or planned earlier in the pass (step 2). */
  | { readonly kind: "all_claimed"; readonly dueDates: readonly string[] };

/**
 * The slot a row dated `rowDate` paid (spec section 6.2): of the slots inside
 * the window, drop those a claim occupies (`claimDates` are the claims'
 * `original_due_date`s) and those planned earlier in the pass
 * (`plannedSlots`, by slot date); of the rest, the nearest to the row in
 * calendar days, the earlier on a tie.
 */
export function selectOccurrenceSlot(
  slots: readonly OccurrenceSlot[],
  rowDate: string,
  window: DateRange,
  claimDates: readonly string[],
  plannedSlots: ReadonlySet<string>,
): SlotSelection {
  const candidates = slots.filter(
    (slot) => slot.date >= window.from && slot.date <= window.to,
  );
  if (candidates.length === 0) return { kind: "none_in_window" };
  const free = candidates.filter(
    (slot) =>
      !plannedSlots.has(slot.date) &&
      !claimDates.some((claimDate) => slotIsOccupiedBy(slot, claimDate)),
  );
  if (free.length === 0) {
    return { kind: "all_claimed", dueDates: candidates.map((s) => s.date) };
  }
  let best = free[0];
  let bestDistance = daysBetween(rowDate, best.date);
  for (const slot of free.slice(1)) {
    const distance = daysBetween(rowDate, slot.date);
    if (
      distance < bestDistance ||
      (distance === bestDistance && slot.date < best.date)
    ) {
      best = slot;
      bestDistance = distance;
    }
  }
  return { kind: "selected", slot: best };
}

/**
 * Whether the schedule's cadence is the loan's (spec section 6.1, item 6):
 * false when `accounts.payment_frequency` is set and
 * `periodsPerYearForStoredFrequency` gives the two a different count. A loan
 * with no stored cadence takes the schedule's; an unknown count on either
 * side is not a mismatch here (the cadence refusal names `paymentFrequency`).
 */
export function scheduleCadenceMatchesLoan(
  loanPaymentFrequency: string | null | undefined,
  scheduleFrequency: string,
): boolean {
  assertFixedCadence(scheduleFrequency, "scheduleCadenceMatchesLoan");
  if (!loanPaymentFrequency) return true;
  const loanCount = periodsPerYearForStoredFrequency(loanPaymentFrequency);
  const scheduleCount = periodsPerYearForStoredFrequency(scheduleFrequency);
  if (loanCount === null || scheduleCount === null) return true;
  return loanCount === scheduleCount;
}

/**
 * The slot's installment number: its ordinal on the loan's own calendar
 * (`calendarPaymentNumber` from `payment_start_date`, spec section 2) when
 * the account carries the terms to draw one, else its ordinal on the
 * schedule's calendar.
 */
export function installmentNumberOf(
  slot: OccurrenceSlot,
  terms: MortgageMethodTerms,
): number {
  const fromTerms = calendarPaymentNumber(terms, slot.date);
  return fromTerms !== null && fromTerms >= 1 ? fromTerms : slot.ordinal;
}
