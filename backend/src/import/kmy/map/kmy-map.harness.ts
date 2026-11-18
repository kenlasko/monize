import { resolveImportOptions } from "../../mny/model/mny-import-options";
import { MnyImportOptions } from "../../mny/model/mny-import-options";
import { KmyRawFile } from "../model/kmy-raw";
import { buildAccountTree } from "./kmy-account-tree";
import { mapKmyAccounts, withOpeningBalances } from "./kmy-map-accounts";
import { KmyInvestmentContext } from "./kmy-investment-holding";
import { payeeHandleById, tagHandleById } from "./kmy-map-payees-tags";
import { buildRateLookup } from "./kmy-map-prices";
import { mapKmySecurities } from "./kmy-map-securities";
import { KmyMapContext } from "./kmy-row-builder";
import { foldOpeningBalances } from "./kmy-opening-balances";

/**
 * Spec support: the mapping context `mapKmyFile` builds, without running the
 * rest, so one mapper can be exercised on a raw model built by hand.
 */

export interface HarnessInit {
  readonly options?: Partial<MnyImportOptions>;
  readonly coinDecimals?: ReadonlyMap<string, number>;
  readonly baseCurrency?: string;
  readonly asOf?: string;
}

export function harness(raw: KmyRawFile, init: HarnessInit = {}) {
  const options = resolveImportOptions(init.options);
  const coinDecimals = init.coinDecimals ?? new Map<string, number>();
  const baseCurrency = init.baseCurrency ?? raw.baseCurrency ?? "USD";
  const asOf = init.asOf ?? "2030-01-01";
  const tree = buildAccountTree(raw.accounts);
  const drafted = mapKmyAccounts({
    raw,
    tree,
    options,
    baseCurrency,
    coinDecimals,
  });
  const opening = foldOpeningBalances(raw, tree, drafted, asOf, coinDecimals);
  const mapping = {
    ...drafted,
    mapped: withOpeningBalances(drafted.mapped, opening.balances),
  };
  const context: KmyMapContext = {
    raw,
    tree,
    mapping,
    coinDecimals,
    payeeHandleById: payeeHandleById(raw),
    tagHandleById: tagHandleById(raw),
  };
  const securities = mapKmySecurities({
    raw,
    tree,
    mapping,
    baseCurrency,
    coinDecimals,
  });
  const investmentContext: KmyInvestmentContext = {
    ...context,
    securities,
    rateLookup: buildRateLookup(raw),
  };
  return {
    options,
    asOf,
    tree,
    drafted,
    opening,
    mapping,
    context,
    securities,
    investmentContext,
  };
}
