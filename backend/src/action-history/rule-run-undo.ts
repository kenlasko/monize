import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { LockedTransactionRow, lockTransactionRows } from "../common/db/locks";
import { tr } from "../i18n/translate";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { assertReconciledRowsMutable } from "../transactions/reconciled-lock.util";
import {
  LegBalanceWriter,
  removeLockedTransactionLeg,
} from "../transactions/remove-transaction-leg";
import { ActionHistory } from "./entities/action-history.entity";

/** The entity type a manual rule run is recorded under. */
export const RULE_RUN_ENTITY_TYPE = "transaction_rule_run";

interface RuleRunRowSnapshot {
  id: string;
  categoryId?: string | null;
  payeeId?: string | null;
  payeeName?: string | null;
  description?: string | null;
  tagIds?: string[];
  isTransfer?: boolean;
  isSplit?: boolean;
  linkedTransactionId?: string | null;
  /** Present on a row a structural action converted or split. */
  structure?: {
    kind: "transfer" | "split";
    counterpartIds: string[];
    /** A split's lines the run created; absent on a transfer. */
    lineIds?: string[];
  };
}

/**
 * Redo replays the after side, and a structural run's after side is a set of
 * counterpart legs and split lines that the undo deleted: recreating them is
 * the rule's job, through a fresh run, not a replay of stored ids. So a run
 * that restructured a row is not redoable (spec section 6).
 */
export function assertRuleRunRedoable(action: ActionHistory): void {
  const rows = action.beforeData?.transactions;
  if (
    Array.isArray(rows) &&
    (rows as RuleRunRowSnapshot[]).some((row) => row.structure !== undefined)
  ) {
    throw new ConflictException({
      message: tr(
        "errors.transactionRules.runRedoStructural",
        "This run restructured transactions (transfers or splits), so it cannot be redone. Run the rule again instead",
      ),
      errorCode: "RULE_RUN_REDO_STRUCTURAL",
    });
  }
}

/**
 * Put every row of a rule run back to the snapshot in `beforeData` (undo), or
 * to the one in `afterData` (redo, which swaps the two before it gets here).
 *
 * The snapshot holds only the fields the run changed: category, payee with its
 * name, description, and the tag set. A payee the run created stays: it is
 * reference data, as when a form creates one. The rows are locked in ascending id order and checked
 * against the strict reconciled lock first (INV-RECONCILE-001: an undo alters
 * the row like the edit did), so a refusal leaves every row as it was. Every
 * write is scoped to the action's user.
 *
 * A structural row (`structure`) also had counterpart legs created in another
 * account, and for a split its lines. The legs are locked with the rows
 * (a transfer's counterpart with its row, ascending; a split's legs after the
 * parent, the order `common/db/locks.ts` requires), checked against the
 * reconciled lock with them, then each is deleted conditionally and its balance
 * contribution reversed by `removeLockedTransactionLeg` (`deletionBalanceEffect`
 * of the locked row), so a leg already gone, or relinked elsewhere, is skipped
 * and moves nothing. The split lines are deleted and the row's category and
 * structural flags come back from the snapshot. Returns the accounts whose
 * balance moved.
 */
export async function undoRuleRun(
  action: ActionHistory,
  manager: EntityManager,
  balances: LegBalanceWriter,
): Promise<Set<string>> {
  const affectedAccountIds = new Set<string>();
  const rows = action.beforeData?.transactions;
  if (!Array.isArray(rows) || rows.length === 0) return affectedAccountIds;
  const snapshots = rows as RuleRunRowSnapshot[];

  const counterpartIdsOf = (kind: "transfer" | "split"): string[] =>
    snapshots.flatMap((row) =>
      row.structure?.kind === kind ? row.structure.counterpartIds : [],
    );
  const locked = await lockTransactionRows(
    manager,
    [...snapshots.map((row) => row.id), ...counterpartIdsOf("transfer")],
    action.userId,
  );
  const splitLegIds = counterpartIdsOf("split");
  // After the parents: a split parent is locked before any of its legs.
  const lockedSplitLegs =
    splitLegIds.length > 0
      ? await lockTransactionRows(manager, splitLegIds, action.userId)
      : new Map<string, LockedTransactionRow>();
  await assertReconciledRowsMutable(manager, action.userId, [
    ...locked.values(),
    ...lockedSplitLegs.values(),
  ]);

  // Before the first write: a row whose structure is no longer the run's
  // refuses the whole undo.
  await assertStructureUnchanged(manager, action.userId, snapshots, locked);

  const tagRows: { transactionId: string; tagId: string }[] = [];
  const tagOwners: string[] = [];
  for (const row of snapshots) {
    // A row deleted since the run has nothing to restore.
    if (!locked.has(row.id)) continue;
    if (row.structure) {
      for (const accountId of await removeCounterparts(
        manager,
        action.userId,
        row,
        new Map([...locked, ...lockedSplitLegs]),
        balances,
      )) {
        affectedAccountIds.add(accountId);
      }
    }
    const fields: Partial<
      Pick<
        Transaction,
        | "categoryId"
        | "payeeId"
        | "payeeName"
        | "description"
        | "isTransfer"
        | "isSplit"
        | "linkedTransactionId"
      >
    > = {};
    if ("isTransfer" in row) fields.isTransfer = row.isTransfer ?? false;
    if ("isSplit" in row) fields.isSplit = row.isSplit ?? false;
    if ("linkedTransactionId" in row) {
      fields.linkedTransactionId = row.linkedTransactionId ?? null;
    }
    if ("categoryId" in row) fields.categoryId = row.categoryId ?? null;
    if ("payeeId" in row) fields.payeeId = row.payeeId ?? null;
    if ("payeeName" in row) fields.payeeName = row.payeeName ?? null;
    if ("description" in row) fields.description = row.description ?? null;
    if (Object.keys(fields).length > 0) {
      await manager.update(
        Transaction,
        { id: row.id, userId: action.userId },
        fields,
      );
    }
    if (Array.isArray(row.tagIds)) {
      tagOwners.push(row.id);
      for (const tagId of row.tagIds) {
        tagRows.push({ transactionId: row.id, tagId });
      }
    }
  }

  if (tagOwners.length === 0) return affectedAccountIds;
  // Two statements for the whole run: replace the tag set of every row that
  // recorded one. A tag deleted since is skipped by the join.
  await manager.query(
    `DELETE FROM transaction_tags tt
      USING transactions t
      WHERE tt.transaction_id = t.id
        AND t.user_id = $1
        AND t.id = ANY($2::uuid[])`,
    [action.userId, tagOwners],
  );
  if (tagRows.length > 0) {
    await manager.query(
      `INSERT INTO transaction_tags (transaction_id, tag_id)
       SELECT p.transaction_id, p.tag_id
         FROM unnest($2::uuid[], $3::uuid[]) AS p(transaction_id, tag_id)
         JOIN transactions t ON t.id = p.transaction_id AND t.user_id = $1
         JOIN tags g ON g.id = p.tag_id AND g.user_id = $1
       ON CONFLICT DO NOTHING`,
      [
        action.userId,
        tagRows.map((row) => row.transactionId),
        tagRows.map((row) => row.tagId),
      ],
    );
  }
  return affectedAccountIds;
}

