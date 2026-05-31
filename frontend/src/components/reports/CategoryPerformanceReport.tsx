'use client';

import { useState, useEffect, useMemo } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { budgetsApi } from '@/lib/budgets';
import type { Budget, CategoryTrendSeries } from '@/types/budget';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportError } from '@/components/reports/ReportError';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { createLogger } from '@/lib/logger';

const logger = createLogger('CategoryPerformanceReport');

type CategoryPerformanceSortField =
  | 'name'
  | 'avgBudgeted'
  | 'avgActual'
  | 'avgPercent'
  | 'variance'
  | 'overCount'
  | 'trend'
  | 'status';

function getTrendArrow(values: number[]): { arrow: string; color: string } {
  if (values.length < 2) return { arrow: '--', color: 'text-gray-400' };

  const recent = values.slice(-3);
  const earlier = values.slice(0, Math.max(1, values.length - 3));
  const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
  const earlierAvg = earlier.reduce((s, v) => s + v, 0) / earlier.length;

  if (earlierAvg === 0) return { arrow: '--', color: 'text-gray-400' };

  const change = ((recentAvg - earlierAvg) / earlierAvg) * 100;

  if (change > 10) return { arrow: 'Up', color: 'text-red-600 dark:text-red-400' };
  if (change < -10) return { arrow: 'Down', color: 'text-green-600 dark:text-green-400' };
  return { arrow: 'Flat', color: 'text-gray-500 dark:text-gray-400' };
}

