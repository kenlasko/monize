import { describe, it, expect } from 'vitest';
import type { HoldingWithMarketValue } from '@/types/investment';
import type { SecurityPeriodResult, SecurityPeriodResults } from '@/types/net-worth';
import {
  buildPerformanceRows,
  sortPerformanceRows,
  symbolsWhere,
} from './investment-performance-rows';

function holding(securityId: string, accountId: string, quantity: number): HoldingWithMarketValue {
  return {
    id: `${securityId}-${accountId}`,
    accountId,
    securityId,
    symbol: securityId.toUpperCase(),
    name: `Name ${securityId}`,
    securityType: 'STOCK',
    currencyCode: 'CAD',
    quantity,
    averageCost: 10,
    costBasis: quantity * 10,
    costBasisAccountCurrency: quantity * 10,
    currentPrice: 12,
    marketValue: quantity * 12,
    gainLoss: quantity * 2,
    gainLossPercent: 20,
  } as HoldingWithMarketValue;
}

function period(securityId: string, overrides: Partial<SecurityPeriodResult> = {}): SecurityPeriodResult {
  return {
    securityId,
    symbol: securityId.toUpperCase(),
    name: `Name ${securityId}`,
    securityCurrency: 'USD',
    startQuantity: 5,
    endQuantity: 5,
    startClose: 10,
    endClose: 12,
    priceChangePercent: 20,
    priceChangeReason: null,
    investedValueStart: 50,
    investedValueEnd: 60,
    investedValueChange: 10,
    investmentCapitalFlows: 0,
    investmentIncome: 0,
    investmentPnl: 10,
    investmentReturnPercent: 20,
    investmentReturnMethod: 'twr',
    investedComplete: true,
    investedReasons: [],
    ...overrides,
  };
}

function results(rows: SecurityPeriodResult[]): SecurityPeriodResults {
  return { currency: 'CAD', startDate: '', endDate: '', reasons: [], securities: rows, unattributedPnl: 0 };
}

describe('buildPerformanceRows', () => {
  it('puts each held security beside its window figures, one row per security', () => {
    const rows = buildPerformanceRows(
      [holding('a', 'x', 2), holding('a', 'y', 3)],
      results([period('a')]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ securityId: 'a', quantity: 5, closed: false });
    expect(rows[0].accountBreakdowns).toHaveLength(2);
    expect(rows[0].period?.investmentPnl).toBe(10);
  });

  it('adds a position the window measured but nobody holds now, worth a known zero', () => {
    const rows = buildPerformanceRows([holding('a', 'x', 2)], results([period('a'), period('b', { endQuantity: 0 })]));
    expect(rows[1]).toMatchObject({
      securityId: 'b',
      quantity: 0,
      averageCost: null,
      currentPrice: 12,
      marketValue: 0,
      currencyCode: 'USD',
      accountBreakdowns: [],
      closed: true,
    });
  });

  it('leaves the period unknown while the figures have not arrived', () => {
    const rows = buildPerformanceRows([holding('a', 'x', 2)], null);
    expect(rows).toHaveLength(1);
    expect(rows[0].period).toBeNull();
  });
});

describe('sortPerformanceRows', () => {
  const rows = buildPerformanceRows(
    [holding('a', 'x', 1), holding('b', 'x', 2), holding('c', 'x', 3)],
    results([
      period('a', { investmentPnl: 5, investmentReturnPercent: 1, priceChangePercent: 3 }),
      period('b', { investmentPnl: null, investmentReturnPercent: null, priceChangePercent: null }),
      period('c', { investmentPnl: 9, investmentReturnPercent: 2, priceChangePercent: 1 }),
    ]),
  );
  const ids = (sorted: ReturnType<typeof sortPerformanceRows>) => sorted.map((r) => r.securityId);

  it.each([
    ['gainLoss', ['a', 'c', 'b'], ['c', 'a', 'b']],
    ['gainLossPercent', ['a', 'c', 'b'], ['c', 'a', 'b']],
    ['priceChangePercent', ['c', 'a', 'b'], ['a', 'c', 'b']],
    ['quantity', ['a', 'b', 'c'], ['c', 'b', 'a']],
  ] as const)('sorts by %s with an unknown last either way', (field, asc, desc) => {
    expect(ids(sortPerformanceRows(rows, field, 'asc'))).toEqual(asc);
    expect(ids(sortPerformanceRows(rows, field, 'desc'))).toEqual(desc);
  });

  it('sorts by every point-in-time column', () => {
    for (const field of ['symbol', 'averageCost', 'currentPrice', 'marketValue'] as const) {
      expect(sortPerformanceRows(rows, field, 'asc')).toHaveLength(3);
    }
  });
});

describe('symbolsWhere', () => {
  it('names the rows a cause applies to, by symbol or else by id', () => {
    const rows = buildPerformanceRows([], results([period('a'), period('b', { symbol: null })]));
    expect(symbolsWhere(rows, () => true)).toEqual(['A', 'b']);
  });
});
