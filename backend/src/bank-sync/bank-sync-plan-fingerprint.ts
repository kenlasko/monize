import { createHash } from "node:crypto";
import type { EntityManager } from "typeorm";
import { returnedRows } from "../common/db/query-result";
import { BANK_SYNC_MONEY_DECIMALS } from "./bank-sync.constants";
import type { PlannedBankRow } from "./bank-transaction-planner";

/** The ledger row that already holds a planned row. */
export interface HeldLedgerRow {
  /**
   * The key the ledger row carries: the planned row's own key, or a key a sync
   * before A26-H09's fix gave the same bank transaction (`legacyKeys`). It is
   * the key an exception is taken back by.
   */
  key: string;
  /** True for an exception (spec section 7b): added from the preview, no transaction. */
  excluded: boolean;
}

/**
 * The planned rows the Monize account's ledger already holds (INV-BANKSYNC-001),
 * keyed by the planned row's `externalKey`. A read-only `SELECT` in the
 * caller's transaction, filtered by `userId`. A planned row is held when the
 * ledger has, first match wins:
 *
 * 1. its own key;
 * 2. its legacy `contested` key: the same reference and the same whole content;
 * 3. its legacy `bare` key booked on the row's date: the row of that reference a
 *    sync before the fix imported on that day. Its amount was never recorded,
 *    so every row of the reference and date reads as held by it, which can
 *    leave a second same-day row of a reused reference unimported; a row of
 *    the reference on another day is a different transaction and is new.
 *
 * An exception (`excluded_at` set) is a ledger row like any other: it claims
 * its key, so it is as much "already held" as an imported row; the preview
 * tells the two apart by `excluded`. The preview lists a row as already held by
 * this, and the sync skips and fingerprints by it, so both ask the ledger the
 * same question.
 */
export async function findHeldRows(
  m: EntityManager,
  userId: string,
  accountId: string,
  planned: readonly PlannedBankRow[],
): Promise<Map<string, HeldLedgerRow>> {
  const candidates = new Set<string>();
  for (const row of planned) {
    candidates.add(row.externalKey);
    if (row.legacyKeys !== null) {
      candidates.add(row.legacyKeys.contested);
      candidates.add(row.legacyKeys.bare);
    }
  }
  if (candidates.size === 0) return new Map();
  const rows = returnedRows<{
    external_key: string;
    booking_date: string;
    excluded?: boolean | null;
  }>(
    await m.query(
      `SELECT external_key,
              TO_CHAR(booking_date, 'YYYY-MM-DD') AS booking_date,
              (excluded_at IS NOT NULL) AS excluded
         FROM bank_sync_imported_transactions
        WHERE account_id = $1
          AND user_id = $2
          AND external_key = ANY($3::varchar[])`,
      [accountId, userId, [...candidates]],
    ),
  );
  const ledger = new Map(rows.map((row) => [row.external_key, row]));
  const held = new Map<string, HeldLedgerRow>();
  for (const row of planned) {
    const legacy = row.legacyKeys;
    const bare = legacy === null ? undefined : ledger.get(legacy.bare);
    const match =
      ledger.get(row.externalKey) ??
      (legacy === null ? undefined : ledger.get(legacy.contested)) ??
      (bare !== undefined && bare.booking_date === row.transactionDate
        ? bare
        : undefined);
    if (match === undefined) continue;
    held.set(row.externalKey, {
      key: match.external_key,
      excluded: match.excluded === true,
    });
  }
  return held;
}

/** The planned rows the ledger does not hold (`findHeldRows`): what a sync would write. */
export function newPlannedRows(
  planned: readonly PlannedBankRow[],
  held: ReadonlyMap<string, HeldLedgerRow>,
): PlannedBankRow[] {
  return planned.filter((row) => !held.has(row.externalKey));
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
  review?: unknown,
): string {
  const pairs = newRows
    .map((row): [string, string] => [
      row.externalKey,
      row.amount.toFixed(BANK_SYNC_MONEY_DECIMALS),
    ])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256")
    .update(JSON.stringify(review === undefined ? pairs : { pairs, review }))
    .digest("hex");
}
