import { EntityManager } from "typeorm";
import { tr } from "../i18n/translate";
import { NotFoundException } from "@nestjs/common";

/**
 * The rows a delete with `reassignTo` moved, kept in the delete's history entry
 * so its undo can move them back and its redo can move them again.
 *
 * An entry over `MAX_JSONB_SIZE_BYTES` is not recorded at all: no undo is better
 * than an undo that restores a category and leaves its rows elsewhere.
 */
export interface MovedCategoryRows {
  /** The category the rows moved to; null is uncategorized. */
  to: string | null;
  transactions: string[];
  transactionSplits: string[];
  scheduled: string[];
  scheduledSplits: string[];
  overrides: string[];
  overrideSplits: { id: string; before: unknown; after: unknown }[];
}

export function hasMovedRows(moved: MovedCategoryRows): boolean {
  return (
    moved.transactions.length +
      moved.transactionSplits.length +
      moved.scheduled.length +
      moved.scheduledSplits.length +
      moved.overrides.length +
      moved.overrideSplits.length >
    0
  );
}

/** The `movedRows` of a category delete's snapshot, when it carries one. */
export function movedRowsOf(
  snapshot: Record<string, any> | null | undefined,
): MovedCategoryRows | null {
  const moved = snapshot?.movedRows;
  return moved && typeof moved === "object" ? moved : null;
}

/**
 * Move the listed rows from category `from` to `to`, only where they still
 * point at `from` (a compare-and-set per row: a row changed since is left
 * alone). `IS NOT DISTINCT FROM` makes null (uncategorized) match null.
 * A row whose target was deleted since reads NULL, not the target's id, so it
 * is not pulled back: a later delete changed it.
 * `reverse` swaps the override JSON: undo writes `before` where it still reads
 * `after`; redo writes `after` where it still reads `before`.
 */
export async function moveListedRows(
  m: EntityManager,
  userId: string,
  moved: MovedCategoryRows,
  from: string | null,
  to: string | null,
  reverse: boolean,
): Promise<void> {
  const move = async (table: string, ids: string[], scope: string) => {
    if (ids.length === 0) return;
    // `table` and `scope` are literals below, never request values.
    await m.query(
      `UPDATE ${table} x SET category_id = $1${
        table === "transactions" || table === "scheduled_transactions"
          ? ", updated_at = CURRENT_TIMESTAMP"
          : ""
      }
        WHERE x.id = ANY($3::uuid[]) AND x.category_id IS NOT DISTINCT FROM $4::uuid
          AND ${scope}`,
      [to, userId, ids, from],
    );
  };
  await move("transactions", moved.transactions, "x.user_id = $2");
  await move(
    "transaction_splits",
    moved.transactionSplits,
    "EXISTS (SELECT 1 FROM transactions t WHERE t.id = x.transaction_id AND t.user_id = $2)",
  );
  await move("scheduled_transactions", moved.scheduled, "x.user_id = $2");
  await move(
    "scheduled_transaction_splits",
    moved.scheduledSplits,
    "EXISTS (SELECT 1 FROM scheduled_transactions t WHERE t.id = x.scheduled_transaction_id AND t.user_id = $2)",
  );
  await move(
    "scheduled_transaction_overrides",
    moved.overrides,
    "EXISTS (SELECT 1 FROM scheduled_transactions t WHERE t.id = x.scheduled_transaction_id AND t.user_id = $2)",
  );
  if (moved.overrideSplits.length > 0) {
    const rows = moved.overrideSplits.map((r) =>
      reverse
        ? { id: r.id, set: r.before, expect: r.after }
        : { id: r.id, set: r.after, expect: r.before },
    );
    // jsonb equality: key order and whitespace do not matter.
    await m.query(
      `UPDATE scheduled_transaction_overrides o SET splits = r.set
         FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, "set" jsonb, expect jsonb),
              scheduled_transactions t
        WHERE o.id = r.id AND o.splits = r.expect
          AND t.id = o.scheduled_transaction_id AND t.user_id = $2`,
      [JSON.stringify(rows), userId],
    );
  }
}

/**
 * Redo of a delete that moved rows: lock the category and its target in id
 * order (as `CategoriesService.remove` does), refuse if the target is gone,
 * then move the same rows to it again so the reference check that follows
 * finds nothing and the delete matches the original. A category that is
 * already gone has nothing to move.
 */
export async function redoMovedRows(
  m: EntityManager,
  userId: string,
  categoryId: string,
  moved: MovedCategoryRows,
): Promise<void> {
  const lock = (id: string, mode: "UPDATE" | "SHARE") =>
    m.query(
      `SELECT id FROM categories WHERE id = $1 AND user_id = $2 FOR ${mode}`,
      [id, userId],
    );
  const target = moved.to;
  let targetRows: unknown[] | null = null;
  if (target && target < categoryId) {
    targetRows = await lock(target, "SHARE");
  }
  const own = await lock(categoryId, "UPDATE");
  if (target && targetRows === null) {
    targetRows = await lock(target, "SHARE");
  }
  if (target && !targetRows?.length) {
    throw new NotFoundException(
      tr(
        "errors.actionHistory.redoDeleteTargetGone",
        "Cannot redo this delete: the category its rows moved to no longer exists.",
      ),
    );
  }
  if (!own?.length) return;
  await moveListedRows(m, userId, moved, categoryId, target, false);
}
