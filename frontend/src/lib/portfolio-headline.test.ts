import { describe, it, expect } from 'vitest';
import {
  portfolioHeadline,
  portfolioValueForShare,
  summaryFigure,
  summaryFigureCauses,
} from './portfolio-headline';
import type { PortfolioSummary } from '@/types/investment';

const account = (overrides: Record<string, unknown>) =>
  ({
    accountId: 'a',
    accountName: 'A',
    currencyCode: 'USD',
    cashAccountId: null,
    cashBalance: 0,
    holdings: [],
    totalCostBasis: 0,
    totalMarketValue: 0,
    unpricedHoldingsCount: 0,
    totalGainLoss: 0,
    totalGainLossPercent: 0,
    netInvested: 0,
    ...overrides,
  }) as never;

const summary = (overrides: Partial<PortfolioSummary>): PortfolioSummary =>
  ({
    totalPortfolioValue: 1000,
    holdingsByAccount: [],
    ...overrides,
  }) as PortfolioSummary;

describe('portfolioHeadline', () => {
  it("is the server's default-currency total under the summary's own flags", () => {
    const s = summary({ totalPortfolioValue: 1234.5, valuationComplete: false });
    const headline = portfolioHeadline(s, null)!;
    expect(headline).toMatchObject({ value: 1234.5, currencyCode: null });
    expect(headline.completeness.valuationComplete).toBe(false);
  });

  it("is one foreign account's cash plus market value in its own currency, summed exactly", () => {
    const s = summary({
      totalPortfolioValue: 99999,
      // The summary converted completely; the account's own valuation did not.
      valuationComplete: true,
      holdingsByAccount: [
        account({ cashBalance: 0.1, totalMarketValue: 0.2, valuationComplete: false, unpricedHoldingsCount: 1 }),
      ],
    });
    const headline = portfolioHeadline(s, 'USD')!;
    expect(headline.value).toBe(0.3);
    expect(headline.currencyCode).toBe('USD');
    expect(headline.completeness).toMatchObject({ valuationComplete: false, unpricedHoldingsCount: 1 });
  });

  it('reads absent account flags as complete', () => {
    const headline = portfolioHeadline(
      summary({ holdingsByAccount: [account({ cashBalance: 5, totalMarketValue: 10 })] }),
      'EUR',
    )!;
    expect(headline.value).toBe(15);
    expect(headline.completeness).toMatchObject({
      valuationComplete: true,
      fxComplete: true,
      pricesComplete: true,
      missingRatePairs: [],
      unpricedHoldingsCount: 0,
    });
  });
});

describe('portfolioHeadline with a withheld total', () => {
  it('is the known subtotal, partial, when the server withheld the value', () => {
    const headline = portfolioHeadline(
      summary({
        totalPortfolioValue: null,
        knownPortfolioValueSubtotal: 400,
        valuationComplete: false,
      }),
      null,
    )!;
    expect(headline.value).toBe(400);
    expect(headline.completeness.valuationComplete).toBe(false);
  });

  it('is not made partial by a gap in an unrelated aggregate', () => {
    const headline = portfolioHeadline(
      summary({
        totalPortfolioValue: 400,
        knownPortfolioValueSubtotal: 400,
        totalCostBasis: null,
        knownCostBasisSubtotal: 300,
        valuationComplete: false,
        fxComplete: false,
      }),
      null,
    )!;
    expect(headline.completeness).toMatchObject({ valuationComplete: true, fxComplete: true });
  });

  it('is unknown, never 0, when neither the total nor the subtotal is there', () => {
    expect(portfolioHeadline(summary({ totalPortfolioValue: null }), null)).toBeNull();
  });
});

describe('summaryFigure names the causes of its own figure', () => {
  // A CHF cash balance has no rate AND a holding is unpriced: two different
  // gaps, two different figures.
  const both = summary({
    totalCashValue: null,
    knownCashValueSubtotal: 0,
    totalHoldingsValue: null,
    knownHoldingsValueSubtotal: 500,
    totalCostBasis: 800,
    knownCostBasisSubtotal: 800,
    totalPortfolioValue: null,
    knownPortfolioValueSubtotal: 500,
    missingRatePairs: ['CHF->USD'],
    cashMissingRatePairs: ['CHF->USD'],
    holdingsValueMissingRatePairs: [],
    costBasisMissingRatePairs: [],
    portfolioValueMissingRatePairs: ['CHF->USD'],
    unpricedSecurityIds: ['sec-1'],
    pricesComplete: false,
    fxComplete: false,
    valuationComplete: false,
  });

  it('cash names the CHF pair and no unpriced holding', () => {
    expect(summaryFigure(both, 'cash')).toEqual({
      value: 0,
      missingCurrencies: ['CHF'],
      excludedCount: 1,
    });
  });

  it('holdings value counts the unpriced holding and no pair', () => {
    expect(summaryFigure(both, 'holdingsValue')).toEqual({
      value: 500,
      missingCurrencies: [],
      excludedCount: 1,
    });
  });

  it('portfolio value names both causes; the cost basis is complete', () => {
    expect(summaryFigure(both, 'portfolioValue')).toEqual({
      value: 500,
      missingCurrencies: ['CHF'],
      excludedCount: 2,
    });
    expect(summaryFigure(both, 'costBasis')).toEqual({
      value: 800,
      missingCurrencies: [],
      excludedCount: 0,
    });
  });
});

describe('portfolioValueForShare', () => {
  it('is the server total when it is known', () => {
    expect(
      portfolioValueForShare(summary({ totalPortfolioValue: 400, knownPortfolioValueSubtotal: 400 })),
    ).toBe(400);
  });

  it('is null when the server withheld the total', () => {
    expect(
      portfolioValueForShare(summary({ totalPortfolioValue: null, knownPortfolioValueSubtotal: 400 })),
    ).toBeNull();
  });

  it('is null for an older backend sending a numeric subtotal with valuationComplete false', () => {
    expect(
      portfolioValueForShare(summary({ totalPortfolioValue: 400, valuationComplete: false })),
    ).toBeNull();
  });

  it('is the total for an older backend whose valuation is complete, and null with no summary', () => {
    expect(
      portfolioValueForShare(summary({ totalPortfolioValue: 400, valuationComplete: true })),
    ).toBe(400);
    expect(portfolioValueForShare(null)).toBeNull();
  });
});

describe('summaryFigureCauses', () => {
  it('names the symbol of an unpriced holding for a value figure and none for cash', () => {
    const s = summary({
      holdings: [{ securityId: 'sec-1', symbol: 'VFV.TO' }] as never,
      unpricedSecurityIds: ['sec-1'],
      cashMissingRatePairs: ['CHF->USD'],
      portfolioValueMissingRatePairs: ['CHF->USD'],
    });
    expect(summaryFigureCauses(s, 'portfolioValue')).toMatchObject({
      pairs: ['CHF->USD'],
      unpricedSymbols: ['VFV.TO'],
    });
    expect(summaryFigureCauses(s, 'cash')).toMatchObject({
      pairs: ['CHF->USD'],
      unpricedSymbols: [],
    });
  });
});
