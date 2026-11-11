import { EntityManager } from "typeorm";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import {
  anchorDayOf,
  calculateNextDueDate,
  ensureYMD,
} from "../common/recurrence";
import { todayYMD } from "../common/date-utils";
import { returnedRows } from "../common/db/query-result";

/** The cursor columns `advanceScheduleCursor` wrote. */
export interface ScheduleCursorAdvance {
  nextDueDate: string;
  occurrencesRemaining: number | null;
  /** True when the advance deactivated the schedule. */
  deactivated: boolean;
  /** How many slots the cursor stepped over, the claimed one included. */
  slotsConsumed: number;
}

/**
 * Advance a recurring schedule's cursor past the occurrences that have been
 * consumed: `next_due_date` to the next unclaimed slot, overrides dated before
 * it pruned, `last_posted_date` set, `occurrences_remaining` decremented once
 * per slot and the schedule deactivated at zero or past `end_date`.
 *
 * Lifted out of `ScheduledTransactionsService.post()`, so the settlement of a
 * bank debit against an occurrence (`docs/specs/loan-installment-settlement.md`
 * section 12.3) advances the cursor through the same code when it claims the
 * due slot. `post()`, `skip()` and the settlement claim all pass the slot they
 * consume plus every claim on or after it (`claimedSlotsFrom`), so a slot a
 * settlement rule claimed ahead of the cursor is never left under it (audit
 * A26-S08-03).
 *
 * `schedule` is the LOCKED row (`SELECT ... FOR UPDATE`), never a snapshot
 * taken before the transaction: a concurrent edit to `occurrences_remaining`
 * or `end_date` would otherwise be reverted by this advancement.
 * `consumedSlots` holds the slot dates (YYYY-MM-DD) already claimed on the
 * schedule, the row's current `next_due_date` among them; the cursor steps
 * past every consecutive claimed slot so the bill never offers an occurrence
 * whose own claim key is taken. With exactly the current slot in the set, this
 * is one step.
 *
 * `options.stampLastPosted` (default true) sets `last_posted_date`; a skip
 * passes false because nothing was posted.
 *
 * A ONCE schedule has no next slot; `post()` deletes it instead and never
 * calls this.
 */
export async function advanceScheduleCursor(
  m: EntityManager,
  schedule: Pick<
    ScheduledTransaction,
    "id" | "nextDueDate" | "frequency" | "occurrencesRemaining" | "endDate"
  > &
    Partial<Pick<ScheduledTransaction, "startDate" | "customRecurrence">>,
  consumedSlots: ReadonlySet<string>,
  options: { stampLastPosted?: boolean } = {},
): Promise<ScheduleCursorAdvance> {
  let newNextDueDateStr = ensureYMD(schedule.nextDueDate);
  let slotsConsumed = 0;
  do {
    // `calculateNextDueDate` hands back its input for ONCE and for a value
    // outside `FrequencyType` (the column is a bare VARCHAR), and the current
    // slot is always in the set, so a step that does not advance would loop
    // for ever under the parent lock. Fail closed: the caller's transaction
    // rolls back and nothing is claimed on a schedule whose cadence cannot
    // step.
    const previous = newNextDueDateStr;
    newNextDueDateStr = calculateNextDueDate(
      previous,
      schedule.frequency,
      anchorDayOf(schedule.startDate, previous),
      { rule: schedule.customRecurrence, startDate: schedule.startDate },
    );
    if (newNextDueDateStr <= previous) {
      throw new Error(
        `advanceScheduleCursor: frequency "${schedule.frequency}" of scheduled ` +
          `transaction ${schedule.id} does not advance ${previous}`,
      );
    }
    slotsConsumed += 1;
  } while (consumedSlots.has(newNextDueDateStr));

  await m
    .createQueryBuilder()
    .delete()
    .from(ScheduledTransactionOverride)
    .where("scheduledTransactionId = :id", { id: schedule.id })
    .andWhere("originalDate < :newNextDueDate", {
      newNextDueDate: newNextDueDateStr,
    })
    .execute();

  const updateFields: Partial<ScheduledTransaction> = {
    nextDueDate: newNextDueDateStr,
  };
  if (options.stampLastPosted !== false) {
    updateFields.lastPostedDate = todayYMD();
  }

  let occurrencesRemaining = schedule.occurrencesRemaining;
  if (
    schedule.occurrencesRemaining !== null &&
    schedule.occurrencesRemaining > 0
  ) {
    occurrencesRemaining = Math.max(
      0,
      schedule.occurrencesRemaining - slotsConsumed,
    );
    updateFields.occurrencesRemaining = occurrencesRemaining;
    if (occurrencesRemaining === 0) {
      updateFields.isActive = false;
    }
  }

  if (schedule.endDate && newNextDueDateStr > ensureYMD(schedule.endDate)) {
    updateFields.isActive = false;
  }

  await m.update(ScheduledTransaction, schedule.id, updateFields);
  return {
    nextDueDate: newNextDueDateStr,
    occurrencesRemaining,
    deactivated: updateFields.isActive === false,
    slotsConsumed,
  };
}

