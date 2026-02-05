'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { format, subMonths } from 'date-fns';
import { transactionsApi } from '@/lib/transactions';
import { Transaction } from '@/types/transaction';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';

type DateRange = '1m' | '3m' | '6m' | '1y' | 'all';
type SortField = 'date' | 'amount' | 'payee';
type SortOrder = 'asc' | 'desc';

export function UncategorizedTransactionsReport() {
  const router = useRouter();
  const { formatCurrency } = useNumberFormat();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [dateRange, setDateRange] = useState<DateRange>('3m');
  const [isLoading, setIsLoading] = useState(true);
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [filterType, setFilterType] = useState<'all' | 'income' | 'expense'>('all');

  const getDateRange = useCallback((range: DateRange): { start: string; end: string } => {
    const now = new Date();
    const end = format(now, 'yyyy-MM-dd');
    let start = '';

    switch (range) {
      case '1m':
        start = format(subMonths(now, 1), 'yyyy-MM-dd');
        break;
      case '3m':
        start = format(subMonths(now, 3), 'yyyy-MM-dd');
        break;
      case '6m':
        start = format(subMonths(now, 6), 'yyyy-MM-dd');
        break;
      case '1y':
        start = format(subMonths(now, 12), 'yyyy-MM-dd');
        break;
      case 'all':
        start = '';
        break;
    }

    return { start, end };
  }, []);

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const { start, end } = getDateRange(dateRange);
        const txData = await transactionsApi.getAll({
          startDate: start || undefined,
          endDate: end,
          limit: 50000,
        });

        // Filter to uncategorized, non-transfer, non-investment transactions
        const uncategorized = txData.data.filter(
          (tx) => !tx.isTransfer && tx.account?.accountType !== 'INVESTMENT' && !tx.categoryId && (!tx.isSplit || !tx.splits?.some((s) => s.categoryId))
        );

        setTransactions(uncategorized);
      } catch (error) {
        console.error('Failed to load transactions:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [dateRange, getDateRange]);

  const filteredAndSortedTransactions = useMemo(() => {
    let filtered = [...transactions];

    // Apply type filter
    if (filterType === 'income') {
      filtered = filtered.filter((tx) => Number(tx.amount) > 0);
    } else if (filterType === 'expense') {
      filtered = filtered.filter((tx) => Number(tx.amount) < 0);
    }

    // Apply sort
    filtered.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'date':
          comparison = new Date(a.transactionDate).getTime() - new Date(b.transactionDate).getTime();
          break;
        case 'amount':
          comparison = Math.abs(Number(a.amount)) - Math.abs(Number(b.amount));
          break;
        case 'payee':
          const payeeA = (a.payee?.name || a.payeeName || '').toLowerCase();
          const payeeB = (b.payee?.name || b.payeeName || '').toLowerCase();
          comparison = payeeA.localeCompare(payeeB);
          break;
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return filtered;
  }, [transactions, filterType, sortField, sortOrder]);

  const summary = useMemo(() => {
    const expenses = transactions.filter((tx) => Number(tx.amount) < 0);
    const income = transactions.filter((tx) => Number(tx.amount) > 0);

    return {
      totalCount: transactions.length,
      expenseCount: expenses.length,
      expenseTotal: expenses.reduce((sum, tx) => sum + Math.abs(Number(tx.amount)), 0),
      incomeCount: income.length,
      incomeTotal: income.reduce((sum, tx) => sum + Number(tx.amount), 0),
    };
  }, [transactions]);

  const handleTransactionClick = (tx: Transaction) => {
    router.push(`/transactions?search=${encodeURIComponent(tx.payee?.name || tx.payeeName || tx.description || '')}`);
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return (
        <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
      );
    }
    return sortOrder === 'asc' ? (
      <svg className="h-4 w-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
      </svg>
    ) : (
      <svg className="h-4 w-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    );
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

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
          <div className="flex flex-wrap gap-2">
            {(['1m', '3m', '6m', '1y', 'all'] as DateRange[]).map((range) => (
              <button
                key={range}
                onClick={() => setDateRange(range)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  dateRange === range
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {range === 'all' ? 'All Time' : range.toUpperCase()}
              </button>
            ))}
          </div>
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
      {transactions.length === 0 ? (
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
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Uncategorized Transactions
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Click a transaction to view it in the transactions page
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <th
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('date')}
                  >
                    <div className="flex items-center gap-1">
                      Date
                      <SortIcon field="date" />
                    </div>
                  </th>
                  <th
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('payee')}
                  >
                    <div className="flex items-center gap-1">
                      Payee / Description
                      <SortIcon field="payee" />
                    </div>
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Account
                  </th>
                  <th
                    className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('amount')}
                  >
                    <div className="flex items-center justify-end gap-1">
                      Amount
                      <SortIcon field="amount" />
                    </div>
                  </th>
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
                        {tx.payee?.name || tx.payeeName || 'Unknown'}
                      </div>
                      {tx.description && (
                        <div className="text-gray-500 dark:text-gray-400 truncate max-w-xs">
                          {tx.description}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                      {tx.account?.name || 'Unknown'}
                    </td>
                    <td className={`px-4 py-3 whitespace-nowrap text-sm text-right font-medium ${
                      Number(tx.amount) >= 0
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-red-600 dark:text-red-400'
                    }`}>
                      {formatCurrency(Number(tx.amount))}
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
