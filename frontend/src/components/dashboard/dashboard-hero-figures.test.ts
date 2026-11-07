import { describe, it, expect } from 'vitest';
import type { MonthlyNetWorth } from '@/types/net-worth';
import { heroMonthChange, heroSnapshot } from './dashboard-hero-figures';

const month = (m: string, assets: number, liabilities: number, extra: Partial<MonthlyNetWorth> = {}): MonthlyNetWorth => ({
  month: m,
  assets,
  liabilities,
  netWorth: assets - liabilities,
  ...extra,
});

describe('heroSnapshot', () => {
  it('reads the newest month as complete figures', () => {
    const snap = heroSnapshot([month('2026-10', 900, 400), month('2026-11', 1000, 400)]);
    expect(snap?.netWorth).toEqual({ value: 600, missingCurrencies: [], excludedCount: 0 });
    expect(snap?.assets.value).toBe(1000);
    expect(snap?.liabilities.value).toBe(400);
  });

  it('is null for an empty series, never a net worth of zero', () => {
    expect(heroSnapshot([])).toBeNull();
  });

  it('marks only the side that failed to convert, and net worth with it', () => {
    const snap = heroSnapshot([
      month('2026-11', 1000, 400, {
        fxComplete: false,
        assetsFxComplete: false,
        liabilitiesFxComplete: true,
        missingRatePairs: ['EUR->CAD'],
      }),
    ]);
    expect(snap?.assets.missingCurrencies).toEqual(['EUR']);
    expect(snap?.liabilities.missingCurrencies).toEqual([]);
    expect(snap?.netWorth.missingCurrencies).toEqual(['EUR']);
  });

  it('treats absent flags as no information, not as incomplete', () => {
    const snap = heroSnapshot([month('2026-11', 10, 0)]);
    expect(snap?.netWorth.excludedCount).toBe(0);
  });
});

describe('heroMonthChange', () => {
  it('compares the newest month with the one before it', () => {
    const change = heroMonthChange([month('2026-09', 0, 0), month('2026-10', 1000, 0), month('2026-11', 1100, 0)], 4);
    expect(change).toEqual({ known: true, amount: 100, percent: 10 });
  });

  it('measures a fall against the magnitude of a negative month', () => {
    const change = heroMonthChange([month('2026-10', 0, 200), month('2026-11', 0, 250)], 4);
    expect(change?.amount).toBe(-50);
    expect(change?.percent).toBe(-25);
  });

  it('sheds float error without rounding to cents or whole units', () => {
    const change = heroMonthChange([month('2026-10', 0.1, 0), month('2026-11', 0.3, 0)], 4);
    expect(change?.amount).toBe(0.2);
    const precise = heroMonthChange([month('2026-10', 1000.25, 0), month('2026-11', 1012.7575, 0)], 4);
    expect(precise?.amount).toBe(12.5075);
  });

  it('has no percentage over a zero month', () => {
    expect(heroMonthChange([month('2026-10', 0, 0), month('2026-11', 50, 0)], 4)?.percent).toBeNull();
  });

  it('is unknown when either month is a subtotal', () => {
    const partialPrev = heroMonthChange([month('2026-10', 1, 0, { fxComplete: false }), month('2026-11', 2, 0)], 4);
    expect(partialPrev?.known).toBe(false);
    const partialNow = heroMonthChange([month('2026-10', 1, 0), month('2026-11', 2, 0, { liabilitiesFxComplete: false })], 4);
    expect(partialNow?.known).toBe(false);
  });

  it('is null with fewer than two months', () => {
    expect(heroMonthChange([month('2026-11', 1, 0)], 4)).toBeNull();
    expect(heroMonthChange([], 4)).toBeNull();
  });
});
