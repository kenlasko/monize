import { EntityManager } from "typeorm";
import { LockedTransactionRow } from "../common/db/locks";
import { deletionBalanceEffect } from "../common/deletion-balance.util";
import { roundMoney } from "../common/round.util";
import { Transaction } from "./entities/transaction.entity";
import { LegBalanceWriter } from "./remove-transaction-leg";

/**
 * Re-total a split parent and move its account by the difference, in one
 * place.
 *
 * Two paths change what a split parent adds up to: editing a split-transfer
 * leg's amount from the target side (`updateSplitTransferLeg`) and removing one
 * line (`removeSplit`, issue #2025). Each wrote its own copy of the amount
 * update and the balance rule beside it (issue #2039).
 *
 * The balance moves by `newAmount - parent.amount` under the deletion rule: a
 * re-total removes the difference from the parent, so a VOID parent moves no
 * balance and a future-dated one gets a recomputation instead of a delta
 * (`deletionBalanceEffect`).
 *
 * `parent` is the row locked inside the caller's transaction, so the old amount
 * the difference is taken from is the committed one. Returns true when the
 * amount changed; the caller then adds `parent.accountId` to the accounts it
 * invalidates after the commit (INV-CACHE-001).
 */
export async function retotalSplitParent(
  m: EntityManager,
  userId: string,
  parent: Pick<
    LockedTransactionRow,
    "id" | "accountId" | "amount" | "status" | "transactionDate"
  >,
  newAmount: number,
  balances: LegBalanceWriter,
): Promise<boolean> {
  const oldAmount = roundMoney(Number(parent.amount));
  const nextAmount = roundMoney(newAmount);
  if (nextAmount === oldAmount) return false;

  await m.update(Transaction, parent.id, { amount: nextAmount });

  const effect = deletionBalanceEffect({
    amount: roundMoney(oldAmount - nextAmount),
    status: parent.status,
    transactionDate: parent.transactionDate,
  });
  if (effect.delta !== 0) {
    await balances.updateBalance(parent.accountId, effect.delta);
  }
  if (effect.needsRecalc) {
    await balances.recalculateCurrentBalance(userId, parent.accountId);
  }
  return true;
}
