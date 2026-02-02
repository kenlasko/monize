'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { CategoricalChartFunc } from 'recharts/types/chart/types';
import { format, startOfWeek, endOfWeek, eachWeekOfInterval, subDays } from 'date-fns';
import { Transaction } from '@/types/transaction';
import { parseLocalDate } from '@/lib/utils';
import { useDateFormat } from '@/hooks/useDateFormat';

interface IncomeExpensesBarChartProps {
  transactions: Transaction[];
  isLoading: boolean;
}

export function IncomeExpensesBarChart({
  transactions,
  isLoading,
}: IncomeExpensesBarChartProps) {
  const router = useRouter();
  const { formatDate } = useDateFormat();

  // Group transactions by week and calculate income/expenses
  const chartData = useMemo(() => {
    const today = new Date();
    const thirtyDaysAgo = subDays(today, 30);

    // Get weeks in the range
    const weeks = eachWeekOfInterval(
      { start: thirtyDaysAgo, end: today },
      { weekStartsOn: 0 }
    );

    const weekData = weeks.map((weekStart) => {
      const weekEnd = endOfWeek(weekStart, { weekStartsOn: 0 });
      return {
        weekStart,
        weekEnd,
        label: formatDate(weekStart),
        income: 0,
        expenses: 0,
      };
    });

    // Aggregate transactions by week
    transactions.forEach((tx) => {
      // Skip transfers - they're not real income/expenses
      if (tx.isTransfer) return;

      const txDate = parseLocalDate(tx.transactionDate);
      const txWeekStart = startOfWeek(txDate, { weekStartsOn: 0 });

      const weekBucket = weekData.find(
        (w) => w.weekStart.getTime() === txWeekStart.getTime()
      );

      if (weekBucket) {
        const amount = Number(tx.amount) || 0;
        if (amount >= 0) {
          weekBucket.income += amount;
        } else {
          weekBucket.expenses += Math.abs(amount);
        }
      }
    });

    return weekData.map((w) => ({
      name: w.label,
      Income: Math.round(w.income),
      Expenses: Math.round(w.expenses),
      startDate: format(w.weekStart, 'yyyy-MM-dd'),
      endDate: format(w.weekEnd, 'yyyy-MM-dd'),
    }));
  }, [transactions, formatDate]);

  const handleChartClick: CategoricalChartFunc = (state) => {
    // Access the data point from chart data using activeIndex
    const index = state?.activeIndex;
    if (typeof index === 'number' && chartData[index]) {
      const { startDate, endDate } = chartData[index];
      router.push(`/transactions?startDate=${startDate}&endDate=${endDate}`);
    }
  };

  const totals = useMemo(() => {
    return chartData.reduce(
      (acc, week) => ({
        income: acc.income + week.Income,
        expenses: acc.expenses + week.Expenses,
      }),
      { income: 0, expenses: 0 }
    );
  }, [chartData]);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: 'CAD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
            Week of {label}
          </p>
          {payload.map((entry, index) => (
            <p
              key={index}
              className="text-sm"
              style={{ color: entry.color }}
            >
              {entry.name}: {formatCurrency(entry.value)}
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Income vs Expenses
        </h3>
        <div className="h-64 flex items-center justify-center">
          <div className="animate-pulse w-full h-full bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Income vs Expenses
        </h3>
        <span className="text-sm text-gray-500 dark:text-gray-400">Past 30 days</span>
      </div>
      <div className="h-64 flex-grow">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            barGap={4}
            onClick={handleChartClick}
            style={{ cursor: 'pointer' }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#e5e7eb"
              className="dark:stroke-gray-700"
            />
            <XAxis
              dataKey="name"
              tick={{ fill: '#6b7280', fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: '#e5e7eb' }}
            />
            <YAxis
              tick={{ fill: '#6b7280', fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: '#e5e7eb' }}
              tickFormatter={(value) => `$${value >= 1000 ? `${(value / 1000).toFixed(0)}k` : value}`}
            />
            <Tooltip content={<CustomTooltip />} />
            <Legend
              wrapperStyle={{ paddingTop: '1rem' }}
              formatter={(value) => (
                <span className="text-gray-600 dark:text-gray-400">{value}</span>
              )}
            />
            <Bar
              dataKey="Income"
              fill="#22c55e"
              radius={[4, 4, 0, 0]}
              maxBarSize={40}
            />
            <Bar
              dataKey="Expenses"
              fill="#ef4444"
              radius={[4, 4, 0, 0]}
              maxBarSize={40}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-auto pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-3 gap-4 text-center">
        <div>
          <div className="text-sm text-gray-500 dark:text-gray-400">Income</div>
          <div className="font-semibold text-green-600 dark:text-green-400">
            {formatCurrency(totals.income)}
          </div>
        </div>
        <div>
          <div className="text-sm text-gray-500 dark:text-gray-400">Expenses</div>
          <div className="font-semibold text-red-600 dark:text-red-400">
            {formatCurrency(totals.expenses)}
          </div>
        </div>
        <div>
          <div className="text-sm text-gray-500 dark:text-gray-400">Net</div>
          <div
            className={`font-semibold ${
              totals.income - totals.expenses >= 0
                ? 'text-green-600 dark:text-green-400'
                : 'text-red-600 dark:text-red-400'
            }`}
          >
            {formatCurrency(totals.income - totals.expenses)}
          </div>
        </div>
      </div>
    </div>
  );
}
