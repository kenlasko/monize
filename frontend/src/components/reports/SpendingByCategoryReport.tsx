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
import { transactionsApi } from '@/lib/transactions';
import { categoriesApi } from '@/lib/categories';
import { Transaction } from '@/types/transaction';
import { Category } from '@/types/category';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { CHART_COLOURS } from '@/lib/chart-colours';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ChartViewToggle } from '@/components/ui/ChartViewToggle';

export function SpendingByCategoryReport() {
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [viewType, setViewType] = useState<'pie' | 'bar'>('pie');
  const { dateRange, setDateRange, startDate, setStartDate, endDate, setEndDate, resolvedRange, isValid } =
    useDateRange({ defaultRange: '3m' });

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const { start, end } = resolvedRange;
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
  }, [resolvedRange]);

  useEffect(() => {
    if (isValid) loadData();
  }, [isValid, loadData]);

  const chartData = useMemo(() => {
    const categoryMap = new Map<string, { id: string; name: string; value: number; colour: string }>();
    let uncategorizedTotal = 0;
    const categoryLookup = new Map(categories.map((c) => [c.id, c]));

    transactions.forEach((tx) => {
      if (tx.isTransfer) return;
      if (tx.account?.accountType === 'INVESTMENT') return;
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
          } else if (!split.transferAccountId) {
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
        item.colour = CHART_COLOURS[colourIndex % CHART_COLOURS.length];
        colourIndex++;
      }
    });

    return data;
  }, [transactions, categories]);

  const totalExpenses = chartData.reduce((sum, item) => sum + item.value, 0);

  const handleCategoryClick = (categoryId: string) => {
    if (categoryId) {
      const { start, end } = resolvedRange;
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
          <DateRangeSelector
            ranges={['1m', '3m', '6m', '1y', 'ytd']}
            value={dateRange}
            onChange={setDateRange}
            showCustom
            customStartDate={startDate}
            onCustomStartDateChange={setStartDate}
            customEndDate={endDate}
            onCustomEndDateChange={setEndDate}
          />
          <ChartViewToggle value={viewType} onChange={setViewType} />
        </div>
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
