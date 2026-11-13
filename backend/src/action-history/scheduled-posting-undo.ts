import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { returnedRows } from "../common/db/query-result";
import { tr } from "../i18n/translate";
import { todayInTimezone, todayYMD } from "../common/date-utils";
import { getEffectiveTimezoneOfUser } from "../common/users-by-timezone.util";
import {
  ScheduleCursorChange,
  rewindScheduleCursor,
} from "../scheduled-transactions/schedule-cursor";
import {
  RemovedScheduleSnapshot,
  ScheduledPostingMoney,
  ScheduledPostingSnapshot,
  restoreRemovedSchedule,
} from "../scheduled-transactions/scheduled-posting-history";
import { ActionHistory } from "./entities/action-history.entity";

/** Removes the rows a posting wrote, through the undo of the matching create. */
export type ScheduledPostingMoneyRemover = (
  money: ScheduledPostingMoney,
) => Promise<void>;

/** What the undo of a posting leaves for the caller's after-commit work. */
export interface ScheduledPostingUndoResult {
  /** The schedule put back, whose loan template is repriced after the commit. */
  readonly scheduleIds: readonly string[];
  /** The security an investment posting traded, repriced after the commit. */
  readonly securityIds: readonly string[];
}

/**
 * Redo would post the occurrence again, which is `post()`'s job with today's
 * prices, rates and loan balance, not a replay of a stored snapshot: the
 * undo deleted the rows, and the ids it recorded name nothing now. So a
 * posting is not redoable; the person posts it again.
 */
export function assertScheduledPostingRedoable(): never {
  throw new ConflictException({
    message: tr(
      "errors.actionHistory.scheduledPostingRedo",
      "A posted scheduled transaction cannot be redone. Post it again from Bills & Deposits instead",
    ),
    errorCode: "SCHEDULED_POSTING_REDO",
  });
}

/**
 * Undo one posted occurrence (issue #2165), in the undo's transaction:
 *
 * 1. lock the schedule row, as `post()` does before it writes, and refuse,
 *    before any write, when a later occurrence of it has been claimed since
 *    (posted, or settled by a rule): that occurrence was priced and dated
 *    after this one, so this one is undone only once it is (last in, first
 *    out per schedule, as for a rule run's settlements); and when the cursor
 *    is no longer where the posting left it (`assertCursorUnmoved`);
 * 2. remove the rows the posting wrote, through the undo of the matching
 *    create (`removeMoney`), which locks them, refuses a reconciled one
 *    before writing and reverses each row's balance;
 * 3. release the occurrence claim (deleting a posted transaction already
 *    released it, `ON DELETE CASCADE`; an investment posting's names no row);
 * 4. put the schedule back: a recurring one's cursor rewound by
 *    `rewindScheduleCursor`, with the overrides the posting removed; a
 *    one-time one, which the posting deleted, re-inserted from its snapshot
 *    (`restoreRemovedSchedule`). Except where the auto-post cron would post
 *    that occurrence again (`wouldAutoPost`): it is then left skipped.
 *
 * Every write is scoped to the action's user.
 */
