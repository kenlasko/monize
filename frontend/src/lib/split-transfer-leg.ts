import type { Transaction, TransactionSplit } from '@/types/transaction';

/**
 * The split parent a receiving transfer leg belongs to, or null for any other
 * row. Such a leg links to the PARENT (whose amount is the total of every
 * line), not to a mirror leg, so it is not a whole transfer.
 */
export function splitTransferParent(tx: Transaction): Transaction | null {
  const linked = tx.linkedTransaction;
  return tx.isTransfer && linked?.isSplit ? linked : null;
}

/** The split line of the parent that this receiving leg was created from, if loaded. */
export function splitTransferLine(tx: Transaction): TransactionSplit | null {
  return (
    splitTransferParent(tx)?.splits?.find((line) => line.linkedTransactionId === tx.id) ?? null
  );
}
