import { roundMoney } from "../common/round.util";
import { CreateTransactionSplitDto } from "./dto/create-transaction-split.dto";

/**
 * A recorded transfer line: the target it moved money to, its amount in the
 * parent's currency, and what its counterpart says arrived.
 */
export interface RecordedTransferLine {
  transferAccountId: string | null;
  amount: number | string;
  /** The counterpart's amount, signed as stored; null when it has none. */
  counterpartAmount: number | string | null;
  /** The counterpart's currency; null when it has none. */
  counterpartCurrencyCode: string | null;
}

/**
 * The incoming split set with each continuing cross-currency transfer line's
 * recorded received amount filled in where the caller sent none.
 *
 * A split write replaces every line, so a caller that rebuilds the set without
 * `transferTargetAmount` -- an AI or MCP split edit, a client that never loaded
 * the counterpart -- used to re-convert every cross-currency counterpart at
 * that day's market rate, overwriting the figure the bank actually credited. A
 * line continues a recorded one when it names the same target account and the
 * same amount (each recorded line is claimed at most once, by a line stating
 * its own figure before any line that states none); its received amount
 * is then a fact about the transfer, not something to re-price, just as a date
 * correction does not re-price a plain transfer.
 *
 * Nothing is carried when the parent moves to another account (the amounts
 * then mean another currency), onto a line that states its own received
 * amount, or from a same-currency line, which has no figure of its own.
 */
export function carryRecordedReceivedAmounts(
  recorded: readonly RecordedTransferLine[],
  incoming: readonly CreateTransactionSplitDto[],
  context: { sourceCurrencyCode: string; parentAccountUnchanged: boolean },
): CreateTransactionSplitDto[] {
  if (!context.parentAccountUnchanged) return [...incoming];
  const pool = recorded.filter(
    (line) =>
      line.transferAccountId !== null &&
      line.counterpartAmount !== null &&
      line.counterpartCurrencyCode !== null &&
      line.counterpartCurrencyCode !== context.sourceCurrencyCode,
  );
  const sameLine = (
    line: RecordedTransferLine,
    split: CreateTransactionSplitDto,
  ): boolean =>
    line.transferAccountId === split.transferAccountId &&
    roundMoney(Number(line.amount)) === roundMoney(Number(split.amount));
  // A line stating its own figure continues a recorded line too: it claims its
  // match first, so a new line identical to it cannot inherit that figure.
  for (const split of incoming) {
    if (
      !split.transferAccountId ||
      split.transferTargetAmount === undefined ||
      split.transferTargetAmount === null
    ) {
      continue;
    }
    const claimed = pool.findIndex((line) => sameLine(line, split));
    if (claimed !== -1) pool.splice(claimed, 1);
  }
  return incoming.map((split) => {
    if (
      !split.transferAccountId ||
      (split.transferTargetAmount !== undefined &&
        split.transferTargetAmount !== null)
    ) {
      return split;
    }
    const index = pool.findIndex((line) => sameLine(line, split));
    if (index === -1) return split;
    const [line] = pool.splice(index, 1);
    return {
      ...split,
      transferTargetAmount: Math.abs(
        roundMoney(Number(line.counterpartAmount)),
      ),
    };
  });
}

/**
 * Register rows with a transfer line's counterpart kept only on the reader's
 * own rows. A joint reader sees the owner's split transactions but cannot edit
 * their splits, and a line's counterpart may sit in an account of the owner's
 * that was never shared with them.
 */
export function ownSplitCounterpartsOnly<
  T extends {
    userId: string;
    splits?: readonly { linkedTransaction?: unknown }[] | null;
  },
>(userId: string, rows: T[]): T[] {
  return rows.map((row) =>
    row.userId === userId || !row.splits
      ? row
      : ({
          ...row,
          splits: row.splits.map((split) => ({
            ...split,
            linkedTransaction: null,
          })),
        } as T),
  );
}
