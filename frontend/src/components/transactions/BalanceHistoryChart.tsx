'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { gainLossColor } from '@/lib/format';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { format } from 'date-fns';
import { chartColors } from '@/lib/chart-colors';
import { parseLocalDate } from '@/lib/utils';
import { computeBalanceGradient, computeBalanceSummary } from '@/lib/balance-history';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { ChartDownloadButton } from '@/components/ui/ChartDownloadButton';
import {
  ChartFlagShadowFilter,
  computeMinMaxFlagIndices,
  renderMinMaxFlagDots,
} from '@/components/investments/portfolio-chart-utils';


interface BalanceHistoryChartProps {
  data: Array<{ date: string; balance: number }>;
  isLoading: boolean;
  currencyCode?: string;
  /** Account name to append to the download filename, e.g. "Checking". */
  accountName?: string;
}

interface ChartPoint {
  date: string;
  label: string;
  balance: number;
}

function BalanceTooltip({
  active,
  payload,
  formatCurrency,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartPoint }>;
  formatCurrency: (v: number) => string;
}) {
  if (active && payload?.[0]) {
    const data = payload[0].payload;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
          {data.label}
        </p>
        <p
          className={`text-lg font-semibold ${
            gainLossColor(data.balance)
          }`}
        >
          {formatCurrency(data.balance)}
        </p>
      </div>
    );
  }
  return null;
}

