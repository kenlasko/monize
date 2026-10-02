import { createHash } from "node:crypto";
import type { EntityManager } from "typeorm";
import { returnedRows } from "../common/db/query-result";
import type { PlannedBankRow } from "./bank-transaction-planner";

/** One ledger row among the keys asked about. */
export interface LedgerEntry {
  /** True for an exception (spec section 7b): added from the preview, no transaction. */
  excluded: boolean;
}

/**
 * The ledger rows, among `keys`, that the Monize account's ledger already holds
 * (INV-BANKSYNC-001), keyed by external key. A read-only `SELECT` in the
 * caller's transaction, filtered by `userId`. An exception (`excluded_at` set)
 * is a ledger row like any other: it claims its key, so it is as much "already
 * held" as an imported row; the preview tells the two apart by `excluded`.
 */
export async function findLedgerEntries(
  m: EntityManager,
  userId: string,
  accountId: string,
  keys: readonly string[],
): Promise<Map<string, LedgerEntry>> {
  if (keys.length === 0) return new Map();
  const rows = returnedRows<{
    external_key: string;
    excluded?: boolean | null;
  }>(
    await m.query(
      `SELECT external_key, (excluded_at IS NOT NULL) AS excluded
         FROM bank_sync_imported_transactions
        WHERE account_id = $1
          AND user_id = $2
          AND external_key = ANY($3::varchar[])`,
      [accountId, userId, [...keys]],
    ),
  );
  return new Map(
    rows.map((row) => [row.external_key, { excluded: row.excluded === true }]),
  );
}

/**
 * The keys, among `keys`, that the Monize account's ledger already holds
 * (INV-BANKSYNC-001): imported rows and exceptions alike. The preview lists a
 * row as already held by it, and a sync that carries a fingerprint recomputes
 * the new rows by it, so both ask the ledger the same question.
 */
export async function findLedgerKeys(
  m: EntityManager,
  userId: string,
  accountId: string,
  keys: readonly string[],
): Promise<Set<string>> {
  return new Set((await findLedgerEntries(m, userId, accountId, keys)).keys());
}

/** The planned rows whose key the ledger does not hold: what a sync would write. */
export function newPlannedRows(
  planned: readonly PlannedBankRow[],
  ledgerKeys: ReadonlySet<string>,
): PlannedBankRow[] {
  return planned.filter((row) => !ledgerKeys.has(row.externalKey));
}

/**
 * The fingerprint of what an import would write (spec section 7a): the SHA-256
 * of the new rows' keys and amounts, in key order. The amount is read at the
 * column's four decimals, so a float's spelling cannot move it. The preview
 * returns it and a sync that carries it recomputes it under the row lock, so a
 * provider answer that changed between the two is refused before anything is
 * written.
 */
export function planFingerprint(
  newRows: readonly Pick<PlannedBankRow, "externalKey" | "amount">[],
): string {
  const pairs = newRows
    .map((row): [string, string] => [row.externalKey, row.amount.toFixed(4)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(pairs)).digest("hex");
}
