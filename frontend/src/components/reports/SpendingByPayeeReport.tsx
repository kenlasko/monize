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
  Cell,
} from 'recharts';
import { format, subMonths, startOfMonth } from 'date-fns';
import { transactionsApi } from '@/lib/transactions';
import { Transaction } from '@/types/transaction';

const COLOURS = [
  '#3b82f6', '#22c55e', '#f97316', '#8b5cf6', '#ec4899',
  '#14b8a6', '#eab308', '#ef4444', '#6366f1', '#06b6d4',
];

type DateRange = '1m' | '3m' | '6m' | '1y' | 'ytd' | 'custom';

export function SpendingByPayeeReport() {
  const router = useRouter();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [dateRange, setDateRange] = useState<DateRange>('3m');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [showTop, setShowTop] = useState(15);

  const getDateRange = useCallback((range: DateRange): { start: string; end: string } => {
    const now = new Date();
    const end = format(now, 'yyyy-MM-dd');
    let start: string;

    switch (range) {
      case '1m':
        start = format(subMonths(now, 1), 'yyyy-MM-dd');
        break;
      case '3m':
        start = format(subMonths(now, 3), 'yyyy-MM-dd');
        break;
      case '6m':
        start = format(subMonths(now, 6), 'yyyy-MM-dd');
        break;
      case '1y':
        start = format(subMonths(now, 12), 'yyyy-MM-dd');
        break;
      case 'ytd':
        start = format(startOfMonth(new Date(now.getFullYear(), 0, 1)), 'yyyy-MM-dd');
        break;
      default:
        start = startDate || format(subMonths(now, 3), 'yyyy-MM-dd');
    }

    return { start, end };
  }, [startDate]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const { start, end } = dateRange === 'custom'
        ? { start: startDate, end: endDate }
        : getDateRange(dateRange);

      const txData = await transactionsApi.getAll({ startDate: start, endDate: end, limit: 10000 });
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
    const payeeMap = new Map<string, { id: string; name: string; value: number }>();

    transactions.forEach((tx) => {
      if (tx.isTransfer) return;
      const txAmount = Number(tx.amount) || 0;
      if (txAmount >= 0) return;
      const expenseAmount = Math.abs(txAmount);

      const payeeName = tx.payee?.name || tx.payeeName || 'Unknown';
      const payeeId = tx.payeeId || '';

      const existing = payeeMap.get(payeeName);
      if (existing) {
        existing.value += expenseAmount;
      } else {
        payeeMap.set(payeeName, {
          id: payeeId,
          name: payeeName,
          value: expenseAmount,
        });
      }
    });

    return Array.from(payeeMap.values())
      .sort((a, b) => b.value - a.value)
      .slice(0, showTop);
  }, [transactions, showTop]);

  const totalExpenses = chartData.reduce((sum, item) => sum + item.value, 0);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: 'CAD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const handlePayeeClick = (payeeId: string) => {
    if (payeeId) {
      const { start, end } = dateRange === 'custom'
        ? { start: startDate, end: endDate }
        : getDateRange(dateRange);
      router.push(`/transactions?payeeId=${payeeId}&startDate=${start}&endDate=${end}`);
    }
  };

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: { name: string; value: number } }> }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      const percentage = ((data.value / totalExpenses) * 100).toFixed(1);
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100">{data.name}</p>
          <p className="text-gray-600 dark:text-gray-400">
            {formatCurrency(data.value)} ({percentage}%)
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
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex flex-wrap gap-2">
            {(['1m', '3m', '6m', '1y', 'ytd'] as DateRange[]).map((range) => (
              <button
                key={range}
                onClick={() => setDateRange(range)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  dateRange === range
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {range === 'ytd' ? 'YTD' : range.toUpperCase()}
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
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600 dark:text-gray-400">Show top:</label>
            <select
              value={showTop}
              onChange={(e) => setShowTop(Number(e.target.value))}
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm"
            >
              <option value={10}>10</option>
              <option value={15}>15</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
            </select>
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
            No expense data for this period.
          </p>
        ) : (
          <>
            <div className="h-[500px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ left: 120, right: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis
                    type="number"
                    tickFormatter={(value) => `$${value >= 1000 ? `${(value / 1000).toFixed(0)}k` : value}`}
                  />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={120} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar
                    dataKey="value"
                    cursor="pointer"
                    onClick={(data) => handlePayeeClick(data.id)}
                    radius={[0, 4, 4, 0]}
                  >
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLOURS[index % COLOURS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Total */}
            <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 text-center">
              <div className="text-sm text-gray-500 dark:text-gray-400">
                Total (Top {chartData.length} Payees)
              </div>
              <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {formatCurrency(totalExpenses)}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
