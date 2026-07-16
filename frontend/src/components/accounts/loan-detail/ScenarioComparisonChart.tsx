'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { chartColors, chartSeriesColor } from '@/lib/chart-colors';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';

export interface ScenarioOutcome {
  id: string;
  name: string;
  /** Extra paid on top of each installment; null when the scenario has none */
  recurringExtra: number | null;
  /** Number of one-time lump sums in the scenario */
  lumpSumCount: number;
  /** Interest saved vs the no-overpayment baseline */
  interestSaved: number;
  /** Projected payoff date (yyyy-MM-dd), or null when not paid off in range */
  payoffDate: string | null;
}

export interface BaselineOutcome {
  payoffDate: string | null;
}

interface ScenarioComparisonChartProps {
  outcomes: ScenarioOutcome[];
  baseline: BaselineOutcome;
  currencyCode: string;
}

const MAX_CHART_POINTS = 60;

/**
 * Compares saved overpayment scenarios as parabolic arcs on a shared monthly
 * timeline, rendered with the same Recharts building blocks as the payoff
 * chart so the two read as one family. Each scenario's arc starts today and
 * returns to the axis at its payoff date (its span is the loan's remaining
 * life) and the apex height is the interest saved vs the no-overpayment
 * baseline; the extra paid per installment rides in the legend name. The
 * baseline is a flat dashed zero-line ending at the original payoff date.
 * Narrower and taller reads as better.
 */
export function ScenarioComparisonChart({
  outcomes,
  baseline,
  currencyCode,
}: ScenarioComparisonChartProps) {
  const t = useTranslations('accounts');
  const formatChartDate = useChartDateFormat();
  const { formatCurrency, formatCurrencyCompact, formatCurrencyAxis } = useNumberFormat();

  const payoffLabel = (payoffDate: string | null): string =>
    payoffDate
      ? formatChartDate(payoffDate, 'MMM yyyy')
      : t('loanDetail.comparison.beyondProjection');

  const overpaymentLabel = (o: ScenarioOutcome): string => {
    const parts: string[] = [];
    if (o.recurringExtra && o.recurringExtra > 0) {
      parts.push(
        t('loanDetail.scenarioChart.extraShort', {
          amount: formatCurrency(o.recurringExtra, currencyCode),
        }),
      );
    }
    if (o.lumpSumCount > 0) {
      parts.push(t('loanDetail.scenarios.lumpSumSummary', { count: o.lumpSumCount }));
    }
    return parts.join(' + ') || t('loanDetail.scenarios.emptyScenario');
  };

  const { series, baselineIndex, chartData } = useMemo(() => {
    const now = new Date();
    const startYear = now.getUTCFullYear();
    const startMonth = now.getUTCMonth();

    // Whole months from the start of the current month to the given date (all
    // in UTC, matching the yyyy-MM-dd DATE strings); at least 1 so an arc
    // always has a visible span.
    const monthIndexOf = (iso: string): number => {
      const d = new Date(iso);
      return Math.max(
        1,
        (d.getUTCFullYear() - startYear) * 12 + (d.getUTCMonth() - startMonth),
      );
    };
    const isoAt = (index: number): string => {
      const d = new Date(Date.UTC(startYear, startMonth + index, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
    };

    const baselinePayoffIndex = baseline.payoffDate
      ? monthIndexOf(baseline.payoffDate)
      : null;
    const scenarioSeries = outcomes.map((o, i) => ({
      ...o,
      color: chartSeriesColor(i),
      payoffIndex: o.payoffDate ? monthIndexOf(o.payoffDate) : null,
    }));
    const lastIndex = Math.max(
      12,
      baselinePayoffIndex ?? 0,
      ...scenarioSeries.map((s) => s.payoffIndex ?? 0),
    );

    // Sample the monthly timeline down to a readable number of points, always
    // keeping the endpoints, each arc's payoff month (where it lands on zero)
    // and its midpoint. Midpoints of odd payoff spans fall between two months;
    // the row builder below pins the kept midpoint to the exact interest-saved
    // value so short arcs still peak at the true amount.
    const midpoints = new Map<string, number>();
    const keep = new Set<number>([0, lastIndex]);
    if (baselinePayoffIndex !== null) keep.add(baselinePayoffIndex);
    for (const s of scenarioSeries) {
      const payoff = s.payoffIndex ?? lastIndex;
      const mid = Math.round(payoff / 2);
      midpoints.set(s.id, mid);
      keep.add(payoff);
      keep.add(mid);
    }
    const step = Math.ceil(lastIndex / MAX_CHART_POINTS);
    const indices: number[] = [];
    for (let i = 0; i <= lastIndex; i++) {
      if (i % step === 0 || keep.has(i)) indices.push(i);
    }

    // The parabola through (0, 0), (payoff/2, saved) and (payoff, 0):
    // value(i) = saved * 4 * f * (1 - f) with f = i / payoff.
    const rows = indices.map((i) => {
      const row: Record<string, number | string> = {
        label: formatChartDate(isoAt(i), 'MMM yyyy'),
      };
      for (const s of scenarioSeries) {
        const payoff = s.payoffIndex ?? lastIndex;
        if (i > payoff) continue;
        const saved = Math.max(0, s.interestSaved);
        row[s.id] =
          i === midpoints.get(s.id)
            ? saved
            : Math.round(saved * 4 * (i / payoff) * (1 - i / payoff) * 100) / 100;
      }
      if (baselinePayoffIndex !== null && i <= baselinePayoffIndex) {
        row.baseline = 0;
      }
      return row;
    });

    return { series: scenarioSeries, baselineIndex: baselinePayoffIndex, chartData: rows };
  }, [outcomes, baseline.payoffDate, formatChartDate]);

  return (
    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {t('loanDetail.scenarioChart.description')}
      </p>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis tickFormatter={formatCurrencyAxis} tick={{ fontSize: 12 }} />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0) return null;
                const shown = series.filter((s) =>
                  payload.some((entry) => entry.dataKey === s.id),
                );
                if (shown.length === 0) return null;
                return (
                  <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                    <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
                      {label}
                    </p>
                    {shown.map((s) => (
                      <p key={s.id} className="text-sm" style={{ color: s.color }}>
                        {s.name}: {formatCurrencyCompact(Math.max(0, s.interestSaved))}
                        {' · '}
                        {payoffLabel(s.payoffDate)}
                      </p>
                    ))}
                  </div>
                );
              }}
            />
            <Legend />
            {baselineIndex !== null && (
              <Line
                dataKey="baseline"
                stroke={chartColors.axis}
                strokeWidth={2}
                strokeDasharray="2 4"
                dot={false}
                name={t('loanDetail.scenarioChart.baselineMarker', {
                  date: payoffLabel(baseline.payoffDate),
                })}
              />
            )}
            {series.map((s) => (
              <Line
                key={s.id}
                type="monotone"
                dataKey={s.id}
                stroke={s.color}
                strokeWidth={2}
                strokeDasharray={s.payoffDate ? undefined : '6 4'}
                dot={false}
                name={
                  s.payoffDate
                    ? `${s.name} · ${overpaymentLabel(s)}`
                    : `${s.name} · ${overpaymentLabel(s)} · ${t('loanDetail.comparison.beyondProjection')}`
                }
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