export function BalanceHistoryChart({
  data,
  isLoading,
  currencyCode,
  accountName,
}: BalanceHistoryChartProps) {
  const t = useTranslations('transactions');
  const tc = useTranslations('common');
  const chartTitle = t('charts.balanceHistory.title');
  const { formatCurrency: formatCurrencyFull, formatCurrencyAxis, formatCurrencyFlag } =
    useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  // High/low value bubbles a user has temporarily dismissed, keyed by the value
  // they marked so a later data change with a new extreme shows its bubble
  // again. Intentionally component-local (not persisted), so it resets on
  // navigation.
  const [dismissedHigh, setDismissedHigh] = useState<number | null>(null);
  const [dismissedLow, setDismissedLow] = useState<number | null>(null);
  const downloadFilename = accountName ? `${chartTitle} - ${accountName}` : chartTitle;

  const formatCurrency = useCallback(
    (value: number) => formatCurrencyFull(value, currencyCode),
    [formatCurrencyFull, currencyCode],
  );

  const formatAxis = useCallback(
    (value: number) => formatCurrencyAxis(value, currencyCode),
    [formatCurrencyAxis, currencyCode],
  );

  const formatFlag = useCallback(
    (value: number) => formatCurrencyFlag(value, currencyCode),
    [formatCurrencyFlag, currencyCode],
  );

  const { chartData, monthTicks } = useMemo(() => {
    if (data.length === 0) return { chartData: [], monthTicks: [] };

    const ticks: string[] = [];
    let lastMonth = '';
    const points = data.map((d) => {
      const parsed = parseLocalDate(d.date);
      const monthKey = format(parsed, 'yyyy-MM');
      if (monthKey !== lastMonth) {
        ticks.push(d.date);
        lastMonth = monthKey;
      }
      return {
        date: d.date,
        label: formatChartDate(parsed, 'MMM d, yyyy'),
        balance: Math.round(d.balance * 100) / 100,
      };
    });
    return { chartData: points, monthTicks: ticks };
  }, [data, formatChartDate]);

  const summary = useMemo(() => computeBalanceSummary(chartData), [chartData]);

  // Date of the last point on or before today, when future (projected) points
  // follow it -- used to draw the "history vs projection" divider line.
  const futureDivider = useMemo(() => {
    if (chartData.length === 0) return null;
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let anchor: string | null = null;
    let hasFuture = false;
    for (const point of chartData) {
      if (point.date <= todayStr) anchor = point.date;
      else hasFuture = true;
    }
    return hasFuture ? anchor : null;
  }, [chartData]);

  const areaGradient = useMemo(
    () => computeBalanceGradient(chartData.map((point) => point.balance)),
    [chartData],
  );

  // Highest/lowest points get green/red value bubbles, positioned to the
  // inside of whichever chart half they fall on so they never overlap the
  // plot edges.
  const flags = useMemo(
    () => computeMinMaxFlagIndices(chartData.map((point) => point.balance)),
    [chartData],
  );

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6 min-h-[420px]">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {chartTitle}
        </h3>
        <div className="h-72 flex items-center justify-center">
          <Skeleton className="w-full h-full" />
        </div>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6 min-h-[420px]">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {chartTitle}
        </h3>
        <div className="h-72 flex items-center justify-center text-gray-500 dark:text-gray-400">
          <p>{t('charts.balanceHistory.noData')}</p>
        </div>
      </div>
    );
  }

  const highValue = flags.show ? chartData[flags.maxIndex].balance : null;
  const lowValue = flags.show ? chartData[flags.minIndex].balance : null;
  const highLabel = highValue !== null ? formatFlag(highValue) : '';
  const lowLabel = lowValue !== null ? formatFlag(lowValue) : '';
  const highDismissed = highValue !== null && highValue === dismissedHigh;
  const lowDismissed = lowValue !== null && lowValue === dismissedLow;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6 min-h-[420px]">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {chartTitle}
        </h3>
        <ChartDownloadButton chartRef={chartRef} filename={downloadFilename} />
      </div>

      {/* overflow-hidden: while the account-widget column animates the card's
          width, the recharts SVG keeps its last measured size until it
          re-measures, so clip it to the card instead of painting outside. */}
      <div ref={chartRef} className="h-72 overflow-hidden" style={{ minHeight: 288 }}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          {/* top margin leaves headroom for the high-value bubble callout */}
          <AreaChart data={chartData} margin={{ left: 0, right: 8, top: 20, bottom: 0 }}>
            <defs>
              <linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1">
                <stop offset={0} stopColor={chartColors.primary} stopOpacity={areaGradient.topOpacity} />
                <stop offset={areaGradient.zeroOffset} stopColor={chartColors.primary} stopOpacity={0} />
                <stop offset={1} stopColor={chartColors.primary} stopOpacity={areaGradient.bottomOpacity} />
              </linearGradient>
            </defs>
            <ChartFlagShadowFilter />
            <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
            <XAxis
              dataKey="date"
              ticks={monthTicks}
              tick={{ fill: chartColors.axis, fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: chartColors.grid }}
              tickFormatter={(value: string) => formatChartDate(value, 'MMM')}
            />
            {/* width="auto" lets recharts size the axis to its widest tick
                label so long localized currency values (e.g. "1.234.567 €")
                are never clipped. */}
            <YAxis
              tick={{ fill: chartColors.axis, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={formatAxis}
              width="auto"
              domain={['auto', 'auto']}
            />
            <Tooltip content={<BalanceTooltip formatCurrency={formatCurrency} />} />
            <ReferenceLine
              y={0}
              stroke={chartColors.expense}
              strokeDasharray="5 5"
              strokeOpacity={0.5}
            />
            {futureDivider && (
              <ReferenceLine
                x={futureDivider}
                stroke={chartColors.axis}
                strokeDasharray="4 4"
                strokeWidth={2}
                label={{
                  value: t('charts.balanceHistory.projected'),
                  // Bottom of the divider, clear of the high-value ("Max
                  // Balance") bubble that sits in the top headroom.
                  position: 'insideBottomRight',
                  fill: chartColors.axis,
                  fontSize: 11,
                }}
              />
            )}
            {summary && summary.minBalance !== summary.startBalance && (
              <ReferenceLine
                y={summary.minBalance}
                stroke={summary.minBalance < 0 ? chartColors.expense : chartColors.warning}
                strokeDasharray="3 3"
                strokeOpacity={0.4}
              />
            )}
            <Area
              type="monotone"
              dataKey="balance"
              stroke={chartColors.primary}
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#colorBalance)"
              dot={(props: { cx?: number; cy?: number; index?: number }) =>
                renderMinMaxFlagDots({
                  cx: props.cx,
                  cy: props.cy,
                  index: props.index,
                  flags,
                  pointCount: chartData.length,
                  highColor: chartColors.income,
                  lowColor: chartColors.expense,
                  highLabel,
                  lowLabel,
                  highDismissed,
                  lowDismissed,
                  onDismissHigh: () => setDismissedHigh(highValue),
                  onDismissLow: () => setDismissedLow(lowValue),
                  dismissLabel: tc('chartFlag.dismiss'),
                })
              }
              activeDot={{ r: 6, fill: chartColors.primary }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Summary footer */}
      {summary && (
        <div className={`mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 grid ${summary.hasFutureData ? 'grid-cols-2' : 'grid-cols-3'} gap-4 text-center`}>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('charts.balanceHistory.starting')}</div>
            <div
              className={`font-semibold ${
                summary.startBalance >= 0
                  ? 'text-gray-900 dark:text-gray-100'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {formatCurrency(summary.startBalance)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('charts.balanceHistory.current')}</div>
            <div
              className={`font-semibold ${
                gainLossColor(summary.currentBalance)
              }`}
            >
              {formatCurrency(summary.currentBalance)}
            </div>
          </div>
          {summary.hasFutureData && (
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400">{t('charts.balanceHistory.ending')}</div>
              <div
                className={`font-semibold ${
                  summary.endBalance >= 0
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-red-600 dark:text-red-400'
                }`}
              >
                {formatCurrency(summary.endBalance)}
              </div>
            </div>
          )}
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {summary.goesNegative ? t('charts.balanceHistory.lowest') : t('charts.balanceHistory.minBalance')}
            </div>
            <div
              className={`font-semibold ${
                summary.minBalance >= 0
                  ? 'text-gray-900 dark:text-gray-100'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {formatCurrency(summary.minBalance)}
              {summary.goesNegative && (
                <span className="ml-1 text-xs text-red-500">!</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
