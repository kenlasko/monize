import { KmyRawFile } from "../model/kmy-raw";
import { Rational, ZERO, add, toNumber } from "../model/kmy-rational";
import { AccountTree, KMY_TYPE } from "./kmy-account-tree";
import {
  QUANTITY_PLACES,
  amountPlaces,
  isIsoDate,
  toUnits,
  unitsToNumber,
} from "./kmy-amounts";
import { KmyAccountMapping } from "./kmy-map-accounts";
import { KmySecurityMapping } from "./kmy-map-securities";
import { journalOrder, replayStockAccount } from "./kmy-stock-splits";

/**
 * Spec 6.1: what KMyMoney itself would show, computed from the raw splits and
 * nothing the mapper computes. It is deliberately dumb: it sums the raw
 * `shares` of every split per account (KMyMoney's `AccountBalances::operator+=`),
 * with the rational helpers and the account's own decimal places only. It
 * shares no sign helper, no split classification, no opening-balance fold and
 * no row builder with the mapper, so a defect in any of them makes the two
 * sides differ instead of agreeing by construction (M1;
 * `kmy-file-expectations.guard.spec.ts` holds the imports). What it does share
 * is the account and security identity: which Monize account a KMyMoney
 * account becomes, its currency, and which holding a stock account is.
 */

export interface FileHolding {
  /** The brokerage account key. */
  readonly accountKey: string;
  readonly securityHandle: number;
  readonly symbol: string;
  /** KMyMoney's replayed share count, at the share column's 8 places. */
  readonly quantity: number;
}

/**
 * Per holding and transaction: the signed sum of the stock splits' `value`
 * (buys and reinvestments positive, sales negative) -- the gross amount
 * invested, before fees, in the security's currency. It is what the trade
 * rows' totals net of commission must add up to, transaction by transaction
 * (a net over a holding would let an error on a buy cancel one on a sale); it
 * is not a cost basis (spec 6.1).
 */
export interface FileTradeValue {
  readonly accountKey: string;
  readonly securityHandle: number;
  readonly transactionOrdinal: number;
  readonly symbol: string;
  readonly currencyCode: string;
  readonly places: number;
  /** Sum of each stock split's value rounded at `places`, in minor units. */
  readonly units: bigint;
  /** Stock splits summed: the comparison allows one minor unit for each. */
  readonly splits: number;
}

export interface FileBalancePrecision {
  readonly places: number;
  /** |rows rounded one by one - the exact sum rounded once|. */
  readonly tolerance: number;
}

export interface FileExpectations {
  /** Monize account key -> the file's own final balance at `asOf`, rounded once. */
  readonly fileBalances: ReadonlyMap<string, number>;
  /**
   * Monize account key -> what one row per split, each rounded at the
   * account's places, sums to: what a correct mapping produces exactly.
   */
  readonly rowBalances: ReadonlyMap<string, number>;
  readonly balancePrecision: ReadonlyMap<string, FileBalancePrecision>;
  readonly holdings: readonly FileHolding[];
  readonly tradeValues: readonly FileTradeValue[];
  /**
   * Transactions whose commodity is not their security's trading currency.
   * Their stock values are in another currency than the rows', so neither
   * side counts them in `tradeValues`.
   */
  readonly otherCurrencyTrades: ReadonlySet<number>;
}

export interface FileExpectationsInput {
  readonly raw: KmyRawFile;
  readonly tree: AccountTree;
  readonly mapping: KmyAccountMapping;
  readonly securities: KmySecurityMapping;
  readonly coinDecimals: ReadonlyMap<string, number>;
  readonly asOf: string;
}

/** Stock actions that move shares without a price: no amount invested. */
const SHARE_ONLY_ACTIONS: ReadonlySet<string> = new Set(["Add", "Split"]);

function dated(postDate: string | null, asOf: string): boolean {
  return isIsoDate(postDate) && postDate <= asOf;
}

