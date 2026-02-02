'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from 'recharts';
import { format, subMonths, startOfMonth, endOfMonth, eachMonthOfInterval } from 'date-fns';
import { transactionsApi } from '@/lib/transactions';
import { Transaction } from '@/types/transaction';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';

type DateRange = '6m' | '1y' | '2y' | 'custom';

export function IncomeVsExpensesReport() {
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [dateRange, setDateRange] = useState<DateRange>('1y');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const getDateRange = useCallback((range: DateRange): { start: string; end: string } => {
    const now = new Date();
    const end = format(endOfMonth(now), 'yyyy-MM-dd');
    let start: string;

    switch (range) {
      case '6m':
        start = format(startOfMonth(subMonths(now, 5)), 'yyyy-MM-dd');
        break;
      case '1y':
        start = format(startOfMonth(subMonths(now, 11)), 'yyyy-MM-dd');
        break;
      case '2y':
        start = format(startOfMonth(subMonths(now, 23)), 'yyyy-MM-dd');
        break;
      default:
        start = startDate || format(startOfMonth(subMonths(now, 11)), 'yyyy-MM-dd');
    }

    return { start, end };
  }, [startDate]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const { start, end } = dateRange === 'custom'
        ? { start: startDate, end: endDate }
        : getDateRange(dateRange);

      const txData = await transactionsApi.getAll({ startDate: start, endDate: end, limit: 50000 });
      setTransactions(txData.data);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setIsLoading(false);
    }
  }, [dateRange, startDate, endDate, getDateRange]);

  useEffect(() => {
    if (dateRange !== 'custom' || (startDate && endDate)) {
      loadData();
    }
  }, [dateRange, startDate, endDate, loadData]);

  const chartData = useMemo(() => {
    const { start, end } = dateRange === 'custom'
      ? { start: startDate, end: endDate }
      : getDateRange(dateRange);

    if (!start || !end) return [];

    const months = eachMonthOfInterval({
      start: parseLocalDate(start),
      end: parseLocalDate(end),
    });

    const monthData = months.map((month) => ({
      month,
      label: format(month, 'MMM yyyy'),
      shortLabel: format(month, 'MMM'),
      expenses: 0,
      income: 0,
    }));

    transactions.forEach((tx) => {
      if (tx.isTransfer) return;
      const txDate = parseLocalDate(tx.transactionDate);
      const txMonth = startOfMonth(txDate);
      const monthBucket = monthData.find(
        (m) => m.month.getTime() === txMonth.getTime()
      );

      if (monthBucket) {
        const amount = Number(tx.amount) || 0;
        if (amount >= 0) {
          monthBucket.income += amount;
        } else {
          monthBucket.expenses += Math.abs(amount);
        }
      }
    });

    return monthData.map((m) => ({
      name: m.shortLabel,
      fullName: m.label,
      Income: Math.round(m.income),
      Expenses: Math.round(m.expenses),
      Savings: Math.round(m.income - m.expenses),
      SavingsRate: m.income > 0 ? Math.round(((m.income - m.expenses) / m.income) * 100) : 0,
      monthStart: format(startOfMonth(m.month), 'yyyy-MM-dd'),
      monthEnd: format(endOfMonth(m.month), 'yyyy-MM-dd'),
    }));
  }, [transactions, dateRange, startDate, endDate, getDateRange]);

  const handleChartClick = (state: unknown) => {
    const chartState = state as { activePayload?: Array<{ payload: { monthStart: string; monthEnd: string } }> } | null;
    if (chartState?.activePayload?.[0]?.payload) {
      const { monthStart, monthEnd } = chartState.activePayload[0].payload;
      router.push(`/transactions?startDate=${monthStart}&endDate=${monthEnd}`);
    }
  };

  const totals = useMemo(() => {
    const totalExpenses = chartData.reduce((sum, m) => sum + m.Expenses, 0);
    const totalIncome = chartData.reduce((sum, m) => sum + m.Income, 0);
    const totalSavings = totalIncome - totalExpenses;
    const savingsRate = totalIncome > 0 ? (totalSavings / totalIncome) * 100 : 0;
    return { totalExpenses, totalIncome, totalSavings, savingsRate };
  }, [chartData]);

  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string; payload: { fullName: string; SavingsRate: number } }>; label?: string }) => {
    if (active && payload && payload.length) {
      const data = payload[0]?.payload;
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{data?.fullName}</p>
          {payload.map((entry, index) => (
            <p key={index} className="text-sm" style={{ color: entry.color }}>
              {entry.name}: {formatCurrency(entry.value)}
            </p>
          ))}
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            Savings Rate: {data?.SavingsRate}%
          </p>
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
        <div className="flex flex-wrap gap-4 items-center">
          <div className="flex flex-wrap gap-2">
            {(['6m', '1y', '2y'] as DateRange[]).map((range) => (
              <button
                key={range}
                onClick={() => setDateRange(range)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  dateRange === range
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {range.toUpperCase()}
              </button>
            ))}
            <button
              onClick={() => setDateRange('custom')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                dateRange === 'custom'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
            >
              Custom
            </button>
          </div>
        </div>
        {dateRange === 'custom' && (
          <div className="flex gap-4 mt-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Start Date
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                End Date
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              />
            </div>
          </div>
        )}
      </div>

      {/* Chart */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        {chartData.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No data for this period.
          </p>
        ) : (
          <>
            <div className="h-96">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
                  onClick={handleChartClick}
                  style={{ cursor: 'pointer' }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis
                    tickFormatter={(value) => `$${value >= 1000 ? `${(value / 1000).toFixed(0)}k` : value}`}
                    tick={{ fontSize: 12 }}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend />
                  <ReferenceLine y={0} stroke="#9ca3af" />
                  <Bar dataKey="Income" fill="#22c55e" radius={[4, 4, 0, 0]} cursor="pointer" />
                  <Bar dataKey="Expenses" fill="#ef4444" radius={[4, 4, 0, 0]} cursor="pointer" />
                  <Bar dataKey="Savings" fill="#3b82f6" radius={[4, 4, 0, 0]} cursor="pointer" />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Summary Cards */}
            <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4 text-center">
                <div className="text-sm text-green-600 dark:text-green-400">Total Income</div>
                <div className="text-xl font-bold text-green-700 dark:text-green-300">
                  {formatCurrency(totals.totalIncome)}
                </div>
              </div>
              <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4 text-center">
                <div className="text-sm text-red-600 dark:text-red-400">Total Expenses</div>
                <div className="text-xl font-bold text-red-700 dark:text-red-300">
                  {formatCurrency(totals.totalExpenses)}
                </div>
              </div>
              <div className={`rounded-lg p-4 text-center ${
                totals.totalSavings >= 0
                  ? 'bg-blue-50 dark:bg-blue-900/20'
                  : 'bg-orange-50 dark:bg-orange-900/20'
              }`}>
                <div className={`text-sm ${
                  totals.totalSavings >= 0
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-orange-600 dark:text-orange-400'
                }`}>
                  Total Savings
                </div>
                <div className={`text-xl font-bold ${
                  totals.totalSavings >= 0
                    ? 'text-blue-700 dark:text-blue-300'
                    : 'text-orange-700 dark:text-orange-300'
                }`}>
                  {formatCurrency(totals.totalSavings)}
                </div>
              </div>
              <div className={`rounded-lg p-4 text-center ${
                totals.savingsRate >= 0
                  ? 'bg-purple-50 dark:bg-purple-900/20'
                  : 'bg-orange-50 dark:bg-orange-900/20'
              }`}>
                <div className={`text-sm ${
                  totals.savingsRate >= 0
                    ? 'text-purple-600 dark:text-purple-400'
                    : 'text-orange-600 dark:text-orange-400'
                }`}>
                  Savings Rate
                </div>
                <div className={`text-xl font-bold ${
                  totals.savingsRate >= 0
                    ? 'text-purple-700 dark:text-purple-300'
                    : 'text-orange-700 dark:text-orange-300'
                }`}>
                  {totals.savingsRate.toFixed(1)}%
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
