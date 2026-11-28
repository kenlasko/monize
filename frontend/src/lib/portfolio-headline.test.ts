import { describe, it, expect } from 'vitest';
import { portfolioHeadline } from './portfolio-headline';
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
