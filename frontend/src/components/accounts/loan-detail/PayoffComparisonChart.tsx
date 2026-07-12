'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from 'recharts';
import { LoanPaymentEvent } from '@/lib/loan-history';
import { LoanScheduleResult } from '@/lib/loan-schedule';
import { chartColors } from '@/lib/chart-colors';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';

const MAX_CHART_POINTS = 60;

export interface PayoffChartPoint {
  /** Month key (yyyy-MM), formatted for display by the chart */
  monthKey: string;
  historicalBalance?: number;
  baselineBalance?: number;
  scenarioBalance?: number;
  /** Original contractual balance (the "if I never overpaid" curve) */
  originalBalance?: number;
}

/**
 * Merge history and the projections into one monthly series. Each series
 * contributes its last balance per month; the forward projections (baseline,
 * scenario) are stitched to the final historical point so the areas connect at
 * "today". The original contractual curve spans origination to payoff and is
 * left continuous (not stitched), since it overlaps the historical period to
 * show what the balance would have been without any overpayments.
 */
export function buildPayoffComparisonSeries(
  historyEvents: LoanPaymentEvent[],
  baseline: LoanScheduleResult | null,
  scenario: LoanScheduleResult | null,
  original: LoanScheduleResult | null = null,
): { points: PayoffChartPoint[]; projectionStartKey: string | null } {
  const byMonth = new Map<string, PayoffChartPoint>();

  const setValue = (
    date: string,
    field: 'historicalBalance' | 'baselineBalance' | 'scenarioBalance' | 'originalBalance',
    balance: number,
  ) => {
    const monthKey = date.slice(0, 7);
    const existing = byMonth.get(monthKey);
    if (existing) {
      byMonth.set(monthKey, { ...existing, [field]: balance });
    } else {
      byMonth.set(monthKey, { monthKey, [field]: balance });
    }
  };

  for (const row of original?.rows ?? []) {
    setValue(row.date, 'originalBalance', row.balance);
  }
  for (const event of historyEvents) {
    setValue(event.date, 'historicalBalance', event.balance);
  }
  for (const row of baseline?.rows ?? []) {
    setValue(row.date, 'baselineBalance', row.balance);
  }
  for (const row of scenario?.rows ?? []) {
    setValue(row.date, 'scenarioBalance', row.balance);
  }

  let points = Array.from(byMonth.values()).sort((a, b) =>
    a.monthKey.localeCompare(b.monthKey),
  );

  // Stitch the projections onto the last historical point so the chart areas
  // connect at the transition instead of leaving a gap
  const hasProjection = (baseline?.rows.length ?? 0) > 0 || (scenario?.rows.length ?? 0) > 0;
  let projectionStartKey: string | null = null;
  if (hasProjection) {
    const lastHistoricalIndex = points.reduce(
      (last, point, index) => (point.historicalBalance !== undefined ? index : last),
      -1,
    );
    if (lastHistoricalIndex >= 0) {
      const lastHistorical = points[lastHistoricalIndex];
      points = points.map((point, index) =>
        index === lastHistoricalIndex
          ? {
              ...point,
              baselineBalance: point.baselineBalance ?? lastHistorical.historicalBalance,
              scenarioBalance:
                scenario !== null
                  ? point.scenarioBalance ?? lastHistorical.historicalBalance
                  : point.scenarioBalance,
            }
          : point,
      );
      projectionStartKey = points[lastHistoricalIndex + 1]?.monthKey ?? null;
    } else {
      projectionStartKey = points[0]?.monthKey ?? null;
    }
  }

  // Sample long series down to a readable number of points, keeping the last
  if (points.length > MAX_CHART_POINTS) {
    const step = Math.ceil(points.length / MAX_CHART_POINTS);
    const sampled = points.filter((_, index) => index % step === 0);
    if (sampled[sampled.length - 1] !== points[points.length - 1]) {
      sampled.push(points[points.length - 1]);
    }
    points = sampled;
  }

  return { points, projectionStartKey };
}

