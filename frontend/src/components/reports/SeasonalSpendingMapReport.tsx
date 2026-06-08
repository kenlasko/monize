'use client';

import { useState, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { budgetsApi } from '@/lib/budgets';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';

type SeasonalMapSortField = 'category' | 'typical' | `month${number}`;

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
  const t = useTranslations('reports');
  const tc = useTranslations('common');
  const MONTH_LABELS = tc.raw('monthsShort') as string[];
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const [selectedBudgetIdOverride, setSelectedBudgetIdOverride] = useState<string>('');
  const { sortField, sortDirection, handleSort } = useSortableTable<SeasonalMapSortField>(
    'reports.seasonal-spending-map.sort',
    { field: 'typical', direction: 'desc' },
  );

  const {
    data: budgets,
    isLoading: budgetsLoading,
    error: budgetsError,
    reload: reloadBudgets,
  } = useReportData(() => budgetsApi.getAll(), []);

  const budgetList = budgets ?? [];

  // Default selection: the active budget, else the first one. A user choice in
  // the dropdown (tracked via the override) takes precedence over the default.
  const defaultBudgetId =
    budgetList.find((b) => b.isActive)?.id ?? budgetList[0]?.id ?? '';
  const selectedBudgetId = selectedBudgetIdOverride || defaultBudgetId;

  const {
    data: patterns,
    isLoading: patternsLoading,
    error: patternsError,
    reload: reloadPatterns,
  } = useReportData(
    () =>
      selectedBudgetId
        ? budgetsApi.getSeasonalPatterns(selectedBudgetId)
        : Promise.resolve([]),
    [selectedBudgetId],
  );

  const isLoading = budgetsLoading || patternsLoading;
  const error = budgetsError ?? patternsError;
  const reload = () => {
    reloadBudgets();
    reloadPatterns();
  };

  // Build heatmap grid data: categories x months
  const { gridData, globalMax } = useMemo(() => {
    let max = 0;
    const grid = (patterns ?? []).map((pattern) => {
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
  }, [patterns, MONTH_LABELS]);

  const sortedGridData = useMemo(() => {
    const sorted = [...gridData];
    sorted.sort((a, b) => {
      let comparison = 0;
      if (sortField === 'category') {
        comparison = compareValues(a.categoryName, b.categoryName);
      } else if (sortField === 'typical') {
        comparison = compareValues(a.typical, b.typical);
      } else if (sortField.startsWith('month')) {
        const idx = Number(sortField.slice(5));
        comparison = compareValues(a.values[idx] ?? 0, b.values[idx] ?? 0);
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [gridData, sortField, sortDirection]);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const headers = [t('seasonalSpendingMap.pdfColCategory'), ...MONTH_LABELS, t('seasonalSpendingMap.pdfColTypical')];
    const rows = gridData.map((row) => [
      row.categoryName,
      ...row.values.map((v) => {
        if (v === 0) return { text: '--', bgColor: [249, 250, 251] as [number, number, number], textColor: [156, 163, 175] as [number, number, number] };
        const intensity = globalMax > 0 ? v / globalMax : 0;
        let bgColor: [number, number, number];
        let textColor: [number, number, number];
        if (intensity >= 0.8) {
          bgColor = [239, 68, 68];
          textColor = [255, 255, 255];
        } else if (intensity >= 0.6) {
          bgColor = [251, 146, 60];
          textColor = [255, 255, 255];
        } else if (intensity >= 0.4) {
          bgColor = [253, 224, 71];
          textColor = [55, 65, 81];
        } else if (intensity >= 0.2) {
          bgColor = [187, 247, 208];
          textColor = [55, 65, 81];
        } else {
          bgColor = [220, 252, 231];
          textColor = [55, 65, 81];
        }
        return { text: formatCurrency(v), bgColor, textColor };
      }),
      formatCurrency(row.typical),
    ]);
    await exportToPdf({
      title: t('seasonalSpendingMap.pdfTitle'),
      chartContainer: chartRef.current,
      tableData: { headers, rows },
      filename: 'seasonal-spending-map',
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

  if (budgetList.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 text-center">
        <p className="text-gray-500 dark:text-gray-400">
          {t('seasonalSpendingMap.noBudgets')}
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
            onChange={(e) => setSelectedBudgetIdOverride(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            {budgetList.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <div className="ml-auto">
            <ExportDropdown onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {/* Heatmap */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
        {gridData.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('seasonalSpendingMap.noData')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead>
                  <tr>
                    <SortableHeader<SeasonalMapSortField>
                      field="category"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      className="py-2 pr-3 text-xs font-medium text-gray-500 dark:text-gray-400 sticky left-0 bg-white dark:bg-gray-800"
                    >
                      {t('seasonalSpendingMap.colCategory')}
                    </SortableHeader>
                    {MONTH_LABELS.map((month, idx) => (
                      <SortableHeader<SeasonalMapSortField>
                        key={month}
                        field={`month${idx}` as SeasonalMapSortField}
                        sortField={sortField}
                        sortDirection={sortDirection}
                        onSort={handleSort}
                        align="center"
                        className="px-1 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 min-w-[60px]"
                      >
                        {month}
                      </SortableHeader>
                    ))}
                    <SortableHeader<SeasonalMapSortField>
                      field="typical"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="pl-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400"
                    >
                      {t('seasonalSpendingMap.colTypicalPerMonth')}
                    </SortableHeader>
                  </tr>
                </thead>
                <tbody>
                  {sortedGridData.map((row) => (
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
                              title={isHigh
                              ? t('seasonalSpendingMap.highSpendingCellTitle', { categoryName: row.categoryName, month: MONTH_LABELS[monthIdx], amount: formatCurrency(value) })
                              : t('seasonalSpendingMap.highSpendingCellTitleNoHigh', { categoryName: row.categoryName, month: MONTH_LABELS[monthIdx], amount: formatCurrency(value) })
                            }
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
              <span className="font-medium">{t('seasonalSpendingMap.intensityLabel')}</span>
              <div className="flex items-center gap-1">
                <div className="w-4 h-4 rounded bg-green-100 dark:bg-green-900" />
                <span>{t('seasonalSpendingMap.intensityLow')}</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-4 h-4 rounded bg-green-200 dark:bg-green-700" />
                <span>{t('seasonalSpendingMap.intensityBelowAvg')}</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-4 h-4 rounded bg-yellow-300 dark:bg-yellow-500" />
                <span>{t('seasonalSpendingMap.intensityAverage')}</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-4 h-4 rounded bg-orange-400 dark:bg-orange-500" />
                <span>{t('seasonalSpendingMap.intensityAboveAvg')}</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-4 h-4 rounded bg-red-500 dark:bg-red-600" />
                <span>{t('seasonalSpendingMap.intensityHigh')}</span>
              </div>
              <div className="flex items-center gap-1 ml-2">
                <div className="w-4 h-4 rounded ring-2 ring-red-500 dark:ring-red-400 bg-gray-100 dark:bg-gray-700" />
                <span>{t('seasonalSpendingMap.highSpendingMonth')}</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
