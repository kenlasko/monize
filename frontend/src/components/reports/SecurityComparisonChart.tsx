'use client';

import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from 'react';
import { useTranslations } from 'next-intl';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from './ReportError';
import { investmentsApi } from '@/lib/investments';
import {
  PerformanceComparison,
  PerformanceExclusionReason,
  PerformanceSeriesRef,
} from '@/types/investment';
import { CHART_SERIES, chartSeriesColor } from '@/lib/chart-colors';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { parseLocalDate, type ChartDatePattern } from '@/lib/utils';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { buildTimeAxisTicks } from '@/lib/chart-time-axis';
import { resolvePdfColor } from '@/components/reports/resolve-pdf-color';
import { EmptyState } from '@/components/ui/EmptyState';
import { CHART_GRID_PROPS, CHART_TOOLTIP_CLASS } from '@/lib/chart-style';
import { ChartActiveDot } from '@/components/ui/ChartActiveDot';

/** A security plotted as one line, with its assigned palette colour. */
export interface PerformanceSeries {
  key: string;
  kind: 'SECURITY' | 'INDEX';
  label: string;
  name: string;
  color: string;
  /** Benchmarks are dashed; they are not one of the user's instruments. */
  dashed: boolean;
}

/** One merged row: a timestamp plus each series' percent return (by key). */
export interface PerformanceRow {
  ts: number;
  [seriesKey: string]: number | null;
}

/**
 * Turn the server's payload into the rows and series Recharts consumes.
 *
 * Everything financial already happened server-side -- the basis per series, the
 * bounded lookup at the window start, the exclusions -- so this is presentation
 * only. Exported and pure so the mapping is testable without React, and so it
 * stays obvious that no arithmetic sneaks back in here: a `null` the server took
 * care to produce is carried through as `null`, never coerced.
 */
export function buildPerformanceView(comparison: PerformanceComparison): {
  rows: PerformanceRow[];
  series: PerformanceSeries[];
} {
  const securityIndex = new Map<string, number>();
  comparison.series
    .filter((entry) => entry.kind === 'SECURITY')
    .forEach((entry, i) => securityIndex.set(entry.key, i));
  const indexIndex = new Map<string, number>();
  comparison.series
    .filter((entry) => entry.kind === 'INDEX')
    .forEach((entry, i) => indexIndex.set(entry.key, i));

  const series: PerformanceSeries[] = comparison.series.map(
    (entry: PerformanceSeriesRef, i) => ({
      key: entry.key,
      kind: entry.kind,
      label: entry.label,
      name: entry.name,
      // The dash is what says "benchmark" -- a yardstick, not one of the
      // holdings. Colour is identity: each kind is indexed among its own, so a
      // holding's colour does not move when an index is added and an index's
      // does not move when a holding is. Securities count up from the front of
      // the palette; indexes count down from the back, so two benchmarks are
      // distinguishable from each other (one neutral token made them
      // identical) and the two kinds only collide once the palette is spent.
      color:
        entry.kind === 'INDEX'
          ? chartSeriesColor(
              CHART_SERIES.length - 1 - (indexIndex.get(entry.key) ?? 0),
            )
          : chartSeriesColor(securityIndex.get(entry.key) ?? i),
      dashed: entry.kind === 'INDEX',
    }),
  );

  const rows: PerformanceRow[] = comparison.points.map((point) => {
    const row: PerformanceRow = { ts: parseLocalDate(point.date).getTime() };
    for (const entry of comparison.series) {
      row[entry.key] = point.values[entry.key] ?? null;
    }
    return row;
  });

  return { rows, series };
}

/** Imperative surface for the parent report's Export dropdown. */
export interface SecurityComparisonChartHandle {
  exportPdf: () => Promise<void>;
}

