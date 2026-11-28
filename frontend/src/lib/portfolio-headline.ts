import type { AssetAllocation, PortfolioSummary } from "@/types/investment";
import { moneyDecimalsForCurrency, sumMoney } from "@/lib/format";
import type { ConvertedTotal } from "@/lib/currency-total";
import {
  summaryTotal,
  totalOrSubtotal,
  type PortfolioCompleteness,
} from "@/lib/net-worth-completeness";

/** The Investments page's headline figure: what the portfolio in view is worth. */
export interface PortfolioHeadline {
  value: number;
  /**
   * The currency `value` is in: the one foreign account's own, or `null` for
   * the reader's default currency, which the server's totals are already in.
   */
  currencyCode: string | null;
  /** What `value` is complete over, for `portfolioPartialTotal`. */
  completeness: PortfolioCompleteness;
}

export type SummaryFigure =
  | "cash"
  | "holdingsValue"
  | "costBasis"
  | "netInvested"
  | "portfolioValue"
  | "gain"
  | "gainPercent"
  | "gainOverNetInvested";

type Pairs = Pick<
  PortfolioSummary,
  | "missingRatePairs"
  | "portfolioValueMissingRatePairs"
  | "cashMissingRatePairs"
  | "holdingsValueMissingRatePairs"
  | "costBasisMissingRatePairs"
  | "netInvestedMissingRatePairs"
>;

/**
 * One summary figure as a `ConvertedTotal`: the server's total or its known
 * subtotal, marked partial from whether ITS OWN total was withheld and naming
 * ITS OWN causes (a CHF cash balance with no rate is not the cost basis's gap,
 * and an unpriced holding is not the cash's). `null` when the figure is unknown
 * outright. Any pair list an older backend does not send falls back to the
 * summary's whole list.
 */
export function summaryFigure(
  summary: Pairs &
    Partial<
      Pick<
        PortfolioSummary,
        | "totalCashValue"
        | "knownCashValueSubtotal"
        | "totalHoldingsValue"
        | "knownHoldingsValueSubtotal"
        | "totalCostBasis"
        | "knownCostBasisSubtotal"
        | "totalNetInvested"
        | "knownNetInvestedSubtotal"
        | "totalPortfolioValue"
        | "knownPortfolioValueSubtotal"
        | "totalGainLoss"
        | "knownGainLossSubtotal"
        | "totalGainLossPercent"
        | "knownGainLossPercentSubtotal"
        | "totalGainOverNetInvested"
        | "knownGainOverNetInvestedSubtotal"
      >
    > &
    PortfolioCompleteness,
  figure: SummaryFigure,
): ConvertedTotal | null {
  const all = summary.missingRatePairs ?? [];
  const pairsOf = (own: readonly string[] | undefined) => own ?? all;
  const union = (...lists: Array<readonly string[]>) => [
    ...new Set(lists.flat()),
  ];
  const unpricedCount = summary.unpricedSecurityIds?.length ?? 0;
  const cash = pairsOf(summary.cashMissingRatePairs);
  const holdings = pairsOf(summary.holdingsValueMissingRatePairs);
  const cost = pairsOf(summary.costBasisMissingRatePairs);
  const invested = pairsOf(summary.netInvestedMissingRatePairs);
  const portfolio = pairsOf(summary.portfolioValueMissingRatePairs);
  switch (figure) {
    case "cash":
      return summaryTotal(
        summary.totalCashValue,
        summary.knownCashValueSubtotal,
        summary,
        {
          pairs: cash,
          unpriced: 0,
        },
      );
    case "holdingsValue":
      return summaryTotal(
        summary.totalHoldingsValue,
        summary.knownHoldingsValueSubtotal,
        summary,
        {
          pairs: holdings,
          unpriced: unpricedCount,
        },
      );
    case "costBasis":
      return summaryTotal(
        summary.totalCostBasis,
        summary.knownCostBasisSubtotal,
        summary,
        {
          pairs: cost,
          unpriced: 0,
        },
      );
    case "netInvested":
      return summaryTotal(
        summary.totalNetInvested,
        summary.knownNetInvestedSubtotal,
        summary,
        {
          pairs: invested,
          unpriced: 0,
        },
      );
    case "portfolioValue":
      return summaryTotal(
        summary.totalPortfolioValue,
        summary.knownPortfolioValueSubtotal,
        summary,
        { pairs: portfolio, unpriced: unpricedCount },
      );
    case "gain":
      return summaryTotal(
        summary.totalGainLoss,
        summary.knownGainLossSubtotal,
        summary,
        {
          pairs: union(holdings, cost),
          unpriced: unpricedCount,
        },
      );
    case "gainPercent":
      return summaryTotal(
        summary.totalGainLossPercent,
        summary.knownGainLossPercentSubtotal,
        summary,
        { pairs: union(holdings, cost), unpriced: unpricedCount },
      );
    case "gainOverNetInvested":
      return summaryTotal(
        summary.totalGainOverNetInvested,
        summary.knownGainOverNetInvestedSubtotal,
        summary,
        { pairs: union(portfolio, invested), unpriced: unpricedCount },
      );
  }
}

