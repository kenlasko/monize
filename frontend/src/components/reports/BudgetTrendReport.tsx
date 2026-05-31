'use client';

import { useState, useMemo, useRef } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
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
import { budgetsApi } from '@/lib/budgets';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportError } from '@/components/reports/ReportError';

export function BudgetTrendReport() {
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const [selectedBudgetIdState, setSelectedBudgetId] = useState<string>('');
  const [months, setMonths] = useState(12);

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
    data: trendResponse,
    isLoading: trendLoading,
    error: trendError,
    reload: reloadTrend,
  } = useReportData(
    () =>
      selectedBudgetId
        ? budgetsApi.getTrend(selectedBudgetId, months)
        : Promise.resolve(null),
    [selectedBudgetId, months],
  );

  const trendData = useMemo(() => trendResponse ?? [], [trendResponse]);
  const isLoading = budgetsLoading || trendLoading;
  const error = budgetsError || trendError;
  const reload = () => {
    reloadBudgets();
    reloadTrend();
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const headers = ['Month', 'Budgeted', 'Actual', '% Used'];
    const rows = trendData.map((point) => [
      point.month,
      formatCurrency(point.budgeted),
      formatCurrency(point.actual),
      `${point.percentUsed}%`,
    ]);
    await exportToPdf({
      title: 'Budget Trend',
      chartContainer: chartRef.current,
      chartLegend: [
        { color: '#3b82f6', label: 'Budgeted' },
        { color: '#10b981', label: 'Actual' },
      ],
      tableData: { headers, rows },
      filename: 'budget-trend',
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
          No budgets found. Create a budget to see this report.
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
            <option value={6}>6 Months</option>
            <option value={12}>12 Months</option>
            <option value={24}>24 Months</option>
          </select>
          <div className="ml-auto">
            <ExportDropdown onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {/* Chart */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        {trendData.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No trend data available for this budget yet.
          </p>
        ) : (
          <>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <LineChart data={trendData}>
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
                  <Line
                    type="monotone"
                    dataKey="budgeted"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={{ r: 4 }}
                    name="Budgeted"
                  />
                  <Line
                    type="monotone"
                    dataKey="actual"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={{ r: 4 }}
                    name="Actual"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Summary stats */}
            <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
              {(() => {
                const avgBudgeted = trendData.reduce((s, p) => s + p.budgeted, 0) / trendData.length;
                const avgActual = trendData.reduce((s, p) => s + p.actual, 0) / trendData.length;
                const avgVariance = avgActual - avgBudgeted;
                const improving = trendData.length >= 2 &&
                  trendData[trendData.length - 1].percentUsed < trendData[0].percentUsed;
                return (
                  <>
                    <div className="text-center">
                      <p className="text-xs text-gray-500 dark:text-gray-400">Avg Budgeted</p>
                      <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{formatCurrency(avgBudgeted)}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-gray-500 dark:text-gray-400">Avg Actual</p>
                      <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{formatCurrency(avgActual)}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-gray-500 dark:text-gray-400">Avg Variance</p>
                      <p className={`text-lg font-semibold ${avgVariance > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
                        {avgVariance > 0 ? '+' : ''}{formatCurrency(avgVariance)}
                      </p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-gray-500 dark:text-gray-400">Trend</p>
                      <p className={`text-lg font-semibold ${improving ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {improving ? 'Improving' : 'Worsening'}
                      </p>
                    </div>
                  </>
                );
              })()}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