/**
 * Refuse the undo when a structural row now carries structure the run did not
 * write (spec section 6). The undo deletes the row's split lines and the legs
 * it recorded; a line a person added or replaced since (`PUT /splits` records
 * no history) has its own counterpart leg, which that delete would orphan with
 * its balance, and a transfer relinked to another leg is no longer the run's
 * to unpick. Something the run wrote that is GONE is fine (nothing is left to
 * orphan, and the removal is skipped as before); something present that the
 * run did not write is not. Runs after the row locks, before any write.
 */
async function assertStructureUnchanged(
  manager: EntityManager,
  userId: string,
  snapshots: readonly RuleRunRowSnapshot[],
  locked: ReadonlyMap<string, LockedTransactionRow>,
): Promise<void> {
  const splitIds = snapshots
    .filter((row) => row.structure?.kind === "split" && locked.has(row.id))
    .map((row) => row.id);
  const lines: {
    id: string;
    transaction_id: string;
    linked_transaction_id: string | null;
  }[] =
    splitIds.length === 0
      ? []
      : await manager.query(
          `SELECT s.id, s.transaction_id, s.linked_transaction_id
             FROM transaction_splits s
             JOIN transactions t ON t.id = s.transaction_id AND t.user_id = $1
            WHERE s.transaction_id = ANY($2::uuid[])`,
          [userId, splitIds],
        );
  for (const row of snapshots) {
    const structure = row.structure;
    const current = locked.get(row.id);
    if (!structure || !current) continue;
    const recordedLegs = new Set(structure.counterpartIds);
    let changed: boolean;
    if (structure.kind === "transfer") {
      const link = current.linkedTransactionId ?? null;
      changed = link !== null && !recordedLegs.has(link);
    } else {
      const recordedLines =
        structure.lineIds === undefined ? null : new Set(structure.lineIds);
      changed = lines
        .filter((line) => line.transaction_id === row.id)
        .some(
          (line) =>
            (recordedLines !== null && !recordedLines.has(line.id)) ||
            (line.linked_transaction_id !== null &&
              !recordedLegs.has(line.linked_transaction_id)),
        );
    }
    if (changed) {
      throw new ConflictException({
        message: tr(
          "errors.transactionRules.runUndoStructureChanged",
          "A transaction this run restructured has been changed since (its split lines or its transfer), so the run cannot be undone safely. Restore it by hand",
        ),
        errorCode: "RULE_RUN_UNDO_STRUCTURE_CHANGED",
        transactionId: row.id,
      });
    }
  }
}

/**
 * Delete the counterpart legs a structural row created, reversing each one's
 * balance contribution, and for a split the split lines. A leg that is gone or
 * no longer linked to this row is left alone (it is not this run's to remove).
 * Returns the accounts whose balance moved.
 */
async function removeCounterparts(
  manager: EntityManager,
  userId: string,
  row: RuleRunRowSnapshot,
  lockedLegs: ReadonlyMap<string, LockedTransactionRow>,
  balances: LegBalanceWriter,
): Promise<string[]> {
  const moved: string[] = [];
  for (const legId of row.structure?.counterpartIds ?? []) {
    const leg = lockedLegs.get(legId);
    if (!leg || leg.linkedTransactionId !== row.id) continue;
    if (await removeLockedTransactionLeg(manager, leg, userId, balances)) {
      moved.push(leg.accountId);
    }
  }
  if (row.structure?.kind === "split") {
    await manager.delete(TransactionSplit, { transactionId: row.id });
  }
  return moved;
}
