import { describe, it, expect } from 'vitest';
import {
  formatPercent,
  formatCellValue,
  ROW_GROUPS,
} from './compareMetricRows';
import type {
  MonteCarloScenario,
  SimulationResult,
} from '@/lib/monte-carlo';

const fakeScenario = (overrides: Partial<MonteCarloScenario> = {}): MonteCarloScenario => ({
  id: 'scn-1',
  name: 'Aggressive',
  description: 'Aggressive growth scenario',
  accountIds: ['a', 'b'],
  startingValue: 100000,
  useCurrentBalance: true,
  yearsToRetirement: 25,
  annualContribution: 12000,
  contributionGrowthRate: 0.02,
  yearsInRetirement: 30,
  annualWithdrawal: 60000,
  expectedReturn: 0.07,
  volatility: 0.15,
  inflationRate: 0.025,
  showRealValues: false,
  useHistoricalReturns: false,
  simulationCount: 5000,
  targetValue: 1000000,
  randomSeed: null,
  isFavourite: false,
  sortOrder: 0,
  lastRunAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  cashFlows: [],
  ...overrides,
});

const fakeResult = (overrides: Partial<SimulationResult> = {}): SimulationResult => ({
  yearLabels: ['2027', '2028'],
  percentiles: {
    p10: [110, 120],
    p25: [115, 130],
    p50: [120, 140],
    p75: [125, 150],
    p90: [130, 160],
  },
  finalDistribution: {
    min: 50,
    max: 300,
    mean: 165,
    median: 160,
    stdev: 30,
    depletionRate: 0.05,
  },
  performanceSummary: {
    twrNominal: { p10: 0.04, p25: 0.05, p50: 0.06, p75: 0.07, p90: 0.08 },
    twrReal: { p10: 0.02, p25: 0.03, p50: 0.04, p75: 0.05, p90: 0.06 },
    endBalanceNominal: { p10: 50, p25: 100, p50: 160, p75: 220, p90: 300 },
    endBalanceReal: { p10: 40, p25: 80, p50: 130, p75: 180, p90: 260 },
    meanReturnNominal: { p10: 0.04, p25: 0.05, p50: 0.06, p75: 0.07, p90: 0.08 },
    annualizedVolatility: { p10: 0.08, p25: 0.09, p50: 0.1, p75: 0.11, p90: 0.12 },
    maxDrawdown: { p10: -0.5, p25: -0.4, p50: -0.3, p75: -0.2, p90: -0.1 },
    maxDrawdownExcludingCashflows: { p10: -0.3, p25: -0.25, p50: -0.2, p75: -0.15, p90: -0.1 },
    safeWithdrawalRate: { p10: 0.03, p25: 0.04, p50: 0.05, p75: 0.06, p90: 0.07 },
    perpetualWithdrawalRate: { p10: 0.01, p25: 0.02, p50: 0.03, p75: 0.04, p90: 0.05 },
  },
  successRate: 0.72,
  inputsSnapshot: {},
  realValues: false,
  ranAt: '2026-05-01T00:00:00Z',
  ...overrides,
});

const dollar = (n: number) => `$${n.toFixed(2)}`;

describe('formatPercent', () => {
  it('multiplies by 100 and appends %', () => {
    expect(formatPercent(0.0725)).toBe('7.25%');
  });

  it('renders em-dash for null', () => {
    expect(formatPercent(null)).toBe('—');
  });

  it('renders em-dash for NaN', () => {
    expect(formatPercent(Number.NaN)).toBe('—');
  });

  it('respects decimal places argument', () => {
    expect(formatPercent(0.073, 1)).toBe('7.3%');
  });
});

describe('formatCellValue', () => {
  it('formats currency via the supplied formatter', () => {
    expect(formatCellValue(1234.5, 'currency', dollar)).toBe('$1234.50');
  });

  it('formats percent for finite numbers', () => {
    expect(formatCellValue(0.05, 'percent', dollar)).toBe('5.00%');
  });

  it('formats number with locale separators', () => {
    expect(formatCellValue(1234567, 'number', dollar)).toBe(
      (1234567).toLocaleString(),
    );
  });

  it('returns text values as-is', () => {
    expect(formatCellValue('Aggressive', 'text', dollar)).toBe('Aggressive');
  });

  it('renders booleans as Yes/No', () => {
    expect(formatCellValue(true, 'boolean', dollar)).toBe('Yes');
    expect(formatCellValue(false, 'boolean', dollar)).toBe('No');
  });

  it('renders em-dash for null', () => {
    expect(formatCellValue(null, 'currency', dollar)).toBe('—');
  });
});

describe('ROW_GROUPS', () => {
  it('exposes the expected groups in order', () => {
    expect(ROW_GROUPS.map((g) => g.key)).toEqual([
      'identity',
      'inputs',
      'finalDistribution',
      'finalYearBands',
      'performance',
      'outcome',
    ]);
  });

  it('extracts final-year percentile bands from the result', () => {
    const finalYear = ROW_GROUPS.find((g) => g.key === 'finalYearBands')!;
    const ctx = { scenario: fakeScenario(), result: fakeResult() };
    const p50 = finalYear.rows.find((r) => r.key === 'finalYear.p50')!;
    expect(p50.accessor(ctx)).toBe(140);
  });

  it('returns null for result-derived rows when result is missing', () => {
    const finalDist = ROW_GROUPS.find((g) => g.key === 'finalDistribution')!;
    const ctx = { scenario: fakeScenario(), result: null };
    for (const row of finalDist.rows) {
      expect(row.accessor(ctx)).toBeNull();
    }
  });

  it('renders successRate as percent and handles null targets', () => {
    const outcome = ROW_GROUPS.find((g) => g.key === 'outcome')!;
    const successRate = outcome.rows[0];
    const withResult = successRate.accessor({
      scenario: fakeScenario(),
      result: fakeResult({ successRate: null }),
    });
    expect(withResult).toBeNull();
    expect(formatCellValue(withResult, successRate.format, dollar)).toBe('—');
  });

  it('uses scenario inputs for the inputs group', () => {
    const inputs = ROW_GROUPS.find((g) => g.key === 'inputs')!;
    const startingValue = inputs.rows.find((r) => r.key === 'startingValue')!;
    const ctx = { scenario: fakeScenario({ startingValue: 75000 }), result: null };
    expect(startingValue.accessor(ctx)).toBe(75000);
  });

  it('emits 30 performance rows (10 metrics × p10/p50/p90)', () => {
    const perf = ROW_GROUPS.find((g) => g.key === 'performance')!;
    expect(perf.rows.length).toBe(30);
  });
});
