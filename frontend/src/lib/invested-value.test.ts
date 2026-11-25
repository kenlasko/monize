import { describe, it, expect } from 'vitest';
import {
  investedValue,
  breakdownCashKey,
  breakdownInvestedValue,
} from './invested-value';

describe('investedValue', () => {
  it('reads securitiesValue when present', () => {
    expect(investedValue({ value: 100, securitiesValue: 80 })).toBe(80);
  });

  it('falls back to the whole value when securitiesValue is absent', () => {
    // Absent is no information, not zero: the point draws what it drew before.
    expect(investedValue({ value: 100 })).toBe(100);
    expect(investedValue({ value: 100, securitiesValue: null })).toBe(100);
  });

  it('keeps a real zero distinct from absent', () => {
    expect(investedValue({ value: 100, securitiesValue: 0 })).toBe(0);
  });
});

describe('breakdownCashKey', () => {
  it('finds the cash band by its type, whatever key the server used', () => {
    expect(
      breakdownCashKey([
        { key: 'sec-1', type: 'security' },
        { key: 'other', type: 'other' },
        { key: 'cash', type: 'cash' },
      ]),
    ).toBe('cash');
  });

  it('returns null when no band is cash', () => {
    expect(
      breakdownCashKey([
        { key: 'sec-1', type: 'security' },
        { key: 'other', type: 'other' },
      ]),
    ).toBeNull();
  });
});

describe('breakdownInvestedValue', () => {
  it('subtracts the cash band from the total', () => {
    // 800 securities + 200 other + 500 cash = 1500 total; invested = 1000.
    expect(
      breakdownInvestedValue(
        { total: 1500, values: { 'sec-1': 800, other: 200, cash: 500 } },
        'cash',
        'USD',
      ),
    ).toBe(1000);
  });

  it('returns the whole total when there is no cash band', () => {
    expect(
      breakdownInvestedValue(
        { total: 1000, values: { 'sec-1': 1000 } },
        null,
        'USD',
      ),
    ).toBe(1000);
  });

  it('treats a missing cash value on a point as zero cash', () => {
    // The band exists across the window but this point carried none.
    expect(
      breakdownInvestedValue(
        { total: 1000, values: { 'sec-1': 1000 } },
        'cash',
        'USD',
      ),
    ).toBe(1000);
  });

  it('takes the difference of two cent figures exactly (issue #2410)', () => {
    // 150.01 - 50.00 is 100.00999999999999 in floats; the server's securities
    // subtotal for the point is 100.01.
    expect(
      breakdownInvestedValue(
        { total: 150.01, values: { 'sec-1': 100.01, cash: 50 } },
        'cash',
        'USD',
      ),
    ).toBe(100.01);
  });

  it("keeps a coin's eight places", () => {
    expect(
      breakdownInvestedValue(
        { total: 0.30000001, values: { 'sec-1': 0.1, cash: 0.20000001 } },
        'cash',
        'BTC',
      ),
    ).toBe(0.1);
  });
});
