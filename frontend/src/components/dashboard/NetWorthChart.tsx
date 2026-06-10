'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LabelList,
} from 'recharts';
import { format } from 'date-fns';
import { chartColors } from '@/lib/chart-colors';
import { MonthlyNetWorth } from '@/types/net-worth';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';

type YDomain = [number | ((dataMin: number) => number), number | 'auto'];

function NetWorthTooltip({
  active,
  payload,
  formatCurrency,
}: {
  active?: boolean;
  payload?: Array<{ payload: { name: string; netWorth: number } }>;
  formatCurrency: (v: number) => string;
}) {
  if (active && payload && payload.length) {
    const d = payload[0].payload;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100">{d.name}</p>
        <p className="text-sm text-blue-600 dark:text-blue-400">
          {formatCurrency(d.netWorth)}
        </p>
      </div>
    );
  }
  return null;
}

interface NetWorthChartProps {
  data: MonthlyNetWorth[];
  isLoading: boolean;
}

export function NetWorthChart({ data, isLoading }: NetWorthChartProps) {
  const t = useTranslations('dashboard');
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency, formatCurrencyLabel } = useNumberFormat();

  const chartData = useMemo(() =>
    data.map((d) => ({
      name: format(parseLocalDate(d.month), 'MMM yyyy'),
      shortName: format(parseLocalDate(d.month), 'MMM'),
      netWorth: Math.round(d.netWorth),
    })),
  [data]);

  const summary = useMemo(() => {
    if (chartData.length === 0) return null;
    const current = chartData[chartData.length - 1].netWorth;
    const initial = chartData[0].netWorth;
    const change = current - initial;
    const changePercent = initial !== 0 ? (change / Math.abs(initial)) * 100 : 0;
    return { current, change, changePercent };
  }, [chartData]);

  // A 0-anchored axis flattens every bar to nearly the same height; use a tight
  // domain padded below the minimum so month-to-month differences are visible.
  const yAxisDomain = useMemo<YDomain>(() => {
    const anchoredAtZero: YDomain = [(min: number) => Math.min(0, min), 'auto'];
    if (chartData.length === 0) return anchoredAtZero;

    const values = chartData.map((d) => d.netWorth);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const range = maxValue - minValue;
    if (range === 0) return anchoredAtZero;

    const rawMin = minValue - range * 0.15;
    const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(rawMin) || 1)));
    const niceMin = Math.floor(rawMin / magnitude) * magnitude;
    return [niceMin, 'auto'];
  }, [chartData]);

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[500px]">
        <button
          onClick={() => router.push('/reports/net-worth')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-4"
        >
          {t('netWorth.title')}
        </button>
        <div className="animate-pulse space-y-3">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-40 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[500px]">
        <button
          onClick={() => router.push('/reports/net-worth')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-4"
        >
          {t('netWorth.title')}
        </button>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          {t('netWorth.empty')}
        </p>
      </div>
    );
  }

  const isPositive = summary!.change >= 0;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[500px] flex flex-col h-full">
      <div className="flex items-center justify-between mb-1">
        <button
          onClick={() => router.push('/reports/net-worth')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          {t('netWorth.title')}
        </button>
        <span className="text-sm text-gray-500 dark:text-gray-400">{t('netWorth.past12Months')}</span>
      </div>
      <div className="mb-3">
        <div className={`text-2xl font-bold ${
          summary!.current >= 0 ? 'text-gray-900 dark:text-gray-100' : 'text-red-600 dark:text-red-400'
        }`}>
          {formatCurrency(summary!.current)}
        </div>
        <div className={`text-sm font-medium ${
          isPositive ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
        }`}>
          {isPositive ? '+' : ''}{formatCurrency(summary!.change)} ({isPositive ? '+' : ''}{summary!.changePercent.toFixed(1)}%)
        </div>
      </div>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart data={chartData} margin={{ top: 52, right: 12, left: 12, bottom: 0 }}>
            <YAxis hide domain={yAxisDomain} />
            <XAxis
              dataKey="name"
              tick={{ fill: chartColors.axis, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              tickFormatter={(value: string) => value.split(' ')[0]}
            />
            <Tooltip
              content={<NetWorthTooltip formatCurrency={formatCurrency} />}
              cursor={{ fill: chartColors.grid, fillOpacity: 0.35 }}
            />
            <Bar dataKey="netWorth" fill={chartColors.primary} radius={[4, 4, 0, 0]}>
              <LabelList
                dataKey="netWorth"
                position="top"
                angle={-90}
                offset={6}
                textAnchor="start"
                formatter={(value: unknown) => formatCurrencyLabel(Number(value))}
                style={{ fill: chartColors.axis, fontSize: 11, fontWeight: 600, dominantBaseline: 'central' }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <button
        onClick={() => router.push('/reports/net-worth')}
        className="mt-3 w-full text-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
      >
        {t('netWorth.viewReport')}
      </button>
    </div>
  );
}
