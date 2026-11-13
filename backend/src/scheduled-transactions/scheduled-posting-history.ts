import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { returnedRows } from "../common/db/query-result";
import { tr } from "../i18n/translate";
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
 * each, every column), with what its delete took with it: by `ON DELETE
 * CASCADE` its split lines, their tags, its overrides and its payroll
 * deduction rules with their periods, and by `ON DELETE SET NULL` the loan
 * accounts naming it as their payment schedule. The occurrence claim is not
 * kept: the undo releases it.
 */
export interface RemovedScheduleSnapshot {
  readonly schedule: Record<string, unknown>;
  readonly splits: readonly Record<string, unknown>[];
  readonly splitTags: readonly Record<string, unknown>[];
  readonly overrides: readonly Record<string, unknown>[];
  readonly payrollRules: readonly Record<string, unknown>[];
  readonly payrollRulePeriods: readonly Record<string, unknown>[];
  readonly linkedAccountIds: readonly string[];
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
  /**
   * The slots after `dueDate` already claimed when the posting ran (a rule's
   * settlement ahead of the cursor, which the advance stepped over): not an
   * occurrence posted after this one.
   */
  readonly laterClaimedSlots?: readonly string[];
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
    payrollRules: await rowsOf(
      `SELECT to_jsonb(pr) AS row FROM payroll_deduction_rules pr
        WHERE pr.scheduled_transaction_id = $1`,
    ),
    payrollRulePeriods: await rowsOf(
      `SELECT to_jsonb(pp) AS row FROM payroll_deduction_rule_periods pp
         JOIN payroll_deduction_rules pr ON pr.id = pp.rule_id
        WHERE pr.scheduled_transaction_id = $1`,
    ),
    linkedAccountIds: (
      await rowsOf(
        `SELECT to_jsonb(a.id) AS row FROM accounts a
          WHERE a.scheduled_transaction_id = $1`,
      )
    ).map((id) => String(id)),
  };
}

/**
 * Put back a one-time schedule `snapshotRemovedSchedule` read, in the undo's
 * transaction. Every row is rebuilt by the database from its own column list
 * (`jsonb_populate_record`), so no column is lost on the way. The schedule is
 * written under `userId` whatever the snapshot says, the children only under
 * that schedule and that user, and a split tag only for a tag the user still
 * holds.
 *
 * A row it names that has been deleted since is treated as the delete would
 * have treated a live schedule: a category or a transfer account is cleared
 * (`ON DELETE SET NULL`), as is a payee (the schedule keeps `payee_name`), and
 * a payroll rule whose category is gone is not restored (`ON DELETE CASCADE`).
 * Anything else gone (the account, a security, a currency) refuses the undo
 * with `SCHEDULED_POSTING_UNDO_REFERENCE_GONE` and the transaction rolls back.
 *
 * Returns false, writing nothing, when a schedule with the id already exists.
 */
export async function restoreRemovedSchedule(
  m: EntityManager,
  userId: string,
  snapshot: RemovedScheduleSnapshot,
): Promise<boolean> {
  try {
    return await restoreRows(m, userId, snapshot);
  } catch (error) {
    if (
      (error as { driverError?: { code?: string } })?.driverError?.code !==
      "23503"
    ) {
      throw error;
    }
    throw new ConflictException({
      message: tr(
        "errors.actionHistory.scheduledPostingUndoReferenceGone",
        "Something this scheduled transaction used (an account, a security or a currency) has been deleted since, so the posting cannot be undone. Delete the posted transaction instead",
      ),
      errorCode: "SCHEDULED_POSTING_UNDO_REFERENCE_GONE",
    });
  }
}

