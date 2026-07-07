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
    );
    expect(regionData[0].region).toBe('Other');
    expect(regionData[0].marketValue).toBe(50);
  });

  it('returns empty structures and zero total for no holdings', () => {
    const result = computeGeographicAllocation([], new Map(), noConvert);
    expect(result).toEqual({ exchangeData: [], regionData: [], totalValue: 0 });
  });
});
