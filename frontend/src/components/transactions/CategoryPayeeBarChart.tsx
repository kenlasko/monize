'use client';

import { useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { gainLossColor } from '@/lib/format';
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
import { format, lastDayOfMonth } from 'date-fns';
import { parseLocalDate } from '@/lib/utils';
import { MonthlyTotal } from '@/types/transaction';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useIsMobile } from '@/hooks/useIsMobile';
import { ChartDownloadButton } from '@/components/ui/ChartDownloadButton';

// Desktop goes vertical on the bar-top labels and widens the top margin only
// once the column count crosses this threshold (3 years of monthly buckets).
const DESKTOP_CROWDED_THRESHOLD = 36;

interface CategoryPayeeBarChartProps {
  data: MonthlyTotal[];
  isLoading: boolean;
  onMonthClick?: (startDate: string, endDate: string) => void;
  /** Category/payee/tag/search descriptor appended to the download filename. */
  filterLabel?: string;
}

interface ChartDataPoint {
  month: string;
  label: string;
  total: number;
  count: number;
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

  const chartData = useMemo(() => {
    return data.map((d) => {
      const parsed = parseLocalDate(`${d.month}-01`);
      return {
        month: d.month,
        label: formatChartDate(parsed, 'MMMM yyyy'),
        total: d.total,
        absTotal: Math.abs(d.total),
        count: d.count,
      };
    });
  }, [data, formatChartDate]);

  const isCrowded = chartData.length > DESKTOP_CROWDED_THRESHOLD;
  const verticalLabels = isMobile || isCrowded;

  const summary = useMemo(() => {
    if (chartData.length === 0) return null;
    const total = chartData.reduce((sum, d) => sum + d.total, 0);
    const totalCount = chartData.reduce((sum, d) => sum + d.count, 0);
    const monthlyAvg = total / chartData.length;
    return { total, totalCount, monthlyAvg };
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
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {chartTitle}
        </h3>
        <ChartDownloadButton chartRef={chartRef} filename={downloadFilename} />
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
            margin={{ top: verticalLabels ? 20 : 12, right: isMobile ? 16 : 5, left: -10, bottom: 0 }}
            onClick={onMonthClick ? (state: any) => {
              const month = state?.activeLabel;
              if (!month) return;
              const firstDay = `${month}-01`;
              const lastDay = format(lastDayOfMonth(parseLocalDate(firstDay)), 'yyyy-MM-dd');
              onMonthClick(firstDay, lastDay);
            } : undefined}
            style={onMonthClick ? { cursor: 'pointer' } : undefined}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#e5e7eb"
              className="dark:stroke-gray-700"
            />
            <XAxis
              dataKey="month"
              tick={{ fill: '#6b7280', fontSize: isMobile ? 10 : 12 }}
              tickLine={false}
              axisLine={{ stroke: '#e5e7eb' }}
              tickFormatter={(value: string) => formatChartDate(`${value}-01`, 'MMM yy')}
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
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('charts.monthlyTotals.monthlyAvg')}</div>
            <div
              className={`font-semibold ${
                gainLossColor(summary.monthlyAvg)
              }`}
            >
              {formatCurrency(summary.monthlyAvg)}
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
