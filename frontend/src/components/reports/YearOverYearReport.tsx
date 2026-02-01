'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { format, startOfYear, endOfYear, eachMonthOfInterval, startOfMonth } from 'date-fns';
import { transactionsApi } from '@/lib/transactions';
import { Transaction } from '@/types/transaction';
import { parseLocalDate } from '@/lib/utils';

const YEAR_COLOURS = ['#3b82f6', '#22c55e', '#f97316', '#8b5cf6', '#ec4899'];

export function YearOverYearReport() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [yearsToCompare, setYearsToCompare] = useState(2);
  const [metric, setMetric] = useState<'expenses' | 'income' | 'savings'>('expenses');

  const currentYear = new Date().getFullYear();
  const years = useMemo(() =>
    Array.from({ length: yearsToCompare }, (_, i) => currentYear - i).reverse(),
    [yearsToCompare, currentYear]
  );

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const oldestYear = currentYear - yearsToCompare + 1;
      const start = format(startOfYear(new Date(oldestYear, 0, 1)), 'yyyy-MM-dd');
      const end = format(new Date(), 'yyyy-MM-dd');

      const txData = await transactionsApi.getAll({ startDate: start, endDate: end, limit: 100000 });
      setTransactions(txData.data);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setIsLoading(false);
    }
  }, [currentYear, yearsToCompare]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const chartData = useMemo(() => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Initialize data structure
    const monthData = months.map((month, index) => {
      const data: { name: string; [key: string]: number | string } = { name: month };
      years.forEach((year) => {
        data[`${year}`] = 0;
      });
      return data;
    });

    // Group transactions by year and month
    transactions.forEach((tx) => {
      if (tx.isTransfer) return;
      const txDate = parseLocalDate(tx.transactionDate);
      const txYear = txDate.getFullYear();
      const txMonth = txDate.getMonth();
      const amount = Number(tx.amount) || 0;

      if (!years.includes(txYear)) return;

      const monthBucket = monthData[txMonth];
      if (monthBucket) {
        const yearKey = `${txYear}`;
        let value = 0;

        switch (metric) {
          case 'expenses':
            if (amount < 0) value = Math.abs(amount);
            break;
          case 'income':
            if (amount > 0) value = amount;
            break;
          case 'savings':
            value = amount; // Will be net
            break;
        }

        monthBucket[yearKey] = ((monthBucket[yearKey] as number) || 0) + value;
      }
    });

    // Round all values
    monthData.forEach((data) => {
      years.forEach((year) => {
        data[`${year}`] = Math.round(data[`${year}`] as number);
      });
    });

    return monthData;
  }, [transactions, years, metric]);

  const yearTotals = useMemo(() => {
    const totals: Record<number, { income: number; expenses: number; savings: number }> = {};

    years.forEach((year) => {
      totals[year] = { income: 0, expenses: 0, savings: 0 };
    });

    transactions.forEach((tx) => {
      if (tx.isTransfer) return;
      const txDate = parseLocalDate(tx.transactionDate);
      const txYear = txDate.getFullYear();
      const amount = Number(tx.amount) || 0;

      if (!years.includes(txYear)) return;

      if (amount > 0) {
        totals[txYear].income += amount;
      } else {
        totals[txYear].expenses += Math.abs(amount);
      }
      totals[txYear].savings += amount;
    });

    return totals;
  }, [transactions, years]);

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
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{label}</p>
          {payload.map((entry, index) => (
            <p key={index} className="text-sm" style={{ color: entry.color }}>
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
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-96 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-6 items-center">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Compare:
            </label>
            <select
              value={yearsToCompare}
              onChange={(e) => setYearsToCompare(Number(e.target.value))}
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm font-sans"
            >
              <option value={2} className="font-sans">2 Years</option>
              <option value={3} className="font-sans">3 Years</option>
              <option value={4} className="font-sans">4 Years</option>
              <option value={5} className="font-sans">5 Years</option>
            </select>
          </div>
          <div className="flex gap-2">
            {(['expenses', 'income', 'savings'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors capitalize ${
                  metric === m
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Year Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        {years.map((year, index) => (
          <div
            key={year}
            className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4"
            style={{ borderLeft: `4px solid ${YEAR_COLOURS[index % YEAR_COLOURS.length]}` }}
          >
            <div className="text-lg font-bold text-gray-900 dark:text-gray-100">{year}</div>
            <div className="mt-2 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">Income</span>
                <span className="text-green-600 dark:text-green-400">
                  {formatCurrency(yearTotals[year]?.income || 0)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">Expenses</span>
                <span className="text-red-600 dark:text-red-400">
                  {formatCurrency(yearTotals[year]?.expenses || 0)}
                </span>
              </div>
              <div className="flex justify-between pt-1 border-t border-gray-200 dark:border-gray-700">
                <span className="text-gray-500 dark:text-gray-400">Net</span>
                <span className={
                  (yearTotals[year]?.savings || 0) >= 0
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-orange-600 dark:text-orange-400'
                }>
                  {formatCurrency(yearTotals[year]?.savings || 0)}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Monthly Comparison Chart */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Monthly {metric.charAt(0).toUpperCase() + metric.slice(1)} Comparison
        </h3>
        <div className="h-96">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis
                tickFormatter={(value) => `$${Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(0)}k` : value}`}
                tick={{ fontSize: 12 }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend />
              {years.map((year, index) => (
                <Bar
                  key={year}
                  dataKey={`${year}`}
                  fill={YEAR_COLOURS[index % YEAR_COLOURS.length]}
                  radius={[4, 4, 0, 0]}
                  name={`${year}`}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Year-over-Year Change */}
      {years.length >= 2 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Year-over-Year Change
          </h3>
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="py-2 px-4 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Metric</th>
                  {years.slice(1).map((year, index) => (
                    <th key={year} className="py-2 px-4 text-right text-sm font-medium text-gray-500 dark:text-gray-400">
                      {years[index]} vs {year}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(['income', 'expenses', 'savings'] as const).map((m) => (
                  <tr key={m} className="border-b border-gray-200 dark:border-gray-700">
                    <td className="py-3 px-4 text-sm font-medium text-gray-900 dark:text-gray-100 capitalize">
                      {m}
                    </td>
                    {years.slice(1).map((year, index) => {
                      const prevYear = years[index];
                      const prevValue = yearTotals[prevYear]?.[m] || 0;
                      const currValue = yearTotals[year]?.[m] || 0;
                      const change = currValue - prevValue;
                      const changePercent = prevValue !== 0 ? (change / Math.abs(prevValue)) * 100 : 0;
                      const isPositive = m === 'expenses' ? change < 0 : change > 0;

                      return (
                        <td key={year} className="py-3 px-4 text-right">
                          <div className={`text-sm font-medium ${
                            isPositive ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                          }`}>
                            {change >= 0 ? '+' : ''}{formatCurrency(change)}
                          </div>
                          <div className={`text-xs ${
                            isPositive ? 'text-green-500' : 'text-red-500'
                          }`}>
                            ({changePercent >= 0 ? '+' : ''}{changePercent.toFixed(1)}%)
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
