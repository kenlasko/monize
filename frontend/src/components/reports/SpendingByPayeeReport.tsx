'use client';

import { useState, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useRouter } from 'next/navigation';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { PayeeSpendingItem } from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { useReportData } from '@/hooks/useReportData';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ChartViewToggle } from '@/components/ui/ChartViewToggle';
import { chartColors, chartSeriesColor } from '@/lib/chart-colors';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { ReportError } from '@/components/reports/ReportError';
import { exportToCsv } from '@/lib/csv-export';
import type { ChartDatum } from '@/types/chart';

type SpendingPayeeSortField = 'name' | 'value' | 'percentage';

type ChartDataItem = ChartDatum & { id: string };

export function SpendingByPayeeReport() {
  const t = useTranslations('reports');
  const router = useRouter();
  const chartRef = useRef<HTMLDivElement>(null);
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const [viewType, setViewType] = useState<'bar' | 'table'>('bar');
  const { dateRange, setDateRange, startDate, setStartDate, endDate, setEndDate, resolvedRange, isValid } =
    useDateRange({ defaultRange: '3m' });
  const { sortField, sortDirection, handleSort } = useSortableTable<SpendingPayeeSortField>(
    'reports.spending-by-payee.table.sort',
    { field: 'value', direction: 'desc' },
  );

  const { start: rangeStart, end: rangeEnd } = resolvedRange;

  const { data: response, isLoading, error, reload } = useReportData(
    () =>
      isValid
        ? builtInReportsApi.getSpendingByPayee({
            startDate: rangeStart || undefined,
            endDate: rangeEnd,
          })
        : Promise.resolve(null),
    [isValid, rangeStart, rangeEnd],
  );

  const chartData = useMemo<ChartDataItem[]>(
    () =>
      (response?.data ?? []).map((item: PayeeSpendingItem) => ({
        id: item.payeeId || '',
        name: item.payeeName,
        value: item.total,
      })),
    [response],
  );

  const totalExpenses = response?.totalSpending ?? 0;

  const sortedTableData = useMemo(() => {
    const sorted = [...chartData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = compareValues(a.name, b.name);
          break;
        case 'value':
          comparison = compareValues(a.value, b.value);
          break;
        case 'percentage': {
          const pa = totalExpenses > 0 ? (a.value / totalExpenses) * 100 : 0;
          const pb = totalExpenses > 0 ? (b.value / totalExpenses) * 100 : 0;
          comparison = compareValues(pa, pb);
          break;
        }
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [chartData, sortField, sortDirection, totalExpenses]);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    await exportToPdf({
      title: t('spendingByPayee.pdfTitle'),
      chartContainer: chartRef.current,
      filename: 'spending-by-payee',
    });
  };

  const handleExportCsv = () => {
    const headers = [
      t('spendingByPayee.csvColPayee'),
      t('spendingByPayee.csvColAmount'),
      t('spendingByPayee.csvColPercentage'),
    ];
    const rows = sortedTableData.map((item) => {
      const percentage = totalExpenses > 0 ? (item.value / totalExpenses) * 100 : 0;
      return [item.name, item.value, `${percentage.toFixed(2)}%`];
    });
    exportToCsv('spending-by-payee', headers, rows);
  };

  const handlePayeeClick = (payeeId: string) => {
    if (payeeId) {
      const { start, end } = resolvedRange;
      router.push(`/transactions?payeeId=${payeeId}&startDate=${start}&endDate=${end}`);
    }
  };

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: { name: string; value: number } }> }) => {
    if (!active || !payload || !payload.length) return null;
    const data = payload[0].payload;
    const percentage = totalExpenses > 0 ? ((data.value / totalExpenses) * 100).toFixed(1) : '0';
    return (
      <ChartTooltipPanel>
        <p className="font-medium text-gray-900 dark:text-gray-100">{data.name}</p>
        <p className="text-gray-600 dark:text-gray-400">
          {formatCurrency(data.value)} ({percentage}%)
        </p>
      </ChartTooltipPanel>
    );
  };

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <DateRangeSelector
            ranges={['1m', '3m', '6m', '1y', 'ytd']}
            value={dateRange}
            onChange={setDateRange}
            showCustom
            customStartDate={startDate}
            onCustomStartDateChange={setStartDate}
            customEndDate={endDate}
            onCustomEndDateChange={setEndDate}
          />
          <div className="flex items-center gap-4">
            <ChartViewToggle
              value={viewType}
              onChange={(v) => setViewType(v as 'bar' | 'table')}
              options={['bar', 'table']}
            />
            <ExportDropdown
              onExportPdf={handleExportPdf}
              onExportCsv={handleExportCsv}
              disabled={chartData.length === 0}
            />
          </div>
        </div>
      </div>

      {/* Chart */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        {chartData.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('spendingByPayee.noData')}
          </p>
        ) : viewType === 'table' ? (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <SortableHeader<SpendingPayeeSortField>
                      field="name"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      {t('spendingByPayee.colPayee')}
                    </SortableHeader>
                    <SortableHeader<SpendingPayeeSortField>
                      field="value"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      {t('spendingByPayee.colAmount')}
                    </SortableHeader>
                    <SortableHeader<SpendingPayeeSortField>
                      field="percentage"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      {t('spendingByPayee.colPctOfTotal')}
                    </SortableHeader>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {sortedTableData.map((item, idx) => {
                    const percentage = totalExpenses > 0 ? (item.value / totalExpenses) * 100 : 0;
                    return (
                      <tr
                        key={item.id || item.name}
                        className={`${item.id ? 'cursor-pointer' : ''} hover:bg-gray-50 dark:hover:bg-gray-700/50`}
                        onClick={() => item.id && handlePayeeClick(item.id)}
                      >
                        <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                          <div className="flex items-center gap-2">
                            <div
                              className="w-3 h-3 rounded-full flex-shrink-0"
                              style={{ backgroundColor: chartSeriesColor(idx) }}
                            />
                            {item.name}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                          {formatCurrency(item.value)}
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-gray-600 dark:text-gray-400">
                          {percentage.toFixed(1)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <td className="px-4 py-3 text-sm font-bold text-gray-900 dark:text-gray-100">
                      {t('spendingByPayee.totalTopPayees', { count: chartData.length })}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-bold text-gray-900 dark:text-gray-100">
                      {formatCurrency(totalExpenses)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-bold text-gray-900 dark:text-gray-100">100%</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        ) : (
          <>
            <div className="h-[500px]">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                  <XAxis
                    type="number"
                    tickFormatter={formatCurrencyAxis}
                  />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={90} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar
                    dataKey="value"
                    cursor="pointer"
                    onClick={(data) => data.id && handlePayeeClick(data.id)}
                    radius={[0, 4, 4, 0]}
                  >
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={chartSeriesColor(index)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Total */}
            <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 text-center">
              <div className="text-sm text-gray-500 dark:text-gray-400">
                {t('spendingByPayee.totalTopPayees', { count: chartData.length })}
              </div>
              <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {formatCurrency(totalExpenses)}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
