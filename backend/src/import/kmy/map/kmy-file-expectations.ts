import { KmyRawFile } from "../model/kmy-raw";
import { Rational, ZERO, add, toNumber } from "../model/kmy-rational";
import { AccountTree, KMY_TYPE } from "./kmy-account-tree";
import { QUANTITY_PLACES, amountNumber, isIsoDate } from "./kmy-amounts";
import { KmyAccountMapping } from "./kmy-map-accounts";
import { KmySecurityMapping } from "./kmy-map-securities";
import { KmyMapContext, sharesOf } from "./kmy-row-builder";
import { journalOrder, replayStockAccount } from "./kmy-stock-splits";

/**
 * Spec 6.1: the balances and holdings KMyMoney itself would show, computed
 * from the raw model and the account-key assignment only, never from mapped
 * rows. Sums are exact rationals, rounded once.
 */

export interface FileHolding {
  /** The brokerage account key. */
  readonly accountKey: string;
  readonly securityHandle: number;
  readonly symbol: string;
  /** KMyMoney's replayed share count, at the share column's 8 places. */
  readonly quantity: number;
}

export interface FileExpectations {
  /** Monize account key -> the file's own final balance at `asOf`. */
  readonly fileBalances: ReadonlyMap<string, number>;
  readonly holdings: readonly FileHolding[];
}

export interface FileExpectationsInput {
  readonly context: KmyMapContext;
  readonly securities: KmySecurityMapping;
  readonly asOf: string;
}

/**
 * Per Monize account key: the sum of `shares` of every split dated on or
 * before `asOf` on every KMyMoney account that maps to it. A brokerage key
 * has no KMyMoney account (its balance is always 0).
 */
function balances(context: KmyMapContext, asOf: string): Map<string, number> {
  const totals = new Map<string, Rational>(
    context.mapping.mapped.accounts.map((account) => [account.key, ZERO]),
  );
  for (const transaction of context.raw.transactions) {
    if (!isIsoDate(transaction.postDate) || transaction.postDate > asOf) {
      continue;
    }
    for (const split of transaction.splits) {
      const key = context.mapping.keyById.get(split.account);
      if (key !== undefined) {
        totals.set(
          key,
          add(totals.get(key) ?? ZERO, sharesOf(split, transaction, context)),
        );
      }
    }
  }
  return new Map(
    [...totals].map(([key, total]) => [
      key,
      amountNumber(
        total,
        context.mapping.currencyByKey.get(key) as string,
        context.coinDecimals,
      ),
    ]),
  );
}

function holdings(
  raw: KmyRawFile,
  tree: AccountTree,
  mapping: KmyAccountMapping,
  securities: KmySecurityMapping,
  asOf: string,
): FileHolding[] {
  const ordered = journalOrder(raw.transactions);
  const totals = new Map<string, FileHolding & { balance: Rational }>();
  for (const account of raw.accounts) {
    if (account.type !== KMY_TYPE.STOCK || !account.currency) {
      continue;
    }
    const investment = tree.nearestAncestor(
      account.id,
      (ancestor) => ancestor.type === KMY_TYPE.INVESTMENT,
    );
    const pair = investment ? mapping.pairs.get(investment.id) : undefined;
    const security = securities.byId.get(account.currency);
    const rawSecurity = securities.rawById.get(account.currency);
    if (!pair || !security || !rawSecurity) {
      continue;
    }
    const replay = replayStockAccount(ordered, account.id, rawSecurity, asOf);
    const key = `${pair.brokerageKey}|${security.handle}`;
    const current = totals.get(key);
    const balance = add(current?.balance ?? ZERO, replay.balance);
    totals.set(key, {
      accountKey: pair.brokerageKey,
      securityHandle: security.handle,
      symbol: security.symbol,
      quantity: 0,
      balance,
    });
  }
  return [...totals.values()].map(({ balance, ...holding }) => ({
    ...holding,
    quantity: toNumber(balance, QUANTITY_PLACES),
  }));
}

export function computeFileExpectations(
  input: FileExpectationsInput,
): FileExpectations {
  const { context, securities, asOf } = input;
  return {
    fileBalances: balances(context, asOf),
    holdings: holdings(
      context.raw,
      context.tree,
      context.mapping,
      securities,
      asOf,
    ),
  };
}
