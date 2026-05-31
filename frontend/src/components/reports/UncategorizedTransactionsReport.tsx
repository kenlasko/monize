'use client';

import { useState, useMemo } from 'react';
import { gainLossColor } from '@/lib/format';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { UncategorizedTransactionItem } from '@/types/built-in-reports';
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

type SortField = 'date' | 'amount' | 'payee' | 'account';

export function UncategorizedTransactionsReport() {
  const router = useRouter();
  const { formatCurrency } = useNumberFormat();
  const { dateRange, setDateRange, resolvedRange, isValid } = useDateRange({ defaultRange: '3m', alignment: 'day' });
  const { sortField, sortDirection, handleSort } = useSortableTable<SortField>(
    'reports.uncategorized-transactions.sort',
    { field: 'date', direction: 'desc' },
  );
  const [filterType, setFilterType] = useState<'all' | 'income' | 'expense'>('all');

  const { start: rangeStart, end: rangeEnd } = resolvedRange;

  const { data: reportData, isLoading, error, reload } = useReportData(
    () =>
      isValid
        ? builtInReportsApi.getUncategorizedTransactions({
            startDate: rangeStart || undefined,
            endDate: rangeEnd,
            limit: 500,
          })
        : Promise.resolve(null),
    [isValid, rangeStart, rangeEnd],
  );

  const filteredAndSortedTransactions = useMemo(() => {
    if (!reportData) return [];

    let filtered = [...reportData.transactions];

    // Apply type filter
    if (filterType === 'income') {
      filtered = filtered.filter((tx) => tx.amount > 0);
    } else if (filterType === 'expense') {
      filtered = filtered.filter((tx) => tx.amount < 0);
    }

    // Apply sort
    filtered.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'date':
          comparison = compareValues(a.transactionDate, b.transactionDate);
          break;
        case 'amount':
          comparison = compareValues(Math.abs(a.amount), Math.abs(b.amount));
          break;
        case 'payee':
          comparison = compareValues((a.payeeName || '').toLowerCase(), (b.payeeName || '').toLowerCase());
          break;
        case 'account':
          comparison = compareValues((a.accountName || '').toLowerCase(), (b.accountName || '').toLowerCase());
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return filtered;
  }, [reportData, filterType, sortField, sortDirection]);

  const handleTransactionClick = (tx: UncategorizedTransactionItem) => {
    const params = new URLSearchParams();
    params.set('categoryIds', 'uncategorized');
    params.set('accountIds', tx.accountId);
    const search = tx.payeeName || tx.description;
    if (search) params.set('search', search);
    router.push(`/transactions?${params.toString()}`);
  };

  const getExportData = () => {
    const headers = ['Date', 'Payee', 'Description', 'Account', 'Amount'];
    const rows = filteredAndSortedTransactions.map((tx) => [
      format(parseLocalDate(tx.transactionDate), 'yyyy-MM-dd'),
      tx.payeeName || 'Unknown',
      tx.description || '',
      tx.accountName || 'Unknown',
      tx.amount,
    ]);
    return { headers, rows };
  };

  const handleExportCsv = () => {
    const { headers, rows } = getExportData();
    exportToCsv('uncategorized-transactions', headers, rows);
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const { headers, rows } = getExportData();
    await exportToPdf({
      title: 'Uncategorized Transactions',
      subtitle: `${filteredAndSortedTransactions.length} transactions`,
      tableData: { headers, rows },
      filename: 'uncategorized-transactions',
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

  const summary = reportData?.summary || {
    totalCount: 0,
    expenseCount: 0,
    expenseTotal: 0,
    incomeCount: 0,
    incomeTotal: 0,
  };

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Uncategorized</div>
          <div className="text-2xl font-bold text-orange-600 dark:text-orange-400">
            {summary.totalCount}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Uncategorized Expenses</div>
          <div className="text-xl font-bold text-red-600 dark:text-red-400">
            {summary.expenseCount}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {formatCurrency(summary.expenseTotal)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Uncategorized Income</div>
          <div className="text-xl font-bold text-green-600 dark:text-green-400">
            {summary.incomeCount}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {formatCurrency(summary.incomeTotal)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Showing</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {filteredAndSortedTransactions.length}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            transactions
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <DateRangeSelector
            ranges={['1m', '3m', '6m', '1y', 'all']}
            value={dateRange}
            onChange={setDateRange}
          />
          <div className="flex gap-2">
            <button
              onClick={() => setFilterType('all')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                filterType === 'all'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              All
            </button>
            <button
              onClick={() => setFilterType('expense')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                filterType === 'expense'
                  ? 'bg-red-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Expenses
            </button>
            <button
              onClick={() => setFilterType('income')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                filterType === 'income'
                  ? 'bg-green-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Income
            </button>
          </div>
        </div>
      </div>

      {/* Transactions Table */}
      {summary.totalCount === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-center py-8">
            <svg className="h-12 w-12 mx-auto text-green-500 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-gray-500 dark:text-gray-400">
              All transactions are categorized. Great job!
            </p>
          </div>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Uncategorized Transactions
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                Click a transaction to view it in the transactions page
              </p>
            </div>
            <ExportDropdown onExportCsv={handleExportCsv} onExportPdf={handleExportPdf} />
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <SortableHeader<SortField>
                    field="date"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Date
                  </SortableHeader>
                  <SortableHeader<SortField>
                    field="payee"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Payee / Description
                  </SortableHeader>
                  <SortableHeader<SortField>
                    field="account"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Account
                  </SortableHeader>
                  <SortableHeader<SortField>
                    field="amount"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Amount
                  </SortableHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {filteredAndSortedTransactions.slice(0, 100).map((tx) => (
                  <tr
                    key={tx.id}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                    onClick={() => handleTransactionClick(tx)}
                  >
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {format(parseLocalDate(tx.transactionDate), 'MMM d, yyyy')}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {tx.payeeName || 'Unknown'}
                      </div>
                      {tx.description && (
                        <div className="text-gray-500 dark:text-gray-400 truncate max-w-xs">
                          {tx.description}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                      {tx.accountName || 'Unknown'}
                    </td>
                    <td className={`px-4 py-3 whitespace-nowrap text-sm text-right font-medium ${
                      gainLossColor(tx.amount)
                    }`}>
                      {formatCurrency(tx.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filteredAndSortedTransactions.length > 100 && (
            <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Showing first 100 of {filteredAndSortedTransactions.length} transactions
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
