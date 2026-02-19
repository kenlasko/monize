'use client';

import { useMemo, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { CategoryTrendSeries } from '@/types/budget';

interface BudgetCategoryTrendProps {
  data: CategoryTrendSeries[];
  formatCurrency: (amount: number) => string;
}

const CHART_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#f97316',
  '#ec4899',
  '#14b8a6',
  '#6366f1',
];

function CategoryTrendTooltip({
  active,
  payload,
  label,
  formatCurrency,
}: {
  active?: boolean;
  payload?: Array<{
    value: number;
    dataKey: string;
    color: string;
    name: string;
  }>;
  label?: string;
  formatCurrency: (amount: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 max-w-xs">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
        {label}
      </p>
      {payload.map((entry) => (
        <div
          key={entry.dataKey}
          className="flex justify-between gap-4 text-sm"
        >
          <span style={{ color: entry.color }}>{entry.name}</span>
          <span className="font-medium text-gray-700 dark:text-gray-300">
            {formatCurrency(entry.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function BudgetCategoryTrend({
  data,
  formatCurrency,
}: BudgetCategoryTrendProps) {
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(
    () => new Set(data.map((s) => s.categoryId)),
  );

  const chartData = useMemo(() => {
    if (data.length === 0) return [];

    // Collect all months across all series
    const monthSet = new Set<string>();
    for (const series of data) {
      for (const point of series.data) {
        monthSet.add(point.month);
      }
    }

    const months = Array.from(monthSet);

    // Build chart data: one entry per month with each category as a field
    return months.map((month) => {
      const entry: Record<string, unknown> = { month };
      for (const series of data) {
        if (!selectedCategories.has(series.categoryId)) continue;
        const point = series.data.find((p) => p.month === month);
        entry[series.categoryId] = point?.actual ?? 0;
      }
      return entry;
    });
  }, [data, selectedCategories]);

  const toggleCategory = (categoryId: string) => {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  };

  if (data.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Category Trends
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Not enough data to display category trends yet.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        Category Trends
      </h2>

      {/* Category toggles */}
      <div className="flex flex-wrap gap-2 mb-4">
        {data.map((series, idx) => {
          const color = CHART_COLORS[idx % CHART_COLORS.length];
          const isSelected = selectedCategories.has(series.categoryId);
          return (
            <button
              key={series.categoryId}
              onClick={() => toggleCategory(series.categoryId)}
              className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                isSelected
                  ? 'text-white border-transparent'
                  : 'text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-600 bg-transparent'
              }`}
              style={isSelected ? { backgroundColor: color } : undefined}
              data-testid={`category-toggle-${series.categoryId}`}
            >
              {series.categoryName}
            </button>
          );
        })}
      </div>

      {/* Chart */}
      <div className="h-72" data-testid="category-trend-chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 12 }}
              className="text-gray-500"
            />
            <YAxis
              tick={{ fontSize: 12 }}
              className="text-gray-500"
              tickFormatter={(value) => formatCurrency(value)}
            />
            <Tooltip
              content={
                <CategoryTrendTooltip formatCurrency={formatCurrency} />
              }
            />
            <Legend />
            {data.map((series, idx) => {
              if (!selectedCategories.has(series.categoryId)) return null;
              const color = CHART_COLORS[idx % CHART_COLORS.length];
              return (
                <Line
                  key={series.categoryId}
                  type="monotone"
                  dataKey={series.categoryId}
                  stroke={color}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  name={series.categoryName}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Summary table */}
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
              <th className="py-2 pr-4 font-medium">Category</th>
              <th className="py-2 pr-4 font-medium text-right">Avg Budget</th>
              <th className="py-2 pr-4 font-medium text-right">Avg Actual</th>
              <th className="py-2 font-medium text-right">Avg Variance</th>
            </tr>
          </thead>
          <tbody>
            {data.map((series) => {
              const avgBudgeted =
                series.data.length > 0
                  ? series.data.reduce((s, d) => s + d.budgeted, 0) /
                    series.data.length
                  : 0;
              const avgActual =
                series.data.length > 0
                  ? series.data.reduce((s, d) => s + d.actual, 0) /
                    series.data.length
                  : 0;
              const avgVariance = avgActual - avgBudgeted;

              return (
                <tr
                  key={series.categoryId}
                  className="border-b border-gray-100 dark:border-gray-700/50"
                >
                  <td className="py-2 pr-4 text-gray-900 dark:text-gray-100">
                    {series.categoryName}
                  </td>
                  <td className="py-2 pr-4 text-right text-gray-600 dark:text-gray-400">
                    {formatCurrency(avgBudgeted)}
                  </td>
                  <td className="py-2 pr-4 text-right text-gray-600 dark:text-gray-400">
                    {formatCurrency(avgActual)}
                  </td>
                  <td
                    className={`py-2 text-right font-medium ${
                      avgVariance > 0
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-green-600 dark:text-green-400'
                    }`}
                  >
                    {avgVariance > 0 ? '+' : ''}
                    {formatCurrency(avgVariance)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
