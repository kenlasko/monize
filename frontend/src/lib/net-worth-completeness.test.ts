import { describe, it, expect } from 'vitest';
import {
  assetsFxComplete,
  liabilitiesFxComplete,
  missingCurrenciesFromPairs,
  isPortfolioPartial,
  netWorthIsPartial,
  pairSourceCurrency,
  partialTotalFor,
  portfolioPartialTotal,
  totalOrSubtotal,
  unionPairs,
} from './net-worth-completeness';
import { isComplete } from './currency-total';

describe('net-worth completeness', () => {
  it('reads the source currency of a pair', () => {
    expect(pairSourceCurrency('ZZZ->USD')).toBe('ZZZ');
    expect(pairSourceCurrency('ZZZ')).toBe('ZZZ');
  });

  it('lists each source currency once, in first-seen order', () => {
    expect(missingCurrenciesFromPairs(['ZZZ->USD', 'EUR->USD', 'ZZZ->CAD'])).toEqual(['ZZZ', 'EUR']);
    expect(missingCurrenciesFromPairs(undefined)).toEqual([]);
  });

  it('unions the pairs of several months', () => {
    expect(unionPairs([{ missingRatePairs: ['A->B'] }, undefined, { missingRatePairs: ['A->B', 'C->B'] }])).toEqual([
      'A->B',
      'C->B',
    ]);
  });

  it('is complete unless the flag is exactly false', () => {
    expect(isComplete(partialTotalFor(5, true))).toBe(true);
    expect(isComplete(partialTotalFor(5, undefined, ['A->B']))).toBe(true);
    const partial = partialTotalFor(5, false, ['A->B', 'C->B']);
    expect(isComplete(partial)).toBe(false);
    expect(partial.missingCurrencies).toEqual(['A', 'C']);
    expect(partial.excludedCount).toBe(2);
  });

  it('still marks a false flag that came without pairs', () => {
    const partial = partialTotalFor(5, false);
    expect(isComplete(partial)).toBe(false);
    expect(partial.excludedCount).toBe(1);
  });

  it('lets a per-side flag override the month flag, and falls back to it', () => {
    expect(assetsFxComplete({ fxComplete: false, assetsFxComplete: true })).toBe(true);
    expect(assetsFxComplete({ fxComplete: false })).toBe(false);
    expect(liabilitiesFxComplete({ liabilitiesFxComplete: false })).toBe(false);
    expect(liabilitiesFxComplete({})).toBeUndefined();
  });

  it('calls a net worth partial when the month or either side is', () => {
    expect(netWorthIsPartial({})).toBe(false);
    expect(netWorthIsPartial({ fxComplete: false })).toBe(true);
    expect(netWorthIsPartial({ fxComplete: true, liabilitiesFxComplete: false })).toBe(true);
  });

  it('calls a portfolio figure partial on any false flag or an unpriced holding', () => {
    expect(isPortfolioPartial(undefined)).toBe(false);
    expect(isPortfolioPartial({})).toBe(false);
    expect(isPortfolioPartial({ valuationComplete: true, fxComplete: true, pricesComplete: true })).toBe(false);
    expect(isPortfolioPartial({ valuationComplete: false })).toBe(true);
    expect(isPortfolioPartial({ fxComplete: false })).toBe(true);
    expect(isPortfolioPartial({ pricesComplete: false })).toBe(true);
    expect(isPortfolioPartial({ unpricedHoldingsCount: 1 })).toBe(true);
    expect(isPortfolioPartial({ unpricedHoldingsCount: 0 })).toBe(false);
  });

  it('counts pairs and unpriced holdings, and always marks a false flag', () => {
    expect(isComplete(portfolioPartialTotal(5, { valuationComplete: true }))).toBe(true);
    const both = portfolioPartialTotal(5, {
      valuationComplete: false,
      missingRatePairs: ['EUR->USD'],
      unpricedSecurityIds: ['a', 'b'],
    });
    expect(both.missingCurrencies).toEqual(['EUR']);
    expect(both.excludedCount).toBe(3);
    const account = portfolioPartialTotal(5, { unpricedHoldingsCount: 2 });
    expect(account.excludedCount).toBe(2);
    expect(account.missingCurrencies).toEqual([]);
    const bare = portfolioPartialTotal(5, { valuationComplete: false });
    expect(isComplete(bare)).toBe(false);
    expect(bare.excludedCount).toBe(1);
  });
});

describe('totalOrSubtotal', () => {
  it('prints the total, else the known subtotal, else 0 for an older backend', () => {
    expect(totalOrSubtotal(5, 3)).toBe(5);
    expect(totalOrSubtotal(0, 3)).toBe(0);
    expect(totalOrSubtotal(null, 3)).toBe(3);
    expect(totalOrSubtotal(null, undefined)).toBe(0);
  });
});
