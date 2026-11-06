import { TransactionStatus } from "../transactions/entities/transaction.entity";
import { isTransactionInFuture, formatDateYMDLocal } from "./date-utils";
import { MONEY_SCALE, roundMoney } from "./round.util";

/**
 * A row that a balance may or may not include.
 *
 * Deliberately structural rather than `Transaction`: the import paths hold raw
 * query rows, and the rule is about three fields, not about an entity.
 */
export interface DeletableRow {
  amount: number | string;
  status?: TransactionStatus | string | null;
  transactionDate: string | Date;
}

/**
 * How much an account's balance must move when this row is deleted.
 *
 * A deletion reverses exactly what the row contributed, and a row contributes
 * nothing when it is `VOID` (excluded from `recalculateCurrentBalance` and from
 * every report) or future-dated (never folded into `currentBalance`). So the
 * answer for either is `0` -- reversing a VOID row creates the money the void
 * withheld.
 *
 * This exists as one function because the rule was written out at nine deletion
 * sites across four services and three of them omitted the status check. Two of
 * the three sat in the *same function* as a correct one: `removeParentTransaction`
 * guarded the deleted row and the split parent and not the sibling counterparts,
 * so deleting one leg under a VOID parent debited every other target account by
 * its own amount (recheck RR4-001). The import and investment cash-leg cleanups
 * had the same omission.
 *
 * Call it and act on the result rather than re-deriving the condition:
 *
 * ```ts
 * const { delta, needsRecalc } = deletionBalanceEffect(row);
 * if (delta !== 0) await this.accountsService.updateBalance(row.accountId, delta);
 * await m.remove(row);
 * if (needsRecalc) await this.accountsService.recalculateCurrentBalance(row.accountId);
 * ```
 *
 * `deletion-balance.guard.spec.ts` scans for a new hand-rolled reversal.
 */
export function deletionBalanceEffect(row: DeletableRow): {
  /** Amount to pass to `updateBalance`; `0` means do not call it at all. */
  delta: number;
  /**
   * Whether the account needs a full recompute after the row is gone instead of
   * an incremental nudge. True only for a future-dated row: it was never in the
   * balance, but removing it can change what a projection shows.
   */
  needsRecalc: boolean;
} {
  const date =
    row.transactionDate instanceof Date
      ? formatDateYMDLocal(row.transactionDate)
      : row.transactionDate;

  // One date evaluation per row, deliberately: two calls made the answer depend
  // on how many times the clock was read.
  const isFuture = isTransactionInFuture(date);

  if (row.status === TransactionStatus.VOID) {
    return { delta: 0, needsRecalc: false };
  }
  if (isFuture) return { delta: 0, needsRecalc: true };
  // The stored amount negated, at the column scale: a stored value already
  // carries at most its currency's places, so rounding at `MONEY_SCALE` only
  // normalizes the double and never drops a coin's satoshis (a fiat amount at
  // four places reads back the same at eight).
  return {
    delta: roundMoney(-Number(row.amount), MONEY_SCALE),
    needsRecalc: false,
  };
}
