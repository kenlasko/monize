import { describe, it, expect } from 'vitest';
import { isProvisionalAmount, provisionalCountOf, sumProvisionalCounts } from './provisional-amount';

describe('isProvisionalAmount', () => {
  it('is true only for a row flagged provisional', () => {
    expect(isProvisionalAmount({ amountIsProvisional: true })).toBe(true);
  });

  it('reads a confirmed row, an absent field and no row as not provisional', () => {
    expect(isProvisionalAmount({ amountIsProvisional: false })).toBe(false);
    expect(isProvisionalAmount({})).toBe(false);
    expect(isProvisionalAmount(null)).toBe(false);
    expect(isProvisionalAmount(undefined)).toBe(false);
  });
});

describe('provisionalCountOf', () => {
  it('reads a count as a number, a decimal column sent as text included', () => {
    expect(provisionalCountOf(1)).toBe(1);
    expect(provisionalCountOf('2')).toBe(2);
  });

  it('reads an absent, zero or unreadable count as no mark', () => {
    expect(provisionalCountOf(undefined)).toBe(0);
    expect(provisionalCountOf(null)).toBe(0);
    expect(provisionalCountOf(0)).toBe(0);
    expect(provisionalCountOf(-1)).toBe(0);
    expect(provisionalCountOf('x')).toBe(0);
  });
});

describe('sumProvisionalCounts', () => {
  it('sums each account\'s count, an account without one adding nothing', () => {
    expect(sumProvisionalCounts([{ provisionalCount: 1 }, {}, { provisionalCount: 2 }])).toBe(3);
    expect(sumProvisionalCounts([])).toBe(0);
  });
});
