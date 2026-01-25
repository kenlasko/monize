'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { Transaction } from '@/types/transaction';
import { Category } from '@/types/category';

interface ExpensesPieChartProps {
  transactions: Transaction[];
  categories: Category[];
  isLoading: boolean;
}

// Default colours for categories without a colour
const DEFAULT_COLOURS = [
  '#3b82f6', // blue
  '#22c55e', // green
  '#f97316', // orange
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#14b8a6', // teal
  '#eab308', // yellow
  '#ef4444', // red
  '#6366f1', // indigo
  '#06b6d4', // cyan
  '#84cc16', // lime
  '#f43f5e', // rose
  '#a855f7', // violet
  '#10b981', // emerald
  '#f59e0b', // amber
  '#64748b', // slate
  '#78716c', // stone
  '#71717a', // zinc
  '#737373', // neutral
  '#6b7280', // gray
];

export function ExpensesPieChart({
  transactions,
  categories,
  isLoading,
}: ExpensesPieChartProps) {
  const router = useRouter();

  // Calculate spending by category
  const chartData = useMemo(() => {
    const categoryMap = new Map<string, { id: string; name: string; value: number; colour: string }>();
    let uncategorizedTotal = 0;

    // Build category lookup
    const categoryLookup = new Map(categories.map((c) => [c.id, c]));

    transactions.forEach((tx) => {
      // Only count expenses (negative amounts)
      const txAmount = Number(tx.amount) || 0;
      if (txAmount >= 0) return;
      const expenseAmount = Math.abs(txAmount);

      if (tx.isSplit && tx.splits && tx.splits.length > 0) {
        // Handle split transactions
        tx.splits.forEach((split) => {
          const splitAmt = Number(split.amount) || 0;
          if (splitAmt >= 0) return;
          const splitAmount = Math.abs(splitAmt);
          if (split.categoryId && split.category) {
            const cat = categoryLookup.get(split.categoryId) || split.category;
            const existing = categoryMap.get(split.categoryId);
            if (existing) {
              existing.value += splitAmount;
            } else {
              categoryMap.set(split.categoryId, {
                id: split.categoryId,
                name: cat.name,
                value: splitAmount,
                colour: cat.color || '',
              });
            }
          } else {
            uncategorizedTotal += splitAmount;
          }
        });
      } else if (tx.categoryId && tx.category) {
        // Regular transaction with category
        const cat = categoryLookup.get(tx.categoryId) || tx.category;
        const existing = categoryMap.get(tx.categoryId);
        if (existing) {
          existing.value += expenseAmount;
        } else {
          categoryMap.set(tx.categoryId, {
            id: tx.categoryId,
            name: cat.name,
            value: expenseAmount,
            colour: cat.color || '',
          });
        }
      } else {
        // Uncategorized
        uncategorizedTotal += expenseAmount;
      }
    });

    // Add uncategorized if any
    if (uncategorizedTotal > 0) {
      categoryMap.set('uncategorized', {
        id: '',
        name: 'Uncategorized',
        value: uncategorizedTotal,
        colour: '#9ca3af',
      });
    }

    // Convert to array and sort by value descending
    const data = Array.from(categoryMap.values())
      .sort((a, b) => b.value - a.value)
      .slice(0, 20); // Top 20

    // Assign colours to categories without one
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
      router.push(`/transactions?categoryId=${categoryId}`);
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: 'CAD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: { id: string; name: string; value: number; colour: string } }> }) => {
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
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Expenses by Category
        </h3>
        <div className="h-64 flex items-center justify-center">
          <div className="animate-pulse w-48 h-48 rounded-full bg-gray-200 dark:bg-gray-700" />
        </div>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Expenses by Category
        </h3>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          No expense data for this period.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Expenses by Category
        </h3>
        <span className="text-sm text-gray-500 dark:text-gray-400">Past 30 days</span>
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={80}
              paddingAngle={2}
              dataKey="value"
              cursor="pointer"
              onClick={(data) => handleCategoryClick(data.id)}
            >
              {chartData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.colour} />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 max-h-32 overflow-y-auto flex-grow">
        {chartData.slice(0, 10).map((item, index) => (
          <button
            key={index}
            onClick={() => handleCategoryClick(item.id)}
            className={`flex items-center gap-2 text-sm text-left ${item.id ? 'hover:underline cursor-pointer' : ''}`}
            disabled={!item.id}
          >
            <div
              className="w-3 h-3 rounded-full flex-shrink-0"
              style={{ backgroundColor: item.colour }}
            />
            <span className="text-gray-600 dark:text-gray-400 truncate">{item.name}</span>
          </button>
        ))}
      </div>
      <div className="mt-auto pt-4 border-t border-gray-200 dark:border-gray-700 text-center">
        <div className="text-sm text-gray-500 dark:text-gray-400">Total</div>
        <div className="font-semibold text-gray-900 dark:text-gray-100">
          {formatCurrency(totalExpenses)}
        </div>
      </div>
    </div>
  );
}
