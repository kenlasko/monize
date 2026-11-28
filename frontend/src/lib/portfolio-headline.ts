import type { AssetAllocation, PortfolioSummary } from '@/types/investment';
import { moneyDecimalsForCurrency, sumMoney } from '@/lib/format';
import { totalOrSubtotal, type PortfolioCompleteness } from '@/lib/net-worth-completeness';

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

/** The summary's by-security allocation, with the completeness it was valued under. */
export function summaryAllocation(summary: PortfolioSummary): AssetAllocation {
  return {
    allocation: summary.allocation,
    totalValue: summary.totalPortfolioValue,
    knownSubtotal: summary.knownPortfolioValueSubtotal,
    valuationComplete: summary.valuationComplete,
    fxComplete: summary.fxComplete,
    pricesComplete: summary.pricesComplete,
    missingRatePairs: summary.missingRatePairs,
    unpricedSecurityIds: summary.unpricedSecurityIds,
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
): PortfolioHeadline {
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
  return {
    value: totalOrSubtotal(summary.totalPortfolioValue, summary.knownPortfolioValueSubtotal),
    currencyCode: null,
    completeness: summary,
  };
}
