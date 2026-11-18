import { KmyAccount, KmySplit, KmyTransaction } from "../model/kmy-raw";
import { sign } from "../model/kmy-rational";
import { AccountTree, KMY_TYPE, isAssetOrLiability } from "./kmy-account-tree";

/**
 * Spec 5.7.1: KMyMoney's own dissection of an investment transaction
 * (`MyMoneyUtils::dissectTransaction`, reference 7.3).
 */

export type KmyActivity =
  | "BuyShares"
  | "SellShares"
  | "AddShares"
  | "RemoveShares"
  | "Dividend"
  | "Yield"
  | "IntIncome"
  | "Reinvest"
  | "Split";

export interface KmyDissection {
  /** The first split on a stock account. */
  readonly stock: KmySplit;
  readonly stockAccount: KmyAccount;
  /** The nearest type-7 ancestor of the stock account, if any. */
  readonly investment: KmyAccount | null;
  /** Splits on expense accounts. */
  readonly fees: readonly KmySplit[];
  /** Splits on income accounts. */
  readonly income: readonly KmySplit[];
  /** The first asset, liability or equity split. */
  readonly asset: KmySplit | null;
  /** Every further asset or liability split. */
  readonly extraAssets: readonly KmySplit[];
  /** Every further split on a stock account. */
  readonly extraStocks: readonly KmySplit[];
  readonly activity: KmyActivity;
  /** True when a `Split` action sits in a transaction of several splits. */
  readonly splitInMultiSplit: boolean;
}

/** Activity of the stock split (spec 5.7.1); anything unrecognised is a buy (KMyMoney's default). */
export function activityOf(stock: KmySplit, splitCount: number): KmyActivity {
  const negative = sign(stock.shares) < 0;
  switch (stock.action) {
    case "Add":
      return negative ? "RemoveShares" : "AddShares";
    case "Dividend":
    case "Yield":
    case "IntIncome":
    case "Reinvest":
      return stock.action;
    case "Split":
      if (splitCount === 1) {
        return "Split";
      }
      return negative ? "RemoveShares" : "AddShares";
    case "Buy":
    default:
      return negative ? "SellShares" : "BuyShares";
  }
}

export function dissectTransaction(
  transaction: KmyTransaction,
  tree: AccountTree,
): KmyDissection | null {
  const stock = transaction.splits.find(
    (split) => tree.byId.get(split.account)?.type === KMY_TYPE.STOCK,
  );
  if (stock === undefined) {
    return null;
  }
  const stockAccount = tree.byId.get(stock.account) as KmyAccount;
  const fees: KmySplit[] = [];
  const income: KmySplit[] = [];
  const extraAssets: KmySplit[] = [];
  const extraStocks: KmySplit[] = [];
  let asset: KmySplit | null = null;

  for (const split of transaction.splits) {
    if (split === stock) {
      continue;
    }
    const account = tree.byId.get(split.account);
    if (!account) {
      continue;
    }
    if (account.type === KMY_TYPE.STOCK) {
      extraStocks.push(split);
    } else if (account.type === KMY_TYPE.EXPENSE) {
      fees.push(split);
    } else if (account.type === KMY_TYPE.INCOME) {
      income.push(split);
    } else if (asset === null) {
      asset = split;
    } else if (isAssetOrLiability(account.type)) {
      extraAssets.push(split);
    }
  }

  const splitCount = transaction.splits.length;
  return {
    stock,
    stockAccount,
    investment: tree.nearestAncestor(
      stock.account,
      (ancestor) => ancestor.type === KMY_TYPE.INVESTMENT,
    ),
    fees,
    income,
    asset,
    extraAssets,
    extraStocks,
    activity: activityOf(stock, splitCount),
    splitInMultiSplit: stock.action === "Split" && splitCount > 1,
  };
}
