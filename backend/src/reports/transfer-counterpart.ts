import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";

/** The other side of a transfer leg: the amount it posted, in its own currency. */
export interface TransferCounterpart {
  amount: number;
  currencyCode: string;
}

/**
 * The other side of the transfer `tx` (or its `split` line) is one leg of, as
 * the report's fetch hydrated it, or `null` when there is none to read.
 *
 * Three shapes (`docs/financial-semantics.md` section 2):
 *
 * - a plain leg links to its mirror leg, which links back;
 * - a split's transfer line links to its counterpart row, whose own link points
 *   at the split PARENT, not at the line;
 * - that counterpart row links to the parent, and its other side is the parent's
 *   line linking back to it, never the parent's whole amount.
 *
 * Read only where the fetch joined it, which is the reader's own ledger: a
 * cross-owner counterpart is never hydrated, so its leg has none here. A link
 * that does not point back is not trusted. Read as conversion context only;
 * the counterpart is never a row of the report.
 */
export function transferCounterpartOf(
  tx: Transaction,
  split?: TransactionSplit,
): TransferCounterpart | null {
  if (split) {
    if (split.transferAccountId == null) return null;
    const leg = split.linkedTransaction;
    if (!leg || leg.linkedTransactionId !== tx.id) return null;
    return { amount: Number(leg.amount), currencyCode: leg.currencyCode };
  }
  if (!tx.isTransfer || tx.isSplit) return null;
  const linked = tx.linkedTransaction;
  if (!linked) return null;
  if (linked.isSplit) {
    const line = linked.splits?.find(
      (candidate) =>
        candidate.linkedTransactionId === tx.id &&
        candidate.transferAccountId != null,
    );
    if (!line) return null;
    return { amount: Number(line.amount), currencyCode: linked.currencyCode };
  }
  if (linked.linkedTransactionId !== tx.id) return null;
  return { amount: Number(linked.amount), currencyCode: linked.currencyCode };
}

/**
 * `amount` of a transfer leg in `reportingCurrency`, read off the transfer's
 * own two posted amounts, or `null` when they do not establish it.
 *
 * A transfer of 100 USD that arrived as 90 EUR converts at 90 EUR per 100 USD,
 * whichever leg a report reads: the outgoing leg's stored rate is 1 and the
 * incoming leg's rate only reaches the source currency, so neither carries an
 * own rate the report could otherwise use, and the market rate on the day
 * answered a different figure than the one that moved (discussion #2139). The
 * posted amounts are the fact: an explicit destination amount is stored as
 * given and is not cross-checked against the rate, so the amounts win over
 * `source x rate` (INV-FX-002).
 *
 * Only a counterpart in the reporting currency answers, and only a leg outside
 * it needs one. Two non-zero amounts of opposite signs are required, so a link
 * that is not a transfer's two sides falls back to the market rate. The leg's
 * whole amount converts to the counterpart's exactly; any other amount of it
 * converts in proportion.
 */
export function convertAtTransferAmounts(
  amount: number,
  own: TransferCounterpart,
  counterpart: TransferCounterpart | null,
  reportingCurrency: string,
): number | null {
  if (!counterpart) return null;
  if (own.currencyCode === reportingCurrency) return null;
  if (counterpart.currencyCode !== reportingCurrency) return null;
  const sent = Math.abs(own.amount);
  const received = Math.abs(counterpart.amount);
  if (!(sent > 0) || !(received > 0)) return null;
  if (!Number.isFinite(sent) || !Number.isFinite(received)) return null;
  if (Math.sign(own.amount) === Math.sign(counterpart.amount)) return null;
  if (Math.abs(amount) === sent) return Math.sign(amount) * received;
  return (amount * received) / sent;
}