async function restoreRows(
  m: EntityManager,
  userId: string,
  snapshot: RemovedScheduleSnapshot,
): Promise<boolean> {
  const restored = returnedRows<{ id: string }>(
    await m.query(
      `INSERT INTO scheduled_transactions
       SELECT * FROM jsonb_populate_record(
         NULL::scheduled_transactions,
         $1::jsonb || jsonb_build_object(
           'user_id', $2::text,
           'category_id', (SELECT c.id FROM categories c
                            WHERE c.id = ($1::jsonb ->> 'category_id')::uuid),
           'payee_id', (SELECT p.id FROM payees p
                         WHERE p.id = ($1::jsonb ->> 'payee_id')::uuid),
           'transfer_account_id', (SELECT a.id FROM accounts a
                                    WHERE a.id = ($1::jsonb ->> 'transfer_account_id')::uuid)
         )
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [JSON.stringify(snapshot.schedule), userId],
    ),
  );
  if (restored.length === 0) return false;
  const scheduleId = restored[0].id;
  const insert = async (
    rows: readonly unknown[] | undefined,
    sql: string,
    params: readonly unknown[],
  ): Promise<void> => {
    if (!rows || rows.length === 0) return;
    await m.query(sql, [JSON.stringify(rows), ...params]);
  };
  // A line's category, gone since, is cleared as the delete would have.
  await insert(
    snapshot.splits,
    `INSERT INTO scheduled_transaction_splits
     SELECT r.* FROM jsonb_array_elements($1::jsonb) e,
       LATERAL jsonb_populate_record(
         NULL::scheduled_transaction_splits,
         e.value || jsonb_build_object(
           'category_id', (SELECT c.id FROM categories c
                            WHERE c.id = (e.value ->> 'category_id')::uuid)
         )
       ) r
      WHERE r.scheduled_transaction_id = $2
     ON CONFLICT (id) DO NOTHING`,
    [scheduleId],
  );
  await insert(
    snapshot.splitTags,
    `INSERT INTO scheduled_transaction_split_tags
     SELECT r.* FROM jsonb_populate_recordset(
       NULL::scheduled_transaction_split_tags, $1::jsonb
     ) r
       JOIN scheduled_transaction_splits sp
         ON sp.id = r.scheduled_transaction_split_id
        AND sp.scheduled_transaction_id = $2
       JOIN tags g ON g.id = r.tag_id AND g.user_id = $3
     ON CONFLICT DO NOTHING`,
    [scheduleId, userId],
  );
  await insert(
    snapshot.overrides,
    `INSERT INTO scheduled_transaction_overrides
     SELECT r.* FROM jsonb_array_elements($1::jsonb) e,
       LATERAL jsonb_populate_record(
         NULL::scheduled_transaction_overrides,
         e.value || jsonb_build_object(
           'category_id', (SELECT c.id FROM categories c
                            WHERE c.id = (e.value ->> 'category_id')::uuid)
         )
       ) r
      WHERE r.scheduled_transaction_id = $2
     ON CONFLICT DO NOTHING`,
    [scheduleId],
  );
  await insert(
    snapshot.payrollRules,
    `INSERT INTO payroll_deduction_rules
     SELECT r.* FROM jsonb_populate_recordset(
       NULL::payroll_deduction_rules, $1::jsonb
     ) r
       JOIN categories c ON c.id = r.category_id
      WHERE r.scheduled_transaction_id = $2 AND r.user_id = $3
     ON CONFLICT DO NOTHING`,
    [scheduleId, userId],
  );
  await insert(
    snapshot.payrollRulePeriods,
    `INSERT INTO payroll_deduction_rule_periods
     SELECT r.* FROM jsonb_populate_recordset(
       NULL::payroll_deduction_rule_periods, $1::jsonb
     ) r
       JOIN payroll_deduction_rules pr
         ON pr.id = r.rule_id AND pr.scheduled_transaction_id = $2
      WHERE r.user_id = $3
     ON CONFLICT DO NOTHING`,
    [scheduleId, userId],
  );
  if (snapshot.linkedAccountIds && snapshot.linkedAccountIds.length > 0) {
    // Only a link nothing has taken since.
    await m.query(
      `UPDATE accounts SET scheduled_transaction_id = $1
        WHERE id = ANY($2::uuid[]) AND user_id = $3
          AND scheduled_transaction_id IS NULL`,
      [scheduleId, snapshot.linkedAccountIds, userId],
    );
  }
  return true;
}
