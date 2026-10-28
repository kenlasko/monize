import { type EntityManager } from "typeorm";
import { lockTransactionRows } from "../common/db/locks";
import { accrualErrors } from "./accrual-errors";

/** No reviewed tag-removal impact command exists yet: refuse cascade loss on accrued sources. */
export async function guardAccruedTagDeletion(
  m: EntityManager,
  userId: string,
  tagId: string,
): Promise<void> {
  const members = async (): Promise<{ id: string }[]> =>
    m.query(
      `SELECT t.id,t.parent_transaction_id AS "parentId", ARRAY(SELECT s.transaction_id FROM transaction_splits s JOIN transactions p ON p.id=s.transaction_id WHERE p.user_id=$1 AND s.linked_transaction_id=t.id ORDER BY s.transaction_id) AS "splitParents" FROM transactions t WHERE t.user_id=$1 AND
    (EXISTS(SELECT 1 FROM transaction_tags a WHERE a.transaction_id=t.id AND a.tag_id=$2) OR
    EXISTS(SELECT 1 FROM transaction_splits s JOIN transaction_split_tags a ON a.transaction_split_id=s.id WHERE s.transaction_id=t.id AND a.tag_id=$2)) ORDER BY t.id`,
      [userId, tagId],
    );
  const before = await members();
  const parents: { id: string }[] = before.length
    ? await m.query(
        "SELECT id FROM transactions WHERE user_id=$1 AND parent_transaction_id IS NULL AND NOT EXISTS(SELECT 1 FROM transaction_splits leg_split WHERE leg_split.linked_transaction_id=transactions.id) AND (id=ANY($2::uuid[]) OR id IN(SELECT parent_transaction_id FROM transactions WHERE user_id=$1 AND id=ANY($2::uuid[])) OR id IN(SELECT s.transaction_id FROM transaction_splits s WHERE s.linked_transaction_id=ANY($2::uuid[]))) ORDER BY id",
        [userId, before.map((r) => r.id)],
      )
    : [];
  await lockTransactionRows(
    m,
    parents.map((r) => r.id),
    userId,
  );
  await lockTransactionRows(
    m,
    before.filter((r) => !parents.some((p) => p.id === r.id)).map((r) => r.id),
    userId,
  );
  await m.query("SELECT id FROM tags WHERE user_id=$1 AND id=$2 FOR UPDATE", [
    userId,
    tagId,
  ]);
  const after = await members();
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw accrualErrors.conflict();
  if (!after.length) return;
  const accrued = await m.query(
    `SELECT id FROM accrual_schedules WHERE user_id=$1 AND (source_transaction_id=ANY($2::uuid[]) OR source_transaction_id IN(SELECT parent_transaction_id FROM transactions WHERE user_id=$1 AND id=ANY($2::uuid[])) OR source_transaction_id IN(SELECT s.transaction_id FROM transaction_splits s JOIN transactions p ON p.id=s.transaction_id WHERE p.user_id=$1 AND s.linked_transaction_id=ANY($2::uuid[]))) LIMIT 1`,
    [userId, after.map((r) => r.id)],
  );
  if (accrued.length) throw accrualErrors.historyUnsupported();
}
/** Legacy tag-delete records omit cascaded links and cannot infer their targets. */
export async function guardLegacyTagRestore(
  m: EntityManager,
  userId: string,
): Promise<void> {
  if (
    (
      await m.query(
        "SELECT id FROM accrual_schedules WHERE user_id=$1 LIMIT 1",
        [userId],
      )
    ).length
  )
    throw accrualErrors.historyUnsupported();
}
