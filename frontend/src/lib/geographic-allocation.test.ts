import { describe, it, expect } from 'vitest';
import { HoldingWithMarketValue } from '@/types/investment';
import {
  computeGeographicAllocation,
  EXCHANGE_TO_REGION,
  REGION_COLOURS,
} from './geographic-allocation';

const holding = (
  securityId: string,
  marketValue: number,
): HoldingWithMarketValue =>
  ({
    securityId,
    marketValue,
    currencyCode: 'USD',
  }) as HoldingWithMarketValue;

const noConvert = (v: number) => v;

describe('EXCHANGE_TO_REGION', () => {
  it('maps known exchanges to their region', () => {
    expect(EXCHANGE_TO_REGION.NYSE.region).toBe('North America');
    expect(EXCHANGE_TO_REGION.LSE.region).toBe('Europe');
    expect(EXCHANGE_TO_REGION.TYO.region).toBe('Asia-Pacific');
  });
});

describe('computeGeographicAllocation', () => {
  const exchangeMap = new Map<string, string>([
    ['s-nyse', 'NYSE'],
    ['s-tsx', 'TSX'],
    ['s-lse', 'LSE'],
  ]);

  it('rolls holdings into exchange and region totals', () => {
    const holdings = [
      holding('s-nyse', 100),
      holding('s-tsx', 300),
      holding('s-lse', 100),
    ];
    const { exchangeData, regionData, totalValue } = computeGeographicAllocation(
      holdings,
      exchangeMap,
      noConvert,
      2,
    );

    expect(totalValue).toBe(500);

    // Exchanges are sorted by market value descending.
    expect(exchangeData.map((e) => e.exchange)).toEqual(['TSX', 'NYSE', 'LSE']);
    const tsx = exchangeData.find((e) => e.exchange === 'TSX')!;
    expect(tsx.marketValue).toBe(300);
    expect(tsx.percentage).toBeCloseTo(60);

    // North America = NYSE (100) + TSX (300) = 400; Europe = LSE (100).
    const na = regionData.find((r) => r.region === 'North America')!;
    expect(na.marketValue).toBe(400);
    expect(na.count).toBe(2);
    expect(na.color).toBe(REGION_COLOURS['North America']);
    expect(regionData.find((r) => r.region === 'Europe')!.marketValue).toBe(100);
  });

  it('classifies unknown exchanges as Other', () => {
    const { regionData } = computeGeographicAllocation(
      [holding('mystery', 50)],
      new Map(),
      noConvert,
      2,
    );
    expect(regionData[0].region).toBe('Other');
    expect(regionData[0].marketValue).toBe(50);
  });

  it('returns empty structures and zero total for no holdings', () => {
    const result = computeGeographicAllocation([], new Map(), noConvert, 2);
    expect(result).toEqual({
      exchangeData: [],
      regionData: [],
      totalValue: 0,
      missingCurrencies: [],
      excludedCount: 0,
    });
  });

  it('leaves an unconvertible holding out of the total and names its currency', () => {
    // A holding whose currency has no rate must not join the total as a zero,
    // and the caller has to be told the total is now a subtotal.
    const eur = {
      securityId: 's-lse',
      marketValue: 1000,
      currencyCode: 'EUR',
    } as HoldingWithMarketValue;
    const result = computeGeographicAllocation(
      [holding('s-nyse', 100), eur],
      exchangeMap,
      (v, currency) => (currency === 'EUR' ? null : v),
      2,
    );
    expect(result.totalValue).toBe(100);
    expect(result.missingCurrencies).toEqual(['EUR']);
    expect(result.excludedCount).toBe(1);
  });

  it('counts an unpriced holding as excluded without a currency', () => {
    const unpriced = {
      securityId: 's-nyse',
      marketValue: null,
      currencyCode: 'USD',
    } as unknown as HoldingWithMarketValue;
    const result = computeGeographicAllocation(
      [holding('s-tsx', 300), unpriced],
      exchangeMap,
      noConvert,
      2,
    );
    expect(result.totalValue).toBe(300);
    expect(result.excludedCount).toBe(1);
    expect(result.missingCurrencies).toEqual([]);
  });

  describe('the totals the page builds (issue #2414)', () => {
    it('reads each figure once from the exact sum of its holdings', () => {
      // 1.0007 + 1.0143 is 2.0149999999999997 in doubles; the exact sum, 2.015,
      // reads 2.02 where the float read 2.01 on screen.
      const { exchangeData, regionData, totalValue } = computeGeographicAllocation(
        [holding('s-nyse', 1.0007), holding('s-nyse', 1.0143)],
        exchangeMap,
        noConvert,
        2,
      );
      expect(exchangeData[0].marketValue).toBe(2.02);
      expect(regionData[0].marketValue).toBe(2.02);
      expect(totalValue).toBe(2.02);
    });

    it('folds a region from its exchanges exact sums, not their readings', () => {
      // NYSE and TSX each hold 0.005, which reads 0.01; North America holds 0.01.
      const { regionData, totalValue } = computeGeographicAllocation(
        [holding('s-nyse', 0.005), holding('s-tsx', 0.005)],
        exchangeMap,
        noConvert,
        2,
      );
      expect(regionData[0].marketValue).toBe(0.01);
      expect(totalValue).toBe(0.01);
    });

    it('divides each share from the exact sums', () => {
      // Two exchanges of 1.2474 each read 1.25 over a total that reads 2.49,
      // and each is half of it, not 50.2%.
      const { exchangeData } = computeGeographicAllocation(
        [holding('s-nyse', 1.2474), holding('s-lse', 1.2474)],
        exchangeMap,
        noConvert,
        2,
      );
      expect(exchangeData.map((e) => e.percentage)).toEqual([50, 50]);
    });
  });
});
