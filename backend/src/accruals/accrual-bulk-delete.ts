import { isUUID } from "class-validator";
import type { EntityManager } from "typeorm";
import { ActionHistory } from "../action-history/entities/action-history.entity";
import { MAX_JSONB_SIZE_BYTES } from "../action-history/history-limits";
import { canonical } from "./accrual-source-edit";
import {
  captureAccrualHistorySnapshot,
  assertAccrualStructureRestorable,
} from "./accrual-history-snapshot";
import { accrualErrors } from "./accrual-errors";
import { tr } from "../i18n/translate";

export type BulkDeleteSnapshot = Record<string, unknown> & {
  id: string;
  accountId: string;
  currencyCode: string;
};
export interface AccrualBulkDeleteData {
  accrualBulkDeleteVersion: 1;
  transactions: BulkDeleteSnapshot[];
}

export function parseAccrualBulkDelete(value: unknown): AccrualBulkDeleteData {
  const data = value as AccrualBulkDeleteData | null;
  if (
    data?.accrualBulkDeleteVersion !== 1 ||
    !Array.isArray(data.transactions) ||
    !data.transactions.length ||
    Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_JSONB_SIZE_BYTES
  )
    throw accrualErrors.historyUnsupported();
  const ids = new Set<string>();
  for (const snapshot of data.transactions) {
    if (
      !snapshot ||
      !isUUID(snapshot.id) ||
      !isUUID(snapshot.accountId) ||
      !snapshot.accrualState ||
      ids.has(snapshot.id) ||
      typeof snapshot.currencyCode !== "string"
    )
      throw accrualErrors.historyUnsupported();
    assertAccrualStructureRestorable(snapshot);
    ids.add(snapshot.id);
  }
  return data;
}

/** includes VOID: investment identity excludes unsupported holding reconstruction. */
export async function assertAccrualBulkDeleteStructure(
  m: EntityManager,
  userId: string,
  snapshots: readonly BulkDeleteSnapshot[],
): Promise<void> {
  for (const row of snapshots) {
    if (row.isTransfer || row.linkedTransactionId || row.parentTransactionId)
      throw accrualErrors.historyUnsupported();
    assertAccrualStructureRestorable(row);
  }
  const investments: { id: string }[] = await m.query(
    "SELECT i.id FROM investment_transactions i JOIN transactions t ON t.id=i.transaction_id WHERE t.user_id=$1 AND t.id=ANY($2) LIMIT 1",
    [userId, snapshots.map((row) => row.id)],
  );
  if (investments.length) throw accrualErrors.historyUnsupported();
}

/** Caller has locked the entire delete set; ordinary cash-only deletion stays legacy. */
export async function captureAccrualBulkDelete(
  m: EntityManager,
  userId: string,
  ids: readonly string[],
): Promise<AccrualBulkDeleteData | null> {
  if (!ids.length) return null;
  const accrued: { id: string }[] = await m.query(
    "SELECT id FROM accrual_schedules WHERE user_id=$1 AND source_transaction_id=ANY($2) LIMIT 1",
    [userId, ids],
  );
  if (!accrued.length) return null;
  const transactions: BulkDeleteSnapshot[] = [];
  for (const id of [...ids].sort()) {
    const snapshot: Record<string, unknown> = {};
    await captureAccrualHistorySnapshot(m, userId, id, snapshot, true);
    transactions.push(snapshot as BulkDeleteSnapshot);
  }
  const data = parseAccrualBulkDelete({
    accrualBulkDeleteVersion: 1,
    transactions,
  });
  await assertAccrualBulkDeleteStructure(m, userId, transactions);
  return data;
}

/**
 * Required history is a direct, non-swallowing write at the END of the source
 * transaction, after account locks. Do not call async best-effort record() here.
 * A failed history insert rolls back the deletion and every balance adjustment.
 */
export async function recordRequiredAccrualBulkDelete(
  m: EntityManager,
  userId: string,
  data: AccrualBulkDeleteData,
): Promise<void> {
  parseAccrualBulkDelete(data);
  const repo = m.getRepository(ActionHistory);
  await repo.delete({ userId, isUndone: true });
  await repo.save(
    repo.create({
      userId,
      entityType: "bulk_transaction",
      entityId: null,
      action: "bulk_delete",
      beforeData: { ...data },
      afterData: null,
      description: tr(
        "common.accruals.bulkDeleted",
        `Deleted ${data.transactions.length} transactions`,
        { count: data.transactions.length },
      ),
      descriptionKey: null,
      descriptionParams: null,
    }),
  );
}

/** JSON normalization preserves Date values before stable key ordering. */
export function equalBulkDeleteSnapshots(
  a: BulkDeleteSnapshot,
  b: BulkDeleteSnapshot,
): boolean {
  const normalized = (value: BulkDeleteSnapshot) =>
    canonical(JSON.parse(JSON.stringify(value)));
  return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
}

/** Category-only batches have no split side effects; remove FK children explicitly. */
export async function clearAccrualBulkDeleteChildren(
  m: EntityManager,
  userId: string,
  ids: readonly string[],
): Promise<void> {
  await m.query(
    `DELETE FROM transaction_split_tags st USING transaction_splits s,transactions t
     WHERE st.transaction_split_id=s.id AND s.transaction_id=t.id AND t.user_id=$1 AND t.id=ANY($2)`,
    [userId, ids],
  );
  await m.query(
    `DELETE FROM transaction_splits s USING transactions t
     WHERE s.transaction_id=t.id AND t.user_id=$1 AND t.id=ANY($2)`,
    [userId, ids],
  );
  await m.query(
    `DELETE FROM transaction_tags tt USING transactions t
     WHERE tt.transaction_id=t.id AND t.user_id=$1 AND t.id=ANY($2)`,
    [userId, ids],
  );
}
