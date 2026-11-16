import type { EntityManager } from "typeorm";
import {
  findPossibleDuplicates,
  type DuplicateCandidate,
} from "../import-preview/possible-duplicates";
import type { PlannedBankRow } from "./bank-transaction-planner";

/**
 * The possible duplicates among a sync's new rows
 * (docs/specs/import-duplicate-review.md section 4): each new row, by key,
 * paired with the transaction already in the account it looks like. Only a
 * transaction bank sync neither wrote nor linked is compared. The preview and
 * the write both ask this, the write under its locks, so they pair the same
 * rows.
 */
export function findBankRowDuplicates(
  m: EntityManager,
  userId: string,
  accountId: string,
  newRows: readonly PlannedBankRow[],
): Promise<Map<string, DuplicateCandidate>> {
  return findPossibleDuplicates(
    m,
    userId,
    accountId,
    newRows.map((row) => ({
      ref: row.externalKey,
      date: row.transactionDate,
      amount: row.amount,
    })),
    { excludeBankSynced: true },
  );
}
