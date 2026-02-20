'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { budgetsApi } from '@/lib/budgets';
import type { Budget, SeasonalPattern } from '@/types/budget';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { createLogger } from '@/lib/logger';

const logger = createLogger('SeasonalSpendingMapReport');

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function getHeatColor(value: number, max: number): string {
  if (max === 0 || value === 0) return 'bg-gray-50 dark:bg-gray-800';

  const intensity = value / max;

  if (intensity >= 0.8) return 'bg-red-500 dark:bg-red-600';
  if (intensity >= 0.6) return 'bg-orange-400 dark:bg-orange-500';
  if (intensity >= 0.4) return 'bg-yellow-300 dark:bg-yellow-500';
  if (intensity >= 0.2) return 'bg-green-200 dark:bg-green-700';
  return 'bg-green-100 dark:bg-green-900';
}

function getTextColor(value: number, max: number): string {
  if (max === 0 || value === 0) return 'text-gray-400 dark:text-gray-500';

  const intensity = value / max;
  if (intensity >= 0.6) return 'text-white';
  return 'text-gray-700 dark:text-gray-200';
}

export function SeasonalSpendingMapReport() {
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [selectedBudgetId, setSelectedBudgetId] = useState<string>('');
  const [patterns, setPatterns] = useState<SeasonalPattern[]>([]);
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

  const loadData = useCallback(async () => {
    if (!selectedBudgetId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const data = await budgetsApi.getSeasonalPatterns(selectedBudgetId);
      setPatterns(data);
    } catch (error) {
      logger.error('Failed to load seasonal patterns:', error);
    } finally {
      setIsLoading(false);
    }
  }, [selectedBudgetId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Build heatmap grid data: categories x months
  const { gridData, globalMax } = useMemo(() => {
    let max = 0;
    const grid = patterns.map((pattern) => {
      const monthValues = MONTH_LABELS.map((_, idx) => {
        const monthData = pattern.monthlyAverages.find((m) => m.month === idx + 1);
        const value = monthData?.average ?? 0;
        if (value > max) max = value;
        return value;
      });
      return {
        categoryId: pattern.categoryId,
        categoryName: pattern.categoryName,
        values: monthValues,
        highMonths: pattern.highMonths,
        typical: pattern.typicalMonthlySpend,
      };
    });
    return { gridData: grid, globalMax: max };
  }, [patterns]);

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
          No budgets found. Create a budget to see seasonal spending patterns.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <select
          value={selectedBudgetId}
          onChange={(e) => setSelectedBudgetId(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        >
          {budgets.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      </div>

      {/* Heatmap */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
        {gridData.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            Not enough historical data to display seasonal patterns.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead>
                  <tr>
                    <th className="py-2 pr-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 sticky left-0 bg-white dark:bg-gray-800">
                      Category
                    </th>
                    {MONTH_LABELS.map((month) => (
                      <th
                        key={month}
                        className="px-1 py-2 text-center text-xs font-medium text-gray-500 dark:text-gray-400 min-w-[60px]"
                      >
                        {month}
                      </th>
                    ))}
                    <th className="pl-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400">
                      Typical/Mo
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {gridData.map((row) => (
                    <tr key={row.categoryId} className="border-t border-gray-100 dark:border-gray-700/50">
                      <td className="py-1.5 pr-3 text-xs font-medium text-gray-900 dark:text-gray-100 sticky left-0 bg-white dark:bg-gray-800 whitespace-nowrap max-w-[140px] truncate">
                        {row.categoryName}
                      </td>
                      {row.values.map((value, monthIdx) => {
                        const isHigh = row.highMonths.includes(monthIdx + 1);
                        return (
                          <td key={monthIdx} className="px-1 py-1.5">
                            <div
                              className={`rounded px-1 py-1 text-center text-xs font-medium ${getHeatColor(value, globalMax)} ${getTextColor(value, globalMax)} ${isHigh ? 'ring-2 ring-red-500 dark:ring-red-400' : ''}`}
                              title={`${row.categoryName} - ${MONTH_LABELS[monthIdx]}: ${formatCurrency(value)}${isHigh ? ' (High)' : ''}`}
                            >
                              {value > 0 ? formatCurrency(value) : '--'}
                            </div>
                          </td>
                        );
                      })}
                      <td className="pl-3 py-1.5 text-right text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {formatCurrency(row.typical)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Legend */}
            <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
              <span className="font-medium">Intensity:</span>
              <div className="flex items-center gap-1">
                <div className="w-4 h-4 rounded bg-green-100 dark:bg-green-900" />
                <span>Low</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-4 h-4 rounded bg-green-200 dark:bg-green-700" />
                <span>Below Avg</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-4 h-4 rounded bg-yellow-300 dark:bg-yellow-500" />
                <span>Average</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-4 h-4 rounded bg-orange-400 dark:bg-orange-500" />
                <span>Above Avg</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-4 h-4 rounded bg-red-500 dark:bg-red-600" />
                <span>High</span>
              </div>
              <div className="flex items-center gap-1 ml-2">
                <div className="w-4 h-4 rounded ring-2 ring-red-500 dark:ring-red-400 bg-gray-100 dark:bg-gray-700" />
                <span>High Spending Month</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