export async function undoScheduledPosting(
  action: ActionHistory,
  manager: EntityManager,
  removeMoney: ScheduledPostingMoneyRemover,
): Promise<ScheduledPostingUndoResult> {
  const snapshot = action.afterData as ScheduledPostingSnapshot | null;
  if (!snapshot?.scheduledTransactionId || !snapshot.money) {
    return { scheduleIds: [], securityIds: [] };
  }
  const userId = action.userId;
  const scheduleId = snapshot.scheduledTransactionId;

  const locked = returnedRows<{
    id: string;
    next_due_date: string;
    auto_post: boolean;
    amount_is_estimated: boolean;
  }>(
    await manager.query(
      `SELECT id, TO_CHAR(next_due_date, 'YYYY-MM-DD') AS next_due_date,
              auto_post, amount_is_estimated
         FROM scheduled_transactions
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [scheduleId, userId],
    ),
  );
  if (locked.length > 0 && snapshot.cursor) {
    await assertNoLaterOccurrence(manager, snapshot, userId);
    assertCursorUnmoved(
      snapshot,
      snapshot.cursor.after.nextDueDate,
      locked[0].next_due_date,
    );
  }

  await removeMoney(snapshot.money);

  await manager.query(
    `DELETE FROM scheduled_transaction_postings stp
      USING scheduled_transactions s
      WHERE stp.id = $1
        AND stp.scheduled_transaction_id = s.id
        AND s.user_id = $2`,
    [snapshot.claimId, userId],
  );

  // The day the cron decides "due" by: the user's effective timezone, as
  // `processAutoPostWithinContext` buckets them, not the request's.
  const today =
    todayInTimezone(await getEffectiveTimezoneOfUser(manager, userId)) ??
    todayYMD();
  if (snapshot.cursor && locked.length > 0) {
    const { before, after, prunedOverrides } = snapshot.cursor;
    const rewoundWouldAutoPost = wouldAutoPost(
      {
        autoPost: locked[0].auto_post,
        isActive: before.isActive,
        amountIsEstimated: locked[0].amount_is_estimated,
        nextDueDate: before.nextDueDate,
        overrideDate:
          prunedOverrides.find((o) => o.originalDate === before.nextDueDate)
            ?.overrideDate ?? null,
      },
      today,
    );
    if (rewoundWouldAutoPost) {
      // The occurrence is left as a skip leaves it: the cursor where the
      // posting moved it, `last_posted_date` as it was before. A schedule the
      // advance left active but that is inactive now was retired after the
      // commit by the payment this undo removed (a loan's last installment,
      // `rewriteLoanTemplate`): the debt is owed again, so it is active again.
      await manager.query(
        `UPDATE scheduled_transactions
            SET last_posted_date = $1,
                is_active = CASE WHEN $5::boolean THEN true ELSE is_active END
          WHERE id = $2 AND user_id = $3
            AND next_due_date = $4`,
        [
          before.lastPostedDate,
          scheduleId,
          userId,
          after.nextDueDate,
          before.isActive && after.isActive,
        ],
      );
      return result(snapshot);
    }
    // Cannot miss: the cursor was confirmed where the posting left it, under
    // the lock this transaction holds.
    await rewindScheduleCursor(
      manager,
      scheduleId,
      userId,
      await withoutGoneCategories(manager, userId, snapshot.cursor),
    );
    if (snapshot.estimatedAmount !== undefined) {
      // The estimate of the occurrence the cursor is back on, from a history
      // without the payment just removed: what it was before the posting.
      // Only the snapshot column, and only while the row is still estimated
      // (CONC-008).
      await manager.query(
        `UPDATE scheduled_transactions SET amount = $1
          WHERE id = $2 AND user_id = $3 AND amount_is_estimated = true`,
        [snapshot.estimatedAmount, scheduleId, userId],
      );
    }
  } else if (
    snapshot.removedSchedule &&
    locked.length === 0 &&
    !wouldAutoPost(removedScheduleState(snapshot.removedSchedule), today)
  ) {
    await restoreRemovedSchedule(manager, userId, snapshot.removedSchedule);
  }

  return result(snapshot);
}

function result(
  snapshot: ScheduledPostingSnapshot,
): ScheduledPostingUndoResult {
  return {
    scheduleIds: [snapshot.scheduledTransactionId],
    securityIds:
      snapshot.money.kind === "investment" && snapshot.money.securityId
        ? [snapshot.money.securityId]
        : [],
  };
}

/** What the auto-post cron reads of a schedule to decide it is due. */
interface AutoPostState {
  readonly autoPost: boolean;
  readonly isActive: boolean;
  readonly amountIsEstimated: boolean;
  readonly nextDueDate: string;
  /** The date an override of the `nextDueDate` occurrence moved it to. */
  readonly overrideDate: string | null;
}

/**
 * Whether the hourly auto-post cron would post this schedule's occurrence
 * again at its next run (`processAutoPostWithinContext`: active,
 * auto-posting, not estimated, and due on or before today by the occurrence's
 * override date when it has one, an earlier one included, else by
 * `next_due_date`; `findPostponedIds` and the cron's `overrideDueIds`). Putting the schedule back on such an
 * occurrence would only re-post what the person just undid, so the undo of
 * an automatic (or due, auto-posting) posting removes the payment and frees
 * the occurrence but leaves it skipped (issue #2165, maintainer decision).
 */
function wouldAutoPost(state: AutoPostState, today: string): boolean {
  return (
    state.autoPost &&
    state.isActive &&
    !state.amountIsEstimated &&
    (state.overrideDate ?? state.nextDueDate) <= today
  );
}

/** The `AutoPostState` of a one-time schedule's snapshot (snake_case `to_jsonb`). */
function removedScheduleState(removed: RemovedScheduleSnapshot): AutoPostState {
  const row = removed.schedule as {
    auto_post?: boolean;
    is_active?: boolean;
    amount_is_estimated?: boolean;
    next_due_date?: string;
  };
  const nextDueDate = String(row.next_due_date ?? "").slice(0, 10);
  const override = removed.overrides.find(
    (o) => String(o.original_date ?? "").slice(0, 10) === nextDueDate,
  );
  return {
    autoPost: row.auto_post === true,
    isActive: row.is_active === true,
    amountIsEstimated: row.amount_is_estimated === true,
    nextDueDate,
    overrideDate: override
      ? String(override.override_date ?? "").slice(0, 10) || null
      : null,
  };
}

/**
 * A claim on a later slot that was not there when the posting ran: a later
 * occurrence posted, or settled by a rule, since. One the posting found
 * (a rule had settled a slot ahead of the cursor, which the advance stepped
 * over) is not "later" than this posting and does not refuse it.
 */
async function assertNoLaterOccurrence(
  manager: EntityManager,
  snapshot: ScheduledPostingSnapshot,
  userId: string,
): Promise<void> {
  const known = new Set(snapshot.laterClaimedSlots ?? []);
  const later = returnedRows<{ d: string }>(
    await manager.query(
      `SELECT TO_CHAR(stp.original_due_date, 'YYYY-MM-DD') AS d
         FROM scheduled_transaction_postings stp
         JOIN scheduled_transactions s
           ON s.id = stp.scheduled_transaction_id AND s.user_id = $3
        WHERE stp.scheduled_transaction_id = $1
          AND stp.original_due_date > $2
          AND stp.id <> $4
        ORDER BY stp.original_due_date`,
      [
        snapshot.scheduledTransactionId,
        snapshot.dueDate,
        userId,
        snapshot.claimId,
      ],
    ),
  ).filter((claim) => !known.has(claim.d));
  if (later.length === 0) return;
  throw new ConflictException({
    message: tr(
      "errors.actionHistory.scheduledPostingUndoLaterOccurrence",
      "A later occurrence of this scheduled transaction has been posted since, so this posting cannot be undone. Undo or delete the later one first",
    ),
    errorCode: "SCHEDULED_POSTING_UNDO_LATER_OCCURRENCE",
    scheduledTransactionId: snapshot.scheduledTransactionId,
    dueDate: later[0].d,
  });
}

/**
 * The cursor moved since the posting without an entry of its own (a skip,
 * which records none): rewinding it would undo that too, and leaving it
 * would drop the posted occurrence for good, since nothing offers a slot
 * behind the cursor again. Refused, so the person decides.
 */
function assertCursorUnmoved(
  snapshot: ScheduledPostingSnapshot,
  postedTo: string,
  nextDueDate: string,
): void {
  if (nextDueDate === postedTo) return;
  throw new ConflictException({
    message: tr(
      "errors.actionHistory.scheduledPostingUndoCursorMoved",
      "This scheduled transaction has moved on since this posting (an occurrence was skipped or its next date changed), so the posting cannot be undone. Delete the posted transaction instead",
    ),
    errorCode: "SCHEDULED_POSTING_UNDO_CURSOR_MOVED",
    scheduledTransactionId: snapshot.scheduledTransactionId,
  });
}

/**
 * The cursor change with the category of each override it re-inserts cleared
 * where that category has been deleted since, as `ON DELETE SET NULL` did to
 * every live override: the re-insert would otherwise fail its foreign key.
 */
async function withoutGoneCategories(
  manager: EntityManager,
  userId: string,
  change: ScheduleCursorChange,
): Promise<ScheduleCursorChange> {
  const named = [
    ...new Set(
      change.prunedOverrides
        .map((o) => o.categoryId)
        .filter((id): id is string => !!id),
    ),
  ];
  if (named.length === 0) return change;
  const kept = new Set(
    returnedRows<{ id: string }>(
      await manager.query(
        `SELECT id FROM categories WHERE id = ANY($1::uuid[]) AND user_id = $2`,
        [named, userId],
      ),
    ).map((row) => row.id),
  );
  return {
    ...change,
    prunedOverrides: change.prunedOverrides.map((o) =>
      o.categoryId && !kept.has(o.categoryId) ? { ...o, categoryId: null } : o,
    ),
  };
}
