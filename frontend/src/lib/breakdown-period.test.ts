import { describe, it, expect } from 'vitest';
import {
  alignPeriodStart,
  asBreakdownPeriod,
  breakdownByPeriod,
  currentPeriodKey,
  periodBounds,
  periodKeyOf,
  yearlyWindowStart,
} from './breakdown-period';
import type { MonthlyCategoryBreakdownResponse } from '@/types/built-in-reports';

const response: MonthlyCategoryBreakdownResponse = {
  currency: 'USD',
  months: ['2024-11', '2024-12', '2025-01', '2025-02'],
  data: [
    {
      categoryId: 'cat-groceries',
      categoryName: 'Groceries',
      parentId: null,
      parentName: null,
      parentIsIncome: null,
      isIncome: false,
      // 0.1 + 0.2 in floats is 0.30000000000000004; the year must be 0.3.
      valuesByMonth: { '2024-11': 0.1, '2024-12': 0.2, '2025-01': 300, '2025-02': 400.55 },
      depositTotal: 0,
      withdrawalTotal: 700.85,
    },
  ],
  transfers: [
    {
      accountId: 'acc-1',
      accountName: 'Chequing',
      direction: 'from',
      valuesByMonth: { '2024-12': 50, '2025-02': 25 },
    },
  ],
  missingCurrencies: [],
  excludedCount: 0,
};

describe('breakdownByPeriod', () => {
  it('returns the monthly answer untouched', () => {
    expect(breakdownByPeriod(response, 'month')).toBe(response);
  });

  it('folds every month into its calendar year, in integer money units', () => {
    const yearly = breakdownByPeriod(response, 'year');
    expect(yearly.months).toEqual(['2024', '2025']);
    expect(yearly.data[0].valuesByMonth).toEqual({ '2024': 0.3, '2025': 700.55 });
    expect(yearly.transfers[0].valuesByMonth).toEqual({ '2024': 50, '2025': 25 });
    // Everything that is not a per-column figure is carried over as it came.
    expect(yearly.data[0].withdrawalTotal).toBe(700.85);
    expect(yearly.currency).toBe('USD');
  });

  it('sorts the years even when the months arrive out of order', () => {
    const yearly = breakdownByPeriod({ ...response, months: ['2025-01', '2023-05', '2024-02'] }, 'year');
    expect(yearly.months).toEqual(['2023', '2024', '2025']);
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
