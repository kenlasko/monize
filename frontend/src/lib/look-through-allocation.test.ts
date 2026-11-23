import { describe, it, expect } from 'vitest';
import {
  collapseLookThrough,
  LOOK_THROUGH_TOP_N,
} from './look-through-allocation';

const bucket = (name: string, totalValue: number, percentage: number) => ({
  name,
  totalValue,
  percentage,
});

describe('collapseLookThrough', () => {
  it('keeps the largest buckets and merges the rest with the unclassified remainder', () => {
    const items = Array.from({ length: LOOK_THROUGH_TOP_N + 3 }, (_, i) =>
      bucket(`B${i}`, 100 - i, 100 - i),
    );
    const slices = collapseLookThrough(
      { items, totalPortfolioValue: 1000, unclassifiedValue: 50 },
      'Other',
    );
    expect(slices).toHaveLength(LOOK_THROUGH_TOP_N + 1);
    const other = slices[slices.length - 1];
    expect(other.name).toBe('Other');
    expect(other.isOther).toBe(true);
    // Buckets 10, 11 and 12 (90, 89, 88) plus the 50 the backend could not place.
    expect(other.value).toBe(317);
    expect(other.percentage).toBeCloseTo(31.7);
  });

  it('sums a large remainder exactly (Discussion #2343)', () => {
    // 300000000000.03 * 10000 is 3000000000000300.5 in doubles, which the
    // float scaling rounded to 300000000000.0301.
    const slices = collapseLookThrough(
      {
        items: [],
        totalPortfolioValue: 300_000_000_000.03,
        unclassifiedValue: 300_000_000_000.03,
      },
      'Other',
    );
    expect(slices).toHaveLength(1);
    expect(slices[0].value).toBe(300_000_000_000.03);
  });

  it('omits Other when everything is classified and nothing overflows', () => {
    const slices = collapseLookThrough(
      {
        items: [bucket('Equity', 700, 70), bucket('Fixed Income', 300, 30)],
        totalPortfolioValue: 1000,
        unclassifiedValue: 0,
      },
      'Other',
    );
    expect(slices.map((s) => s.name)).toEqual(['Equity', 'Fixed Income']);
  });

  it('carries the backend percentages through, so slices are shares of the whole portfolio', () => {
    // 70 + 20 leaves 10% unclassified: the slices sum to the portfolio, not to
    // the classified part of it.
    const slices = collapseLookThrough(
      {
        items: [bucket('Equity', 700, 70), bucket('Fixed Income', 200, 20)],
        totalPortfolioValue: 1000,
        unclassifiedValue: 100,
      },
      'Other',
    );
    expect(slices.map((s) => s.percentage)).toEqual([70, 20, 10]);
  });

  it('sorts defensively rather than trusting the order it was handed', () => {
    const slices = collapseLookThrough(
      {
        items: [bucket('Small', 100, 10), bucket('Large', 900, 90)],
        totalPortfolioValue: 1000,
        unclassifiedValue: 0,
      },
      'Other',
    );
    expect(slices.map((s) => s.name)).toEqual(['Large', 'Small']);
  });

  it('reports no percentage share as zero when the portfolio is worth nothing', () => {
    // An empty portfolio holds zero, so Other's share of it is zero rather than
    // a division by nothing.
    const slices = collapseLookThrough(
      { items: [], totalPortfolioValue: 0, unclassifiedValue: 5 },
      'Other',
    );
    expect(slices).toEqual([
      { name: 'Other', value: 5, percentage: 0, isOther: true },
    ]);
  });

  it('leaves the caller list alone', () => {
    const items = [bucket('Small', 100, 10), bucket('Large', 900, 90)];
    collapseLookThrough(
      { items, totalPortfolioValue: 1000, unclassifiedValue: 0 },
      'Other',
    );
    expect(items.map((i) => i.name)).toEqual(['Small', 'Large']);
  });
});
