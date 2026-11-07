'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { CHART_SERIES, chartColors } from '@/lib/chart-colors';
import { buildBondInterestSeries } from '@/lib/bond-interest-series';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { BondLotValuation } from '@/types/bond';
import { benchmarkLabel } from './bond-labels';
import { CHART_GRID_PROPS } from '@/lib/chart-style';

interface SecurityBondInterestChartProps {
  lot: BondLotValuation;
  currency: string;
}

/** A projected period is drawn lighter than a known or announced one. */
const PROJECTED_OPACITY = 0.45;

const SERIES = [
  { key: 'fixed', color: chartColors.primary },
  { key: 'margin', color: CHART_SERIES[1] },
  { key: 'inflation', color: CHART_SERIES[2] },
  { key: 'announced', color: CHART_SERIES[3] },
] as const;

interface TooltipRow {
  name?: string;
  value?: number;
  color?: string;
}

interface InterestTooltipProps {
  active?: boolean;
  label?: string;
  payload?: Array<{ payload?: { projected?: boolean } } & TooltipRow>;
  formatMoney: (value: number) => string;
  projectedLabel: string;
}

function InterestTooltip({
  active,
  label,
  payload,
  formatMoney,
  projectedLabel,
}: InterestTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const projected = payload[0].payload?.projected === true;
  return (
    <ChartTooltipPanel>
      <p className="font-medium text-gray-900 dark:text-gray-100">
        {label}
        {projected ? ` (${projectedLabel})` : ''}
      </p>
      {payload.map((row) => (
        <p key={row.name} style={{ color: row.color }}>
          {row.name}: {formatMoney(row.value ?? 0)}
        </p>
      ))}
    </ChartTooltipPanel>
  );
}

/**
 * Cumulative interest of one lot at each period end, for the whole holding,
 * split into fixed, margin, inflation and announced parts (spec 13.4). It sums
 * the server's per-period attribution and recomputes nothing; projected periods
 * are lighter, and the subtitle names the assumption they follow. The series
 * stops at the first period whose interest is unknown.
 */
export function SecurityBondInterestChart({
  lot,
  currency,
}: SecurityBondInterestChartProps) {
  const t = useTranslations('securityDetail');
  const { formatDate } = useDateFormat();
  const { formatCurrency, formatCurrencyAxis, formatPercentTrimmed } =
    useNumberFormat();
  const valuation = lot.valuation;

  const series = useMemo(
    () => buildBondInterestSeries(valuation.rateSchedule, lot.quantity),
    [valuation.rateSchedule, lot.quantity],
  );
  const data = useMemo(
    () => series.points.map((p) => ({ ...p, label: formatDate(p.end) })),
    [series.points, formatDate],
  );

  if (data.length === 0 && series.unknownFromPeriod === null) return null;

  // A FIXED rule pays its one rate for the whole term; only a benchmark rule
  // has a first period whose rate the terms state, and margin / benchmark parts.
  const isFixedRule = valuation.rateRule.type === 'FIXED';
  const names: Record<(typeof SERIES)[number]['key'], string> = {
    fixed: t(isFixedRule ? 'bond.interestParts.fixedTerm' : 'bond.interestParts.fixed'),
    margin: t('bond.interestParts.margin'),
    inflation: t(
      valuation.rateRule.type === 'INFLATION_PLUS_MARGIN_AS_RATE'
        ? 'bond.interestParts.inflation'
        : 'bond.interestParts.benchmark',
    ),
    announced: t('bond.interestParts.announced'),
  };
  const hasProjected = series.points.some((p) => p.projected);
  const assumption = valuation.projectionAssumptions[0];

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
        {t('bond.chart.title')}
      </p>
      {hasProjected && assumption && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('bond.chart.assumption', {
            benchmark: benchmarkLabel(t, assumption.benchmarkId),
            value: formatPercentTrimmed(Number(assumption.value) * 100),
          })}
          {' · '}
          {t('bond.chart.projectedNote')}
        </p>
      )}
      {data.length > 0 && (
        <div
          role="img"
          aria-label={t('bond.chart.title')}
          className="h-64 w-full"
        >
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart data={data}>
              <CartesianGrid {...CHART_GRID_PROPS} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              {/* The bond's own currency, not the reader's default. */}
              <YAxis
                tickFormatter={(v: number) => formatCurrencyAxis(v, currency)}
              />
              <Tooltip
                content={
                  <InterestTooltip
                    formatMoney={(v) => formatCurrency(v, currency)}
                    projectedLabel={t('bond.lots.projected')}
                  />
                }
              />
              <Legend />
              {SERIES.filter((s) =>
                s.key === 'announced'
                  ? series.hasAnnounced
                  : s.key === 'fixed' || !isFixedRule,
              ).map(
                (s) => (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={names[s.key]}
                    stackId="interest"
                    fill={s.color}
                  >
                    {data.map((p) => (
                      <Cell
                        key={p.index}
                        fill={s.color}
                        fillOpacity={p.projected ? PROJECTED_OPACITY : 1}
                      />
                    ))}
                  </Bar>
                ),
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {series.unknownFromPeriod !== null && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('bond.chart.stoppedAt', { period: series.unknownFromPeriod })}
        </p>
      )}
    </div>
  );
}
