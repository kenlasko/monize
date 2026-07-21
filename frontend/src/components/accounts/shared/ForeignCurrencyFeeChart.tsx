'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { sumMoney } from '@/lib/format';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LabelList,
  Cell,
} from 'recharts';
import { MonthlyTotal } from '@/types/transaction';
import {
  bucketMonthlyTotals,
  selectGranularity,
  type BucketedPoint,
  type Granularity,
} from '@/lib/chart-buckets';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useIsMobile } from '@/hooks/useIsMobile';
import { ChartDownloadButton } from '@/components/ui/ChartDownloadButton';

// Same crowding thresholds as the transactions Monthly Totals chart: switch the
// bar-top value labels to vertical once horizontal ones would overlap, and drop
// them entirely once even vertical labels are unreadable.
const DESKTOP_CROWDED_THRESHOLD = 20;
const MAX_LABELED_BARS = 60;

// 'auto' follows the data span; the fixed modes let the user override it.
type GranularityMode = 'auto' | Granularity;
const GRANULARITY_MODES: readonly GranularityMode[] = [
  'auto',
  'month',
  'quarter',
  'year',
];

// Summary "average" label switches to match the active bucket size.
const AVG_LABEL_KEY: Record<Granularity, string> = {
  month: 'monthlyAvg',
  quarter: 'quarterlyAvg',
  year: 'yearlyAvg',
};

// Quarter number (1-4) from a 'YYYY-MM-DD' period start.
function quarterOf(periodStart: string): number {
  return Math.floor((Number(periodStart.split('-')[1]) - 1) / 3) + 1;
}

// Fees are costs: a positive total (fees paid) reads red, a negative net
// (refunded fees) reads green -- the inverse of an income/expense chart.
function feeColorClass(total: number): string {
  return total > 0
    ? 'text-red-600 dark:text-red-400'
    : 'text-green-600 dark:text-green-400';
}

interface ForeignCurrencyFeeChartProps {
  /** Per-month fee totals (positive = fees paid), in the account currency. */
  data: MonthlyTotal[];
  isLoading: boolean;
  /** Account currency the fee amounts are denominated in. */
  currencyCode: string;
  /** Account name appended to the download filename. */
  accountName?: string;
}

interface ChartDataPoint extends BucketedPoint {
  label: string;
  absTotal: number;
}

function FeeTooltip({
  active,
  payload,
  formatCurrency,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartDataPoint }>;
  formatCurrency: (v: number) => string;
}) {
  const t = useTranslations('accountDetail-fxFees');
  if (active && payload?.[0]) {
    const data = payload[0].payload;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
          {data.label}
        </p>
        <p className={`text-lg font-semibold ${feeColorClass(data.total)}`}>
          {formatCurrency(data.total)}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {t('chart.tooltip', { count: data.count })}
        </p>
      </div>
    );
  }
  return null;
}

/**
 * Bar chart of foreign-transaction fees over the life of an account, bucketed
 * by month/quarter/year with an Auto default -- the same resolution selector,
 * bar-top label, and summary-footer formatting as the transactions page's
 * Monthly Totals chart.
 */
