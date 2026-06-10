'use client';

import { useState, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useRouter } from 'next/navigation';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import { format } from 'date-fns';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { RecurringExpenseItem } from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { chartSeriesColor } from '@/lib/chart-colors';
import { resolvePdfColor } from '@/components/reports/resolve-pdf-color';
import { exportToCsv } from '@/lib/csv-export';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';

type RecurringSortField = 'payee' | 'category' | 'frequency' | 'count' | 'average' | 'total' | 'lastPaid';

export function RecurringExpensesReport() {
  const t = useTranslations('reports');
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const [minOccurrences, setMinOccurrences] = useState(3);
  const { sortField, sortDirection, handleSort } = useSortableTable<RecurringSortField>(
    'reports.recurring-expenses.sort',
    { field: 'total', direction: 'desc' },
  );

  const { data: recurringData, isLoading, error, reload } = useReportData(
    () => builtInReportsApi.getRecurringExpenses(minOccurrences),
    [minOccurrences],
  );

  const sortedExpenses = useMemo(() => {
    if (!recurringData) return [];
    const sorted = [...recurringData.data].sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'payee':
          comparison = compareValues(a.payeeName, b.payeeName);
          break;
        case 'category':
          comparison = compareValues(a.categoryName, b.categoryName);
          break;
        case 'frequency':
          comparison = compareValues(a.frequency, b.frequency);
          break;
        case 'count':
          comparison = compareValues(a.occurrences, b.occurrences);
          break;
        case 'average':
          comparison = compareValues(a.averageAmount, b.averageAmount);
          break;
        case 'total':
          comparison = compareValues(a.totalAmount, b.totalAmount);
          break;
        case 'lastPaid':
          comparison = compareValues(a.lastTransactionDate, b.lastTransactionDate);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [recurringData, sortField, sortDirection]);

  const chartData = useMemo(() => {
    if (!recurringData) return [];
    return recurringData.data.slice(0, 10).map((item, index) => ({
      ...item,
      color: chartSeriesColor(index),
    }));
  }, [recurringData]);

  const getExportData = () => {
    if (!recurringData) return null;
    const headers = [
      t('recurringExpenses.csvColPayee'),
      t('recurringExpenses.csvColCategory'),
      t('recurringExpenses.csvColFrequency'),
      t('recurringExpenses.csvColCount'),
      t('recurringExpenses.csvColAvgAmount'),
      t('recurringExpenses.csvColSixMonthTotal'),
      t('recurringExpenses.csvColLastPaid'),
    ];
    const rows = recurringData.data.map((e) => [
      e.payeeName,
      e.categoryName,
      e.frequency,
      e.occurrences,
      e.averageAmount,
      e.totalAmount,
      format(new Date(e.lastTransactionDate), 'yyyy-MM-dd'),
    ]);
    return { headers, rows };
  };

  const handleExportCsv = () => {
    const data = getExportData();
    if (!data) return;
    exportToCsv('recurring-expenses', data.headers, data.rows);
  };

  const handleExportPdf = async () => {
    const expData = getExportData();
    if (!expData || !recurringData) return;
    const { exportToPdf } = await import('@/lib/pdf-export');
    await exportToPdf({
      title: t('recurringExpenses.pdfTitle'),
      subtitle: t('recurringExpenses.pdfSubtitle', { count: recurringData.summary.uniquePayees }),
      summaryCards: [
        { label: t('recurringExpenses.recurringExpenses'), value: String(recurringData.summary.uniquePayees), color: '#111827' },
        { label: t('recurringExpenses.sixMonthTotal'), value: formatCurrency(recurringData.summary.totalRecurring), color: '#dc2626' },
        { label: t('recurringExpenses.monthlyEstimate'), value: formatCurrency(recurringData.summary.monthlyEstimate), color: '#ea580c' },
      ],
      chartContainer: chartRef.current,
      chartLegend: chartData.map((item) => ({
        color: resolvePdfColor(item.color),
        label: `${item.payeeName}: ${formatCurrency(item.totalAmount)}`,
      })),
      tableData: { headers: expData.headers, rows: expData.rows },
      filename: 'recurring-expenses',
    });
  };

  const handlePayeeClick = (payeeId: string | null) => {
    if (payeeId) {
      router.push(`/transactions?payeeId=${payeeId}`);
    }
  };

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: RecurringExpenseItem & { color: string } }> }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100">{data.payeeName}</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('recurringExpenses.tooltipTransactions', { count: data.occurrences, frequency: data.frequency })}
          </p>
          <p className="text-sm text-gray-900 dark:text-gray-100 mt-1">
            {t('recurringExpenses.tooltipTotal', { amount: formatCurrency(data.totalAmount) })}
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('recurringExpenses.tooltipAvg', { amount: formatCurrency(data.averageAmount) })}
          </p>
        </div>
      );
    }
    return null;
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

  if (!recurringData) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">
          {t('recurringExpenses.failedToLoad')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('recurringExpenses.recurringExpenses')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {recurringData.summary.uniquePayees}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{t('recurringExpenses.identifiedPayees')}</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('recurringExpenses.sixMonthTotal')}</div>
          <div className="text-xl font-bold text-red-600 dark:text-red-400">
            {formatCurrency(recurringData.summary.totalRecurring)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('recurringExpenses.monthlyEstimate')}</div>
          <div className="text-xl font-bold text-orange-600 dark:text-orange-400">
            {formatCurrency(recurringData.summary.monthlyEstimate)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex items-center gap-3">
          <label className="text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">
            {t('recurringExpenses.minOccurrencesLabel')}
          </label>
          <select
            value={minOccurrences}
            onChange={(e) => setMinOccurrences(Number(e.target.value))}
            className="w-16 rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm"
          >
            <option value={2}>2+</option>
            <option value={3}>3+</option>
            <option value={4}>4+</option>
            <option value={5}>5+</option>
            <option value={6}>6+</option>
          </select>
          <span className="text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
            {t('recurringExpenses.inLast6Months')}
          </span>
          <div className="ml-auto shrink-0">
            <ExportDropdown onExportCsv={handleExportCsv} onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {recurringData.data.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('recurringExpenses.noRecurring', { count: minOccurrences })}
          </p>
        </div>
      ) : (
        <>
          {/* Chart */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              {t('recurringExpenses.top10ChartTitle')}
            </h3>
            <div ref={chartRef} className="h-80">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={120}
                    paddingAngle={2}
                    dataKey="totalAmount"
                    cursor="pointer"
                    onClick={(data) => handlePayeeClick(data.payeeId)}
                  >
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Table */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {t('recurringExpenses.allRecurringTitle')}
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <SortableHeader<RecurringSortField>
                      field="payee"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      {t('recurringExpenses.colPayee')}
                    </SortableHeader>
                    <SortableHeader<RecurringSortField>
                      field="category"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      {t('recurringExpenses.colCategory')}
                    </SortableHeader>
                    <SortableHeader<RecurringSortField>
                      field="frequency"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="center"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      {t('recurringExpenses.colFrequency')}
                    </SortableHeader>
                    <SortableHeader<RecurringSortField>
                      field="count"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="center"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      {t('recurringExpenses.colCount')}
                    </SortableHeader>
                    <SortableHeader<RecurringSortField>
                      field="average"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      {t('recurringExpenses.colAvgAmount')}
                    </SortableHeader>
                    <SortableHeader<RecurringSortField>
                      field="total"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      {t('recurringExpenses.colSixMonthTotal')}
                    </SortableHeader>
                    <SortableHeader<RecurringSortField>
                      field="lastPaid"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      {t('recurringExpenses.colLastPaid')}
                    </SortableHeader>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {sortedExpenses.map((expense, index) => (
                    <tr
                      key={index}
                      className={`hover:bg-gray-50 dark:hover:bg-gray-700/50 ${expense.payeeId ? 'cursor-pointer' : ''}`}
                      onClick={() => handlePayeeClick(expense.payeeId)}
                    >
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                        {expense.payeeName}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                        {expense.categoryName}
                      </td>
                      <td className="px-4 py-3 text-sm text-center">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          expense.frequency === 'Weekly'
                            ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
                            : expense.frequency === 'Bi-weekly'
                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                            : expense.frequency === 'Monthly'
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-400'
                        }`}>
                          {expense.frequency}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-center text-gray-900 dark:text-gray-100">
                        {expense.occurrences}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-gray-900 dark:text-gray-100">
                        {formatCurrency(expense.averageAmount)}
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-medium text-red-600 dark:text-red-400">
                        {formatCurrency(expense.totalAmount)}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-gray-500 dark:text-gray-400">
                        {format(new Date(expense.lastTransactionDate), 'MMM d')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
