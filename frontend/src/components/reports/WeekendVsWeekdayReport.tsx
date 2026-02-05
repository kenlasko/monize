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
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { format, subMonths, isWeekend, getDay, startOfWeek, endOfWeek, eachDayOfInterval } from 'date-fns';
import { transactionsApi } from '@/lib/transactions';
import { categoriesApi } from '@/lib/categories';
import { Transaction } from '@/types/transaction';
import { Category } from '@/types/category';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';

type DateRange = '1m' | '3m' | '6m' | '1y';

interface DaySpending {
  day: string;
  dayIndex: number;
  total: number;
  count: number;
  average: number;
  isWeekend: boolean;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function WeekendVsWeekdayReport() {
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [dateRange, setDateRange] = useState<DateRange>('3m');
  const [isLoading, setIsLoading] = useState(true);
  const [viewType, setViewType] = useState<'comparison' | 'byDay' | 'categories'>('comparison');

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
    }

    return { start, end };
  }, []);

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const { start, end } = getDateRange(dateRange);
        const [txData, catData] = await Promise.all([
          transactionsApi.getAll({ startDate: start, endDate: end, limit: 50000 }),
          categoriesApi.getAll(),
        ]);

        setTransactions(txData.data.filter((tx) => !tx.isTransfer && tx.account?.accountType !== 'INVESTMENT' && Number(tx.amount) < 0));
        setCategories(catData);
      } catch (error) {
        console.error('Failed to load data:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [dateRange, getDateRange]);

  const { weekendTotal, weekdayTotal, weekendCount, weekdayCount, dayData } = useMemo(() => {
    let weekendTotal = 0;
    let weekdayTotal = 0;
    let weekendCount = 0;
    let weekdayCount = 0;
    const dayTotals: number[] = [0, 0, 0, 0, 0, 0, 0];
    const dayCounts: number[] = [0, 0, 0, 0, 0, 0, 0];

    transactions.forEach((tx) => {
      const txDate = parseLocalDate(tx.transactionDate);
      const amount = Math.abs(Number(tx.amount));
      const dayOfWeek = getDay(txDate);

      dayTotals[dayOfWeek] += amount;
      dayCounts[dayOfWeek]++;

      if (isWeekend(txDate)) {
        weekendTotal += amount;
        weekendCount++;
      } else {
        weekdayTotal += amount;
        weekdayCount++;
      }
    });

    const dayData: DaySpending[] = DAY_NAMES.map((day, index) => ({
      day,
      dayIndex: index,
      total: dayTotals[index],
      count: dayCounts[index],
      average: dayCounts[index] > 0 ? dayTotals[index] / dayCounts[index] : 0,
      isWeekend: index === 0 || index === 6,
    }));

    return { weekendTotal, weekdayTotal, weekendCount, weekdayCount, dayData };
  }, [transactions]);

  const categoryComparison = useMemo(() => {
    const weekendByCategory = new Map<string, { name: string; total: number }>();
    const weekdayByCategory = new Map<string, { name: string; total: number }>();
    const categoryLookup = new Map(categories.map((c) => [c.id, c]));

    transactions.forEach((tx) => {
      const txDate = parseLocalDate(tx.transactionDate);
      const amount = Math.abs(Number(tx.amount));
      const cat = tx.categoryId ? categoryLookup.get(tx.categoryId) : null;
      const parentCat = cat?.parentId ? categoryLookup.get(cat.parentId) : null;
      const displayCat = parentCat || cat;
      const categoryId = displayCat?.id || 'uncategorized';
      const categoryName = displayCat?.name || 'Uncategorized';

      const targetMap = isWeekend(txDate) ? weekendByCategory : weekdayByCategory;
      const existing = targetMap.get(categoryId);
      if (existing) {
        existing.total += amount;
      } else {
        targetMap.set(categoryId, { name: categoryName, total: amount });
      }
    });

    // Get all unique categories
    const allCategories = new Set([...weekendByCategory.keys(), ...weekdayByCategory.keys()]);
    const comparison = Array.from(allCategories).map((catId) => {
      const weekend = weekendByCategory.get(catId);
      const weekday = weekdayByCategory.get(catId);
      return {
        categoryId: catId,
        name: weekend?.name || weekday?.name || 'Unknown',
        weekendTotal: weekend?.total || 0,
        weekdayTotal: weekday?.total || 0,
        difference: (weekend?.total || 0) - (weekday?.total || 0),
      };
    });

    return comparison.sort((a, b) => (b.weekendTotal + b.weekdayTotal) - (a.weekendTotal + a.weekdayTotal)).slice(0, 10);
  }, [transactions, categories]);

  const weekendAvg = weekendCount > 0 ? weekendTotal / weekendCount : 0;
  const weekdayAvg = weekdayCount > 0 ? weekdayTotal / weekdayCount : 0;
  const totalSpending = weekendTotal + weekdayTotal;
  const weekendPercent = totalSpending > 0 ? (weekendTotal / totalSpending) * 100 : 0;

  const pieData = [
    { name: 'Weekend', value: weekendTotal, color: '#8b5cf6' },
    { name: 'Weekday', value: weekdayTotal, color: '#3b82f6' },
  ];

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
          <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4">
          <div className="text-sm text-purple-600 dark:text-purple-400">Weekend Spending</div>
          <div className="text-xl font-bold text-purple-700 dark:text-purple-300">
            {formatCurrency(weekendTotal)}
          </div>
          <div className="text-xs text-purple-500 dark:text-purple-400">
            {weekendCount} transactions
          </div>
        </div>
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
          <div className="text-sm text-blue-600 dark:text-blue-400">Weekday Spending</div>
          <div className="text-xl font-bold text-blue-700 dark:text-blue-300">
            {formatCurrency(weekdayTotal)}
          </div>
          <div className="text-xs text-blue-500 dark:text-blue-400">
            {weekdayCount} transactions
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Avg per Weekend Tx</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(weekendAvg)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Avg per Weekday Tx</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(weekdayAvg)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex flex-wrap gap-2">
            {(['1m', '3m', '6m', '1y'] as DateRange[]).map((range) => (
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
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setViewType('comparison')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'comparison'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => setViewType('byDay')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'byDay'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              By Day
            </button>
            <button
              onClick={() => setViewType('categories')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'categories'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              By Category
            </button>
          </div>
        </div>
      </div>

      {transactions.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No expense transactions found for this period.
          </p>
        </div>
      ) : viewType === 'comparison' ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Weekend vs Weekday Split
          </h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={90}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => formatCurrency(Number(value) || 0)} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-col justify-center space-y-4">
              <div className="flex items-center gap-4">
                <div className="w-4 h-4 rounded bg-purple-500" />
                <div className="flex-1">
                  <div className="text-sm text-gray-600 dark:text-gray-400">Weekend (Sat-Sun)</div>
                  <div className="font-medium text-gray-900 dark:text-gray-100">
                    {formatCurrency(weekendTotal)} ({weekendPercent.toFixed(1)}%)
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-4 h-4 rounded bg-blue-500" />
                <div className="flex-1">
                  <div className="text-sm text-gray-600 dark:text-gray-400">Weekday (Mon-Fri)</div>
                  <div className="font-medium text-gray-900 dark:text-gray-100">
                    {formatCurrency(weekdayTotal)} ({(100 - weekendPercent).toFixed(1)}%)
                  </div>
                </div>
              </div>
              <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                {weekendAvg > weekdayAvg ? (
                  <p className="text-sm text-purple-600 dark:text-purple-400">
                    You spend {formatCurrency(weekendAvg - weekdayAvg)} more per transaction on weekends
                  </p>
                ) : (
                  <p className="text-sm text-blue-600 dark:text-blue-400">
                    You spend {formatCurrency(weekdayAvg - weekendAvg)} more per transaction on weekdays
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : viewType === 'byDay' ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Spending by Day of Week
          </h3>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dayData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="day" />
                <YAxis tickFormatter={(value) => `$${value >= 1000 ? `${(value / 1000).toFixed(0)}k` : value}`} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="total" name="Total Spent">
                  {dayData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={entry.isWeekend ? '#8b5cf6' : '#3b82f6'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 grid grid-cols-7 gap-2">
            {dayData.map((day) => (
              <div
                key={day.day}
                className={`text-center p-2 rounded ${
                  day.isWeekend
                    ? 'bg-purple-50 dark:bg-purple-900/20'
                    : 'bg-blue-50 dark:bg-blue-900/20'
                }`}
              >
                <div className="text-xs text-gray-500 dark:text-gray-400">{day.day}</div>
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {day.count}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">txns</div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Category Comparison
          </h3>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={categoryComparison} layout="vertical" margin={{ left: 100 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis type="number" tickFormatter={(value) => `$${value >= 1000 ? `${(value / 1000).toFixed(0)}k` : value}`} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={100} />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                <Bar dataKey="weekendTotal" fill="#8b5cf6" name="Weekend" />
                <Bar dataKey="weekdayTotal" fill="#3b82f6" name="Weekday" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
