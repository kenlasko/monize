'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  AreaChart,
  Area,
  XAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { format } from 'date-fns';
import { MonthlyNetWorth } from '@/types/net-worth';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';

interface NetWorthChartProps {
  data: MonthlyNetWorth[];
  isLoading: boolean;
}

export function NetWorthChart({ data, isLoading }: NetWorthChartProps) {
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();

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

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: { name: string; netWorth: number } }> }) => {
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
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <button
          onClick={() => router.push('/reports/net-worth')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-4"
        >
          Net Worth
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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <button
          onClick={() => router.push('/reports/net-worth')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-4"
        >
          Net Worth
        </button>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          No net worth data available yet.
        </p>
      </div>
    );
  }

  const isPositive = summary!.change >= 0;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 flex flex-col h-full">
      <div className="flex items-center justify-between mb-1">
        <button
          onClick={() => router.push('/reports/net-worth')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          Net Worth
        </button>
        <span className="text-sm text-gray-500 dark:text-gray-400">Past 12 months</span>
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
      <div className="h-40 flex-grow">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 0 }}>
            <defs>
              <linearGradient id="dashboardNetWorthGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="shortName"
              tick={{ fill: '#6b7280', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="netWorth"
              stroke="#3b82f6"
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#dashboardNetWorthGradient)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <button
        onClick={() => router.push('/reports/net-worth')}
        className="mt-3 w-full text-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
      >
        View full report
      </button>
    </div>
  );
}