interface SecurityComparisonChartProps {
  /** Ids of the securities the user chose to compare. */
  securityIds: string[];
  /** Codes of the market indexes overlaid as benchmarks. */
  indexCodes: string[];
  /** Window start (`''` means all history, resolved server-side from the data). */
  startDate: string;
  endDate: string;
  /**
   * Overrides the subtitle shown above the chart and used as the PDF
   * description. Defaults to the comparison-report copy, which names "each
   * selected instrument" and "dashed index lines" -- both wrong for a caller
   * plotting a whole portfolio with no benchmarks (`indexCodes={[]}`), so such
   * a caller passes its own portfolio-appropriate string.
   */
  subtitle?: string;
  /** Bumped by the RefreshPricesButton so a manual price refresh re-fetches. */
  reloadKey?: number;
  /**
   * Exposes `exportPdf` so the parent report's Export dropdown (which lives in
   * the shared toolbar above this component) can export the comparison chart.
   * The handle lives here because this component owns the fetched series and
   * the chart DOM the capture needs.
   */
  exportRef?: Ref<SecurityComparisonChartHandle>;
  /**
   * Told whether the series on screen is the current request's answer: `false`
   * while it is loading or has failed (the hook keeps the previous payload
   * through both) and when this component unmounts. The parent's export button
   * lives outside this component and reads it, so a document never carries the
   * previous window's series.
   */
  onExportableChange?: (exportable: boolean) => void;
}

/**
 * Performance-comparison view for the Security Performance report: each selected
 * security, and each overlaid market index, drawn on one chart as its cumulative
 * percent return over the chosen window.
 *
 * The arithmetic is the server's (`docs/security-benchmark-comparison.md`).
 * What this component owes the payload is honesty about what it could not work
 * out: a `null` is a break in the line rather than a bridge, and a series the
 * server refused is named with its reason rather than quietly absent.
 */
