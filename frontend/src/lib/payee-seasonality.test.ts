import { describe, it, expect } from 'vitest';
import { computeSeasonality, MIN_YEARS_FOR_SEASONALITY } from './payee-seasonality';
import type { MonthlyTotal } from '@/types/transaction';

function month(key: string, total: number, count = 1): MonthlyTotal {
  return { month: key, total, count };
}

describe('computeSeasonality', () => {
  it('returns nothing for an empty history', () => {
    const result = computeSeasonality([]);
    expect(result.months).toEqual([]);
    expect(result.peakMonth).toBeNull();
    expect(result.yearsCovered).toBe(0);
  });

  it('averages a calendar month across the years rather than summing it', () => {
    const result = computeSeasonality([
      month('2024-01', -100),
      month('2025-01', -200),
      month('2026-01', -300),
    ]);

    const january = result.months.find((m) => m.month === 1);
    expect(january?.average).toBe(-200);
    expect(january?.years).toBe(3);
    expect(result.yearsCovered).toBe(3);
  });

  it('omits calendar months with no history rather than zero-filling them', () => {
    const result = computeSeasonality([month('2024-03', -50), month('2025-03', -70)]);

    expect(result.months).toHaveLength(1);
    expect(result.months[0].month).toBe(3);
  });

  it('names the peak month when one clearly dominates', () => {
    const evenMonths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].flatMap((m) => [
      month(`2025-${String(m).padStart(2, '0')}`, -100),
      month(`2026-${String(m).padStart(2, '0')}`, -100),
    ]);
    const result = computeSeasonality([
      ...evenMonths,
      month('2025-12', -900),
      month('2026-12', -900),
    ]);

    expect(result.peakMonth).toBe(12);
    expect(result.peakRatio).toBeCloseTo(9, 5);
  });

  it('claims no peak for a payee billed evenly', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((m) => [
      month(`2025-${String(m).padStart(2, '0')}`, -100),
      month(`2026-${String(m).padStart(2, '0')}`, -105),
    ]);
    const result = computeSeasonality(rows);

    // A largest month exists, but it is not a season.
    expect(result.peakMonth).toBeNull();
    expect(result.peakRatio).toBeNull();
  });

  it('refuses to call one year of history seasonal', () => {
    const result = computeSeasonality([
      month('2026-01', -10),
      month('2026-02', -10),
      month('2026-12', -900),
    ]);

    expect(result.yearsCovered).toBe(1);
    expect(result.yearsCovered).toBeLessThan(MIN_YEARS_FOR_SEASONALITY);
    expect(result.peakMonth).toBeNull();
  });

  it('detects a peak the same way for an income payee', () => {
    const evenMonths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].flatMap((m) => [
      month(`2025-${String(m).padStart(2, '0')}`, 1000),
      month(`2026-${String(m).padStart(2, '0')}`, 1000),
    ]);
    const result = computeSeasonality([
      ...evenMonths,
      // A December bonus.
      month('2025-12', 5000),
      month('2026-12', 5000),
    ]);

    expect(result.peakMonth).toBe(12);
  });

  it('ignores rows whose month key is not YYYY-MM', () => {
    const result = computeSeasonality([
      month('not-a-month', -100),
      month('2026-13', -100),
      month('2026-05', -100),
      month('2025-05', -100),
    ]);

    expect(result.months).toHaveLength(1);
    expect(result.months[0].month).toBe(5);
    expect(result.yearsCovered).toBe(2);
  });

  it('keeps months in calendar order', () => {
    const result = computeSeasonality([
      month('2026-11', -10),
      month('2026-02', -10),
      month('2026-07', -10),
    ]);

    expect(result.months.map((m) => m.month)).toEqual([2, 7, 11]);
  });

  it('skips a month with an unknown total instead of averaging it as zero', () => {
    const result = computeSeasonality([
      month('2025-05', -100),
      { month: '2026-05', total: null, knownSubtotal: -10, count: 1 },
    ]);

    expect(result.months).toEqual([{ month: 5, average: -100, years: 1 }]);
  });
});
