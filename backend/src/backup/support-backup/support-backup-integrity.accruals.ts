import type { RefRule } from "./support-backup-integrity";

function composite(
  refTable: string,
  pairs: readonly (readonly [string, string])[],
): RefRule[] {
  const targetColumns = pairs.map(([local, remote]) => ({ local, remote }));
  return pairs.map(([column]) => ({
    column,
    refTable,
    onMissing: "dropRow",
    targetColumns,
  }));
}

/** Each FK constituent remains visible to the existing completeness guard. */
export const ACCRUAL_REFS: Record<string, RefRule[]> = {
  accrual_schedules: [
    ...composite("transactions", [
      ["source_transaction_id", "id"],
      ["user_id", "user_id"],
    ]),
    ...composite("transaction_splits", [
      ["source_split_id", "id"],
      ["source_transaction_id", "transaction_id"],
    ]),
    ...composite("accrual_system_accounts", [
      ["user_id", "user_id"],
      ["family", "family"],
      ["currency_code", "currency_code"],
    ]),
  ],
  accrual_allocations: [
    ...composite("accrual_schedules", [
      ["schedule_id", "id"],
      ["user_id", "user_id"],
    ]),
  ],
};
