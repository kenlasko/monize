'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
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
import { captureSvgAsImage } from '@/lib/pdf-export-charts';
import { sanitizeFilename } from '@/lib/export-filename';
import { ExportIconButton } from '@/components/ui/ExportIconButton';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { OverpaymentFrequency } from '@/lib/loan-schedule';
import { FREQUENCY_LABEL_KEY } from '@/components/accounts/loan-detail/loan-scenario-labels';

export interface ScenarioOutcome {
  id: string;
  name: string;
  /** Recurring overpayment amount at its cadence; null when the scenario has none */
  recurringExtra: number | null;
  /** Cadence of the recurring overpayment; undefined/MONTHLY reads as per payment */
  recurringFrequency?: OverpaymentFrequency;
  /** Number of one-time lump sums in the scenario */
  lumpSumCount: number;
  /** Interest saved vs the no-overpayment baseline */
  interestSaved: number;
  /** Projected payoff date (yyyy-MM-dd), or null when not paid off in range */
  payoffDate: string | null;
  /** Date the overpayments begin (yyyy-MM-dd); undefined/past means from today,
   *  so the arc starts later when a scenario's overpayment is date-scheduled. */
  startDate?: string;
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
  const tc = useTranslations('common');
  const formatChartDate = useChartDateFormat();
  const { formatCurrency, formatCurrencyCompact, formatCurrencyAxis } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);

  // Legend entries toggle their line on click; hovering a line (or a legend
  // entry) emphasizes that series and its legend name.
  const [hiddenKeys, setHiddenKeys] = useState<string[]>([]);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const legendKeyOf = (entry: unknown): string | null => {
    const key = (entry as { dataKey?: unknown }).dataKey;
    return typeof key === 'string' ? key : null;
  };
  const toggleKey = (entry: unknown) => {
    const key = legendKeyOf(entry);
    if (!key) return;
    setHiddenKeys((keys) =>
      keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key],
    );
  };

  const chartTitle = t('loanDetail.scenarioChart.title');

  // Same PNG capture as PayoffComparisonChart, so both loan charts export
  // identically.
  async function handleExportPng() {
    if (!chartRef.current) return;
    try {
      const captured = await captureSvgAsImage(chartRef.current);
      if (!captured) {
        toast.error(tc('chartDownload.unableToCapture'));
        return;
      }
      const link = document.createElement('a');
      link.href = captured.dataUrl;
      link.download = `${sanitizeFilename(chartTitle, 'chart')}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch {
      toast.error(tc('chartDownload.failedToDownload'));
    }
  }

  const payoffLabel = (payoffDate: string | null): string =>
    payoffDate
      ? formatChartDate(payoffDate, 'MMM yyyy')
      : t('loanDetail.comparison.beyondProjection');

  const overpaymentLabel = (o: ScenarioOutcome): string => {
    const parts: string[] = [];
    if (o.recurringExtra && o.recurringExtra > 0) {
      const freq = o.recurringFrequency;
      parts.push(
        freq && freq !== 'MONTHLY'
          ? t('loanDetail.scenarios.overpaymentWithFrequency', {
              amount: formatCurrency(o.recurringExtra, currencyCode),
              frequency: t(FREQUENCY_LABEL_KEY[freq]),
            })
          : t('loanDetail.scenarioChart.extraShort', {
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

    // Whole months from the current month to a date; unlike monthIndexOf this is
    // not clamped up to 1, so a start on/before today lands at 0 (the arc begins
    // at today) rather than being pushed a month out.
    const monthOffset = (iso: string): number => {
      const d = new Date(iso);
      return (d.getUTCFullYear() - startYear) * 12 + (d.getUTCMonth() - startMonth);
    };

    const baselinePayoffIndex = baseline.payoffDate
      ? monthIndexOf(baseline.payoffDate)
      : null;
    const scenarioSeries = outcomes.map((o, i) => ({
      ...o,
      color: chartSeriesColor(i),
      payoffIndex: o.payoffDate ? monthIndexOf(o.payoffDate) : null,
      startIndex: o.startDate ? Math.max(0, monthOffset(o.startDate)) : 0,
    }));
    const lastIndex = Math.max(
      12,
      baselinePayoffIndex ?? 0,
      ...scenarioSeries.map((s) => s.payoffIndex ?? 0),
    );

    // Per-arc geometry: it rises from 0 at its start month to the interest saved
    // at the midpoint and back to 0 at payoff. The start clamps below payoff so
    // there is always a visible span.
    const arcOf = (s: (typeof scenarioSeries)[number]) => {
      const payoff = s.payoffIndex ?? lastIndex;
      const start = Math.min(Math.max(0, s.startIndex), Math.max(0, payoff - 1));
      return { payoff, start, mid: Math.round((start + payoff) / 2) };
    };

    // Sample the monthly timeline down to a readable number of points, always
    // keeping the endpoints, each arc's payoff month (where it lands on zero)
    // and its midpoint. Midpoints of odd payoff spans fall between two months;
    // the row builder below pins the kept midpoint to the exact interest-saved
    // value so short arcs still peak at the true amount.
    const arcs = new Map(scenarioSeries.map((s) => [s.id, arcOf(s)]));
    const keep = new Set<number>([0, lastIndex]);
    if (baselinePayoffIndex !== null) keep.add(baselinePayoffIndex);
    for (const s of scenarioSeries) {
      const { payoff, start, mid } = arcs.get(s.id)!;
      keep.add(start);
      keep.add(payoff);
      keep.add(mid);
    }
    const step = Math.ceil(lastIndex / MAX_CHART_POINTS);
    const indices: number[] = [];
    for (let i = 0; i <= lastIndex; i++) {
      if (i % step === 0 || keep.has(i)) indices.push(i);
    }

    // The parabola through (start, 0), (mid, saved) and (payoff, 0):
    // value(i) = saved * 4 * f * (1 - f) with f = (i - start) / (payoff - start).
    // Nothing is drawn before the start month, so a date-scheduled overpayment's
    // arc begins on that date rather than at today.
    const rows = indices.map((i) => {
      const row: Record<string, number | string> = {
        label: formatChartDate(isoAt(i), 'MMM yyyy'),
      };
      for (const s of scenarioSeries) {
        const { payoff, start, mid } = arcs.get(s.id)!;
        if (i < start || i > payoff) continue;
        const saved = Math.max(0, s.interestSaved);
        const span = payoff - start || 1;
        const f = (i - start) / span;
        row[s.id] = i === mid ? saved : Math.round(saved * 4 * f * (1 - f) * 100) / 100;
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
      <div className="flex items-start justify-between gap-2 mb-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('loanDetail.scenarioChart.description')}
        </p>
        <ExportIconButton
          onExport={handleExportPng}
          title={tc('chartDownload.downloadAsPng', { filename: chartTitle })}
        />
      </div>
      <div className="h-80" ref={chartRef}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11 }}
              interval="preserveStartEnd"
              height={48}
              label={{
                value: t('loanDetail.scenarioChart.axisMonths'),
                position: 'insideBottom',
                offset: 0,
                style: { fontSize: 11, fill: chartColors.axis, textAnchor: 'middle' },
              }}
            />
            <YAxis
              tickFormatter={formatCurrencyAxis}
              tick={{ fontSize: 12 }}
              width={72}
              label={{
                value: t('loanDetail.scenarioChart.axisInterestSaved'),
                angle: -90,
                position: 'insideLeft',
                style: { fontSize: 11, fill: chartColors.axis, textAnchor: 'middle' },
              }}
            />
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
                      <p
                        key={s.id}
                        className={`text-sm ${hoveredKey === s.id ? 'font-semibold' : ''}`}
                        style={{ color: s.color }}
                      >
                        {s.name} · {overpaymentLabel(s)}:{' '}
                        {formatCurrencyCompact(Math.max(0, s.interestSaved))}
                        {' · '}
                        {payoffLabel(s.payoffDate)}
                      </p>
                    ))}
                  </div>
                );
              }}
            />
            <Legend
              onClick={toggleKey}
              onMouseEnter={(entry) => setHoveredKey(legendKeyOf(entry))}
              onMouseLeave={() => setHoveredKey(null)}
              formatter={(value, entry) => {
                const key = legendKeyOf(entry);
                const hidden = key !== null && hiddenKeys.includes(key);
                const hovered = key !== null && hoveredKey === key;
                return (
                  <span
                    className={`cursor-pointer select-none ${
                      hidden ? 'line-through opacity-50' : ''
                    } ${hovered ? 'font-semibold' : ''}`}
                  >
                    {value}
                  </span>
                );
              }}
            />
            {baselineIndex !== null && (
              <Line
                dataKey="baseline"
                stroke={chartColors.axis}
                strokeWidth={hoveredKey === 'baseline' ? 3 : 2}
                strokeOpacity={hoveredKey !== null && hoveredKey !== 'baseline' ? 0.35 : 1}
                strokeDasharray="2 4"
                dot={false}
                hide={hiddenKeys.includes('baseline')}
                onMouseEnter={() => setHoveredKey('baseline')}
                onMouseLeave={() => setHoveredKey(null)}
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
                strokeWidth={hoveredKey === s.id ? 3.5 : 2}
                strokeOpacity={hoveredKey !== null && hoveredKey !== s.id ? 0.35 : 1}
                strokeDasharray={s.payoffDate ? undefined : '6 4'}
                dot={false}
                hide={hiddenKeys.includes(s.id)}
                onMouseEnter={() => setHoveredKey(s.id)}
                onMouseLeave={() => setHoveredKey(null)}
                name={
                  s.payoffDate
                    ? `${s.name} · ${overpaymentLabel(s)}`
                    : `${s.name} · ${overpaymentLabel(s)} · ${t('loanDetail.comparison.beyondProjection')}`
                }
              />
            ))}
            {/* Invisible wide twin of each arc: a 2px stroke is nearly
                impossible to hit while the tooltip layer is active, so these
                carry the hover detection that emphasizes the series and bolds
                its name in the tooltip and legend. */}
            {series.map((s) => (
              <Line
                key={`${s.id}-hit`}
                type="monotone"
                dataKey={s.id}
                stroke="transparent"
                strokeWidth={18}
                dot={false}
                activeDot={false}
                legendType="none"
                tooltipType="none"
                hide={hiddenKeys.includes(s.id)}
                onMouseEnter={() => setHoveredKey(s.id)}
                onMouseLeave={() => setHoveredKey(null)}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
