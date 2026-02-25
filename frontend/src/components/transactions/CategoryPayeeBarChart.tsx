'use client';

import { useMemo } from 'react';
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
import { format } from 'date-fns';
import { parseLocalDate } from '@/lib/utils';
import { MonthlyTotal } from '@/types/transaction';
import { useNumberFormat } from '@/hooks/useNumberFormat';

interface CategoryPayeeBarChartProps {
  data: MonthlyTotal[];
  isLoading: boolean;
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
  if (active && payload?.[0]) {
    const data = payload[0].payload;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
          {data.label}
        </p>
        <p
          className={`text-lg font-semibold ${
            data.total >= 0
              ? 'text-green-600 dark:text-green-400'
              : 'text-red-600 dark:text-red-400'
          }`}
        >
          {formatCurrency(data.total)}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {data.count} transaction{data.count !== 1 ? 's' : ''}
        </p>
      </div>
    );
  }
  return null;
}

export function CategoryPayeeBarChart({
  data,
  isLoading,
}: CategoryPayeeBarChartProps) {
  const { formatCurrency, formatCurrencyCompact, formatCurrencyAxis } = useNumberFormat();

  const chartData = useMemo(() => {
    return data.map((d) => {
      const parsed = parseLocalDate(`${d.month}-01`);
      return {
        month: d.month,
        label: format(parsed, 'MMMM yyyy'),
        total: d.total,
        absTotal: Math.abs(d.total),
        count: d.count,
      };
    });
  }, [data]);

  const summary = useMemo(() => {
    if (chartData.length === 0) return null;
    const total = chartData.reduce((sum, d) => sum + d.total, 0);
    const totalCount = chartData.reduce((sum, d) => sum + d.count, 0);
    const monthlyAvg = total / chartData.length;
    return { total, totalCount, monthlyAvg };
  }, [chartData]);

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Monthly Totals
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
          Monthly Totals
        </h3>
        <div className="h-72 flex items-center justify-center text-gray-500 dark:text-gray-400">
          <p>No transaction data available</p>
        </div>
      </div>
    );
  }

  // Determine if totals are predominantly negative (expenses) or positive (income)
  const predominantlyNegative = chartData.filter(d => d.total < 0).length > chartData.length / 2;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        Monthly Totals
      </h3>

      <div className="h-72" style={{ minHeight: 288 }}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart
            data={chartData}
            margin={{ top: 20, right: 5, left: -10, bottom: 0 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#e5e7eb"
              className="dark:stroke-gray-700"
            />
            <XAxis
              dataKey="month"
              tick={{ fill: '#6b7280', fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: '#e5e7eb' }}
              tickFormatter={(value: string) => format(parseLocalDate(`${value}-01`), 'MMM yy')}
            />
            <YAxis
              tick={{ fill: '#6b7280', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={formatCurrencyAxis}
              width={45}
            />
            <Tooltip content={<MonthlyTotalTooltip formatCurrency={formatCurrencyCompact} />} />
            <Bar
              dataKey="absTotal"
              radius={[4, 4, 0, 0]}
              maxBarSize={50}
            >
              {chartData.map((entry, index) => (
                <Cell
                  key={index}
                  fill={entry.total >= 0 ? '#22c55e' : '#3b82f6'}
                />
              ))}
              <LabelList
                dataKey="total"
                position="top"
                formatter={(value: unknown) => formatCurrency(Number(value))}
                style={{ fill: '#6b7280', fontSize: 11, fontWeight: 500 }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Summary footer */}
      {summary && (
        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">Monthly Avg</div>
            <div
              className={`font-semibold ${
                summary.monthlyAvg >= 0
                  ? 'text-green-600 dark:text-green-400'
                  : predominantlyNegative ? 'text-blue-600 dark:text-blue-400' : 'text-red-600 dark:text-red-400'
              }`}
            >
              {formatCurrencyCompact(summary.monthlyAvg)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">Total</div>
            <div
              className={`font-semibold ${
                summary.total >= 0
                  ? 'text-green-600 dark:text-green-400'
                  : predominantlyNegative ? 'text-blue-600 dark:text-blue-400' : 'text-red-600 dark:text-red-400'
              }`}
            >
              {formatCurrencyCompact(summary.total)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">Transactions</div>
            <div className="font-semibold text-gray-900 dark:text-gray-100">
              {summary.totalCount.toLocaleString()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
