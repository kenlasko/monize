'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';
import { format, subMonths, startOfMonth, endOfMonth } from 'date-fns';
import { transactionsApi } from '@/lib/transactions';
import { categoriesApi } from '@/lib/categories';
import { Transaction } from '@/types/transaction';
import { Category } from '@/types/category';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';

const DEFAULT_COLOURS = [
  '#3b82f6', '#22c55e', '#f97316', '#8b5cf6', '#ec4899',
  '#14b8a6', '#eab308', '#ef4444', '#6366f1', '#06b6d4',
];

type DateRange = '1m' | '3m' | '6m' | '1y' | 'ytd' | 'custom';

export function SpendingByCategoryReport() {
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [dateRange, setDateRange] = useState<DateRange>('3m');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [viewType, setViewType] = useState<'pie' | 'bar'>('pie');

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

      const [txData, catData] = await Promise.all([
        transactionsApi.getAll({ startDate: start, endDate: end, limit: 10000 }),
        categoriesApi.getAll(),
      ]);
      setTransactions(txData.data);
      setCategories(catData);
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
    const categoryMap = new Map<string, { id: string; name: string; value: number; colour: string }>();
    let uncategorizedTotal = 0;
    const categoryLookup = new Map(categories.map((c) => [c.id, c]));

    transactions.forEach((tx) => {
      if (tx.isTransfer) return;
      const txAmount = Number(tx.amount) || 0;
      if (txAmount >= 0) return;
      const expenseAmount = Math.abs(txAmount);

      if (tx.isSplit && tx.splits && tx.splits.length > 0) {
        tx.splits.forEach((split) => {
          const splitAmt = Number(split.amount) || 0;
          if (splitAmt >= 0) return;
          const splitAmount = Math.abs(splitAmt);
          if (split.categoryId && split.category) {
            const cat = categoryLookup.get(split.categoryId) || split.category;
            const parentCat = cat.parentId ? categoryLookup.get(cat.parentId) : null;
            const displayCat = parentCat || cat;
            const existing = categoryMap.get(displayCat.id);
            if (existing) {
              existing.value += splitAmount;
            } else {
              categoryMap.set(displayCat.id, {
                id: displayCat.id,
                name: displayCat.name,
                value: splitAmount,
                colour: displayCat.color || '',
              });
            }
          } else {
            uncategorizedTotal += splitAmount;
          }
        });
      } else if (tx.categoryId && tx.category) {
        const cat = categoryLookup.get(tx.categoryId) || tx.category;
        const parentCat = cat.parentId ? categoryLookup.get(cat.parentId) : null;
        const displayCat = parentCat || cat;
        const existing = categoryMap.get(displayCat.id);
        if (existing) {
          existing.value += expenseAmount;
        } else {
          categoryMap.set(displayCat.id, {
            id: displayCat.id,
            name: displayCat.name,
            value: expenseAmount,
            colour: displayCat.color || '',
          });
        }
      } else {
        uncategorizedTotal += expenseAmount;
      }
    });

    if (uncategorizedTotal > 0) {
      categoryMap.set('uncategorized', {
        id: '',
        name: 'Uncategorized',
        value: uncategorizedTotal,
        colour: '#9ca3af',
      });
    }

    const data = Array.from(categoryMap.values())
      .sort((a, b) => b.value - a.value)
      .slice(0, 15);

    let colourIndex = 0;
    data.forEach((item) => {
      if (!item.colour) {
        item.colour = DEFAULT_COLOURS[colourIndex % DEFAULT_COLOURS.length];
        colourIndex++;
      }
    });

    return data;
  }, [transactions, categories]);

  const totalExpenses = chartData.reduce((sum, item) => sum + item.value, 0);

  const handleCategoryClick = (categoryId: string) => {
    if (categoryId) {
      const { start, end } = dateRange === 'custom'
        ? { start: startDate, end: endDate }
        : getDateRange(dateRange);
      router.push(`/transactions?categoryId=${categoryId}&startDate=${start}&endDate=${end}`);
    }
  };

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: { id: string; name: string; value: number } }> }) => {
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
          <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded" />
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
          <div className="flex gap-2">
            <button
              onClick={() => setViewType('pie')}
              className={`p-2 rounded-md transition-colors ${
                viewType === 'pie'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
              title="Pie Chart"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />
              </svg>
            </button>
            <button
              onClick={() => setViewType('bar')}
              className={`p-2 rounded-md transition-colors ${
                viewType === 'bar'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
              title="Bar Chart"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
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
            No expense data for this period.
          </p>
        ) : (
          <>
            {viewType === 'pie' ? (
              <div className="h-96">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={chartData}
                      cx="50%"
                      cy="50%"
                      innerRadius={80}
                      outerRadius={140}
                      paddingAngle={2}
                      dataKey="value"
                      cursor="pointer"
                      onClick={(data) => data.id && handleCategoryClick(data.id)}
                    >
                      {chartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.colour} />
                      ))}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-96">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} layout="vertical" margin={{ left: 100 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis type="number" tickFormatter={(value) => formatCurrency(value)} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={100} />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar
                      dataKey="value"
                      cursor="pointer"
                      onClick={(data) => data.id && handleCategoryClick(data.id)}
                    >
                      {chartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.colour} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Legend */}
            <div className="mt-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {chartData.map((item, index) => {
                const percentage = ((item.value / totalExpenses) * 100).toFixed(1);
                return (
                  <button
                    key={index}
                    onClick={() => handleCategoryClick(item.id)}
                    className={`flex items-center gap-2 p-2 rounded-md text-left ${
                      item.id ? 'hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer' : ''
                    }`}
                    disabled={!item.id}
                  >
                    <div
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: item.colour }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {item.name}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {formatCurrency(item.value)} ({percentage}%)
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Total */}
            <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 text-center">
              <div className="text-sm text-gray-500 dark:text-gray-400">Total Expenses</div>
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
