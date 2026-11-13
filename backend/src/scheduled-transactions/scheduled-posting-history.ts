import { EntityManager } from "typeorm";
import { returnedRows } from "../common/db/query-result";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import { todayYMD } from "../common/date-utils";
import { ensureYMD } from "../common/recurrence";
import {
  ScheduleCursorAdvance,
  ScheduleCursorChange,
  ScheduleCursorState,
  prunedScheduleOverride,
  scheduleCursorState,
} from "./schedule-cursor";

/**
 * The history entry of one posted occurrence (issue #2165). `post()` writes
 * the money through the transaction, transfer or investment service with their
 * own history switched off and records this one entry after its commit, so the
 * undo puts back everything the posting did: the money, the occurrence claim
 * and the schedule's cursor (or, for a one-time bill, the schedule itself).
 */
export const SCHEDULED_POSTING_ENTITY_TYPE = "scheduled_posting";
export const SCHEDULED_POSTING_ACTION = "post";

/** The rows a posting wrote, by kind. */
export type ScheduledPostingMoney =
  | { readonly kind: "transaction"; readonly transactionId: string }
  | {
      readonly kind: "transfer";
      readonly fromTransactionId: string;
      readonly toTransactionId: string;
      readonly fromAccountId: string;
      readonly toAccountId: string;
    }
  | {
      readonly kind: "investment";
      readonly investmentTransactionId: string;
      readonly securityId: string | null;
    };

/**
 * A one-time schedule the posting deleted, as its rows stood (`to_jsonb` of
 * each, every column), with the rows that went with it by `ON DELETE CASCADE`
 * and that the bill needs to be posted again: its split lines, their tags and
 * its overrides. The occurrence claim is not kept: the undo releases it.
 */
export interface RemovedScheduleSnapshot {
  readonly schedule: Record<string, unknown>;
  readonly splits: readonly Record<string, unknown>[];
  readonly splitTags: readonly Record<string, unknown>[];
  readonly overrides: readonly Record<string, unknown>[];
}

/** `afterData` of a `scheduled_posting` entry. */
export interface ScheduledPostingSnapshot {
  readonly scheduledTransactionId: string;
  readonly claimId: string;
  /** The occurrence's own slot, the claim's `original_due_date`. */
  readonly dueDate: string;
  readonly money: ScheduledPostingMoney;
  /** A recurring schedule's cursor advance. */
  readonly cursor?: ScheduleCursorChange;
  /** A one-time schedule, deleted by the posting. */
  readonly removedSchedule?: RemovedScheduleSnapshot;
}

/**
 * What a cursor advance is measured against: the locked row's cursor columns
 * and the override rows it holds, read before the posting removes the
 * occurrence's override and before the advance prunes the rest.
 */
export interface CursorBaseline {
  readonly before: ScheduleCursorState;
  readonly held: readonly ScheduledTransactionOverride[];
}

export async function cursorBaseline(
  m: EntityManager,
  schedule: ScheduledTransaction,
): Promise<CursorBaseline> {
  return {
    before: scheduleCursorState(schedule),
    held: await m.getRepository(ScheduledTransactionOverride).find({
      where: { scheduledTransactionId: schedule.id },
    }),
  };
}

/**
 * The advance a posting made, from what `advanceScheduleCursor` wrote: the
 * cursor columns as it left them and the overrides the posting removed (the
 * occurrence's own and those the advance pruned, every one dated before the
 * new `next_due_date`), in the shape `rewindScheduleCursor` re-inserts.
 */
export function cursorChangeOf(
  baseline: CursorBaseline,
  advance: ScheduleCursorAdvance,
): ScheduleCursorChange {
  return {
    before: baseline.before,
    after: {
      nextDueDate: advance.nextDueDate,
      occurrencesRemaining: advance.occurrencesRemaining,
      isActive: advance.deactivated ? false : baseline.before.isActive,
      // `advanceScheduleCursor` stamps the posting day.
      lastPostedDate: todayYMD(),
    },
    prunedOverrides: baseline.held
      .filter(
        (override) => ensureYMD(override.originalDate) < advance.nextDueDate,
      )
      .map(prunedScheduleOverride),
  };
}