function getStatusBadge(avgPercent: number): { label: string; className: string } {
  if (avgPercent <= 80) {
    return { label: 'Under Budget', className: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' };
  }
  if (avgPercent <= 100) {
    return { label: 'On Track', className: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300' };
  }
  return { label: 'Over Budget', className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' };
}

export function CategoryPerformanceReport() {
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [selectedBudgetId, setSelectedBudgetId] = useState<string>('');
  const [months, setMonths] = useState(6);
  const { sortField, sortDirection, handleSort } = useSortableTable<CategoryPerformanceSortField>(
    'reports.category-performance.sort',
    { field: 'avgPercent', direction: 'desc' },
  );

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

  const { data: response, isLoading, error, reload } = useReportData(
    () =>
      selectedBudgetId
        ? budgetsApi.getCategoryTrend(selectedBudgetId, months)
        : Promise.resolve<CategoryTrendSeries[]>([]),
    [selectedBudgetId, months],
  );

  const categoryData = useMemo<CategoryTrendSeries[]>(() => response ?? [], [response]);

  const processedData = useMemo(() => {
    return categoryData.map((series) => {
      const monthData = series.data;
      const avgBudgeted = monthData.length > 0
        ? monthData.reduce((s, d) => s + d.budgeted, 0) / monthData.length
        : 0;
      const avgActual = monthData.length > 0
        ? monthData.reduce((s, d) => s + d.actual, 0) / monthData.length
        : 0;
      const avgPercent = avgBudgeted > 0
        ? (avgActual / avgBudgeted) * 100
        : 0;
      const totalVariance = monthData.reduce((s, d) => s + (d.actual - d.budgeted), 0);
      const percentages = monthData.map((d) =>
        d.budgeted > 0 ? (d.actual / d.budgeted) * 100 : 0,
      );
      const trend = getTrendArrow(percentages);
      const status = getStatusBadge(avgPercent);
      const overCount = monthData.filter((d) => d.actual > d.budgeted).length;

      return {
        categoryId: series.categoryId,
        categoryName: series.categoryName,
        avgBudgeted,
        avgActual,
        avgPercent: Math.round(avgPercent * 10) / 10,
        totalVariance,
        trend,
        status,
        overCount,
        monthCount: monthData.length,
        monthData,
      };
    });
  }, [categoryData]);

  const sortedData = useMemo(() => {
    const sorted = [...processedData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = compareValues(a.categoryName, b.categoryName);
          break;
        case 'avgBudgeted':
          comparison = compareValues(a.avgBudgeted, b.avgBudgeted);
          break;
        case 'avgActual':
          comparison = compareValues(a.avgActual, b.avgActual);
          break;
        case 'avgPercent':
          comparison = compareValues(a.avgPercent, b.avgPercent);
          break;
        case 'variance':
          comparison = compareValues(a.totalVariance, b.totalVariance);
          break;
        case 'overCount':
          comparison = compareValues(a.overCount, b.overCount);
          break;
        case 'trend':
          comparison = compareValues(a.trend.arrow, b.trend.arrow);
          break;
        case 'status':
          comparison = compareValues(a.status.label, b.status.label);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [processedData, sortField, sortDirection]);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const headers = ['Category', 'Avg Budget', 'Avg Actual', '% Used', 'Total Variance', 'Over/Total', 'Trend', 'Status'];
    const rows = sortedData.map(row => [
      row.categoryName,
      formatCurrency(row.avgBudgeted),
      formatCurrency(row.avgActual),
      `${row.avgPercent}%`,
      `${row.totalVariance > 0 ? '+' : ''}${formatCurrency(row.totalVariance)}`,
      `${row.overCount}/${row.monthCount}`,
      row.trend.arrow,
      row.status.label,
    ]);
    await exportToPdf({
      title: 'Category Performance',
      tableData: { headers, rows },
      filename: 'category-performance',
    });
  };

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (budgets.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 text-center">
        <p className="text-gray-500 dark:text-gray-400">
          No budgets found. Create a budget to see category performance.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <select
            value={selectedBudgetId}
            onChange={(e) => setSelectedBudgetId(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            {budgets.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
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
          </select>
          <div className="ml-auto">
            <ExportDropdown onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
        {sortedData.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No category data available yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <SortableHeader<CategoryPerformanceSortField>
                    field="name"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="py-2 pr-4 font-medium text-gray-500 dark:text-gray-400"
                  >
                    Category
                  </SortableHeader>
                  <SortableHeader<CategoryPerformanceSortField>
                    field="avgBudgeted"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="py-2 pr-4 font-medium text-gray-500 dark:text-gray-400"
                  >
                    Avg Budget
                  </SortableHeader>
                  <SortableHeader<CategoryPerformanceSortField>
                    field="avgActual"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="py-2 pr-4 font-medium text-gray-500 dark:text-gray-400"
                  >
                    Avg Actual
                  </SortableHeader>
                  <SortableHeader<CategoryPerformanceSortField>
                    field="avgPercent"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="py-2 pr-4 font-medium text-gray-500 dark:text-gray-400"
                  >
                    % Used
                  </SortableHeader>
                  <SortableHeader<CategoryPerformanceSortField>
                    field="variance"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="py-2 pr-4 font-medium text-gray-500 dark:text-gray-400"
                  >
                    Total Variance
                  </SortableHeader>
                  <SortableHeader<CategoryPerformanceSortField>
                    field="overCount"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="center"
                    className="py-2 pr-4 font-medium text-gray-500 dark:text-gray-400"
                  >
                    Over/Total
                  </SortableHeader>
                  <SortableHeader<CategoryPerformanceSortField>
                    field="trend"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="center"
                    className="py-2 pr-4 font-medium text-gray-500 dark:text-gray-400"
                  >
                    Trend
                  </SortableHeader>
                  <SortableHeader<CategoryPerformanceSortField>
                    field="status"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="center"
                    className="py-2 font-medium text-gray-500 dark:text-gray-400"
                  >
                    Status
                  </SortableHeader>
                </tr>
              </thead>
              <tbody>
                {sortedData.map((row) => (
                  <tr key={row.categoryId} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="py-2.5 pr-4 text-gray-900 dark:text-gray-100 font-medium">{row.categoryName}</td>
                    <td className="py-2.5 pr-4 text-right text-gray-600 dark:text-gray-400">{formatCurrency(row.avgBudgeted)}</td>
                    <td className="py-2.5 pr-4 text-right text-gray-600 dark:text-gray-400">{formatCurrency(row.avgActual)}</td>
                    <td className={`py-2.5 pr-4 text-right font-medium ${
                      row.avgPercent > 100 ? 'text-red-600 dark:text-red-400' :
                      row.avgPercent > 80 ? 'text-yellow-600 dark:text-yellow-400' :
                      'text-green-600 dark:text-green-400'
                    }`}>
                      {row.avgPercent}%
                    </td>
                    <td className={`py-2.5 pr-4 text-right font-medium ${
                      row.totalVariance > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'
                    }`}>
                      {row.totalVariance > 0 ? '+' : ''}{formatCurrency(row.totalVariance)}
                    </td>
                    <td className="py-2.5 pr-4 text-center text-gray-600 dark:text-gray-400">
                      {row.overCount}/{row.monthCount}
                    </td>
                    <td className={`py-2.5 pr-4 text-center font-medium ${row.trend.color}`}>
                      {row.trend.arrow}
                    </td>
                    <td className="py-2.5 text-center">
                      <span className={`px-2 py-0.5 text-xs font-medium rounded ${row.status.className}`}>
                        {row.status.label}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
