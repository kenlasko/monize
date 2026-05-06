import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCachedResult,
  setCachedResult,
  clearCachedResult,
  MONTE_CARLO_RESULTS_STORAGE_KEY,
} from './monte-carlo-cache';
import type { SimulationResult } from './monte-carlo';

const sampleResult: SimulationResult = {
  yearLabels: ['2025'],
  percentiles: { p10: [0], p25: [0], p50: [0], p75: [0], p90: [0] },
  finalDistribution: { min: 0, max: 0, mean: 0, median: 0, stdev: 0, depletionRate: 0 },
  performanceSummary: {
    twrNominal: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 },
    twrReal: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 },
    endBalanceNominal: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 },
    endBalanceReal: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 },
    meanReturnNominal: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 },
    annualizedVolatility: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 },
    maxDrawdown: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 },
    maxDrawdownExcludingCashflows: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 },
    safeWithdrawalRate: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 },
    perpetualWithdrawalRate: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 },
  },
  successRate: 1,
  inputsSnapshot: {},
  realValues: false,
  ranAt: '2025-01-01',
};

describe('monte-carlo-cache', () => {
  beforeEach(() => {
    window.localStorage.removeItem(MONTE_CARLO_RESULTS_STORAGE_KEY);
  });

  it('returns null when no result is cached', () => {
    expect(getCachedResult('s-1')).toBeNull();
  });

  it('stores and reads back a result', () => {
    setCachedResult('s-1', sampleResult);
    expect(getCachedResult('s-1')).toEqual(sampleResult);
  });

  it('storing one scenario does not overwrite another', () => {
    setCachedResult('s-1', sampleResult);
    const altered = { ...sampleResult, successRate: 0.5 };
    setCachedResult('s-2', altered);
    expect(getCachedResult('s-1')).toEqual(sampleResult);
    expect(getCachedResult('s-2')!.successRate).toBe(0.5);
  });

  it('clearCachedResult removes the result', () => {
    setCachedResult('s-1', sampleResult);
    clearCachedResult('s-1');
    expect(getCachedResult('s-1')).toBeNull();
  });

  it('clearCachedResult is a no-op for missing keys', () => {
    expect(() => clearCachedResult('not-set')).not.toThrow();
  });

  it('handles malformed localStorage gracefully', () => {
    window.localStorage.setItem(MONTE_CARLO_RESULTS_STORAGE_KEY, 'not-json');
    expect(getCachedResult('s-1')).toBeNull();
  });

  it('handles non-object localStorage value gracefully', () => {
    window.localStorage.setItem(MONTE_CARLO_RESULTS_STORAGE_KEY, 'null');
    expect(getCachedResult('s-1')).toBeNull();
  });
});
