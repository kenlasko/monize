import { describe, it, expect } from 'vitest';
import {
  alignPeriodStart,
  asBreakdownPeriod,
  breakdownRequestEnd,
  currentPeriodKey,
  periodBounds,
  periodKeyOf,
  yearlyWindowStart,
} from './breakdown-period';

// The column in progress is left out by ending the window the day before it
// opens, so the server's totals are over the columns shown (issue #2413).
describe('breakdownRequestEnd', () => {
  const now = new Date(2026, 10, 25); // 25 November 2026

  it('ends the window before the current month unless it is included', () => {
    expect(breakdownRequestEnd('2026-11-25', '2026-05-01', 'month', false, now)).toBe('2026-10-31');
    expect(breakdownRequestEnd('2026-11-25', '2026-05-01', 'month', true, now)).toBe('2026-11-25');
  });

  it('ends a yearly window before the current year', () => {
    expect(breakdownRequestEnd('2026-11-25', '2021-01-01', 'year', false, now)).toBe('2025-12-31');
  });

  it('keeps a window that ends before the current column as it is', () => {
    expect(breakdownRequestEnd('2026-03-31', '2026-01-01', 'month', false, now)).toBe('2026-03-31');
  });

  it('asks for nothing when the whole window is the column in progress', () => {
    expect(breakdownRequestEnd('2026-11-25', '2026-11-01', 'month', false, now)).toBeNull();
    expect(breakdownRequestEnd('2026-11-25', '', 'month', false, now)).toBe('2026-10-31');
  });
});

describe('period helpers', () => {
  it('keys a month by itself or by its year', () => {
    expect(periodKeyOf('2025-07', 'month')).toBe('2025-07');
    expect(periodKeyOf('2025-07', 'year')).toBe('2025');
  });

  it('names the column today falls in', () => {
    const now = new Date(2026, 10, 19);
    expect(currentPeriodKey('month', now)).toBe('2026-11');
    expect(currentPeriodKey('year', now)).toBe('2026');
  });

  it('snaps a start to the first day of its column and keeps "all" empty', () => {
    expect(alignPeriodStart('2024-11-19', 'month')).toBe('2024-11-01');
    expect(alignPeriodStart('2024-11-19', 'year')).toBe('2024-01-01');
    expect(alignPeriodStart('', 'year')).toBe('');
  });

  it('bounds a column by its first and last day', () => {
    expect(periodBounds('2024-02', 'month')).toEqual({ start: '2024-02-01', end: '2024-02-29' });
    expect(periodBounds('2025-12', 'month')).toEqual({ start: '2025-12-01', end: '2025-12-31' });
    expect(periodBounds('2025', 'year')).toEqual({ start: '2025-01-01', end: '2025-12-31' });
  });

  it('reads anything but "year" as monthly', () => {
    expect(asBreakdownPeriod('year')).toBe('year');
    expect(asBreakdownPeriod('month')).toBe('month');
    expect(asBreakdownPeriod('weekly')).toBe('month');
    expect(asBreakdownPeriod(null)).toBe('month');
  });
});

describe('yearlyWindowStart', () => {
  it('counts N calendar years back from the current one', () => {
    const now = new Date(2026, 10, 19);
    expect(yearlyWindowStart('2y', '2024-11-19', now)).toBe('2024-01-01');
    expect(yearlyWindowStart('5y', '2021-12-01', now)).toBe('2021-01-01');
    expect(yearlyWindowStart('10y', '2016-12-01', now)).toBe('2016-01-01');
  });

  it('keeps two whole years on 31 December of a leap year', () => {
    // 730 days before 2028-12-31 is 2027-01-01: one whole year, not two.
    expect(yearlyWindowStart('2y', '2027-01-01', new Date(2028, 11, 31))).toBe('2026-01-01');
  });

  it('snaps a custom start to its year and keeps "all" empty', () => {
    const now = new Date(2026, 10, 19);
    expect(yearlyWindowStart('custom', '2023-07-14', now)).toBe('2023-01-01');
    expect(yearlyWindowStart('all', '', now)).toBe('');
  });
});
