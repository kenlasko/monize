import type { AssetAllocation, PortfolioSummary } from '@/types/investment';
import { moneyDecimalsForCurrency, sumMoney } from '@/lib/format';
import { isComplete, type ConvertedTotal } from '@/lib/currency-total';
import {
  summaryTotal,
  totalOrSubtotal,
  type PortfolioCompleteness,
} from '@/lib/net-worth-completeness';

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
  | 'cash'
  | 'holdingsValue'
  | 'costBasis'
  | 'netInvested'
  | 'portfolioValue'
  | 'gain'
  | 'gainPercent'
  | 'gainOverNetInvested';

type PairsKey =
  | 'portfolioValueMissingRatePairs'
  | 'cashMissingRatePairs'
  | 'holdingsValueMissingRatePairs'
  | 'costBasisMissingRatePairs'
  | 'netInvestedMissingRatePairs';

type TotalKey =
  | 'totalCashValue'
  | 'totalHoldingsValue'
  | 'totalCostBasis'
  | 'totalNetInvested'
  | 'totalPortfolioValue'
  | 'totalGainLoss'
  | 'totalGainLossPercent'
  | 'totalGainOverNetInvested';

type KnownKey =
  | 'knownCashValueSubtotal'
  | 'knownHoldingsValueSubtotal'
  | 'knownCostBasisSubtotal'
  | 'knownNetInvestedSubtotal'
  | 'knownPortfolioValueSubtotal'
  | 'knownGainLossSubtotal'
  | 'knownGainLossPercentSubtotal'
  | 'knownGainOverNetInvestedSubtotal';

/** What a summary figure is read from: its total, its subtotal, and what can withhold it. */
const FIGURES: Record<
  SummaryFigure,
  { total: TotalKey; known: KnownKey; pairs: PairsKey[]; unpriced: boolean }
> = {
  cash: {
    total: 'totalCashValue',
    known: 'knownCashValueSubtotal',
    pairs: ['cashMissingRatePairs'],
    unpriced: false,
  },
  holdingsValue: {
    total: 'totalHoldingsValue',
    known: 'knownHoldingsValueSubtotal',
    pairs: ['holdingsValueMissingRatePairs'],
    unpriced: true,
  },
  costBasis: {
    total: 'totalCostBasis',
    known: 'knownCostBasisSubtotal',
    pairs: ['costBasisMissingRatePairs'],
    unpriced: false,
  },
  netInvested: {
    total: 'totalNetInvested',
    known: 'knownNetInvestedSubtotal',
    pairs: ['netInvestedMissingRatePairs'],
    unpriced: false,
  },
  portfolioValue: {
    total: 'totalPortfolioValue',
    known: 'knownPortfolioValueSubtotal',
    pairs: ['portfolioValueMissingRatePairs'],
    unpriced: true,
  },
  gain: {
    total: 'totalGainLoss',
    known: 'knownGainLossSubtotal',
    pairs: ['holdingsValueMissingRatePairs', 'costBasisMissingRatePairs'],
    unpriced: true,
  },
  gainPercent: {
    total: 'totalGainLossPercent',
    known: 'knownGainLossPercentSubtotal',
    pairs: ['holdingsValueMissingRatePairs', 'costBasisMissingRatePairs'],
    unpriced: true,
  },
  gainOverNetInvested: {
    total: 'totalGainOverNetInvested',
    known: 'knownGainOverNetInvestedSubtotal',
    pairs: ['portfolioValueMissingRatePairs', 'netInvestedMissingRatePairs'],
    unpriced: true,
  },
};

/** The summary fields a figure is read from; every one is optional for an older backend. */
type FigureSource = Partial<
  Pick<PortfolioSummary, TotalKey | KnownKey | PairsKey | 'missingRatePairs' | 'holdings'>
> &
  PortfolioCompleteness;

/**
 * What withholds one summary figure, by name: its own missing pairs (the
 * summary's whole list when an older backend sends none) and, for a figure that
 * values holdings, the symbols with no price. A CHF cash balance with no rate is
 * not the cost basis's gap, and an unpriced holding is not the cash's.
 */
export function summaryFigureCauses(
  summary: FigureSource,
  figure: SummaryFigure,
): { pairs: string[]; unpricedSymbols: string[]; unpricedCount: number } {
  const spec = FIGURES[figure];
  const pairs = [
    ...new Set(spec.pairs.flatMap((key) => summary[key] ?? summary.missingRatePairs ?? [])),
  ].sort();
  const ids = spec.unpriced ? (summary.unpricedSecurityIds ?? []) : [];
  const unpricedSymbols = ids.flatMap((id) => {
    const symbol = summary.holdings?.find((h) => h.securityId === id)?.symbol;
    return symbol ? [symbol] : [];
  });
  return { pairs, unpricedSymbols, unpricedCount: ids.length };
}

/**
 * One summary figure as a `ConvertedTotal`: the server's total or its known
 * subtotal, marked partial from whether ITS OWN total was withheld and naming
 * ITS OWN causes. `null` when the figure is unknown outright.
 */
export function summaryFigure(summary: FigureSource, figure: SummaryFigure): ConvertedTotal | null {
  const spec = FIGURES[figure];
  const { pairs, unpricedCount } = summaryFigureCauses(summary, figure);
  return summaryTotal(summary[spec.total], summary[spec.known], summary, {
    pairs,
    unpriced: unpricedCount,
  });
}

/**
 * The portfolio value a share of it ("% Port") may be measured against: the
 * server's total, and `null` whenever it is withheld or only a subtotal (an
 * older backend sends a numeric subtotal with `valuationComplete: false`).
 */
export function portfolioValueForShare(
  summary: PortfolioSummary | null | undefined,
): number | null {
  if (!summary) return null;
  const figure = summaryFigure(summary, 'portfolioValue');
  return figure !== null && isComplete(figure) ? figure.value : null;
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
  const pairs = summary.portfolioValueMissingRatePairs ?? summary.missingRatePairs;
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
        missingRatePairs: [...new Set(accounts.flatMap((a) => a.missingRatePairs ?? []))].sort(),
        unpricedHoldingsCount: accounts.reduce((n, a) => n + (a.unpricedHoldingsCount ?? 0), 0),
      },
    };
  }
  const value = totalOrSubtotal(summary.totalPortfolioValue, summary.knownPortfolioValueSubtotal);
  // Unknown outright (neither the total nor its subtotal): no figure, never 0.
  if (value === null) return null;
  // A withheld total is partial whatever the other flags say, and a complete
  // one is not made partial by a gap in an unrelated aggregate.
  const completeness: PortfolioCompleteness =
    summary.totalPortfolioValue === null
      ? {
          ...summary,
          valuationComplete: false,
          missingRatePairs: summary.portfolioValueMissingRatePairs ?? summary.missingRatePairs,
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
