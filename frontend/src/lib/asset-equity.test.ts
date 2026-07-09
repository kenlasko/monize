import { describe, it, expect } from 'vitest';
import { computeAppreciation, buildEquitySeries } from './asset-equity';

describe('computeAppreciation', () => {
  const today = new Date(2026, 0, 1); // 2026-01-01

  it('computes total appreciation and percent', () => {
    const a = computeAppreciation(120000, 100000, null, today);
    expect(a.total).toBe(20000);
    expect(a.totalPercent).toBeCloseTo(20);
    expect(a.annualizedPercent).toBeNull(); // no acquisition date
  });

  it('computes annualized appreciation over multiple years', () => {
    // 100k -> 121k over 2 years => ~10% CAGR.
    const a = computeAppreciation(121000, 100000, '2024-01-01', today);
    expect(a.annualizedPercent).toBeCloseTo(10, 1);
  });

  it('returns null annualized for a very short hold', () => {
    const a = computeAppreciation(105000, 100000, '2025-12-20', today);
    expect(a.annualizedPercent).toBeNull();
  });

  it('handles a zero purchase value without dividing by zero', () => {
    const a = computeAppreciation(5000, 0, null, today);
    expect(a.total).toBe(5000);
    expect(a.totalPercent).toBe(0);
    expect(a.annualizedPercent).toBeNull();
  });
});

describe('buildEquitySeries', () => {
  it('subtracts the owed loan balance from the asset value', () => {
    const asset = [
      { date: '2026-01-01', balance: 500000 },
      { date: '2026-02-01', balance: 510000 },
    ];
    const loan = [
      { date: '2026-01-01', balance: -300000 },
      { date: '2026-02-01', balance: -295000 },
    ];
    expect(buildEquitySeries(asset, loan)).toEqual([
      { date: '2026-01-01', balance: 200000 },
      { date: '2026-02-01', balance: 215000 },
    ]);
  });

  it('forward-fills across misaligned dates and omits pre-asset dates', () => {
    const asset = [{ date: '2026-01-15', balance: 400000 }];
    const loan = [
      { date: '2026-01-01', balance: -100000 },
      { date: '2026-02-01', balance: -90000 },
    ];
    const series = buildEquitySeries(asset, loan);
    // 2026-01-01 is before the asset's first point -> omitted.
    expect(series.map((p) => p.date)).toEqual(['2026-01-15', '2026-02-01']);
    expect(series[0]).toEqual({ date: '2026-01-15', balance: 300000 }); // 400k - 100k
    expect(series[1]).toEqual({ date: '2026-02-01', balance: 310000 }); // 400k - 90k
  });

  it('treats a missing loan as zero debt', () => {
    const asset = [{ date: '2026-01-01', balance: 30000 }];
    expect(buildEquitySeries(asset, [])).toEqual([{ date: '2026-01-01', balance: 30000 }]);
  });
});
