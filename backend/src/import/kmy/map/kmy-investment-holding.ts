import { KmySplit, KmyTransaction } from "../model/kmy-raw";
import { Rational } from "../model/kmy-rational";
import { KMY_TYPE } from "./kmy-account-tree";
import { KmyDissection } from "./kmy-dissect";
import { KmyPair } from "./kmy-map-accounts";
import { KmySecurityMapping } from "./kmy-map-securities";
import { KmyMapContext, sharesOf } from "./kmy-row-builder";

/**
 * Spec 5.7.1 and 5.7.3: which holding a stock account belongs to, and where a
 * trade's cash lands.
 */

export interface KmyInvestmentContext extends KmyMapContext {
  readonly securities: KmySecurityMapping;
}

export interface Holding {
  readonly pair: KmyPair;
  readonly securityId: string;
  readonly securityHandle: number;
  readonly securityCurrency: string;
}

export type CashOnlyReason =
  "silent" | "stockWithoutInvestment" | "security" | "trade";

/** The holding a stock account belongs to, or why it cannot import as one. */
export function resolveHolding(
  context: KmyInvestmentContext,
  stockAccountId: string,
): { holding: Holding } | { reason: CashOnlyReason } {
  const { tree, mapping, securities } = context;
  const stock = tree.byId.get(stockAccountId);
  const investment = tree.nearestAncestor(
    stockAccountId,
    (ancestor) => ancestor.type === KMY_TYPE.INVESTMENT,
  );
  if (!stock || !investment) {
    return { reason: "stockWithoutInvestment" };
  }
  const pair = mapping.pairs.get(investment.id);
  if (!pair) {
    return { reason: "silent" };
  }
  const security = stock.currency
    ? securities.byId.get(stock.currency)
    : undefined;
  if (!security || !stock.currency) {
    return { reason: "security" };
  }
  return {
    holding: {
      pair,
      securityId: stock.currency,
      securityHandle: security.handle,
      securityCurrency: security.currencyCode,
    },
  };
}

export interface CashPlan {
  readonly key: string | null;
  readonly funding: string | null;
  readonly shares: Rational | null;
  readonly fundedFromEquity: boolean;
}

export const NO_CASH: CashPlan = {
  key: null,
  funding: null,
  shares: null,
  fundedFromEquity: false,
};

/** Spec 5.7.3: where the asset split's cash lands. */
export function planCash(
  context: KmyInvestmentContext,
  transaction: KmyTransaction,
  d: KmyDissection,
  asset: KmySplit | null,
): CashPlan {
  const { mapping, tree } = context;
  if (asset === null) {
    return NO_CASH;
  }
  const account = tree.byId.get(asset.account);
  if (account?.type === KMY_TYPE.EQUITY) {
    return { ...NO_CASH, fundedFromEquity: true };
  }
  const key = mapping.keyById.get(asset.account);
  if (key === undefined) {
    return NO_CASH;
  }
  const own = d.investment ? mapping.pairs.get(d.investment.id) : undefined;
  return {
    key,
    funding: own && key === own.cashKey ? null : key,
    shares: sharesOf(asset, transaction, context),
    fundedFromEquity: false,
  };
}
