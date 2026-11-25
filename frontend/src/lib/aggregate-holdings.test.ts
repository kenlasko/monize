import { describe, it, expect } from 'vitest';
import { aggregateHoldingsBySecurity } from './aggregate-holdings';
import type { HoldingWithMarketValue } from '@/types/investment';

function holding(overrides: Partial<HoldingWithMarketValue> & { securityId: string }): HoldingWithMarketValue {
  return {
    id: `h-${overrides.securityId}`,
    accountId: 'acc-1',
    symbol: overrides.securityId,
    name: overrides.securityId,
    securityType: 'STOCK',
    currencyCode: 'CAD',
    quantity: 10,
    averageCost: 100,
    costBasis: 1000,
    costBasisAccountCurrency: 1000,
    currentPrice: 110,
    marketValue: 1100,
    gainLoss: 100,
    gainLossPercent: 10,
    ...overrides,
  };
}

describe('aggregateHoldingsBySecurity', () => {
  it('returns empty array for empty input', () => {
    expect(aggregateHoldingsBySecurity([])).toEqual([]);
  });

  it('returns single holding unchanged with empty accountBreakdowns', () => {
    const h = holding({ securityId: 'AAPL' });
    const result = aggregateHoldingsBySecurity([h]);
    expect(result).toHaveLength(1);
    expect(result[0].securityId).toBe('AAPL');
    expect(result[0].accountBreakdowns).toHaveLength(1);
    expect(result[0].accountBreakdowns[0]).toBe(h);
  });

  it('returns two rows for two different securities', () => {
    const result = aggregateHoldingsBySecurity([
      holding({ securityId: 'AAPL', id: 'h1', accountId: 'acc-1' }),
      holding({ securityId: 'GOOG', id: 'h2', accountId: 'acc-2' }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('aggregates two holdings of the same security', () => {
    const h1 = holding({ id: 'h1', securityId: 'AAPL', accountId: 'acc-1', quantity: 10, costBasis: 1000, costBasisAccountCurrency: 1000, marketValue: 1100, gainLoss: 100, gainLossPercent: 10 });
    const h2 = holding({ id: 'h2', securityId: 'AAPL', accountId: 'acc-2', quantity: 5, costBasis: 500, costBasisAccountCurrency: 500, marketValue: 550, gainLoss: 50, gainLossPercent: 10 });
    const result = aggregateHoldingsBySecurity([h1, h2]);
    expect(result).toHaveLength(1);
    expect(result[0].quantity).toBe(15);
    expect(result[0].costBasis).toBe(1500);
    expect(result[0].marketValue).toBe(1650);
    expect(result[0].gainLoss).toBe(150);
    expect(result[0].gainLossPercent).toBeCloseTo(10);
    expect(result[0].accountBreakdowns).toHaveLength(2);
  });

  it('returns null totalMarketValue when both holdings have null market value', () => {
    const h1 = holding({ id: 'h1', securityId: 'AAPL', accountId: 'acc-1', marketValue: null, gainLoss: null, gainLossPercent: null });
    const h2 = holding({ id: 'h2', securityId: 'AAPL', accountId: 'acc-2', marketValue: null, gainLoss: null, gainLossPercent: null });
    const result = aggregateHoldingsBySecurity([h1, h2]);
    expect(result[0].marketValue).toBeNull();
    expect(result[0].gainLoss).toBeNull();
    expect(result[0].gainLossPercent).toBeNull();
  });

  it('an unpriced account makes the aggregate market value unknown, not a subtotal', () => {
    // This assertion previously read `expect(result[0].marketValue).toBe(550)`
    // under the name "treats null market value as 0 when the other holding has
    // a market value" -- it documented the defect as intended behaviour. A sum
    // with an unknown component is unknown; 550 is the priced half's subtotal
    // and must not ship under the aggregate's marketValue.
    const h1 = holding({ id: 'h1', securityId: 'AAPL', accountId: 'acc-1', quantity: 10, costBasis: 1000, costBasisAccountCurrency: 1000, marketValue: null, gainLoss: null, gainLossPercent: null });
    const h2 = holding({ id: 'h2', securityId: 'AAPL', accountId: 'acc-2', quantity: 5, costBasis: 500, costBasisAccountCurrency: 500, marketValue: 550, gainLoss: 50, gainLossPercent: 10 });
    const result = aggregateHoldingsBySecurity([h1, h2]);
    expect(result[0].marketValue).toBeNull();
    expect(result[0].gainLoss).toBeNull();
    expect(result[0].gainLossPercent).toBeNull();
  });

  it('an unconvertible basis in one account makes the aggregate basis unknown', () => {
    // Number(null) is 0, so the old `Number(a) + Number(b)` silently dropped a
    // whole account's cost basis from the rollup and overstated the gain
    // computed against it.
    const h1 = holding({ id: 'h1', securityId: 'AAPL', accountId: 'acc-1', quantity: 10, costBasis: 1000, costBasisAccountCurrency: null, marketValue: 1100, gainLoss: 100, gainLossPercent: 10 });
    const h2 = holding({ id: 'h2', securityId: 'AAPL', accountId: 'acc-2', quantity: 5, costBasis: 500, costBasisAccountCurrency: 500, marketValue: 550, gainLoss: 50, gainLossPercent: 10 });
    const result = aggregateHoldingsBySecurity([h1, h2]);
    expect(result[0].costBasisAccountCurrency).toBeNull();
    // The native-currency basis is still known, so the aggregate gain (which is
    // derived from costBasis, not the account-currency basis) survives.
    expect(result[0].costBasis).toBe(1500);
  });

  it('returns null gainLossPercent when costBasis is 0', () => {
    const h1 = holding({ id: 'h1', securityId: 'AAPL', accountId: 'acc-1', quantity: 10, costBasis: 0, costBasisAccountCurrency: 0, marketValue: 1100 });
    const h2 = holding({ id: 'h2', securityId: 'AAPL', accountId: 'acc-2', quantity: 5, costBasis: 0, costBasisAccountCurrency: 0, marketValue: 550 });
    const result = aggregateHoldingsBySecurity([h1, h2]);
    expect(result[0].gainLossPercent).toBeNull();
  });

  it('returns 0 averageCost when total quantity is 0', () => {
    const h1 = holding({ id: 'h1', securityId: 'AAPL', accountId: 'acc-1', quantity: 0, costBasis: 0, costBasisAccountCurrency: 0, marketValue: null, gainLoss: null, gainLossPercent: null });
    const h2 = holding({ id: 'h2', securityId: 'AAPL', accountId: 'acc-2', quantity: 0, costBasis: 0, costBasisAccountCurrency: 0, marketValue: null, gainLoss: null, gainLossPercent: null });
    const result = aggregateHoldingsBySecurity([h1, h2]);
    expect(result[0].averageCost).toBe(0);
  });

  it('preserves metadata from the first holding for the aggregated row', () => {
    const h1 = holding({ id: 'h1', securityId: 'AAPL', symbol: 'AAPL', name: 'Apple Inc.', currencyCode: 'USD' });
    const h2 = holding({ id: 'h2', securityId: 'AAPL', symbol: 'AAPL', name: 'Apple Inc.', currencyCode: 'USD', accountId: 'acc-2' });
    const result = aggregateHoldingsBySecurity([h1, h2]);
    expect(result[0].symbol).toBe('AAPL');
    expect(result[0].name).toBe('Apple Inc.');
    expect(result[0].currencyCode).toBe('USD');
  });

  it('adds the accounts exactly, so the rollup is not a float sum (issue #2414)', () => {
    // 1.0007 + 1.0143 is 2.0149999999999997 in doubles; the exact sum is 2.015.
    const [rolled] = aggregateHoldingsBySecurity([
      holding({ securityId: 'AAPL', marketValue: 1.0007, costBasis: 0.5, costBasisAccountCurrency: 0.5 }),
      holding({ securityId: 'AAPL', accountId: 'acc-2', marketValue: 1.0143, costBasis: 0.5, costBasisAccountCurrency: 0.5 }),
    ]);
    expect(rolled.marketValue).toBe(2.015);
    expect(rolled.costBasis).toBe(1);
    expect(rolled.costBasisAccountCurrency).toBe(1);
    expect(rolled.gainLoss).toBe(1.015);
  });

  it("adds the account-currency basis at the column scale, not the security's places", () => {
    // A USD security in two BTC accounts: each basis has eight places.
    const [rolled] = aggregateHoldingsBySecurity([
      holding({ securityId: 'AAPL', currencyCode: 'USD', costBasisAccountCurrency: 0.00012345 }),
      holding({ securityId: 'AAPL', accountId: 'acc-2', currencyCode: 'USD', costBasisAccountCurrency: 0.00000001 }),
    ]);
    expect(rolled.costBasisAccountCurrency).toBe(0.00012346);
  });
});

