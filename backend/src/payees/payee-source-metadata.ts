import { In, type EntityManager } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import { refreshSourceAccruals } from "../accruals/accrual-lifecycle";

export interface PayeeSourceRow {
  id: string;
  payeeId: string;
}

/** Freeze the whole operation's source set before payee or source writes. */
export async function lockPayeeSources(
  m: EntityManager,
  userId: string,
  payeeIds: readonly string[],
): Promise<PayeeSourceRow[]> {
  if (!payeeIds.length) return [];
  return m.query(
    `SELECT id,payee_id AS "payeeId" FROM transactions
     WHERE user_id=$1 AND payee_id=ANY($2::uuid[])
     ORDER BY id FOR UPDATE`,
    [userId, [...new Set(payeeIds)].sort()],
  );
}

/** Metadata only: amounts, allocation periods, bank balances and split IDs stay put. */
export async function updatePayeeSourceMetadata(
  m: EntityManager,
  userId: string,
  sources: readonly PayeeSourceRow[],
  sourcePayeeId: string,
  patch: { payeeId?: string; payeeName: string },
): Promise<number> {
  const ids = sources
    .filter((row) => row.payeeId === sourcePayeeId)
    .map((row) => row.id);
  if (!ids.length) return 0;
  const result = await m.update(
    Transaction,
    { userId, id: In(ids), payeeId: sourcePayeeId },
    patch,
  );
  // A fresh statement after locking also sees schedules committed while a
  // source lock was queued. Cash-only batches avoid one refresh query per row.
  const scheduled: { id: string }[] = await m.query(
    `SELECT DISTINCT source_transaction_id AS id FROM accrual_schedules
     WHERE user_id=$1 AND source_transaction_id=ANY($2::uuid[]) ORDER BY id`,
    [userId, ids],
  );
  for (const { id } of scheduled) await refreshSourceAccruals(m, userId, id);
  return result.affected ?? 0;
}