export function ForeignCurrencyFeeChart({
  data,
  isLoading,
  currencyCode,
  accountName,
}: ForeignCurrencyFeeChartProps) {
  const t = useTranslations('accountDetail-fxFees');
  const chartTitle = t('chart.title');
  const { formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const downloadFilename = accountName ? `${chartTitle} - ${accountName}` : chartTitle;
  const isMobile = useIsMobile();

  const formatFee = useCallback(
    (value: number) => formatCurrency(value, currencyCode),
    [formatCurrency, currencyCode],
  );

  const [granularityMode, setGranularityMode] = useState<GranularityMode>('auto');
  const autoGranularity = useMemo(
    () => selectGranularity(data.map((d) => d.month)),
    [data],
  );
  const granularity: Granularity =
    granularityMode === 'auto' ? autoGranularity : granularityMode;

  // Full label for the tooltip (e.g. "January 2024", "Q1 2024", "2024").
  const bucketFullLabel = useCallback(
    (bucket: BucketedPoint): string => {
      if (bucket.granularity === 'year') {
        return formatChartDate(bucket.periodStart, 'yyyy');
      }
      if (bucket.granularity === 'quarter') {
        return t('chart.quarterLabel', {
          quarter: String(quarterOf(bucket.periodStart)),
          year: formatChartDate(bucket.periodStart, 'yyyy'),
        });
      }
      return formatChartDate(bucket.periodStart, 'MMMM yyyy');
    },
    [formatChartDate, t],
  );

  // Compact axis tick (e.g. "Jan 24", "Q1 24", "2024").
  const axisTick = useCallback(
    (periodStart: string): string => {
      if (granularity === 'year') return formatChartDate(periodStart, 'yyyy');
      if (granularity === 'quarter') {
        return t('chart.quarterTick', {
          quarter: String(quarterOf(periodStart)),
          year: periodStart.slice(2, 4),
        });
      }
      return formatChartDate(periodStart, 'MMM yy');
    },
    [granularity, formatChartDate, t],
  );

  const buckets = useMemo(
    () => bucketMonthlyTotals(data, granularity),
    [data, granularity],
  );

  const chartData = useMemo<ChartDataPoint[]>(
    () =>
      buckets.map((bucket) => ({
        ...bucket,
        label: bucketFullLabel(bucket),
        absTotal: Math.abs(bucket.total),
      })),
    [buckets, bucketFullLabel],
  );

  const isCrowded = chartData.length > DESKTOP_CROWDED_THRESHOLD;
  const verticalLabels = isMobile || isCrowded;
  const showBarLabels = chartData.length <= MAX_LABELED_BARS;

  const summary = useMemo(() => {
    if (chartData.length === 0) return null;
    const total = sumMoney(chartData.map((d) => d.total));
    const totalCount = chartData.reduce((sum, d) => sum + d.count, 0);
    const periodsElapsed = chartData.length;
    const periodAvg = periodsElapsed > 0 ? total / periodsElapsed : 0;
    return { total, totalCount, periodAvg };
  }, [chartData]);

  if (isLoading) {
    return (
      <div className="min-h-[420px]">
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
      <div className="min-h-[420px]">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {chartTitle}
        </h3>
        <div className="h-72 flex items-center justify-center text-gray-500 dark:text-gray-400">
          <p>{t('chart.noData')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[420px]">
      <div className="flex items-center justify-between mb-4 gap-2">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {chartTitle}
        </h3>
        <div className="flex items-center gap-2">
          <div
            className="flex gap-1"
            role="group"
            aria-label={t('chart.granularityLabel')}
          >
            {GRANULARITY_MODES.map((mode) => {
              const isActive = granularityMode === mode;
              const label = t(`chart.granularity.${mode}`);
              const title =
                mode === 'auto'
                  ? t('chart.granularityAutoTitle', {
                      granularity: t(`chart.granularity.${autoGranularity}`),
                    })
                  : t('chart.granularityTitle', { label });
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setGranularityMode(mode)}
                  aria-pressed={isActive}
                  title={title}
                  className={
                    isActive
                      ? 'px-2 py-1 text-xs rounded-md bg-blue-600 text-white transition-colors'
                      : 'px-2 py-1 text-xs rounded-md bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors'
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
          <ChartDownloadButton chartRef={chartRef} filename={downloadFilename} />
        </div>
      </div>

      {/* overflow-hidden: while a layout column animates the card's width, the
          recharts SVG keeps its last measured size until it re-measures, so
          clip it to the card instead of painting outside. */}
      <div
        ref={chartRef}
        className="h-72 overflow-hidden"
        style={{ minHeight: 288 }}
      >
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart
            data={chartData}
            margin={{ top: verticalLabels ? 28 : 20, right: isMobile ? 16 : 5, left: 0, bottom: 0 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#e5e7eb"
              className="dark:stroke-gray-700"
            />
            <XAxis
              dataKey="periodStart"
              tick={{ fill: '#6b7280', fontSize: isMobile ? 10 : 12 }}
              tickLine={false}
              axisLine={{ stroke: '#e5e7eb' }}
              tickFormatter={axisTick}
              interval="preserveStartEnd"
              angle={isMobile ? -35 : 0}
              textAnchor={isMobile ? 'end' : 'middle'}
              tickMargin={isMobile ? 10 : 0}
              height={isMobile ? 64 : 30}
            />
            <YAxis
              tick={{ fill: '#6b7280', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => formatCurrencyAxis(value, currencyCode)}
              width="auto"
            />
            <Tooltip content={<FeeTooltip formatCurrency={formatFee} />} />
            <Bar
              dataKey="absTotal"
              radius={[4, 4, 0, 0]}
              maxBarSize={50}
            >
              {chartData.map((entry, index) => (
                <Cell
                  key={index}
                  fill={entry.total > 0 ? '#ef4444' : '#22c55e'}
                />
              ))}
              {showBarLabels && (
                <LabelList
                  dataKey="total"
                  position="top"
                  angle={verticalLabels ? -90 : 0}
                  offset={verticalLabels ? (isMobile ? 8 : 6) : 5}
                  textAnchor={verticalLabels ? 'start' : 'middle'}
                  formatter={(value: unknown) =>
                    isMobile
                      ? formatCurrencyAxis(Number(value), currencyCode)
                      : formatFee(Number(value))
                  }
                  style={{
                    fill: '#6b7280',
                    fontSize: isMobile ? 10 : 11,
                    fontWeight: 500,
                    ...(verticalLabels && { dominantBaseline: 'central' as const }),
                  }}
                />
              )}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Summary footer */}
      {summary && (
        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {t(`chart.${AVG_LABEL_KEY[granularity]}`)}
            </div>
            <div className={`font-semibold ${feeColorClass(summary.periodAvg)}`}>
              {formatFee(summary.periodAvg)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('chart.total')}</div>
            <div className={`font-semibold ${feeColorClass(summary.total)}`}>
              {formatFee(summary.total)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('chart.transactions')}</div>
            <div className="font-semibold text-gray-900 dark:text-gray-100">
              {summary.totalCount.toLocaleString()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
