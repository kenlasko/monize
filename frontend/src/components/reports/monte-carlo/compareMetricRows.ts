import {
  MonteCarloScenario,
  PercentileBand,
  SimulationResult,
} from '@/lib/monte-carlo';

export type RowFormat = 'currency' | 'percent' | 'number' | 'text' | 'boolean';

export type ScenarioContext = {
  scenario: MonteCarloScenario;
  result: SimulationResult | null;
};

export type MetricRow = {
  key: string;
  label: string;
  format: RowFormat;
  /**
   * Returns the cell value for a scenario column. Return `null` when the
   * datum is not available (renders as `—`).
   */
  accessor: (ctx: ScenarioContext) => number | string | boolean | null;
  /** Marks the row as the start of a new subgroup within the parent group. */
  subgroupStart?: boolean;
};

export type RowGroup = {
  key: string;
  label: string;
  rows: MetricRow[];
};

export function formatPercent(value: number | null, dp = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(dp)}%`;
}

export function formatCellValue(
  value: number | string | boolean | null,
  format: RowFormat,
  formatCurrency: (n: number) => string,
): string {
  if (value === null) return '—';
  if (format === 'text') return String(value);
  if (format === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (format === 'currency') return formatCurrency(value);
  if (format === 'percent') return formatPercent(value);
  return value.toLocaleString();
}

const last = <T>(arr: T[] | undefined): T | null =>
  arr && arr.length > 0 ? arr[arr.length - 1] : null;

const fromBand = (
  pick: (s: SimulationResult['performanceSummary']) => PercentileBand,
  key: keyof PercentileBand,
) => (ctx: ScenarioContext) =>
  ctx.result ? pick(ctx.result.performanceSummary)[key] : null;

const PERFORMANCE_METRICS: Array<{
  label: string;
  format: 'currency' | 'percent';
  pick: (s: SimulationResult['performanceSummary']) => PercentileBand;
  keyBase: string;
}> = [
  {
    label: 'Time-weighted return (nominal)',
    format: 'percent',
    pick: (s) => s.twrNominal,
    keyBase: 'twrNominal',
  },
  {
    label: 'Time-weighted return (real)',
    format: 'percent',
    pick: (s) => s.twrReal,
    keyBase: 'twrReal',
  },
  {
    label: 'End balance (nominal)',
    format: 'currency',
    pick: (s) => s.endBalanceNominal,
    keyBase: 'endBalanceNominal',
  },
  {
    label: 'End balance (real)',
    format: 'currency',
    pick: (s) => s.endBalanceReal,
    keyBase: 'endBalanceReal',
  },
  {
    label: 'Annual mean return (nominal)',
    format: 'percent',
    pick: (s) => s.meanReturnNominal,
    keyBase: 'meanReturnNominal',
  },
  {
    label: 'Annualized volatility',
    format: 'percent',
    pick: (s) => s.annualizedVolatility,
    keyBase: 'annualizedVolatility',
  },
  {
    label: 'Maximum drawdown',
    format: 'percent',
    pick: (s) => s.maxDrawdown,
    keyBase: 'maxDrawdown',
  },
  {
    label: 'Max drawdown (excl. cash flows)',
    format: 'percent',
    pick: (s) => s.maxDrawdownExcludingCashflows,
    keyBase: 'maxDrawdownExcludingCashflows',
  },
  {
    label: 'Safe withdrawal rate',
    format: 'percent',
    pick: (s) => s.safeWithdrawalRate,
    keyBase: 'safeWithdrawalRate',
  },
  {
    label: 'Perpetual withdrawal rate',
    format: 'percent',
    pick: (s) => s.perpetualWithdrawalRate,
    keyBase: 'perpetualWithdrawalRate',
  },
];

const performanceRows: MetricRow[] = PERFORMANCE_METRICS.flatMap(
  ({ label, format, pick, keyBase }, metricIdx) =>
    (['p10', 'p50', 'p90'] as const).map<MetricRow>((p, pIdx) => ({
      key: `${keyBase}.${p}`,
      label: `${label} (${p})`,
      format,
      accessor: fromBand(pick, p),
      subgroupStart: pIdx === 0 && metricIdx > 0,
    })),
);

export const ROW_GROUPS: RowGroup[] = [
  {
    key: 'identity',
    label: 'Identity',
    rows: [
      {
        key: 'name',
        label: 'Name',
        format: 'text',
        accessor: (ctx) => ctx.scenario.name,
      },
      {
        key: 'description',
        label: 'Description',
        format: 'text',
        accessor: (ctx) => ctx.scenario.description ?? '—',
      },
      {
        key: 'lastRunAt',
        label: 'Last run',
        format: 'text',
        accessor: (ctx) =>
          ctx.scenario.lastRunAt
            ? new Date(ctx.scenario.lastRunAt).toLocaleString()
            : 'Never',
      },
    ],
  },
  {
    key: 'inputs',
    label: 'Inputs',
    rows: [
      {
        key: 'startingValue',
        label: 'Starting value',
        format: 'currency',
        accessor: (ctx) => Number(ctx.scenario.startingValue),
      },
      {
        key: 'yearsToRetirement',
        label: 'Years to retirement',
        format: 'number',
        accessor: (ctx) => ctx.scenario.yearsToRetirement,
      },
      {
        key: 'annualContribution',
        label: 'Annual contribution',
        format: 'currency',
        accessor: (ctx) => Number(ctx.scenario.annualContribution),
      },
      {
        key: 'contributionGrowthRate',
        label: 'Contribution growth',
        format: 'percent',
        accessor: (ctx) => Number(ctx.scenario.contributionGrowthRate),
      },
      {
        key: 'yearsInRetirement',
        label: 'Years in retirement',
        format: 'number',
        accessor: (ctx) => ctx.scenario.yearsInRetirement,
      },
      {
        key: 'annualWithdrawal',
        label: 'Annual withdrawal',
        format: 'currency',
        accessor: (ctx) => Number(ctx.scenario.annualWithdrawal),
      },
      {
        key: 'expectedReturn',
        label: 'Expected return',
        format: 'percent',
        accessor: (ctx) => Number(ctx.scenario.expectedReturn),
      },
      {
        key: 'volatility',
        label: 'Volatility',
        format: 'percent',
        accessor: (ctx) => Number(ctx.scenario.volatility),
      },
      {
        key: 'inflationRate',
        label: 'Inflation rate',
        format: 'percent',
        accessor: (ctx) => Number(ctx.scenario.inflationRate),
      },
      {
        key: 'simulationCount',
        label: 'Simulations',
        format: 'number',
        accessor: (ctx) => ctx.scenario.simulationCount,
      },
      {
        key: 'accountCount',
        label: 'Accounts',
        format: 'number',
        accessor: (ctx) => ctx.scenario.accountIds.length,
      },
      {
        key: 'showRealValues',
        label: 'Real values',
        format: 'boolean',
        accessor: (ctx) => ctx.scenario.showRealValues,
      },
      {
        key: 'useHistoricalReturns',
        label: 'Historical returns',
        format: 'boolean',
        accessor: (ctx) => ctx.scenario.useHistoricalReturns,
      },
      {
        key: 'targetValue',
        label: 'Target value',
        format: 'currency',
        accessor: (ctx) =>
          ctx.scenario.targetValue == null
            ? null
            : Number(ctx.scenario.targetValue),
      },
    ],
  },
  {
    key: 'finalDistribution',
    label: 'Final distribution',
    rows: [
      {
        key: 'mean',
        label: 'Mean',
        format: 'currency',
        accessor: (ctx) => ctx.result?.finalDistribution.mean ?? null,
      },
      {
        key: 'median',
        label: 'Median',
        format: 'currency',
        accessor: (ctx) => ctx.result?.finalDistribution.median ?? null,
      },
      {
        key: 'stdev',
        label: 'Std dev',
        format: 'currency',
        accessor: (ctx) => ctx.result?.finalDistribution.stdev ?? null,
      },
      {
        key: 'depletionRate',
        label: 'Depletion rate',
        format: 'percent',
        accessor: (ctx) => ctx.result?.finalDistribution.depletionRate ?? null,
      },
    ],
  },
  {
    key: 'finalYearBands',
    label: 'Final-year percentile bands',
    rows: (['p10', 'p25', 'p50', 'p75', 'p90'] as const).map((p) => ({
      key: `finalYear.${p}`,
      label: `${p} (final year)`,
      format: 'currency',
      accessor: (ctx) => last(ctx.result?.percentiles[p]),
    })),
  },
  {
    key: 'performance',
    label: 'Performance summary',
    rows: performanceRows,
  },
  {
    key: 'outcome',
    label: 'Outcome',
    rows: [
      {
        key: 'successRate',
        label: 'Success rate',
        format: 'percent',
        accessor: (ctx) => ctx.result?.successRate ?? null,
      },
    ],
  },
];
