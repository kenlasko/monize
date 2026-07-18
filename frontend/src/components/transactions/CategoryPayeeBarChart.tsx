'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { gainLossColor, sumMoney } from '@/lib/format';
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

// Desktop switches the bar-top value labels to vertical (and widens the top
// margin) once there are more than this many bars. Kept low because full
// currency labels are wide and overlap while still horizontal well before the
// bars themselves look crowded -- especially when the info widget narrows the
// chart to ~75% width.
const DESKTOP_CROWDED_THRESHOLD = 10;

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

interface CategoryPayeeBarChartProps {
  data: MonthlyTotal[];
  isLoading: boolean;
  onMonthClick?: (startDate: string, endDate: string) => void;
  /** Category/payee/tag/search descriptor appended to the download filename. */
  filterLabel?: string;
}

interface ChartDataPoint extends BucketedPoint {
  label: string;
  absTotal: number;
}

function MonthlyTotalTooltip({
  active,
  payload,
  formatCurrency,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartDataPoint }>;
  formatCurrency: (v: number) => string;
}) {
  const t = useTranslations('transactions');
  if (active && payload?.[0]) {
    const data = payload[0].payload;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
          {data.label}
        </p>
        <p
          className={`text-lg font-semibold ${
            gainLossColor(data.total)
          }`}
        >
          {formatCurrency(data.total)}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {t('charts.monthlyTotals.tooltip', { count: data.count })}
        </p>
      </div>
    );
  }
  return null;
}

export function CategoryPayeeBarChart({
  data,
  isLoading,
  onMonthClick,
  filterLabel,
}: CategoryPayeeBarChartProps) {
  const t = useTranslations('transactions');
  const chartTitle = t('charts.monthlyTotals.title');
  const { formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const downloadFilename = filterLabel ? `${chartTitle} - ${filterLabel}` : chartTitle;
  const isMobile = useIsMobile();

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
        return t('charts.monthlyTotals.quarterLabel', {
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
        return t('charts.monthlyTotals.quarterTick', {
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

  // Drill-down: map each bar's x value (periodStart) to its [start, end] range.
  const rangeByStart = useMemo(
    () =>
      new Map(
        buckets.map((b) => [b.periodStart, [b.periodStart, b.periodEnd] as const]),
      ),
    [buckets],
  );

  const isCrowded = chartData.length > DESKTOP_CROWDED_THRESHOLD;
  const verticalLabels = isMobile || isCrowded;

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
          <p>{t('charts.monthlyTotals.noData')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6 min-h-[420px]">
      <div className="flex items-center justify-between mb-4 gap-2">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {chartTitle}
        </h3>
        <div className="flex items-center gap-2">
          <div
            className="flex gap-1"
            role="group"
            aria-label={t('charts.monthlyTotals.granularityLabel')}
          >
            {GRANULARITY_MODES.map((mode) => {
              const isActive = granularityMode === mode;
              const label = t(`charts.monthlyTotals.granularity.${mode}`);
              const title =
                mode === 'auto'
                  ? t('charts.monthlyTotals.granularityAutoTitle', {
                      granularity: t(
                        `charts.monthlyTotals.granularity.${autoGranularity}`,
                      ),
                    })
                  : t('charts.monthlyTotals.granularityTitle', { label });
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

      {/* overflow-hidden: while the account-widget column animates the card's
          width, the recharts SVG keeps its last measured size until it
          re-measures, so clip it to the card instead of painting outside. */}
      <div
        ref={chartRef}
        className="h-72 overflow-hidden"
        style={{ minHeight: 288 }}
      >
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart
            data={chartData}
            margin={{ top: verticalLabels ? 28 : 20, right: isMobile ? 16 : 5, left: 0, bottom: 0 }}
            onClick={onMonthClick ? (state: any) => {
              const start = state?.activeLabel;
              const range = start ? rangeByStart.get(start) : undefined;
              if (range) onMonthClick(range[0], range[1]);
            } : undefined}
            style={onMonthClick ? { cursor: 'pointer' } : undefined}
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
              tickFormatter={formatCurrencyAxis}
              width="auto"
            />
            <Tooltip content={<MonthlyTotalTooltip formatCurrency={formatCurrency} />} />
            <Bar
              dataKey="absTotal"
              radius={[4, 4, 0, 0]}
              maxBarSize={50}
            >
              {chartData.map((entry, index) => (
                <Cell
                  key={index}
                  fill={entry.total >= 0 ? '#22c55e' : '#ef4444'}
                />
              ))}
              <LabelList
                dataKey="total"
                position="top"
                angle={verticalLabels ? -90 : 0}
                offset={verticalLabels ? (isMobile ? 8 : 6) : 5}
                textAnchor={verticalLabels ? 'start' : 'middle'}
                formatter={(value: unknown) =>
                  isMobile
                    ? formatCurrencyAxis(Number(value))
                    : formatCurrency(Number(value))
                }
                style={{
                  fill: '#6b7280',
                  fontSize: isMobile ? 10 : 11,
                  fontWeight: 500,
                  ...(verticalLabels && { dominantBaseline: 'central' as const }),
                }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Summary footer */}
      {summary && (
        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{t(`charts.monthlyTotals.${AVG_LABEL_KEY[granularity]}`)}</div>
            <div
              className={`font-semibold ${
                gainLossColor(summary.periodAvg)
              }`}
            >
              {formatCurrency(summary.periodAvg)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('charts.monthlyTotals.total')}</div>
            <div
              className={`font-semibold ${
                gainLossColor(summary.total)
              }`}
            >
              {formatCurrency(summary.total)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('charts.monthlyTotals.transactions')}</div>
            <div className="font-semibold text-gray-900 dark:text-gray-100">
              {summary.totalCount.toLocaleString()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
