import { describe, it, expect } from 'vitest';
import { buildTimeAxisTicks } from './chart-time-axis';

const ts = (d: string) => new Date(d + 'T00:00:00Z').getTime();

describe('buildTimeAxisTicks', () => {
  it('returns a single tick when the range is empty or inverted', () => {
    const only = ts('2024-01-01');
    expect(buildTimeAxisTicks(only, only)).toEqual({ ticks: [only], stepMonths: 1 });
    expect(buildTimeAxisTicks(only, only - 1000)).toEqual({ ticks: [only], stepMonths: 1 });
  });

  it('keeps the tick count within the target by widening the step', () => {
    const { ticks, stepMonths } = buildTimeAxisTicks(ts('2010-01-01'), ts('2024-01-01'), 10);
    // 14 years cannot fit monthly/quarterly ticks under 10, so it steps up.
    expect(stepMonths).toBeGreaterThanOrEqual(12);
    expect(ticks.length).toBeLessThanOrEqual(10);
    // Ticks stay within the requested range and ascend.
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    }
    expect(ticks[0]).toBeGreaterThanOrEqual(ts('2010-01-01'));
  });

  it('uses a fine (monthly) step for a short range', () => {
    const { stepMonths } = buildTimeAxisTicks(ts('2024-01-01'), ts('2024-04-01'), 10);
    expect(stepMonths).toBe(1);
  });
});
