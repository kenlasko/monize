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
import { categoriesApi } from '@/lib/categories';
import { Transaction } from '@/types/transaction';
import { Category } from '@/types/category';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';

type DateRange = '3m' | '6m' | '1y' | 'custom';

export function CashFlowReport() {
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [dateRange, setDateRange] = useState<DateRange>('6m');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const getDateRange = useCallback((range: DateRange): { start: string; end: string } => {
    const now = new Date();
    const end = format(endOfMonth(now), 'yyyy-MM-dd');
    let start: string;

    switch (range) {
      case '3m':
        start = format(startOfMonth(subMonths(now, 2)), 'yyyy-MM-dd');
        break;
      case '6m':
        start = format(startOfMonth(subMonths(now, 5)), 'yyyy-MM-dd');
        break;
      case '1y':
        start = format(startOfMonth(subMonths(now, 11)), 'yyyy-MM-dd');
        break;
      default:
        start = startDate || format(startOfMonth(subMonths(now, 5)), 'yyyy-MM-dd');
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
        transactionsApi.getAll({ startDate: start, endDate: end, limit: 50000 }),
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

  const cashFlowData = useMemo(() => {
    const categoryLookup = new Map(categories.map((c) => [c.id, c]));

    // Group by income/expense categories
    const incomeByCategory = new Map<string, { name: string; total: number }>();
    const expenseByCategory = new Map<string, { name: string; total: number }>();

    transactions.forEach((tx) => {
      if (tx.isTransfer) return;
      if (tx.account?.accountType === 'INVESTMENT') return;
      const amount = Number(tx.amount) || 0;

      const processCategory = (catId: string | null, catName: string, amt: number) => {
        const cat = catId ? categoryLookup.get(catId) : null;
        const parentCat = cat?.parentId ? categoryLookup.get(cat.parentId) : null;
        const displayCat = parentCat || cat;
        const name = displayCat?.name || catName || 'Uncategorized';
        const id = displayCat?.id || 'uncategorized';

        if (amt > 0) {
          const existing = incomeByCategory.get(id);
          if (existing) {
            existing.total += amt;
          } else {
            incomeByCategory.set(id, { name, total: amt });
          }
        } else {
          const existing = expenseByCategory.get(id);
          if (existing) {
            existing.total += Math.abs(amt);
          } else {
            expenseByCategory.set(id, { name, total: Math.abs(amt) });
          }
        }
      };

      if (tx.isSplit && tx.splits && tx.splits.length > 0) {
        tx.splits.forEach((split) => {
          if (split.transferAccountId) return;
          const splitAmt = Number(split.amount) || 0;
          processCategory(split.categoryId || null, split.category?.name || '', splitAmt);
        });
      } else {
        processCategory(tx.categoryId || null, tx.category?.name || '', amount);
      }
    });

    const incomeItems = Array.from(incomeByCategory.values())
      .sort((a, b) => b.total - a.total);
    const expenseItems = Array.from(expenseByCategory.values())
      .sort((a, b) => b.total - a.total);

    const totalIncome = incomeItems.reduce((sum, item) => sum + item.total, 0);
    const totalExpenses = expenseItems.reduce((sum, item) => sum + item.total, 0);
    const netCashFlow = totalIncome - totalExpenses;

    return { incomeItems, expenseItems, totalIncome, totalExpenses, netCashFlow };
  }, [transactions, categories]);

  const monthlyData = useMemo(() => {
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
      income: 0,
      expenses: 0,
    }));

    transactions.forEach((tx) => {
      if (tx.isTransfer) return;
      if (tx.account?.accountType === 'INVESTMENT') return;
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
      Net: Math.round(m.income - m.expenses),
    }));
  }, [transactions, dateRange, startDate, endDate, getDateRange]);

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string; payload: { fullName: string } }> }) => {
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
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-6">
          <div className="text-sm text-green-600 dark:text-green-400">Total Inflows</div>
          <div className="text-2xl font-bold text-green-700 dark:text-green-300">
            {formatCurrency(cashFlowData.totalIncome)}
          </div>
        </div>
        <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-6">
          <div className="text-sm text-red-600 dark:text-red-400">Total Outflows</div>
          <div className="text-2xl font-bold text-red-700 dark:text-red-300">
            {formatCurrency(cashFlowData.totalExpenses)}
          </div>
        </div>
        <div className={`rounded-lg p-6 ${
          cashFlowData.netCashFlow >= 0
            ? 'bg-blue-50 dark:bg-blue-900/20'
            : 'bg-orange-50 dark:bg-orange-900/20'
        }`}>
          <div className={`text-sm ${
            cashFlowData.netCashFlow >= 0
              ? 'text-blue-600 dark:text-blue-400'
              : 'text-orange-600 dark:text-orange-400'
          }`}>
            Net Cash Flow
          </div>
          <div className={`text-2xl font-bold ${
            cashFlowData.netCashFlow >= 0
              ? 'text-blue-700 dark:text-blue-300'
              : 'text-orange-700 dark:text-orange-300'
          }`}>
            {cashFlowData.netCashFlow >= 0 ? '+' : ''}{formatCurrency(cashFlowData.netCashFlow)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-2">
          {(['3m', '6m', '1y'] as DateRange[]).map((range) => (
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

      {/* Monthly Chart */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Monthly Cash Flow
        </h3>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthlyData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis
                tickFormatter={(value) => `$${Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(0)}k` : value}`}
                tick={{ fontSize: 12 }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend />
              <ReferenceLine y={0} stroke="#9ca3af" />
              <Bar dataKey="Income" fill="#22c55e" name="Inflows" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Expenses" fill="#ef4444" name="Outflows" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Breakdown Tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Inflows */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 bg-green-50 dark:bg-green-900/20 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-green-700 dark:text-green-300">
              Inflows by Category
            </h3>
          </div>
          <div className="divide-y divide-gray-200 dark:divide-gray-700 max-h-96 overflow-y-auto">
            {cashFlowData.incomeItems.length === 0 ? (
              <p className="px-6 py-4 text-gray-500 dark:text-gray-400">No income in this period</p>
            ) : (
              cashFlowData.incomeItems.map((item, index) => (
                <div key={index} className="px-6 py-3 flex items-center justify-between">
                  <span className="text-gray-900 dark:text-gray-100">{item.name}</span>
                  <span className="font-medium text-green-600 dark:text-green-400">
                    {formatCurrency(item.total)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Outflows */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 bg-red-50 dark:bg-red-900/20 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-red-700 dark:text-red-300">
              Outflows by Category
            </h3>
          </div>
          <div className="divide-y divide-gray-200 dark:divide-gray-700 max-h-96 overflow-y-auto">
            {cashFlowData.expenseItems.length === 0 ? (
              <p className="px-6 py-4 text-gray-500 dark:text-gray-400">No expenses in this period</p>
            ) : (
              cashFlowData.expenseItems.map((item, index) => (
                <div key={index} className="px-6 py-3 flex items-center justify-between">
                  <span className="text-gray-900 dark:text-gray-100">{item.name}</span>
                  <span className="font-medium text-red-600 dark:text-red-400">
                    {formatCurrency(item.total)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