interface PayoffComparisonChartProps {
  historyEvents: LoanPaymentEvent[];
  baseline: LoanScheduleResult | null;
  /** Scenario projection; omitted when no overpayments are active */
  scenario: LoanScheduleResult | null;
  /** Original contractual schedule ("if I never overpaid"); omitted when unknown */
  original?: LoanScheduleResult | null;
}

/**
 * Payoff curves for the loan detail page: the original contractual balance,
 * the actual historical balance, the current projection, and (when a
 * simulation is active) the overpayment scenario -- one chart, so the past
 * impact (actual vs contractual) and the future impact (projection vs
 * scenario) read off the same axes.
 */
export function PayoffComparisonChart({
  historyEvents,
  baseline,
  scenario,
  original = null,
}: PayoffComparisonChartProps) {
  const t = useTranslations('accounts');
  const formatChartDate = useChartDateFormat();
  const { formatCurrencyCompact, formatCurrencyAxis } = useNumberFormat();

  const { points, projectionStartKey } = useMemo(
    () => buildPayoffComparisonSeries(historyEvents, baseline, scenario, original),
    [historyEvents, baseline, scenario, original],
  );

  const chartData = useMemo(
    () =>
      points.map((point) => ({
        ...point,
        label: formatChartDate(`${point.monthKey}-01`, 'MMM yyyy'),
      })),
    [points, formatChartDate],
  );

  const projectionStartLabel = projectionStartKey
    ? formatChartDate(`${projectionStartKey}-01`, 'MMM yyyy')
    : null;

  if (chartData.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">
          {t('loanDetail.chart.empty')}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4 px-4 sm:px-0">
        {t('loanDetail.chart.title')}
      </h3>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis tickFormatter={formatCurrencyAxis} tick={{ fontSize: 12 }} />
            <Tooltip
              formatter={(value: number | string | undefined) =>
                value === undefined ? '' : formatCurrencyCompact(Number(value))
              }
            />
            <Legend />
            {original && (
              <Area
                type="monotone"
                dataKey="originalBalance"
                stroke={chartColors.axis}
                fill={chartColors.axis}
                fillOpacity={0.08}
                strokeWidth={2}
                strokeDasharray="2 4"
                name={t('loanDetail.chart.seriesOriginal')}
                connectNulls
              />
            )}
            <Area
              type="monotone"
              dataKey="historicalBalance"
              stroke={chartColors.expense}
              fill={chartColors.expense}
              fillOpacity={0.3}
              strokeWidth={2}
              name={t('loanDetail.chart.seriesHistorical')}
              connectNulls={false}
            />
            {baseline && (
              <Area
                type="monotone"
                dataKey="baselineBalance"
                stroke={chartColors.primary}
                fill={chartColors.primary}
                fillOpacity={0.15}
                strokeWidth={2}
                strokeDasharray="6 3"
                name={t('loanDetail.chart.seriesBaseline')}
                connectNulls={false}
              />
            )}
            {scenario && (
              <Area
                type="monotone"
                dataKey="scenarioBalance"
                stroke={chartColors.income}
                fill={chartColors.income}
                fillOpacity={0.15}
                strokeWidth={2}
                strokeDasharray="4 2"
                name={t('loanDetail.chart.seriesScenario')}
                connectNulls={false}
              />
            )}
            {projectionStartLabel && (
              <ReferenceLine
                x={projectionStartLabel}
                stroke={chartColors.axis}
                strokeDasharray="4 4"
                strokeWidth={2}
                label={{
                  value: t('loanDetail.chart.today'),
                  position: 'top',
                  fill: chartColors.axis,
                  fontSize: 12,
                  fontWeight: 600,
                }}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {scenario && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 text-center">
          {t('loanDetail.chart.scenarioNote')}
        </p>
      )}
    </div>
  );
}
