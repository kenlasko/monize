'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
} from 'recharts';
import { budgetsApi } from '@/lib/budgets';
import type { Budget, BudgetTrendPoint, CategoryTrendSeries } from '@/types/budget';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { BudgetCategoryTrend } from '@/components/budgets/BudgetCategoryTrend';
import { createLogger } from '@/lib/logger';

const logger = createLogger('BudgetVsActualReport');

export function BudgetVsActualReport() {
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [selectedBudgetId, setSelectedBudgetId] = useState<string>('');
  const [months, setMonths] = useState(6);
  const [trendData, setTrendData] = useState<BudgetTrendPoint[]>([]);
  const [categoryData, setCategoryData] = useState<CategoryTrendSeries[]>([]);
  const [viewMode, setViewMode] = useState<'overview' | 'categories'>('overview');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadBudgets = async () => {
      try {
        const data = await budgetsApi.getAll();
        setBudgets(data);
        const active = data.find((b) => b.isActive);
        if (active) {
          setSelectedBudgetId(active.id);
        } else if (data.length > 0) {
          setSelectedBudgetId(data[0].id);
        }
      } catch (error) {
        logger.error('Failed to load budgets:', error);
      }
    };
    loadBudgets();
  }, []);

  const loadReportData = useCallback(async () => {
    if (!selectedBudgetId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const [trend, catTrend] = await Promise.all([
        budgetsApi.getTrend(selectedBudgetId, months),
        budgetsApi.getCategoryTrend(selectedBudgetId, months),
      ]);
      setTrendData(trend);
      setCategoryData(catTrend);
    } catch (error) {
      logger.error('Failed to load report data:', error);
    } finally {
      setIsLoading(false);
    }
  }, [selectedBudgetId, months]);

  useEffect(() => {
    loadReportData();
  }, [loadReportData]);

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

  if (budgets.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 text-center">
        <p className="text-gray-500 dark:text-gray-400">
          No budgets found. Create a budget to see this report.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex items-center gap-3">
            <select
              value={selectedBudgetId}
              onChange={(e) => setSelectedBudgetId(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            >
              {budgets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <select
              value={months}
              onChange={(e) => setMonths(Number(e.target.value))}
              className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            >
              <option value={3}>3 Months</option>
              <option value={6}>6 Months</option>
              <option value={12}>12 Months</option>
              <option value={24}>24 Months</option>
            </select>
          </div>
          <div className="flex gap-1 bg-gray-100 dark:bg-gray-700 rounded-md p-0.5">
            <button
              onClick={() => setViewMode('overview')}
              className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
                viewMode === 'overview'
                  ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm'
                  : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => setViewMode('categories')}
              className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
                viewMode === 'categories'
                  ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm'
                  : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              By Category
            </button>
          </div>
        </div>
      </div>

      {/* Chart */}
      {viewMode === 'overview' ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          {trendData.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">
              No trend data available for this budget yet.
            </p>
          ) : (
            <>
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={trendData}>
                    <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                    <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={(v) => formatCurrency(v)} tick={{ fontSize: 12 }} />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload || payload.length === 0) return null;
                        return (
                          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">{label}</p>
                            {payload.map((entry) => (
                              <p key={entry.dataKey as string} className="text-sm" style={{ color: entry.color }}>
                                {entry.name}: {formatCurrency(entry.value as number)}
                              </p>
                            ))}
                          </div>
                        );
                      }}
                    />
                    <Legend />
                    <Bar dataKey="budgeted" name="Budgeted" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                    <Bar dataKey="actual" name="Actual" fill="#10b981" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Variance line */}
              <div className="mt-6">
                <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Variance Over Time</h3>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={trendData}>
                      <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                      <YAxis tickFormatter={(v) => formatCurrency(v)} tick={{ fontSize: 12 }} />
                      <Tooltip
                        content={({ active, payload, label }) => {
                          if (!active || !payload) return null;
                          const variance = payload[0]?.value as number;
                          return (
                            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{label}</p>
                              <p className={`text-sm font-medium ${variance > 0 ? 'text-red-500' : 'text-green-500'}`}>
                                Variance: {variance > 0 ? '+' : ''}{formatCurrency(variance)}
                              </p>
                            </div>
                          );
                        }}
                      />
                      <Line
                        type="monotone"
                        dataKey="variance"
                        stroke="#f59e0b"
                        strokeWidth={2}
                        dot={{ r: 4 }}
                        name="Variance"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Summary table */}
              <div className="mt-6 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      <th className="py-2 pr-4 text-left font-medium text-gray-500 dark:text-gray-400">Month</th>
                      <th className="py-2 pr-4 text-right font-medium text-gray-500 dark:text-gray-400">Budgeted</th>
                      <th className="py-2 pr-4 text-right font-medium text-gray-500 dark:text-gray-400">Actual</th>
                      <th className="py-2 pr-4 text-right font-medium text-gray-500 dark:text-gray-400">Variance</th>
                      <th className="py-2 text-right font-medium text-gray-500 dark:text-gray-400">% Used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trendData.map((point) => (
                      <tr key={point.month} className="border-b border-gray-100 dark:border-gray-700/50">
                        <td className="py-2 pr-4 text-gray-900 dark:text-gray-100">{point.month}</td>
                        <td className="py-2 pr-4 text-right text-gray-600 dark:text-gray-400">{formatCurrency(point.budgeted)}</td>
                        <td className="py-2 pr-4 text-right text-gray-600 dark:text-gray-400">{formatCurrency(point.actual)}</td>
                        <td className={`py-2 pr-4 text-right font-medium ${point.variance > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
                          {point.variance > 0 ? '+' : ''}{formatCurrency(point.variance)}
                        </td>
                        <td className="py-2 text-right text-gray-600 dark:text-gray-400">{point.percentUsed}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : (
        <BudgetCategoryTrend data={categoryData} formatCurrency={formatCurrency} />
      )}
    </div>
  );
}
