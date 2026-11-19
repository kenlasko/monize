import { MappedInvestmentTransaction } from "../../mny/model/mny-import-model";
import { MnyWarningRow } from "../../mny/model/mny-warnings";
import { KmyTransaction } from "../model/kmy-raw";
import { toNumber } from "../model/kmy-rational";

/**
 * The review step's identity of a flagged KMyMoney transaction: its ordinal
 * stands in for Money's `htrn`, and the date, account, payee, number and memo
 * are what KMyMoney's own register can be searched by.
 */

export interface WarningRowContext {
  /** Raw account id -> Monize account key, for the account name lookup. */
  readonly keyById: ReadonlyMap<string, string>;
  /** Payee id -> handle. */
  readonly payeeHandleById: ReadonlyMap<string, number>;
  /** Raw account id -> currency places for the amount shown. */
  readonly placesOf: (accountId: string) => number;
}

/** The row for a transaction: its first split on an imported account leads. */
export function warningRowFor(
  transaction: KmyTransaction,
  context: WarningRowContext,
): MnyWarningRow {
  const lead =
    transaction.splits.find((split) => context.keyById.has(split.account)) ??
    transaction.splits[0];
  const payeeId =
    lead?.payee ?? transaction.splits.find((split) => split.payee)?.payee;
  return {
    handle: transaction.ordinal,
    accountKey: lead ? (context.keyById.get(lead.account) ?? null) : null,
    date: transaction.postDate,
    amount: lead ? toNumber(lead.shares, context.placesOf(lead.account)) : null,
    payeeHandle: payeeId
      ? (context.payeeHandleById.get(payeeId) ?? null)
      : null,
    reference: lead?.number ? lead.number : null,
    memo: lead?.memo || transaction.memo || null,
  };
}

/** The row for a mapped investment row (its transaction ordinal is `handle`). */
export function warningRowForInvestment(
  row: MappedInvestmentTransaction,
): MnyWarningRow {
  return {
    handle: row.handle ?? 0,
    accountKey: row.accountKey,
    date: row.transactionDate,
    amount: row.cashAmount !== 0 ? row.cashAmount : row.totalAmount,
    payeeHandle: row.payeeHandle,
    reference: null,
    memo: row.description,
  };
}
