'use client';

import { useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { format } from 'date-fns';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';

interface BalanceHistoryChartProps {
  data: Array<{ date: string; balance: number }>;
  isLoading: boolean;
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
            data.balance >= 0
              ? 'text-green-600 dark:text-green-400'
              : 'text-red-600 dark:text-red-400'
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
}: BalanceHistoryChartProps) {
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } = useNumberFormat();

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
        label: format(parsed, 'MMM d, yyyy'),
        balance: Math.round(d.balance * 100) / 100,
      };
    });
    return { chartData: points, monthTicks: ticks };
  }, [data]);

  const summary = useMemo(() => {
    if (chartData.length === 0) return null;
    const startBalance = chartData[0].balance;
    const endBalance = chartData[chartData.length - 1].balance;
    let minBalance = startBalance;
    for (const point of chartData) {
      if (point.balance < minBalance) minBalance = point.balance;
    }
    return { startBalance, endBalance, minBalance, goesNegative: minBalance < 0 };
  }, [chartData]);

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Balance History
        </h3>
        <div className="h-72 flex items-center justify-center">
          <div className="animate-pulse w-full h-full bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Balance History
        </h3>
        <div className="h-72 flex items-center justify-center text-gray-500 dark:text-gray-400">
          <p>No balance data available</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        Balance History
      </h3>

      <div className="h-72" style={{ minHeight: 288 }}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={chartData} margin={{ left: 0, right: 8, top: 5, bottom: 0 }}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#e5e7eb"
              className="dark:stroke-gray-700"
            />
            <XAxis
              dataKey="date"
              ticks={monthTicks}
              tick={{ fill: '#6b7280', fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: '#e5e7eb' }}
              tickFormatter={(value: string) => format(parseLocalDate(value), 'MMM')}
            />
            <YAxis
              tick={{ fill: '#6b7280', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={formatCurrencyAxis}
              width={45}
              domain={['auto', 'auto']}
            />
            <Tooltip content={<BalanceTooltip formatCurrency={formatCurrency} />} />
            <ReferenceLine
              y={0}
              stroke="#ef4444"
              strokeDasharray="5 5"
              strokeOpacity={0.5}
            />
            {summary && summary.minBalance !== summary.startBalance && (
              <ReferenceLine
                y={summary.minBalance}
                stroke={summary.minBalance < 0 ? '#ef4444' : '#f59e0b'}
                strokeDasharray="3 3"
                strokeOpacity={0.4}
              />
            )}
            <Line
              type="monotone"
              dataKey="balance"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 6, fill: '#3b82f6' }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Summary footer */}
      {summary && (
        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">Starting</div>
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
            <div className="text-sm text-gray-500 dark:text-gray-400">Current</div>
            <div
              className={`font-semibold ${
                summary.endBalance >= 0
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {formatCurrency(summary.endBalance)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {summary.goesNegative ? 'Lowest' : 'Min Balance'}
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
