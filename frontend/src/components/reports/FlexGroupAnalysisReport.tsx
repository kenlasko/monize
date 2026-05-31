'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { gainLossColor } from '@/lib/format';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { budgetsApi } from '@/lib/budgets';
import type { Budget, FlexGroupStatus } from '@/types/budget';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportError } from '@/components/reports/ReportError';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { createLogger } from '@/lib/logger';

const logger = createLogger('FlexGroupAnalysisReport');

type FlexGroupSortField = 'category' | 'budgeted' | 'spent' | 'remaining' | 'percentUsed';


export function FlexGroupAnalysisReport() {
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [selectedBudgetId, setSelectedBudgetId] = useState<string>('');
  const { sortField, sortDirection, handleSort } = useSortableTable<FlexGroupSortField>(
    'reports.flex-group-analysis.sort',
    { field: 'spent', direction: 'desc' },
  );

  const { data: response, isLoading, error, reload } = useReportData(
    () =>
      selectedBudgetId
        ? budgetsApi.getFlexGroupStatus(selectedBudgetId)
        : Promise.resolve<FlexGroupStatus[]>([]),
    [selectedBudgetId],
  );

  const flexGroups = useMemo<FlexGroupStatus[]>(() => response ?? [], [response]);

  const sortedFlexGroups = useMemo(() => {
    return flexGroups.map((group) => {
      const sortedCategories = [...group.categories];
      sortedCategories.sort((a, b) => {
        let comparison = 0;
        switch (sortField) {
          case 'category':
            comparison = compareValues(a.categoryName, b.categoryName);
            break;
          case 'budgeted':
            comparison = compareValues(a.budgeted, b.budgeted);
            break;
          case 'spent':
            comparison = compareValues(a.spent, b.spent);
            break;
          case 'remaining':
            comparison = compareValues(a.budgeted - a.spent, b.budgeted - b.spent);
            break;
          case 'percentUsed':
            comparison = compareValues(a.percentUsed, b.percentUsed);
            break;
        }
        return sortDirection === 'asc' ? comparison : -comparison;
      });
      return { ...group, categories: sortedCategories };
    });
  }, [flexGroups, sortField, sortDirection]);

  useEffect(() => {
    const loadBudgets = async () => {
      try {
        const budgetList = await budgetsApi.getAll();
        setBudgets(budgetList);
        const active = budgetList.find((b) => b.isActive);
        if (active) {
          setSelectedBudgetId(active.id);
        } else if (budgetList.length > 0) {
          setSelectedBudgetId(budgetList[0].id);
        }
      } catch (error) {
        logger.error('Failed to load budgets:', error);
      }
    };
    loadBudgets();
  }, []);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const headers = ['Group', 'Category', 'Budgeted', 'Spent', 'Remaining', '% Used'];
    const rows = flexGroups.flatMap((group) =>
      group.categories.map((cat) => [
        group.groupName,
        cat.categoryName,
        formatCurrency(cat.budgeted),
        formatCurrency(cat.spent),
        formatCurrency(cat.budgeted - cat.spent),
        `${cat.percentUsed}%`,
      ]),
    );
    await exportToPdf({
      title: 'Flex Group Analysis',
      chartContainer: chartRef.current,
      tableData: { headers, rows },
      filename: 'flex-group-analysis',
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
          No budgets found. Create a budget to see flex group analysis.
        </p>
      </div>
    );
  }

  if (flexGroups.length === 0) {
    return (
      <div className="space-y-6">
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
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 text-center">
          <p className="text-gray-500 dark:text-gray-400">
            No flex groups configured for this budget. Edit the budget to add flex groups.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <select
            value={selectedBudgetId}
            onChange={(e) => setSelectedBudgetId(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            {budgets.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <ExportDropdown onExportPdf={handleExportPdf} />
        </div>
      </div>

      {/* Per-group charts */}
      <div ref={chartRef}>
      {sortedFlexGroups.map((group) => {
        const chartData = group.categories.map((cat) => ({
          name: cat.categoryName,
          spent: cat.spent,
          budgeted: cat.budgeted,
        }));

        return (
          <div key={group.groupName} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {group.groupName}
              </h2>
              <div className="flex items-center gap-3 text-sm">
                <span className="text-gray-500 dark:text-gray-400">
                  {formatCurrency(group.totalSpent)} / {formatCurrency(group.totalBudgeted)}
                </span>
                <span className={`font-medium ${
                  group.percentUsed > 100 ? 'text-red-600 dark:text-red-400' :
                  group.percentUsed > 80 ? 'text-yellow-600 dark:text-yellow-400' :
                  'text-green-600 dark:text-green-400'
                }`}>
                  {group.percentUsed}%
                </span>
              </div>
            </div>

            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={chartData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                  <XAxis
                    type="number"
                    tickFormatter={(v) => formatCurrency(v)}
                    tick={{ fontSize: 12 }}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fontSize: 12 }}
                    width={120}
                  />
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
                  <Bar
                    dataKey="spent"
                    name="Spent"
                    fill="#3b82f6"
                    radius={[0, 4, 4, 0]}
                  />
                  <ReferenceLine
                    x={group.totalBudgeted}
                    stroke="#ef4444"
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    label={{ value: `Limit: ${formatCurrency(group.totalBudgeted)}`, position: 'top', fill: '#ef4444', fontSize: 11 }}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Category breakdown table */}
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    <SortableHeader<FlexGroupSortField>
                      field="category"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      className="py-2 pr-4 font-medium text-gray-500 dark:text-gray-400"
                    >
                      Category
                    </SortableHeader>
                    <SortableHeader<FlexGroupSortField>
                      field="budgeted"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="py-2 pr-4 font-medium text-gray-500 dark:text-gray-400"
                    >
                      Budget
                    </SortableHeader>
                    <SortableHeader<FlexGroupSortField>
                      field="spent"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="py-2 pr-4 font-medium text-gray-500 dark:text-gray-400"
                    >
                      Spent
                    </SortableHeader>
                    <SortableHeader<FlexGroupSortField>
                      field="remaining"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="py-2 pr-4 font-medium text-gray-500 dark:text-gray-400"
                    >
                      Remaining
                    </SortableHeader>
                    <SortableHeader<FlexGroupSortField>
                      field="percentUsed"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="py-2 font-medium text-gray-500 dark:text-gray-400"
                    >
                      % Used
                    </SortableHeader>
                  </tr>
                </thead>
                <tbody>
                  {group.categories.map((cat) => (
                    <tr key={cat.categoryId} className="border-b border-gray-100 dark:border-gray-700/50">
                      <td className="py-2 pr-4 text-gray-900 dark:text-gray-100">{cat.categoryName}</td>
                      <td className="py-2 pr-4 text-right text-gray-600 dark:text-gray-400">{formatCurrency(cat.budgeted)}</td>
                      <td className="py-2 pr-4 text-right text-gray-600 dark:text-gray-400">{formatCurrency(cat.spent)}</td>
                      <td className={`py-2 pr-4 text-right font-medium ${gainLossColor(cat.budgeted - cat.spent)}`}>
                        {formatCurrency(cat.budgeted - cat.spent)}
                      </td>
                      <td className={`py-2 text-right font-medium ${
                        cat.percentUsed > 100 ? 'text-red-600 dark:text-red-400' :
                        cat.percentUsed > 80 ? 'text-yellow-600 dark:text-yellow-400' :
                        'text-green-600 dark:text-green-400'
                      }`}>
                        {cat.percentUsed}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}
