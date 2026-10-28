import type { EntityManager } from "typeorm";
import { lockTransactionRows } from "../common/db/locks";
import { assertReconciledRowsMutable } from "../transactions/reconciled-lock.util";
import { requireAccrualOwner } from "./accrual-source";
import { refreshSourceAccruals } from "./accrual-lifecycle";
import { accrualErrors } from "./accrual-errors";

/**
 * Non-structural history replay retains source/split identities. Lock all accrued
 * sources before the first write; refresh with the same manager before commit.
 * This does not restore schedules lost to deletion or split reconstruction.
 */
export async function lockAccrualReplaySources(
  m: EntityManager,
  userId: string,
  transactionIds: readonly string[],
): Promise<string[]> {
  const ids = [...new Set(transactionIds)].sort();
  if (!ids.length) return [];
  // Freeze every source before discovering schedules. A concurrent schedule
  // create must serialize here too, including batches that started with none.
  const locked = await lockTransactionRows(m, ids, userId);
  if (locked.size !== ids.length) throw accrualErrors.conflict();
  await assertReconciledRowsMutable(m, userId, [...locked.values()]);
  const rows: { id: string }[] = await m.query(
    "SELECT DISTINCT source_transaction_id AS id FROM accrual_schedules WHERE user_id=$1 AND source_transaction_id=ANY($2) ORDER BY id",
    [userId, ids],
  );
  if (rows.length) requireAccrualOwner(userId);
  return rows.map((row) => row.id);
}

export async function refreshAccrualReplaySources(
  m: EntityManager,
  userId: string,
  transactionIds: readonly string[],
): Promise<void> {
  for (const id of transactionIds) await refreshSourceAccruals(m, userId, id);
}
