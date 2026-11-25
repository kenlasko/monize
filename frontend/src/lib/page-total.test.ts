import { describe, it, expect } from 'vitest';
import {
  foldPageSums,
  pageDifference,
  pageRatio,
  pageSum,
  pageSumSign,
  pageSumValue,
} from './page-total';

describe('pageSum', () => {
  it('reads the exact sum once, where a float sum drifts below the half-cent', () => {
    // 1.0007 + 1.0143 is 2.0149999999999997 in doubles.
    expect(1.0007 + 1.0143).toBeLessThan(2.015);
    expect(pageSumValue(pageSum([1.0007, 1.0143], 2))).toBe(2.02);
  });

  it('rounds the sum once rather than adding rows that each round up', () => {
    // 1.005 reads 1.01 on its own; three of them are 3.015, which reads 3.02.
    expect(pageSumValue(pageSum([1.005, 1.005, 1.005], 2))).toBe(3.02);
  });

  it('is unknown when any component is', () => {
    expect(pageSum([1, null, 2], 2)).toBeNull();
  });

  it('is a known zero over no components', () => {
    expect(pageSumValue(pageSum([], 2))).toBe(0);
  });

  it('reads at the places it is given', () => {
    expect(pageSumValue(pageSum([162.3456, 162.3456], 0))).toBe(325);
  });
});

describe('foldPageSums', () => {
  it('folds the groups by their exact sums, never by their readings', () => {
    // Each group of 0.005 reads 0.01; the three together are 0.015, which reads 0.02.
    const groups = [pageSum([0.005], 2), pageSum([0.005], 2), pageSum([0.005], 2)];
    expect(groups.map(pageSumValue)).toEqual([0.01, 0.01, 0.01]);
    expect(pageSumValue(foldPageSums(groups, 2))).toBe(0.02);
  });

  it('is unknown when any group is', () => {
    expect(foldPageSums([pageSum([1], 2), null], 2)).toBeNull();
  });

  it('is a known zero over no groups', () => {
    expect(pageSumValue(foldPageSums([], 2))).toBe(0);
  });
});

describe('pageDifference', () => {
  it('is the single rounding of the exact difference', () => {
    // 0.008 reads 0.01 and 0.004 reads 0.00: the readings differ by 0.01, the net is 0.004.
    const a = pageSum([0.008], 2)!;
    const b = pageSum([0.004], 2)!;
    expect(pageDifference(a, b, 2).value).toBe(0);
  });
});

describe('pageRatio', () => {
  it('divides the exact sums, not their readings', () => {
    // Two parts of 1.2474: each reads 1.25 over a whole that reads 2.49 (50.2%), and each is half.
    const part = pageSum([1.2474], 2)!;
    const whole = pageSum([1.2474, 1.2474], 2)!;
    expect(part.value / whole.value).toBeGreaterThan(0.5);
    expect(pageRatio(part, whole)).toBe(0.5);
  });

  it('is null over a zero whole', () => {
    expect(pageRatio(pageSum([1], 2)!, pageSum([], 2)!)).toBeNull();
  });

  it('reads a figure with no exact sum as its value', () => {
    expect(pageRatio({ value: 1, missingCurrencies: [], excludedCount: 0 }, pageSum([4], 2)!)).toBe(
      0.25,
    );
  });
});

describe('pageSumSign', () => {
  it('reads the sign of the exact sum, not of its reading', () => {
    const small = pageSum([0.003], 2)!;
    expect(small.value).toBe(0);
    expect(pageSumSign(small)).toBe(1);
    expect(pageSumSign(pageSum([-0.003], 2)!)).toBe(-1);
    expect(pageSumSign(pageSum([], 2)!)).toBe(0);
  });
});
