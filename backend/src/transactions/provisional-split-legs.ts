import { EntityManager } from "typeorm";
import { MONEY_SCALE, roundMoney } from "../common/round.util";
import { Transaction } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";

/** A provisional counterpart of one of a split parent's transfer lines. */
export interface ProvisionalSplitLeg {
  accountId: string;
  /** Signed as stored, at the column scale. */
  amount: number;
}

const storedAmount = (value: unknown): number =>
  roundMoney(Number(value), MONEY_SCALE);

/**
 * The provisional counterparts of a split parent's transfer lines, read
 * before a replacement of the split set deletes them.
 *
 * A split write replaces every line, and each transfer line's counterpart is
 * deleted and written again. The amount survives that (a continuing line keeps
 * what was recorded, `carryRecordedReceivedAmounts`), so whether that amount is
 * the importer's estimate has to survive it too: an edit of the parent's memo
 * or payee resends the lines, and is no statement about what the other
 * account received (design P2 of docs/future-plans/provisional-amounts.md).
 */
export async function readProvisionalSplitLegs(
  m: EntityManager,
  parentId: string,
): Promise<ProvisionalSplitLeg[]> {
  const lines = await m.find(TransactionSplit, {
    where: { transactionId: parentId },
    relations: ["linkedTransaction"],
  });
  return (lines ?? []).flatMap((line) =>
    line.linkedTransaction?.amountIsProvisional
      ? [
          {
            accountId: line.linkedTransaction.accountId,
            amount: storedAmount(line.linkedTransaction.amount),
          },
        ]
      : [],
  );
}

/**
 * Put the flag back on the counterparts a replacement wrote, in the
 * replacement's own transaction. A new counterpart continues a provisional one
 * when it sits in the same account and holds the same amount; each recorded
 * leg is claimed at most once. A counterpart whose amount differs was stated
 * by the request or repriced for a changed line, and stays as written.
 *
 * This preserves a state across a row replacement; it never makes an amount
 * provisional that was not (design decision 5).
 */
export async function carryProvisionalSplitLegs(
  m: EntityManager,
  parentId: string,
  recorded: readonly ProvisionalSplitLeg[],
): Promise<void> {
  if (recorded.length === 0) return;
  const lines = await m.find(TransactionSplit, {
    where: { transactionId: parentId },
    relations: ["linkedTransaction"],
  });
  const pool = [...recorded];
  for (const line of lines ?? []) {
    const leg = line.linkedTransaction;
    if (!leg) continue;
    const claimed = pool.findIndex(
      (old) =>
        old.accountId === leg.accountId &&
        old.amount === storedAmount(leg.amount),
    );
    if (claimed === -1) continue;
    pool.splice(claimed, 1);
    await m.update(Transaction, { id: leg.id }, { amountIsProvisional: true });
  }
}