/** The summary's by-security allocation, with the completeness it was valued under. */
export function summaryAllocation(summary: PortfolioSummary): AssetAllocation {
  // Only the value aggregates feed an allocation: a withheld cost basis or net
  // invested does not make a slice partial. An older backend sends no known
  // subtotal, and its summary-wide flag is all there is to read.
  const valuationComplete =
    summary.knownPortfolioValueSubtotal === undefined
      ? summary.valuationComplete
      : summary.totalPortfolioValue !== null;
  const pairs =
    summary.portfolioValueMissingRatePairs ?? summary.missingRatePairs;
  return {
    allocation: summary.allocation,
    totalValue: summary.totalPortfolioValue,
    knownSubtotal: summary.knownPortfolioValueSubtotal,
    valuationComplete,
    fxComplete: pairs === undefined ? summary.fxComplete : pairs.length === 0,
    pricesComplete: summary.pricesComplete,
    missingRatePairs: pairs,
    unpricedSecurityIds: summary.unpricedSecurityIds,
    unpricedSymbols: summary.unpricedSecurityIds
      ?.map((id) => summary.holdings.find((h) => h.securityId === id)?.symbol)
      .filter((s): s is string => Boolean(s)),
  };
}

/**
 * The Total Portfolio Value the Portfolio Summary card leads with, worked out
 * once so every surface that repeats it (the desktop's pinned accounts bar)
 * shows the same figure under the same completeness.
 *
 * With one foreign-currency account in view (`foreignCurrency`), the figure is
 * that account's cash plus market value in its own currency, and complete only
 * over its own valuation: the summary's top-level flags describe a conversion
 * into the default currency that this figure never went through. Otherwise it
 * is the server's default-currency total with the summary's own flags.
 */
export function portfolioHeadline(
  summary: PortfolioSummary,
  foreignCurrency: string | null,
): PortfolioHeadline | null {
  if (foreignCurrency) {
    const accounts = summary.holdingsByAccount;
    return {
      value: sumMoney(
        accounts.flatMap((a) => [a.cashBalance, a.totalMarketValue]),
        moneyDecimalsForCurrency(foreignCurrency),
      ),
      currencyCode: foreignCurrency,
      completeness: {
        valuationComplete: accounts.every((a) => a.valuationComplete !== false),
        fxComplete: accounts.every((a) => a.fxComplete !== false),
        pricesComplete: accounts.every((a) => a.pricesComplete !== false),
        missingRatePairs: [
          ...new Set(accounts.flatMap((a) => a.missingRatePairs ?? [])),
        ].sort(),
        unpricedHoldingsCount: accounts.reduce(
          (n, a) => n + (a.unpricedHoldingsCount ?? 0),
          0,
        ),
      },
    };
  }
  const value = totalOrSubtotal(
    summary.totalPortfolioValue,
    summary.knownPortfolioValueSubtotal,
  );
  // Unknown outright (neither the total nor its subtotal): no figure, never 0.
  if (value === null) return null;
  // A withheld total is partial whatever the other flags say, and a complete
  // one is not made partial by a gap in an unrelated aggregate.
  const completeness: PortfolioCompleteness =
    summary.totalPortfolioValue === null
      ? {
          ...summary,
          valuationComplete: false,
          missingRatePairs:
            summary.portfolioValueMissingRatePairs ?? summary.missingRatePairs,
        }
      : summary.knownPortfolioValueSubtotal === undefined
        ? summary
        : {
            ...summary,
            valuationComplete: true,
            fxComplete: true,
            pricesComplete: true,
          };
  return { value, currencyCode: null, completeness };
}