/**
 * Every row of a one-time schedule that its deletion takes with it and that a
 * restore needs, read inside the posting's transaction before the delete.
 */
export async function snapshotRemovedSchedule(
  m: EntityManager,
  scheduleId: string,
): Promise<RemovedScheduleSnapshot> {
  const rowsOf = async (sql: string): Promise<Record<string, unknown>[]> =>
    returnedRows<{ row: Record<string, unknown> }>(
      await m.query(sql, [scheduleId]),
    ).map((r) => r.row);
  const [schedule] = await rowsOf(
    `SELECT to_jsonb(s) AS row FROM scheduled_transactions s WHERE s.id = $1`,
  );
  return {
    schedule,
    splits: await rowsOf(
      `SELECT to_jsonb(sp) AS row FROM scheduled_transaction_splits sp
        WHERE sp.scheduled_transaction_id = $1`,
    ),
    splitTags: await rowsOf(
      `SELECT to_jsonb(st) AS row FROM scheduled_transaction_split_tags st
         JOIN scheduled_transaction_splits sp
           ON sp.id = st.scheduled_transaction_split_id
        WHERE sp.scheduled_transaction_id = $1`,
    ),
    overrides: await rowsOf(
      `SELECT to_jsonb(o) AS row FROM scheduled_transaction_overrides o
        WHERE o.scheduled_transaction_id = $1`,
    ),
  };
}

/**
 * Put back a one-time schedule `snapshotRemovedSchedule` read. Every row is
 * rebuilt by the database from its own column list
 * (`jsonb_populate_record`), so no column is lost on the way. The schedule
 * is written under `userId` whatever the snapshot says, the children only
 * under that schedule, and a split tag only for a tag the user still holds.
 * Returns false, writing nothing, when a schedule with the id already exists.
 */
export async function restoreRemovedSchedule(
  m: EntityManager,
  userId: string,
  snapshot: RemovedScheduleSnapshot,
): Promise<boolean> {
  const restored = returnedRows<{ id: string }>(
    await m.query(
      `INSERT INTO scheduled_transactions
       SELECT * FROM jsonb_populate_record(
         NULL::scheduled_transactions,
         $1::jsonb || jsonb_build_object('user_id', $2::text)
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [JSON.stringify(snapshot.schedule), userId],
    ),
  );
  if (restored.length === 0) return false;
  const scheduleId = restored[0].id;
  if (snapshot.splits.length > 0) {
    await m.query(
      `INSERT INTO scheduled_transaction_splits
       SELECT r.* FROM jsonb_populate_recordset(
         NULL::scheduled_transaction_splits, $1::jsonb
       ) r
        WHERE r.scheduled_transaction_id = $2
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(snapshot.splits), scheduleId],
    );
  }
  if (snapshot.splitTags.length > 0) {
    await m.query(
      `INSERT INTO scheduled_transaction_split_tags
       SELECT r.* FROM jsonb_populate_recordset(
         NULL::scheduled_transaction_split_tags, $1::jsonb
       ) r
         JOIN scheduled_transaction_splits sp
           ON sp.id = r.scheduled_transaction_split_id
          AND sp.scheduled_transaction_id = $2
         JOIN tags g ON g.id = r.tag_id AND g.user_id = $3
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(snapshot.splitTags), scheduleId, userId],
    );
  }
  if (snapshot.overrides.length > 0) {
    await m.query(
      `INSERT INTO scheduled_transaction_overrides
       SELECT r.* FROM jsonb_populate_recordset(
         NULL::scheduled_transaction_overrides, $1::jsonb
       ) r
        WHERE r.scheduled_transaction_id = $2
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(snapshot.overrides), scheduleId],
    );
  }
  return true;
}
