'use client';

import { useState, useMemo, useRef } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { budgetsApi } from '@/lib/budgets';
import { BudgetHealthGauge } from '@/components/budgets/BudgetHealthGauge';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportError } from '@/components/reports/ReportError';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useReportData } from '@/hooks/useReportData';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';

function getImpactColor(impact: number): string {
  if (impact > 0) return 'text-green-600 dark:text-green-400';
  if (impact < 0) return 'text-red-600 dark:text-red-400';
  return 'text-gray-500 dark:text-gray-400';
}

function getGroupLabel(group: string | null): string {
  if (group === 'NEED') return 'Need';
  if (group === 'WANT') return 'Want';
  if (group === 'SAVING') return 'Saving';
  return 'Uncategorized';
}

function getGroupColor(group: string | null): string {
  if (group === 'NEED') return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
  if (group === 'WANT') return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300';
  if (group === 'SAVING') return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300';
  return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';
}

type CategoryImpactSortField = 'category' | 'group' | 'percentUsed' | 'impact';

export function BudgetHealthScoreReport() {
  const chartRef = useRef<HTMLDivElement>(null);
  const [selectedBudgetIdState, setSelectedBudgetId] = useState<string>('');
  const { sortField, sortDirection, handleSort } = useSortableTable<CategoryImpactSortField>(
    'reports.budget-health-score.categoryImpact.sort',
    { field: 'impact', direction: 'asc' },
  );

  const {
    data: budgetsData,
    isLoading: budgetsLoading,
    error: budgetsError,
    reload: reloadBudgets,
  } = useReportData(() => budgetsApi.getAll(), []);

  const budgets = useMemo(() => budgetsData ?? [], [budgetsData]);

  // Auto-select the active budget (or first) until the user picks one. Derived
  // during render rather than via setState-in-effect.
  const autoSelectedBudgetId = useMemo(() => {
    const active = budgets.find((b) => b.isActive);
    return active?.id ?? budgets[0]?.id ?? '';
  }, [budgets]);
  const selectedBudgetId = selectedBudgetIdState || autoSelectedBudgetId;

  const {
    data: healthScore,
    isLoading: scoreLoading,
    error: scoreError,
    reload: reloadScore,
  } = useReportData(
    () =>
      selectedBudgetId
        ? budgetsApi.getHealthScore(selectedBudgetId)
        : Promise.resolve(null),
    [selectedBudgetId],
  );

  const isLoading = budgetsLoading || scoreLoading;
  const error = budgetsError || scoreError;
  const reload = () => {
    reloadBudgets();
    reloadScore();
  };

  const sortedCategoryScores = useMemo(() => {
    if (!healthScore) return [];
    const sorted = [...healthScore.categoryScores].sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'category':
          comparison = compareValues(a.categoryName, b.categoryName);
          break;
        case 'group':
          comparison = compareValues(a.categoryGroup, b.categoryGroup);
          break;
        case 'percentUsed':
          comparison = compareValues(a.percentUsed, b.percentUsed);
          break;
        case 'impact':
          comparison = compareValues(a.impact, b.impact);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [healthScore, sortField, sortDirection]);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const headers = ['Category', 'Group', '% Used', 'Score Impact'];
    const rows = healthScore
      ? healthScore.categoryScores
          .sort((a, b) => a.impact - b.impact)
          .map((cat) => [
            cat.categoryName,
            getGroupLabel(cat.categoryGroup),
            `${cat.percentUsed}%`,
            `${cat.impact > 0 ? '+' : ''}${cat.impact}`,
          ])
      : [];
    const scoreColor = healthScore
      ? healthScore.score >= 80 ? '#16a34a' : healthScore.score >= 60 ? '#ca8a04' : '#dc2626'
      : '#111827';
    await exportToPdf({
      title: 'Budget Health Score',
      summaryCards: healthScore ? [
        { label: 'Health Score', value: `${healthScore.score}/100`, color: scoreColor },
      ] : undefined,
      tableData: healthScore ? {
        headers: ['Component', 'Value'],
        rows: [
          ['Base Score', String(healthScore.breakdown.baseScore)],
          ['Over-Budget Deductions', `-${healthScore.breakdown.overBudgetDeductions}`],
          ['Essential Category Penalty', `-${healthScore.breakdown.essentialWeightPenalty}`],
          ['Under-Budget Bonus', `+${healthScore.breakdown.underBudgetBonus}`],
          ['Improving Trend Bonus', `+${healthScore.breakdown.trendBonus}`],
          ['Final Score', String(healthScore.score)],
        ],
      } : undefined,
      additionalTables: rows.length > 0 ? [{
        title: 'Category Impact',
        headers,
        rows,
      }] : undefined,
      filename: 'budget-health-score',
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
          <div className="h-40 w-40 bg-gray-200 dark:bg-gray-700 rounded-full mx-auto" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (budgets.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 text-center">
        <p className="text-gray-500 dark:text-gray-400">
          No budgets found. Create a budget to see your health score.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Budget selector */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center justify-between">
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
          <ExportDropdown onExportPdf={handleExportPdf} />
        </div>
      </div>

      {healthScore && (
        <>
          {/* Gauge */}
          <div ref={chartRef} className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <BudgetHealthGauge score={healthScore.score} />

            {/* Score Breakdown */}
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                Score Breakdown
              </h2>
              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400">Base Score</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {healthScore.breakdown.baseScore}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400">Over-Budget Deductions</span>
                  <span className="font-medium text-red-600 dark:text-red-400">
                    -{healthScore.breakdown.overBudgetDeductions}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400">Essential Category Penalty</span>
                  <span className="font-medium text-red-600 dark:text-red-400">
                    -{healthScore.breakdown.essentialWeightPenalty}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400">Under-Budget Bonus</span>
                  <span className="font-medium text-green-600 dark:text-green-400">
                    +{healthScore.breakdown.underBudgetBonus}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400">Improving Trend Bonus</span>
                  <span className="font-medium text-green-600 dark:text-green-400">
                    +{healthScore.breakdown.trendBonus}
                  </span>
                </div>
                <div className="pt-2 border-t border-gray-200 dark:border-gray-700 flex justify-between text-sm font-semibold">
                  <span className="text-gray-900 dark:text-gray-100">Final Score</span>
                  <span className="text-gray-900 dark:text-gray-100">{healthScore.score}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Per-Category Impact */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              Category Impact
            </h2>
            {healthScore.categoryScores.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No categories to evaluate.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      <SortableHeader<CategoryImpactSortField>
                        field="category"
                        sortField={sortField}
                        sortDirection={sortDirection}
                        onSort={handleSort}
                        className="py-2 pr-4 text-left font-medium text-gray-500 dark:text-gray-400"
                      >
                        Category
                      </SortableHeader>
                      <SortableHeader<CategoryImpactSortField>
                        field="group"
                        sortField={sortField}
                        sortDirection={sortDirection}
                        onSort={handleSort}
                        className="py-2 pr-4 text-left font-medium text-gray-500 dark:text-gray-400"
                      >
                        Group
                      </SortableHeader>
                      <SortableHeader<CategoryImpactSortField>
                        field="percentUsed"
                        sortField={sortField}
                        sortDirection={sortDirection}
                        onSort={handleSort}
                        align="right"
                        className="py-2 pr-4 font-medium text-gray-500 dark:text-gray-400"
                      >
                        % Used
                      </SortableHeader>
                      <SortableHeader<CategoryImpactSortField>
                        field="impact"
                        sortField={sortField}
                        sortDirection={sortDirection}
                        onSort={handleSort}
                        align="right"
                        className="py-2 font-medium text-gray-500 dark:text-gray-400"
                      >
                        Score Impact
                      </SortableHeader>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCategoryScores.map((cat) => (
                        <tr key={cat.categoryId} className="border-b border-gray-100 dark:border-gray-700/50">
                          <td className="py-2 pr-4 text-gray-900 dark:text-gray-100">{cat.categoryName}</td>
                          <td className="py-2 pr-4">
                            <span className={`px-2 py-0.5 text-xs font-medium rounded ${getGroupColor(cat.categoryGroup)}`}>
                              {getGroupLabel(cat.categoryGroup)}
                            </span>
                          </td>
                          <td className={`py-2 pr-4 text-right font-medium ${cat.percentUsed > 100 ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'}`}>
                            {cat.percentUsed}%
                          </td>
                          <td className={`py-2 text-right font-medium ${getImpactColor(cat.impact)}`}>
                            {cat.impact > 0 ? '+' : ''}{cat.impact}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
