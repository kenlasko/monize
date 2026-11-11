import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { returnedRows } from "../common/db/query-result";
import { todayYMD } from "../common/date-utils";
import {
  assertFixedCadence,
  calculateNextDueDate,
  ensureYMD,
  FrequencyType,
} from "../common/recurrence";
import { tr } from "../i18n/translate";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "../scheduled-transactions/entities/scheduled-transaction-override.entity";
import {
  advanceScheduleCursor,
  claimedSlotsFrom,
  prunedScheduleOverride,
  ScheduleCursorChange,
  scheduleCursorState,
} from "../scheduled-transactions/schedule-cursor";
import { LoanSettlementPlan, pricingColumn } from "./loan-settlement.types";

/**
 * The claim a settlement writes on the occurrence it paid
 * (`docs/specs/loan-installment-settlement.md` sections 12.1 and 12.3,
 * INV-LOAN-008): one `scheduled_transaction_postings` row keyed on the slot,
 * on the caller's `EntityManager`, after the split it accounts for, and the
 * cursor advance when the slot is the schedule's `next_due_date`.
 *
 * Nothing here decides whether the slot is free: that is the planner's
 * (`occurrence_already_posted`), made before any write from the claims read
 * under the schedule row lock (section 13). The `ON CONFLICT DO NOTHING` is
 * the database's own guarantee against a plan made on stale facts, so zero
 * rows is the backstop `ConflictException` of decision 17, and the caller's
 * transaction rolls the split back with it; it is not a second decision
 * point that records a refusal.
 */
export interface ClaimLoanOccurrenceInput {
  readonly plan: LoanSettlementPlan;
  /** The settled row: the claim's `transaction_id`. */
  readonly transactionId: string;
  /** The rule whose action planned the settlement: the claim's `rule_id`. */
  readonly ruleId: string;
  /** The row's date: the claim's `posted_date`. */
  readonly postedDate: string;
}

/** What the claim wrote: the row's id and what it did to the cursor. */
export interface ClaimedLoanOccurrence {
  readonly claimId: string;
  readonly scheduledTransactionId: string;
  /** The slot claimed, the claim's `original_due_date`. */
  readonly dueDate: string;
  /** True when the slot was the schedule's `next_due_date`, so the cursor moved. */
  readonly cursorAdvanced: boolean;
  /** The advance, recorded for the undo; present exactly when `cursorAdvanced`. */
  readonly cursor?: ScheduleCursorChange;
}

/** The error code the backstop conflict carries. */
export const OCCURRENCE_ALREADY_POSTED_CODE = "OCCURRENCE_ALREADY_POSTED";

/**
 * Claim the planned slot for `transactionId`, then advance the cursor when the
 * slot is the schedule's current `next_due_date`.
 *
 * The cursor is compared on the locked schedule row, read here, never on the
 * plan's `advancesCursor` alone: the facts the plan was made from were read in
 * this transaction under the same lock, so the two agree, and the row is what
 * the write is about. The advance is `advanceScheduleCursor`, the function
 * `post()` calls, over every claim dated on or after the slot (the one just
 * written included), so the cursor steps past consecutive claimed slots and
 * the bill never offers an occurrence whose own key is taken. A cadence that
 * does not step (`ONCE`, a value outside `FrequencyType`) has no next slot:
 * the schedule is deactivated with `last_posted_date` set, the
 * claim-preserving counterpart of the delete `post()` makes for a `ONCE` bill
 * (deleting the schedule would cascade to the claim).
 */
export async function claimLoanOccurrence(
  m: EntityManager,
  userId: string,
  input: ClaimLoanOccurrenceInput,
): Promise<ClaimedLoanOccurrence> {
  const { plan } = input;
  // A bare ON CONFLICT covers both unique indexes (the occurrence key and the
  // one claim per transaction), so either refuses as a 409 rather than a raw
  // unique violation. The planner keeps both unreachable: a taken slot is
  // `occurrence_already_posted`, and a row any claim already names is
  // `row_from_scheduled_posting` (`loan-settlement-facts.ts`, `postedRows`).
  const inserted = returnedRows<{ id: string }>(
    await m.query(
      `INSERT INTO scheduled_transaction_postings
         (scheduled_transaction_id, original_due_date, posted_date,
          transaction_id, source, rule_id, pricing)
       VALUES ($1, $2, $3, $4, 'rule', $5, $6::jsonb)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        plan.scheduledTransactionId,
        plan.dueDate,
        input.postedDate,
        input.transactionId,
        input.ruleId,
        JSON.stringify(pricingColumn(plan)),
      ],
    ),
  );
  if (inserted.length === 0) {
    throw new ConflictException({
      message: tr(
        "errors.transactionRules.occurrenceAlreadyPosted",
        "This loan installment has already been paid or posted, so the transaction cannot settle it",
      ),
      errorCode: OCCURRENCE_ALREADY_POSTED_CODE,
      scheduledTransactionId: plan.scheduledTransactionId,
      dueDate: plan.dueDate,
    });
  }
  const claimId = inserted[0].id;

  const schedule = await m.getRepository(ScheduledTransaction).findOne({
    where: { id: plan.scheduledTransactionId, userId },
    lock: { mode: "pessimistic_write" },
  });
  if (!schedule) {
    // The planner read it, locked, in this transaction; only a deleted row
    // can be missing here, and the claim would then have failed its foreign key.
    throw new Error(
      `claimLoanOccurrence: scheduled transaction ${plan.scheduledTransactionId} vanished mid-write`,
    );
  }
  const claimed = {
    claimId,
    scheduledTransactionId: schedule.id,
    dueDate: plan.dueDate,
  };
  if (ensureYMD(schedule.nextDueDate) !== plan.dueDate) {
    return { ...claimed, cursorAdvanced: false };
  }
  return {
    ...claimed,
    cursorAdvanced: true,
    cursor: await advanceClaimedCursor(m, schedule),
  };
}

/** Advance (or, for a cadence that cannot step, retire) the locked schedule, recording the change. */
async function advanceClaimedCursor(
  m: EntityManager,
  schedule: ScheduledTransaction,
): Promise<ScheduleCursorChange> {
  const before = scheduleCursorState(schedule);
  const overrides = m.getRepository(ScheduledTransactionOverride);
  const held = await overrides.find({
    where: { scheduledTransactionId: schedule.id },
  });

  assertFixedCadence(schedule.frequency, "claimLoanOccurrence");
  const steps =
    calculateNextDueDate(
      before.nextDueDate,
      schedule.frequency as FrequencyType,
    ) > before.nextDueDate;
  if (!steps) {
    await m.update(ScheduledTransaction, schedule.id, {
      isActive: false,
      lastPostedDate: todayYMD(),
    });
  } else {
    await advanceScheduleCursor(
      m,
      schedule,
      await claimedSlotsFrom(m, schedule.id, before.nextDueDate),
    );
  }

  const advanced = await m
    .getRepository(ScheduledTransaction)
    .findOne({ where: { id: schedule.id } });
  if (!advanced) {
    throw new Error(
      `claimLoanOccurrence: scheduled transaction ${schedule.id} vanished mid-write`,
    );
  }
  const kept = new Set(
    (
      await overrides.find({ where: { scheduledTransactionId: schedule.id } })
    ).map((override) => override.id),
  );
  return {
    before,
    after: scheduleCursorState(advanced),
    prunedOverrides: held
      .filter((override) => !kept.has(override.id))
      .map(prunedScheduleOverride),
  };
}