function balances(input: FileExpectationsInput) {
  const { raw, mapping, coinDecimals, asOf } = input;
  const placesOf = (key: string): number =>
    amountPlaces(mapping.currencyByKey.get(key) as string, coinDecimals);
  const exact = new Map<string, Rational>();
  const rows = new Map<string, bigint>();
  for (const account of mapping.mapped.accounts) {
    exact.set(account.key, ZERO);
    rows.set(account.key, 0n);
  }
  for (const transaction of raw.transactions) {
    if (!dated(transaction.postDate, asOf)) {
      continue;
    }
    for (const split of transaction.splits) {
      const key = mapping.keyById.get(split.account);
      if (key === undefined) {
        continue;
      }
      exact.set(key, add(exact.get(key) ?? ZERO, split.shares));
      rows.set(
        key,
        (rows.get(key) ?? 0n) + toUnits(split.shares, placesOf(key)),
      );
    }
  }

  const fileBalances = new Map<string, number>();
  const rowBalances = new Map<string, number>();
  const precision = new Map<string, FileBalancePrecision>();
  for (const [key, total] of exact) {
    const places = placesOf(key);
    const once = toUnits(total, places);
    const each = rows.get(key) ?? 0n;
    const gap = each > once ? each - once : once - each;
    fileBalances.set(key, unitsToNumber(once, places));
    rowBalances.set(key, unitsToNumber(each, places));
    precision.set(key, { places, tolerance: unitsToNumber(gap, places) });
  }
  return { fileBalances, rowBalances, precision };
}

/** The holding a stock account belongs to, through the account and security identity only. */
function holdingOf(input: FileExpectationsInput, stockAccountId: string) {
  const { tree, mapping, securities } = input;
  const account = tree.byId.get(stockAccountId);
  if (!account || account.type !== KMY_TYPE.STOCK || !account.currency) {
    return null;
  }
  const investment = tree.nearestAncestor(
    account.id,
    (ancestor) => ancestor.type === KMY_TYPE.INVESTMENT,
  );
  const pair = investment ? mapping.pairs.get(investment.id) : undefined;
  const security = securities.byId.get(account.currency);
  const rawSecurity = securities.rawById.get(account.currency);
  if (!pair || !security || !rawSecurity) {
    return null;
  }
  return {
    key: `${pair.brokerageKey}|${security.handle}`,
    accountKey: pair.brokerageKey,
    security,
    rawSecurity,
  };
}

function holdings(input: FileExpectationsInput): FileHolding[] {
  const ordered = journalOrder(input.raw.transactions);
  const totals = new Map<string, FileHolding & { balance: Rational }>();
  for (const account of input.raw.accounts) {
    const holding = holdingOf(input, account.id);
    if (holding === null) {
      continue;
    }
    const replay = replayStockAccount(
      ordered,
      account.id,
      holding.rawSecurity,
      input.asOf,
    );
    const current = totals.get(holding.key);
    totals.set(holding.key, {
      accountKey: holding.accountKey,
      securityHandle: holding.security.handle,
      symbol: holding.security.symbol,
      quantity: 0,
      balance: add(current?.balance ?? ZERO, replay.balance),
    });
  }
  return [...totals.values()].map(({ balance, ...holding }) => ({
    ...holding,
    quantity: toNumber(balance, QUANTITY_PLACES),
  }));
}

function tradeValues(input: FileExpectationsInput) {
  const { raw, mapping, coinDecimals, asOf } = input;
  const totals = new Map<string, FileTradeValue>();
  const otherCurrency = new Set<number>();
  for (const transaction of raw.transactions) {
    if (!dated(transaction.postDate, asOf)) {
      continue;
    }
    const commodity = transaction.commodity?.trim() || mapping.baseCurrency;
    for (const split of transaction.splits) {
      const holding = holdingOf(input, split.account);
      if (holding === null || SHARE_ONLY_ACTIONS.has(split.action)) {
        continue;
      }
      const currencyCode = holding.security.currencyCode;
      if (commodity !== currencyCode) {
        otherCurrency.add(transaction.ordinal);
        continue;
      }
      const places = amountPlaces(currencyCode, coinDecimals);
      const key = `${holding.key}|${transaction.ordinal}`;
      const current = totals.get(key);
      totals.set(key, {
        accountKey: holding.accountKey,
        securityHandle: holding.security.handle,
        transactionOrdinal: transaction.ordinal,
        symbol: holding.security.symbol,
        currencyCode,
        places,
        units: (current?.units ?? 0n) + toUnits(split.value, places),
        splits: (current?.splits ?? 0) + 1,
      });
    }
  }
  return { values: [...totals.values()], otherCurrency };
}

export function computeFileExpectations(
  input: FileExpectationsInput,
): FileExpectations {
  const { fileBalances, rowBalances, precision } = balances(input);
  const trades = tradeValues(input);
  return {
    fileBalances,
    rowBalances,
    balancePrecision: precision,
    holdings: holdings(input),
    tradeValues: trades.values,
    otherCurrencyTrades: trades.otherCurrency,
  };
}