export function SecurityComparisonChart({
  securityIds,
  indexCodes,
  startDate,
  endDate,
  subtitle,
  reloadKey = 0,
  exportRef,
  onExportableChange,
}: SecurityComparisonChartProps) {
  const t = useTranslations('reports');
  const ti = useTranslations('marketIndexes');
  const formatChartDate = useChartDateFormat();
  const { formatSignedPercent } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  // The comparison report's default copy speaks of "each selected instrument"
  // and "dashed index lines"; a caller plotting a whole portfolio with no
  // benchmarks passes its own subtitle instead. Used for both the on-screen
  // subtitle and the PDF description so the two never disagree.
  const resolvedSubtitle = subtitle ?? t('securityPerformance.comparisonSubtitle');

  // Everything that changes the *meaning* of the response is in the key, so a
  // payload can never be mistaken for the answer to a different selection
  // (`docs/frontend/api-and-cache.md`, asynchronous data).
  const requestKey = [
    [...securityIds].sort().join(','),
    [...indexCodes].sort().join(','),
    startDate,
    endDate,
  ].join('|');

  const { data, isLoading, error, reload } = useReportData(
    () =>
      investmentsApi.getPerformanceComparison({
        securityIds,
        indexCodes,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      }),
    [requestKey, reloadKey],
    { requestKey },
  );

  const exportable = !isLoading && !error;
  useEffect(() => {
    onExportableChange?.(exportable);
    return () => onExportableChange?.(false);
  }, [exportable, onExportableChange]);

  const { rows, series } = useMemo(
    () => (data ? buildPerformanceView(data) : { rows: [], series: [] }),
    [data],
  );

  const labelByKey = useMemo(() => {
    const map = new Map<string, string>();
    series.forEach((s) => map.set(s.key, s.label));
    return map;
  }, [series]);

  /** An index's localized name, falling back to what the server called it. */
  const indexName = (code: string, fallback: string) => {
    const key = `names.${code}` as Parameters<typeof ti>[0];
    const localized = ti(key);
    return localized === key ? fallback : localized;
  };

  const seriesName = (entry: PerformanceSeries) =>
    entry.kind === 'INDEX' ? indexName(entry.key.slice(4), entry.name) : entry.label;

  const xAxis = useMemo(() => {
    if (rows.length === 0) {
      return {
        ticks: [] as number[],
        domain: ['dataMin', 'dataMax'] as [string, string],
        tickFormat: 'MMM yyyy' as ChartDatePattern,
      };
    }
    const minTs = rows[0].ts;
    const maxTs = rows[rows.length - 1].ts;
    const { ticks, stepMonths } = buildTimeAxisTicks(minTs, maxTs);
    return {
      ticks,
      domain: [minTs, maxTs] as [number, number],
      tickFormat: (stepMonths >= 12 ? 'yyyy' : 'MMM yyyy') as ChartDatePattern,
    };
  }, [rows]);

  // Mirrors the single-security chart export: the on-screen card's title,
  // subtitle, and chart, plus a drawn legend (the Recharts legend is HTML, not
  // part of the captured SVG, so the PDF redraws it from the series colours).
  useImperativeHandle(
    exportRef,
    () => ({
      exportPdf: async () => {
        if (!exportable) return;
        const { exportToPdf } = await import('@/lib/pdf-export');
        await exportToPdf({
          title: t('securityPerformance.comparisonTitle'),
          subtitle: series.map((s) => seriesName(s)).join(', ') || undefined,
          description: resolvedSubtitle,
          chartContainer: chartRef.current,
          chartLegend: series.map((s) => ({
            color: resolvePdfColor(s.color),
            label:
              s.kind === 'INDEX'
                ? t('securityPerformance.comparisonIndexLegend', {
                    name: seriesName(s),
                  })
                : `${s.label} - ${s.name}`,
          })),
          filename: 'security-performance-comparison',
        });
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, resolvedSubtitle, exportable, t, ti],
  );

  const excluded = data?.excluded ?? [];

  return (
    <div
      ref={chartRef}
      className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6"
    >
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('securityPerformance.comparisonTitle')}
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {resolvedSubtitle}
      </p>

      {error ? (
        <ReportError message={t('securityPerformance.comparisonError')} onRetry={reload} />
      ) : isLoading ? (
        <Skeleton className="h-80 w-full" />
      ) : series.length === 0 ? (
        <EmptyState title={t('securityPerformance.comparisonNoData')} />
      ) : (
        <div className="h-96">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <LineChart data={rows}>
              <CartesianGrid {...CHART_GRID_PROPS} />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={xAxis.domain}
                ticks={xAxis.ticks}
                tickFormatter={(ts: number) =>
                  formatChartDate(new Date(ts), xAxis.tickFormat)
                }
                tick={{ fontSize: 11 }}
              />
              <YAxis
                tickFormatter={(v: number) => formatSignedPercent(v)}
                domain={['auto', 'auto']}
                tick={{ fontSize: 11 }}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const ts = (payload[0].payload as PerformanceRow).ts;
                  const items = payload
                    .filter((p) => typeof p.value === 'number')
                    .map((p) => ({
                      id: String(p.dataKey),
                      label: labelByKey.get(String(p.dataKey)) ?? '',
                      value: p.value as number,
                      color: p.color as string,
                    }))
                    .sort((a, b) => b.value - a.value);
                  return (
                    <div className={`${CHART_TOOLTIP_CLASS} max-h-64 overflow-y-auto`}>
                      <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
                        {formatChartDate(new Date(ts), 'MMM d, yyyy')}
                      </p>
                      {items.map((item) => (
                        <p key={item.id} className="text-sm flex justify-between gap-3">
                          <span style={{ color: item.color }}>{item.label}</span>
                          <span className="text-gray-700 dark:text-gray-300">
                            {formatSignedPercent(item.value)}
                          </span>
                        </p>
                      ))}
                    </div>
                  );
                }}
              />
              <Legend />
              {series.map((s) => (
                <Line
                  activeDot={ChartActiveDot}
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={seriesName(s)}
                  stroke={s.color}
                  strokeWidth={2}
                  strokeDasharray={s.dashed ? '5 3' : undefined}
                  dot={false}
                  // A gap in the prices stays a gap in the line. Bridging it
                  // draws a straight segment through a stretch nobody observed,
                  // indistinguishable from measured data -- and it throws away
                  // the null the server went to real trouble to send.
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/*
        A refused series must be named. Dropping it silently makes a chart of
        two instruments out of a request for three, and it reads as complete.
      */}
      {excluded.length > 0 && (
        <div className="mt-4 rounded-md bg-gray-50 dark:bg-gray-900/40 p-3">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('securityPerformance.comparisonExcludedTitle')}
          </p>
          <ul className="mt-1 space-y-1">
            {excluded.map((entry) => (
              <li
                key={entry.key}
                className="text-sm text-gray-500 dark:text-gray-400"
              >
                {t('securityPerformance.comparisonExcludedRow', {
                  label:
                    entry.kind === 'INDEX'
                      ? indexName(entry.id, entry.label)
                      : entry.label,
                  reason: t(
                    `securityPerformance.comparisonExcluded.${entry.reason}` as Parameters<
                      typeof t
                    >[0],
                  ),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data?.status === 'incomplete' && series.length > 0 && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t('securityPerformance.comparisonIncomplete')}
        </p>
      )}
    </div>
  );
}

/** Exported for the report's excluded-reason copy; keeps the union in one place. */
export type { PerformanceExclusionReason };
