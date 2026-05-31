'use client';

import { useState, useMemo, useRef } from 'react';
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
} from 'recharts';
import { format } from 'date-fns';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { BillPaymentHistoryResponse } from '@/types/built-in-reports';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { exportToCsv } from '@/lib/csv-export';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';

type BillSortField = 'bill' | 'count' | 'average' | 'total' | 'lastPayment';

export function BillPaymentHistoryReport() {
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const { dateRange, setDateRange, resolvedRange } = useDateRange({ defaultRange: '1y', alignment: 'day' });
  const [viewType, setViewType] = useState<'overview' | 'byBill'>('overview');
  const { sortField, sortDirection, handleSort } = useSortableTable<BillSortField>(
    'reports.bill-payment-history.sort',
    { field: 'total', direction: 'desc' },
  );

  const { start: rangeStart, end: rangeEnd } = resolvedRange;

  const { data: billData, isLoading, error, reload } = useReportData<BillPaymentHistoryResponse | null>(
    () =>
      builtInReportsApi.getBillPaymentHistory({
        startDate: rangeStart,
        endDate: rangeEnd,
      }),
    [rangeStart, rangeEnd],
  );

  const sortedBillPayments = useMemo(() => {
    if (!billData) return [];
    const sorted = [...billData.billPayments];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'bill':
          comparison = compareValues(a.scheduledTransactionName, b.scheduledTransactionName);
          break;
        case 'count':
          comparison = compareValues(a.paymentCount, b.paymentCount);
          break;
        case 'average':
          comparison = compareValues(a.averagePayment, b.averagePayment);
          break;
        case 'total':
          comparison = compareValues(a.totalPaid, b.totalPaid);
          break;
        case 'lastPayment':
          comparison = compareValues(a.lastPaymentDate, b.lastPaymentDate);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [billData, sortField, sortDirection]);

  const handleBillClick = () => {
    router.push('/bills');
  };

  const getExportData = () => {
    if (!billData) return null;
    const headers = ['Bill', 'Payee', 'Payments', 'Average', 'Total Paid', 'Last Payment'];
    const rows = billData.billPayments.map((bp) => [
      bp.scheduledTransactionName,
      bp.payeeName || '',
      bp.paymentCount,
      bp.averagePayment,
      bp.totalPaid,
      bp.lastPaymentDate ? format(parseLocalDate(bp.lastPaymentDate), 'yyyy-MM-dd') : '',
    ]);
    return { headers, rows };
  };

  const handleExportCsv = () => {
    const data = getExportData();
    if (!data) return;
    exportToCsv('bill-payment-history', data.headers, data.rows);
  };

  const handleExportPdf = async () => {
    const data = getExportData();
    if (!data || !billData) return;
    const { exportToPdf } = await import('@/lib/pdf-export');
    await exportToPdf({
      title: 'Bill Payment History',
      subtitle: `${billData.summary.uniqueBills} bills, ${billData.summary.totalPayments} payments`,
      summaryCards: [
        { label: 'Total Paid', value: formatCurrency(billData.summary.totalPaid), color: '#111827' },
        { label: 'Monthly Average', value: formatCurrency(billData.summary.monthlyAverage), color: '#2563eb' },
        { label: 'Bills Paid', value: String(billData.summary.uniqueBills), color: '#111827' },
        { label: 'Total Payments', value: String(billData.summary.totalPayments), color: '#111827' },
      ],
      chartContainer: chartRef.current,
      tableData: { headers: data.headers, rows: data.rows },
      filename: 'bill-payment-history',
    });
  };

  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100">{label}</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {formatCurrency(payload[0].value)}
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

  if (!billData) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">
          Failed to load bill payment history data.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Paid</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(billData.summary.totalPaid)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Monthly Average</div>
          <div className="text-xl font-bold text-blue-600 dark:text-blue-400">
            {formatCurrency(billData.summary.monthlyAverage)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Bills Paid</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {billData.summary.uniqueBills}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">unique bills</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Payments</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {billData.summary.totalPayments}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <DateRangeSelector
            ranges={['6m', '1y', '2y']}
            value={dateRange}
            onChange={setDateRange}
          />
          <div className="flex gap-2 items-center">
            <button
              onClick={() => setViewType('overview')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'overview'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => setViewType('byBill')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'byBill'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              By Bill
            </button>
            <ExportDropdown onExportCsv={handleExportCsv} onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {billData.billPayments.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No bill payments found for this period. Post scheduled transactions to see payment history.
          </p>
        </div>
      ) : viewType === 'overview' ? (
        /* Monthly Overview Chart */
        <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Monthly Bill Payments
          </h3>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart data={billData.monthlyTotals}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={formatCurrencyAxis} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="total" fill="#3b82f6" name="Total Paid" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : (
        /* By Bill Table */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Payment History by Bill
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <SortableHeader<BillSortField>
                    field="bill"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Bill
                  </SortableHeader>
                  <SortableHeader<BillSortField>
                    field="count"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="center"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Payments
                  </SortableHeader>
                  <SortableHeader<BillSortField>
                    field="average"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Average
                  </SortableHeader>
                  <SortableHeader<BillSortField>
                    field="total"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Total Paid
                  </SortableHeader>
                  <SortableHeader<BillSortField>
                    field="lastPayment"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Last Payment
                  </SortableHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {sortedBillPayments.map((bp) => (
                  <tr
                    key={bp.scheduledTransactionId}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                    onClick={handleBillClick}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {bp.scheduledTransactionName}
                      </div>
                      <div className="text-sm text-gray-500 dark:text-gray-400">
                        {bp.payeeName || 'No payee'}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center text-sm text-gray-900 dark:text-gray-100">
                      {bp.paymentCount}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                      {formatCurrency(bp.averagePayment)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      {formatCurrency(bp.totalPaid)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-500 dark:text-gray-400">
                      {bp.lastPaymentDate
                        ? format(parseLocalDate(bp.lastPaymentDate), 'MMM d, yyyy')
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
