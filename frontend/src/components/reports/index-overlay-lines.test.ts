import { describe, it, expect, vi } from 'vitest';
import { overlayIndexLines } from './index-overlay-lines';
import type { PerformanceComparison } from '@/types/investment';

vi.mock('@/lib/utils', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

const ts = (d: string) => new Date(d + 'T00:00:00').getTime();

const SP500 = {
  key: 'idx:SP500',
  kind: 'INDEX',
  id: 'SP500',
  label: 'SP500',
  name: 'S&P 500',
  currencyCode: 'USD',
  basis: 'ADJUSTED',
} as const;

function comparison(
  points: Array<[string, number | null]>,
  overrides: Partial<PerformanceComparison> = {},
): PerformanceComparison {
  return {
    window: { start: points[0][0], end: points[points.length - 1][0] },
    sampling: 'day',
    series: [SP500],
    points: points.map(([date, value]) => ({ date, values: { 'idx:SP500': value } })),
    totals: {},
    gaps: [],
    excluded: [],
    status: 'complete',
    ...overrides,
  };
}

describe('overlayIndexLines', () => {
  it('draws nothing with no comparison', () => {
    expect(overlayIndexLines(null)).toEqual([]);
  });

  it('keeps an index on its own sampled dates, its gaps as nulls', () => {
    // Friday, a planted gap, then the next Wednesday: nothing for the weekend.
    const [line] = overlayIndexLines(
      comparison([
        ['2026-09-11', 0],
        ['2026-09-14', null],
        ['2026-09-16', 1.5],
      ]),
    );
    expect(line).toMatchObject({ key: 'idx:SP500', code: 'SP500', name: 'S&P 500' });
    expect(line.points).toEqual([
      { ts: ts('2026-09-11'), 'idx:SP500': 0 },
      { ts: ts('2026-09-14'), 'idx:SP500': null },
      { ts: ts('2026-09-16'), 'idx:SP500': 1.5 },
    ]);
  });

  it('answers the tooltip only for a date the server sent', () => {
    const [line] = overlayIndexLines(
      comparison([
        ['2026-09-11', 0],
        ['2026-09-14', 2],
      ]),
    );
    expect(line.valueAt.get(ts('2026-09-14'))).toBe(2);
    // Saturday was never sampled: no value, rather than the next row's.
    expect(line.valueAt.get(ts('2026-09-12'))).toBeUndefined();
  });

  it('draws no line for an index with no known value', () => {
    expect(overlayIndexLines(comparison([['2026-09-01', null]]))).toEqual([]);
  });

  it('draws no line for a security series, only indexes', () => {
    const lines = overlayIndexLines(
      comparison([['2026-09-01', 0]], {
        series: [{ ...SP500, key: 'sec:1', kind: 'SECURITY', id: '1', label: 'VFV' }],
      }),
    );
    expect(lines).toEqual([]);
  });
});
