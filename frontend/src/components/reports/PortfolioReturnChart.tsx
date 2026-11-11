'use client';

import { CARD_CLASS } from '@/components/ui/Card';
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
  ReferenceLine,
} from 'recharts';
import { ReportError } from './ReportError';
import { useTwrSeries } from '@/hooks/useTwrSeries';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ChartActiveDot } from '@/components/ui/ChartActiveDot';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { buildTimeAxisTicks } from '@/lib/chart-time-axis';
import { chartColors } from '@/lib/chart-colors';
import { CHART_GRID_PROPS, CHART_TOOLTIP_CLASS } from '@/lib/chart-style';
import { resolvePdfColor } from '@/components/reports/resolve-pdf-color';
import type { ChartDatePattern } from '@/lib/utils';
import {
  buildAccountReturnView,
  buildPortfolioReturnView,
  type ReturnRow,
  type ReturnView,
} from './portfolio-return-rows';
import type { SecurityComparisonChartHandle } from './SecurityComparisonChart';

const EMPTY_VIEW: ReturnView = { rows: [], lines: [], withheld: [] };

interface PortfolioReturnChartProps {
  /**
   * `portfolio` draws one line for the scope `accountIds` names; `account`
   * draws one line per entry of `accountIdList`.
   */
  groupBy: 'portfolio' | 'account';
  /** The active range preset ('1d', 'mtd', '1y', ...). */
  range: string;
  /** The day the window is measured from (`usePortfolioRangeWindow`'s `start`). */
  startDate: string;
  /** The day the period opens (`periodStart`). */
  periodStartDate: string;
  endDate: string;
  /** Comma-separated account filter for the portfolio grouping. */
  accountIds?: string;
  /** The accounts drawn one line each, in order, for the account grouping. */
  accountIdList: readonly string[];
  /** An account's name, for its line and its legend entry. */
  accountName: (accountId: string) => string;
  /** Report in this currency instead of the reader's preferred one. */
  displayCurrency?: string;
  reloadKey?: number;
  /** Ask nothing yet; the report's accounts have not loaded. */
  skip?: boolean;
  /** Exposes `exportPdf` to the report's Export dropdown. */
  exportRef?: Ref<SecurityComparisonChartHandle>;
  /** Told whether the line on screen is the current request's answer. */
  onExportableChange?: (exportable: boolean) => void;
}

/**
 * The portfolio's cumulative time-weighted return, over the window the cards
 * beside it are measured over (`docs/specs/portfolio-twr-series.md`).
 *
 * Deposits and withdrawals move no point: this is the chart that answers "how
 * is the portfolio doing" where the value chart answers "how much is in it".
 * The arithmetic is the server's and the line ends on the Return card's figure
 * (INV-PORTTWR-001); what this component owes the payload is honesty about what
 * the server could not work out. A series it withheld is named with its cause,
 * never drawn as a flat line, and a gap stays a gap.
 */
export function PortfolioReturnChart({
  groupBy,
  range,
  startDate,
  periodStartDate,
  endDate,
  accountIds,
  accountIdList,
  accountName,
  displayCurrency,
  reloadKey = 0,
  skip = false,
  exportRef,
  onExportableChange,
}: PortfolioReturnChartProps) {
  const t = useTranslations('reports');
  const formatChartDate = useChartDateFormat();
  const { formatSignedPercent } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);

  const accountsKey = accountIdList.join(',');
  const result = useTwrSeries({
    range,
    startDate,
    periodStartDate,
    endDate,
    groupBy,
    accountIds: groupBy === 'account' ? accountsKey || undefined : accountIds,
    displayCurrency,
    reloadKey,
    skip,
  });

  const portfolioLabel = t('investmentPerformance.twrPortfolioLine');
  const view = useMemo<ReturnView>(() => {
    if (result.status !== 'ready') return EMPTY_VIEW;
    return result.groupBy === 'account'
      ? buildAccountReturnView(result.series, accountName)
      : buildPortfolioReturnView(result.series, portfolioLabel);
  }, [result, accountName, portfolioLabel]);

  const { rows, lines, withheld } = view;

  // Only a chart with a line in it is worth exporting.
  const exportable = result.status === 'ready' && lines.length > 0;
  useEffect(() => {
    onExportableChange?.(exportable);
    return () => onExportableChange?.(false);
  }, [exportable, onExportableChange]);
  const labelByKey = useMemo(() => new Map(lines.map((l) => [l.key, l.label])), [lines]);

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

  const subtitle =
    groupBy === 'account'
      ? t('investmentPerformance.twrSubtitleAccounts')
      : t('investmentPerformance.twrSubtitlePortfolio');

  useImperativeHandle(
    exportRef,
    () => ({
      exportPdf: async () => {
        if (!exportable) return;
        const { exportToPdf } = await import('@/lib/pdf-export');
        await exportToPdf({
          title: t('investmentPerformance.twrTitle'),
          description: subtitle,
          chartContainer: chartRef.current,
          chartLegend: lines.map((line) => ({
            color: resolvePdfColor(line.color),
            label: line.label,
          })),
          filename: 'portfolio-return',
        });
      },
    }),
    [exportable, lines, subtitle, t],
  );

  return (
    <div
      ref={chartRef}
      className={`${CARD_CLASS} px-2 py-4 sm:p-6`}
    >
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('investmentPerformance.twrTitle')}
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{subtitle}</p>

      {result.status === 'error' ? (
        <ReportError message={t('investmentPerformance.twrError')} />
      ) : result.status === 'loading' ? (
        <Skeleton className="h-80 w-full" />
      ) : lines.length === 0 ? (
        // Nothing drawn because every series was withheld: the "Not drawn" list
        // below says why, so do not also claim there is no history.
        withheld.length === 0 && <EmptyState title={t('investmentPerformance.twrNoData')} />
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
                tickFormatter={(ts: number) => formatChartDate(new Date(ts), xAxis.tickFormat)}
                tick={{ fontSize: 11 }}
              />
              <YAxis
                tickFormatter={(v: number) => formatSignedPercent(v)}
                domain={['auto', 'auto']}
                tick={{ fontSize: 11 }}
              />
              {/* The origin every line starts from: above it the portfolio
                  gained, below it it lost. */}
              <ReferenceLine y={0} stroke={chartColors.axis} strokeDasharray="2 3" />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const ts = (payload[0].payload as ReturnRow).ts;
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
              {lines.length > 1 && <Legend />}
              {lines.map((line) => (
                <Line
                  activeDot={ChartActiveDot}
                  key={line.key}
                  type="monotone"
                  dataKey={line.key}
                  name={line.label}
                  stroke={line.color}
                  strokeWidth={line.heavy ? 3 : 2}
                  dot={false}
                  // A gap stays a gap: bridging it draws a segment through a
                  // stretch nobody measured, indistinguishable from data.
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/*
        A withheld series must be named, with what the reader can do about it.
        Dropping it silently makes a chart of two accounts out of a request for
        three, and a flat line at zero would read as a portfolio that did nothing.
      */}
      {result.status === 'ready' && withheld.length > 0 && (
        <div className="mt-4 rounded-md bg-gray-50 dark:bg-gray-900/40 p-3">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('investmentPerformance.twrWithheldTitle')}
          </p>
          <ul className="mt-1 space-y-1">
            {withheld.map((entry) => (
              <li key={entry.key} className="text-sm text-gray-500 dark:text-gray-400">
                {t('investmentPerformance.twrWithheldRow', {
                  label: entry.label,
                  reason: t(
                    `investmentPerformance.twrReason.${entry.cause}` as Parameters<typeof t>[0],
                  ),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
