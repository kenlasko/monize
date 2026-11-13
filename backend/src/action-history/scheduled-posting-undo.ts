import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { returnedRows } from "../common/db/query-result";
import { tr } from "../i18n/translate";
import { rewindScheduleCursor } from "../scheduled-transactions/schedule-cursor";
import {
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
 *    out per schedule, as for a rule run's settlements);
 * 2. remove the rows the posting wrote, through the undo of the matching
 *    create (`removeMoney`), which refuses a reconciled row before writing
 *    and reverses each row's balance;
 * 3. release the occurrence claim (deleting a posted transaction already
 *    released it, `ON DELETE CASCADE`; an investment posting's names no row);
 * 4. put the schedule back: a recurring one's cursor rewound by
 *    `rewindScheduleCursor`, only while it still stands where the posting
 *    left it, with the overrides the posting removed; a one-time one, which
 *    the posting deleted, re-inserted from its snapshot.
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

  const locked = returnedRows<{ id: string }>(
    await manager.query(
      `SELECT id FROM scheduled_transactions
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [scheduleId, userId],
    ),
  );
  if (locked.length > 0) {
    await assertNoLaterOccurrence(manager, snapshot, userId);
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

  if (snapshot.cursor && locked.length > 0) {
    await rewindScheduleCursor(manager, scheduleId, userId, snapshot.cursor);
  } else if (snapshot.removedSchedule && locked.length === 0) {
    await restoreRemovedSchedule(manager, userId, snapshot.removedSchedule);
  }

  return {
    scheduleIds: [scheduleId],
    securityIds:
      snapshot.money.kind === "investment" && snapshot.money.securityId
        ? [snapshot.money.securityId]
        : [],
  };
}

async function assertNoLaterOccurrence(
  manager: EntityManager,
  snapshot: ScheduledPostingSnapshot,
  userId: string,
): Promise<void> {
  const later = returnedRows<{ d: string }>(
    await manager.query(
      `SELECT TO_CHAR(stp.original_due_date, 'YYYY-MM-DD') AS d
         FROM scheduled_transaction_postings stp
         JOIN scheduled_transactions s
           ON s.id = stp.scheduled_transaction_id AND s.user_id = $3
        WHERE stp.scheduled_transaction_id = $1
          AND stp.original_due_date > $2
          AND stp.id <> $4
        ORDER BY stp.original_due_date
        LIMIT 1`,
      [
        snapshot.scheduledTransactionId,
        snapshot.dueDate,
        userId,
        snapshot.claimId,
      ],
    ),
  );
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
