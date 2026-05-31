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
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { budgetsApi } from '@/lib/budgets';
import type { HealthScoreHistoryPoint } from '@/types/budget';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportError } from '@/components/reports/ReportError';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useReportData } from '@/hooks/useReportData';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';

type HealthHistorySortField = 'month' | 'score' | 'grade' | 'change';

function getScoreColor(score: number): string {
  if (score >= 80) return '#10b981';
  if (score >= 60) return '#f59e0b';
  if (score >= 40) return '#f97316';
  return '#ef4444';
}

function getScoreGrade(score: number): { label: string; color: string } {
  if (score >= 90) return { label: 'Excellent', color: 'text-green-600 dark:text-green-400' };
  if (score >= 80) return { label: 'Good', color: 'text-green-600 dark:text-green-400' };
  if (score >= 60) return { label: 'Fair', color: 'text-yellow-600 dark:text-yellow-400' };
  if (score >= 40) return { label: 'Poor', color: 'text-orange-600 dark:text-orange-400' };
  return { label: 'Critical', color: 'text-red-600 dark:text-red-400' };
}

export function HealthScoreHistoryReport() {
  const chartRef = useRef<HTMLDivElement>(null);
  const [selectedBudgetIdState, setSelectedBudgetId] = useState<string>('');
  const [months, setMonths] = useState(12);
  const { sortField, sortDirection, handleSort } = useSortableTable<HealthHistorySortField>(
    'reports.health-score-history.sort',
    { field: 'month', direction: 'asc' },
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
    data: historyData,
    isLoading: historyLoading,
    error: historyError,
    reload: reloadHistory,
  } = useReportData(
    () =>
      selectedBudgetId
        ? budgetsApi.getHealthScoreHistory(selectedBudgetId, months)
        : Promise.resolve(null),
    [selectedBudgetId, months],
  );

  const data = useMemo<HealthScoreHistoryPoint[]>(() => historyData ?? [], [historyData]);
  const isLoading = budgetsLoading || historyLoading;
  const error = budgetsError || historyError;
  const reload = () => {
    reloadBudgets();
    reloadHistory();
  };

  const sortedData = useMemo(() => {
    const indexed = data.map((point, idx) => {
      const grade = getScoreGrade(point.score);
      const prev = idx > 0 ? data[idx - 1].score : null;
      const change = prev !== null ? point.score - prev : null;
      return { point, grade, change };
    });
    indexed.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'month':
          comparison = compareValues(a.point.month, b.point.month);
          break;
        case 'score':
          comparison = compareValues(a.point.score, b.point.score);
          break;
        case 'grade':
          comparison = compareValues(a.grade.label, b.grade.label);
          break;
        case 'change':
          comparison = compareValues(a.change, b.change);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return indexed;
  }, [data, sortField, sortDirection]);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const curScore = data.length > 0 ? data[data.length - 1].score : 0;
    const avg = data.length > 0 ? Math.round(data.reduce((s, p) => s + p.score, 0) / data.length) : 0;
    const best = data.length > 0 ? Math.max(...data.map((p) => p.score)) : 0;
    const worst = data.length > 0 ? Math.min(...data.map((p) => p.score)) : 0;
    const up = data.length >= 2 && data[data.length - 1].score > data[0].score;
    const curColor = curScore >= 80 ? '#16a34a' : curScore >= 60 ? '#ca8a04' : '#dc2626';
    await exportToPdf({
      title: 'Health Score History',
      summaryCards: [
        { label: 'Current Score', value: String(curScore), color: curColor },
        { label: 'Average', value: String(avg), color: '#111827' },
        { label: 'Best', value: String(best), color: '#16a34a' },
        { label: 'Worst', value: String(worst), color: '#dc2626' },
        { label: 'Trajectory', value: up ? 'Up' : data.length >= 2 ? 'Down' : '--', color: up ? '#16a34a' : '#dc2626' },
      ],
      chartContainer: chartRef.current,
      additionalTables: data.length > 0 ? [{
        title: 'Score History',
        headers: ['Month', 'Score', 'Grade', 'Change'],
        rows: data.map((point, idx) => {
          const grade = getScoreGrade(point.score);
          const prev = idx > 0 ? data[idx - 1].score : null;
          const change = prev !== null ? point.score - prev : null;
          return [
            point.month,
            String(point.score),
            grade.label,
            change === null ? '--' : change > 0 ? `+${change}` : String(change),
          ];
        }),
      }] : undefined,
      filename: 'health-score-history',
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
          No budgets found. Create a budget to see your health score history.
        </p>
      </div>
    );
  }

  const currentScore = data.length > 0 ? data[data.length - 1].score : 0;
  const avgScore = data.length > 0
    ? Math.round(data.reduce((s, p) => s + p.score, 0) / data.length)
    : 0;
  const bestScore = data.length > 0 ? Math.max(...data.map((p) => p.score)) : 0;
  const worstScore = data.length > 0 ? Math.min(...data.map((p) => p.score)) : 0;
  const improving = data.length >= 2 && data[data.length - 1].score > data[0].score;
  const currentGrade = getScoreGrade(currentScore);

  return (
    <div ref={chartRef} className="space-y-6">
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

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Current Score</p>
          <p className={`text-2xl font-bold ${currentGrade.color}`}>{currentScore}</p>
          <p className={`text-xs ${currentGrade.color}`}>{currentGrade.label}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Average</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{avgScore}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Best</p>
          <p className="text-2xl font-bold text-green-600 dark:text-green-400">{bestScore}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Worst</p>
          <p className="text-2xl font-bold text-red-600 dark:text-red-400">{worstScore}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Trajectory</p>
          <p className={`text-2xl font-bold ${improving ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {improving ? 'Up' : data.length >= 2 ? 'Down' : '--'}
          </p>
        </div>
      </div>

      {/* Chart */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        {data.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No health score history available yet.
          </p>
        ) : (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <LineChart data={data}>
                <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const point = payload[0]?.payload as HealthScoreHistoryPoint | undefined;
                    if (!point) return null;
                    const grade = getScoreGrade(point.score);
                    return (
                      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{label}</p>
                        <p className="text-lg font-bold" style={{ color: getScoreColor(point.score) }}>
                          {point.score} - {grade.label}
                        </p>
                      </div>
                    );
                  }}
                />
                <ReferenceLine y={80} stroke="#10b981" strokeDasharray="3 3" label={{ value: 'Good', position: 'right', fill: '#10b981', fontSize: 11 }} />
                <ReferenceLine y={60} stroke="#f59e0b" strokeDasharray="3 3" label={{ value: 'Fair', position: 'right', fill: '#f59e0b', fontSize: 11 }} />
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke="#6366f1"
                  strokeWidth={3}
                  dot={(props: { cx?: number; cy?: number; payload?: HealthScoreHistoryPoint }) => {
                    const { cx, cy, payload } = props;
                    if (cx == null || cy == null || !payload) return <circle r={0} />;
                    return (
                      <circle
                        key={payload.month}
                        cx={cx}
                        cy={cy}
                        r={5}
                        fill={getScoreColor(payload.score)}
                        stroke="white"
                        strokeWidth={2}
                      />
                    );
                  }}
                  name="Health Score"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* History table */}
      {data.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Score History</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <SortableHeader<HealthHistorySortField>
                    field="month"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="py-2 pr-4 font-medium text-gray-500 dark:text-gray-400"
                  >
                    Month
                  </SortableHeader>
                  <SortableHeader<HealthHistorySortField>
                    field="score"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="py-2 pr-4 font-medium text-gray-500 dark:text-gray-400"
                  >
                    Score
                  </SortableHeader>
                  <SortableHeader<HealthHistorySortField>
                    field="grade"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="center"
                    className="py-2 pr-4 font-medium text-gray-500 dark:text-gray-400"
                  >
                    Grade
                  </SortableHeader>
                  <SortableHeader<HealthHistorySortField>
                    field="change"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="py-2 font-medium text-gray-500 dark:text-gray-400"
                  >
                    Change
                  </SortableHeader>
                </tr>
              </thead>
              <tbody>
                {sortedData.map(({ point, grade, change }) => {
                  return (
                    <tr key={point.month} className="border-b border-gray-100 dark:border-gray-700/50">
                      <td className="py-2 pr-4 text-gray-900 dark:text-gray-100">{point.month}</td>
                      <td className="py-2 pr-4 text-right font-medium" style={{ color: getScoreColor(point.score) }}>
                        {point.score}
                      </td>
                      <td className={`py-2 pr-4 text-center ${grade.color}`}>{grade.label}</td>
                      <td className={`py-2 text-right font-medium ${
                        change === null ? 'text-gray-400' :
                        change > 0 ? 'text-green-600 dark:text-green-400' :
                        change < 0 ? 'text-red-600 dark:text-red-400' :
                        'text-gray-500'
                      }`}>
                        {change === null ? '--' : change > 0 ? `+${change}` : String(change)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
