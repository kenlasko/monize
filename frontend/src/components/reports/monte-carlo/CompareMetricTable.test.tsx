import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { render, screen } from '@/test/render';
import { CompareMetricTable, CompareColumn } from './CompareMetricTable';
import type {
  MonteCarloScenario,
  SimulationResult,
} from '@/lib/monte-carlo';

const scenario = (overrides: Partial<MonteCarloScenario> = {}): MonteCarloScenario => ({
  id: 'scn-1',
  name: 'Aggressive',
  description: null,
  accountIds: ['a'],
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
  targetValue: null,
  randomSeed: null,
  isFavourite: false,
  sortOrder: 0,
  lastRunAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  cashFlows: [],
  ...overrides,
});

const result = (): SimulationResult => ({
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
});

const dollar = (n: number) => `$${n.toFixed(0)}`;

describe('CompareMetricTable', () => {
  it('renders one column per scenario with metric rows from each group', () => {
    const columns: CompareColumn[] = [
      {
        id: 'a',
        status: 'ok',
        scenario: scenario({ id: 'a', name: 'Plan A' }),
        result: result(),
      },
      {
        id: 'b',
        status: 'ok',
        scenario: scenario({ id: 'b', name: 'Plan B', startingValue: 75000 }),
        result: result(),
      },
    ];

    render(
      <CompareMetricTable
        columns={columns}
        formatCurrency={dollar}
        onRetry={vi.fn()}
        onRemove={vi.fn()}
        onRerun={vi.fn()}
      />,
    );

    // Each scenario name appears in the column header and in the Identity row.
    expect(screen.getAllByText('Plan A').length).toBe(2);
    expect(screen.getAllByText('Plan B').length).toBe(2);
    expect(screen.getByText('Identity')).toBeInTheDocument();
    expect(screen.getByText('Inputs')).toBeInTheDocument();
    expect(screen.getByText('Final distribution')).toBeInTheDocument();
    expect(screen.getByText('Performance summary')).toBeInTheDocument();
    // Currency-formatted starting value cells.
    expect(screen.getByText('$100000')).toBeInTheDocument();
    expect(screen.getByText('$75000')).toBeInTheDocument();
    // Success rate as percent.
    expect(screen.getAllByText('72.00%').length).toBe(2);
  });

  it('renders an error cell with retry button when status is error', () => {
    const onRetry = vi.fn();
    const columns: CompareColumn[] = [
      {
        id: 'a',
        status: 'ok',
        scenario: scenario({ id: 'a', name: 'Plan A' }),
        result: result(),
      },
      {
        id: 'b',
        status: 'error',
        scenario: scenario({ id: 'b', name: 'Plan B' }),
        result: null,
        error: 'Network exploded',
      },
    ];

    render(
      <CompareMetricTable
        columns={columns}
        formatCurrency={dollar}
        onRetry={onRetry}
        onRemove={vi.fn()}
        onRerun={vi.fn()}
      />,
    );

    // Error message renders in every result-derived row, so use getAllByText.
    expect(screen.getAllByText('Network exploded').length).toBeGreaterThan(0);
    const retryButtons = screen.getAllByRole('button', { name: 'Retry' });
    fireEvent.click(retryButtons[0]);
    expect(onRetry).toHaveBeenCalledWith('b');
  });

  it('shows "Scenario no longer exists" for missing columns', () => {
    const columns: CompareColumn[] = [
      {
        id: 'a',
        status: 'missing',
        scenario: null,
        result: null,
      },
      {
        id: 'b',
        status: 'ok',
        scenario: scenario({ id: 'b', name: 'Plan B' }),
        result: result(),
      },
    ];

    render(
      <CompareMetricTable
        columns={columns}
        formatCurrency={dollar}
        onRetry={vi.fn()}
        onRemove={vi.fn()}
        onRerun={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Scenario no longer exists').length).toBeGreaterThan(0);
  });

  it('calls onRemove when the remove button is clicked', () => {
    const onRemove = vi.fn();
    const columns: CompareColumn[] = [
      {
        id: 'a',
        status: 'ok',
        scenario: scenario({ id: 'a', name: 'Plan A' }),
        result: result(),
      },
      {
        id: 'b',
        status: 'ok',
        scenario: scenario({ id: 'b', name: 'Plan B' }),
        result: result(),
      },
    ];

    render(
      <CompareMetricTable
        columns={columns}
        formatCurrency={dollar}
        onRetry={vi.fn()}
        onRemove={onRemove}
        onRerun={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove Plan B from comparison' }),
    );
    expect(onRemove).toHaveBeenCalledWith('b');
  });

  it('shows cached badge and re-run button for ok columns from cache', () => {
    const onRerun = vi.fn();
    const columns: CompareColumn[] = [
      {
        id: 'a',
        status: 'ok',
        scenario: scenario({ id: 'a', name: 'Plan A' }),
        result: result(),
        fromCache: true,
      },
      {
        id: 'b',
        status: 'ok',
        scenario: scenario({ id: 'b', name: 'Plan B' }),
        result: result(),
      },
    ];

    render(
      <CompareMetricTable
        columns={columns}
        formatCurrency={dollar}
        onRetry={vi.fn()}
        onRemove={vi.fn()}
        onRerun={onRerun}
      />,
    );

    expect(screen.getByText('cached')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Re-run' })[0]);
    expect(onRerun).toHaveBeenCalledWith('a');
  });
});
