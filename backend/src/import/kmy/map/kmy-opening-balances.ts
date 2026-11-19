import { KmyRawFile, KmyTransaction } from "../model/kmy-raw";
import { Rational } from "../model/kmy-rational";
import { AccountTree, KMY_TYPE } from "./kmy-account-tree";
import { amountNumber, isIsoDate } from "./kmy-amounts";
import { KmyAccountMapping } from "./kmy-map-accounts";

/**
 * Spec 5.3: a KMyMoney opening balance is a two-split transaction against an
 * equity account. The earliest such candidate of an account key is folded into
 * its `openingBalance` (and produces no row) when nothing else touches the key
 * before it; every other candidate stays an ordinary transaction.
 */

export interface OpeningBalanceResult {
  /** Monize account key -> opening balance, for the keys that have one. */
  readonly balances: ReadonlyMap<string, number>;
  /** Ordinals of the transactions folded away. */
  readonly folded: ReadonlySet<number>;
}

export function foldOpeningBalances(
  raw: KmyRawFile,
  tree: AccountTree,
  mapping: KmyAccountMapping,
  asOf: string,
  coinDecimals: ReadonlyMap<string, number>,
): OpeningBalanceResult {
  // Earliest date anything touches each key, and the candidates per key.
  const earliest = new Map<string, string>();
  const candidates = new Map<
    string,
    { transaction: KmyTransaction; shares: Rational }[]
  >();

  for (const transaction of raw.transactions) {
    if (!isIsoDate(transaction.postDate)) {
      continue;
    }
    const keys = new Set<string>();
    for (const split of transaction.splits) {
      const key = mapping.keyById.get(split.account);
      if (key !== undefined) {
        keys.add(key);
      }
    }
    for (const key of keys) {
      const current = earliest.get(key);
      if (current === undefined || transaction.postDate < current) {
        earliest.set(key, transaction.postDate);
      }
    }

    if (transaction.splits.length !== 2 || transaction.postDate > asOf) {
      continue;
    }
    const [first, second] = transaction.splits;
    const equityFirst = tree.byId.get(first.account)?.type === KMY_TYPE.EQUITY;
    const equitySecond =
      tree.byId.get(second.account)?.type === KMY_TYPE.EQUITY;
    if (equityFirst === equitySecond) {
      continue;
    }
    const own = equityFirst ? second : first;
    const key = mapping.keyById.get(own.account);
    const account = tree.byId.get(own.account);
    if (key === undefined || account === undefined) {
      continue;
    }
    const shares = own.shares;
    const list = candidates.get(key) ?? [];
    list.push({ transaction, shares });
    candidates.set(key, list);
  }

  const balances = new Map<string, number>();
  const folded = new Set<number>();
  for (const [key, list] of candidates) {
    const [first] = [...list].sort((a, b) =>
      a.transaction.postDate === b.transaction.postDate
        ? a.transaction.ordinal - b.transaction.ordinal
        : (a.transaction.postDate as string) <
            (b.transaction.postDate as string)
          ? -1
          : 1,
    );
    if (earliest.get(key) !== first.transaction.postDate) {
      continue;
    }
    folded.add(first.transaction.ordinal);
    balances.set(
      key,
      amountNumber(
        first.shares,
        mapping.currencyByKey.get(key) as string,
        coinDecimals,
      ),
    );
  }

  return { balances, folded };
}
