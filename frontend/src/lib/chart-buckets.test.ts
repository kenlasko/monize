import { describe, it, expect } from 'vitest';
import {
  selectGranularity,
  bucketMonthlyTotals,
  countElapsedPeriods,
} from './chart-buckets';
import { MonthlyTotal } from '@/types/transaction';

const m = (month: string, total: number, count = 1): MonthlyTotal => ({
  month,
  total,
  count,
});

// Build N consecutive month keys starting at 2020-01.
function months(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const year = 2020 + Math.floor(i / 12);
    const month = (i % 12) + 1;
    out.push(`${year}-${String(month).padStart(2, '0')}`);
  }
  return out;
}

describe('selectGranularity', () => {
  it('returns month for empty or single-month input', () => {
    expect(selectGranularity([])).toBe('month');
    expect(selectGranularity(['2024-05'])).toBe('month');
  });

  it('stays monthly for spans up to ~2 years', () => {
    // span 23 months -> 24 buckets -> still month
    expect(selectGranularity(['2020-01', '2021-12'])).toBe('month');
  });

  it('switches to quarter for a medium (2-6 year) span', () => {
    // span 24 months -> 25 monthly buckets > 24 -> quarter
    expect(selectGranularity(['2020-01', '2022-01'])).toBe('quarter');
    expect(selectGranularity(['2020-01', '2025-12'])).toBe('quarter');
  });

  it('switches to year for a long (> ~6 year) span', () => {
    // span 72 months -> 25 quarterly buckets > 24 -> year
    expect(selectGranularity(['2020-01', '2026-02'])).toBe('year');
    expect(selectGranularity(['2010-01', '2024-01'])).toBe('year');
  });

  it('ignores input order (uses min/max)', () => {
    expect(selectGranularity(['2026-02', '2020-01'])).toBe('year');
  });
});

describe('bucketMonthlyTotals - month', () => {
  it('returns [] for empty input', () => {
    expect(bucketMonthlyTotals([], 'month')).toEqual([]);
  });

  it('gap-fills missing months with zero totals at their true position', () => {
    const data = [m('2020-01', 100), m('2020-04', 300), m('2020-12', 1200)];
    const buckets = bucketMonthlyTotals(data, 'month');
    // Jan..Dec = 12 buckets, no calendar gaps collapsed.
    expect(buckets).toHaveLength(12);
    expect(buckets.map((b) => b.key)).toEqual([
      '2020-01', '2020-02', '2020-03', '2020-04', '2020-05', '2020-06',
      '2020-07', '2020-08', '2020-09', '2020-10', '2020-11', '2020-12',
    ]);
    expect(buckets[0]).toMatchObject({ total: 100, count: 1, periodStart: '2020-01-01', periodEnd: '2020-01-31' });
    expect(buckets[1]).toMatchObject({ total: 0, count: 0 }); // gap-filled Feb
    expect(buckets[3]).toMatchObject({ total: 300, count: 1 });
    expect(buckets[11]).toMatchObject({ total: 1200, count: 1, periodStart: '2020-12-01', periodEnd: '2020-12-31' });
  });

  it('flags a period partial when a month has no total, keeping the known part', () => {
    const data = [
      m('2020-01', 100),
      { month: '2020-02', total: null, knownSubtotal: 40, count: 1 },
    ];
    const buckets = bucketMonthlyTotals(data, 'month');
    expect(buckets[0].partial).toBeUndefined();
    expect(buckets[1]).toMatchObject({ total: 40, partial: true });
    expect(bucketMonthlyTotals(data, 'quarter')[0]).toMatchObject({
      total: 140,
      partial: true,
    });
  });

  it('sums same-month rows in integer cents (no float drift)', () => {
    const data = [m('2020-01', 0.1), m('2020-01', 0.2)];
    const buckets = bucketMonthlyTotals(data, 'month');
    expect(buckets).toHaveLength(1);
    expect(buckets[0].total).toBe(0.3);
    expect(buckets[0].count).toBe(2);
  });

  it('reports a leap-February end date', () => {
    const buckets = bucketMonthlyTotals([m('2024-02', 50)], 'month');
    expect(buckets[0].periodEnd).toBe('2024-02-29');
  });

  it('preserves sign for net-negative periods', () => {
    const data = [m('2020-01', 100), m('2020-01', -250)];
    const buckets = bucketMonthlyTotals(data, 'month');
    expect(buckets[0].total).toBe(-150);
  });
});

describe('bucketMonthlyTotals - quarter', () => {
  it('rolls months into quarter buckets with correct keys and bounds', () => {
    const data = [m('2020-01', 100), m('2020-02', 100), m('2020-11', 300)];
    const buckets = bucketMonthlyTotals(data, 'quarter');
    // Q1..Q4 gap-filled = 4 buckets.
    expect(buckets.map((b) => b.key)).toEqual(['2020-Q1', '2020-Q2', '2020-Q3', '2020-Q4']);
    expect(buckets[0]).toMatchObject({ total: 200, count: 2, periodStart: '2020-01-01', periodEnd: '2020-03-31' });
    expect(buckets[1]).toMatchObject({ total: 0, count: 0, periodStart: '2020-04-01', periodEnd: '2020-06-30' });
    expect(buckets[3]).toMatchObject({ total: 300, count: 1, periodStart: '2020-10-01', periodEnd: '2020-12-31' });
  });
});

describe('bucketMonthlyTotals - year', () => {
  it('rolls a sparse multi-year series into one bucket per year', () => {
    const data = [m('2020-03', 1200), m('2022-07', 1200)];
    const buckets = bucketMonthlyTotals(data, 'year');
    expect(buckets.map((b) => b.key)).toEqual(['2020', '2021', '2022']);
    expect(buckets[0]).toMatchObject({ total: 1200, count: 1, periodStart: '2020-01-01', periodEnd: '2020-12-31' });
    expect(buckets[1]).toMatchObject({ total: 0, count: 0 }); // gap-filled 2021
    expect(buckets[2]).toMatchObject({ total: 1200, count: 1, periodStart: '2022-01-01', periodEnd: '2022-12-31' });
  });

  it('handles a single bucket', () => {
    const buckets = bucketMonthlyTotals([m('2020-06', 500)], 'year');
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ key: '2020', total: 500 });
  });
});

describe('countElapsedPeriods', () => {
  it('counts every elapsed period including gaps', () => {
    const data = [m('2020-01', 100), m('2020-12', 100)];
    expect(countElapsedPeriods(data, 'month')).toBe(12);
    expect(countElapsedPeriods(data, 'year')).toBe(1);
  });

  it('returns 0 for empty input', () => {
    expect(countElapsedPeriods([], 'month')).toBe(0);
  });

  it('matches the bucket length for a long monthly span', () => {
    const keys = months(30);
    const data = keys.map((k) => m(k, 10));
    expect(countElapsedPeriods(data, 'month')).toBe(30);
  });
});