/**
 * The slot dates (YYYY-MM-DD) of every claim on the schedule dated on or after
 * `fromYmd`: the occurrences a post or a settlement rule has already consumed at
 * or ahead of the cursor. Read inside the transaction that holds the schedule
 * lock, after any claim it inserted, so the set passed to
 * `advanceScheduleCursor` is complete.
 */
export async function claimedSlotsFrom(
  m: EntityManager,
  scheduleId: string,
  fromYmd: string,
): Promise<Set<string>> {
  const rows = returnedRows<{ d: string }>(
    await m.query(
      `SELECT TO_CHAR(original_due_date, 'YYYY-MM-DD') AS d
         FROM scheduled_transaction_postings
        WHERE scheduled_transaction_id = $1 AND original_due_date >= $2`,
      [scheduleId, fromYmd],
    ),
  );
  return new Set(rows.map((row) => row.d));
}

/** The cursor columns of a schedule, as they stand before an advance or after it. */
export interface ScheduleCursorState {
  readonly nextDueDate: string;
  readonly occurrencesRemaining: number | null;
  readonly isActive: boolean;
  readonly lastPostedDate: string | null;
}

/**
 * An override row an advance pruned, in the shape it is re-inserted in: the
 * entity's own columns, without the timestamps the database regenerates.
 */
export type PrunedScheduleOverride = Pick<
  ScheduledTransactionOverride,
  | "id"
  | "scheduledTransactionId"
  | "originalDate"
  | "overrideDate"
  | "amount"
  | "categoryId"
  | "description"
  | "isSplit"
  | "splits"
  | "investmentQuantity"
  | "investmentPrice"
  | "investmentTotalAmount"
>;

/**
 * One advance of a schedule's cursor, recorded so it can be undone
 * (`docs/specs/loan-installment-settlement.md` sections 12.4 and 12.6): the
 * cursor columns before and after, and the override rows the advance pruned.
 */
export interface ScheduleCursorChange {
  readonly before: ScheduleCursorState;
  readonly after: ScheduleCursorState;
  readonly prunedOverrides: readonly PrunedScheduleOverride[];
}

/** The cursor columns of a schedule row as `YYYY-MM-DD` strings and plain values. */
export function scheduleCursorState(
  schedule: Pick<
    ScheduledTransaction,
    "nextDueDate" | "occurrencesRemaining" | "isActive" | "lastPostedDate"
  >,
): ScheduleCursorState {
  return {
    nextDueDate: ensureYMD(schedule.nextDueDate),
    occurrencesRemaining: schedule.occurrencesRemaining ?? null,
    isActive: schedule.isActive,
    lastPostedDate:
      schedule.lastPostedDate === null || schedule.lastPostedDate === undefined
        ? null
        : ensureYMD(schedule.lastPostedDate),
  };
}

/** The columns of an override row the rewind puts back. */
export function prunedScheduleOverride(
  override: ScheduledTransactionOverride,
): PrunedScheduleOverride {
  return {
    id: override.id,
    scheduledTransactionId: override.scheduledTransactionId,
    originalDate: ensureYMD(override.originalDate),
    overrideDate: ensureYMD(override.overrideDate),
    amount: override.amount ?? null,
    categoryId: override.categoryId ?? null,
    description: override.description ?? null,
    isSplit: override.isSplit ?? null,
    splits: override.splits ?? null,
    investmentQuantity: override.investmentQuantity ?? null,
    investmentPrice: override.investmentPrice ?? null,
    investmentTotalAmount: override.investmentTotalAmount ?? null,
  };
}

/**
 * The inverse of one `advanceScheduleCursor`, for the undo of a rule run that
 * settled the cursor's occurrence (`docs/specs/loan-installment-settlement.md`
 * section 12.6): put the cursor columns back to `change.before`, but only
 * while `next_due_date` still stands where that advance left it
 * (`change.after`), so a cursor the person has moved since is left as they
 * set it. Returns whether the cursor was rewound. When it was, the override
 * rows the advance pruned are re-inserted, `ON CONFLICT DO NOTHING` so an
 * override the person has since re-created for the same occurrence stands.
 *
 * Scoped to `userId`: an undo only ever touches the acting user's schedules.
 */
export async function rewindScheduleCursor(
  m: EntityManager,
  scheduleId: string,
  userId: string,
  change: ScheduleCursorChange,
): Promise<boolean> {
  const result = await m
    .createQueryBuilder()
    .update(ScheduledTransaction)
    .set({
      nextDueDate: change.before.nextDueDate,
      occurrencesRemaining: change.before.occurrencesRemaining,
      isActive: change.before.isActive,
      lastPostedDate: change.before.lastPostedDate,
    })
    .where("id = :id", { id: scheduleId })
    .andWhere("userId = :userId", { userId })
    .andWhere("nextDueDate = :after", { after: change.after.nextDueDate })
    .execute();
  if ((result.affected ?? 0) === 0) return false;
  if (change.prunedOverrides.length > 0) {
    await m
      .createQueryBuilder()
      .insert()
      .into(ScheduledTransactionOverride)
      .values(
        change.prunedOverrides.map((override) => ({
          ...override,
          scheduledTransactionId: scheduleId,
        })),
      )
      .orIgnore()
      .execute();
  }
  return true;
}
