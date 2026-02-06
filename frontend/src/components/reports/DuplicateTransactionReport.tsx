'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { DuplicateTransactionsResponse, DuplicateGroup, DuplicateTransactionItem } from '@/types/built-in-reports';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { createLogger } from '@/lib/logger';

const logger = createLogger('DuplicateTransactionReport');

export function DuplicateTransactionReport() {
  const router = useRouter();
  const { formatCurrency } = useNumberFormat();
  const [reportData, setReportData] = useState<DuplicateTransactionsResponse | null>(null);
  const { dateRange, setDateRange, resolvedRange } = useDateRange({ defaultRange: '3m', alignment: 'day' });
  const [isLoading, setIsLoading] = useState(true);
  const [sensitivity, setSensitivity] = useState<'high' | 'medium' | 'low'>('medium');

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const { start, end } = resolvedRange;
        const data = await builtInReportsApi.getDuplicateTransactions({
          startDate: start,
          endDate: end,
          sensitivity,
        });
        setReportData(data);
      } catch (error) {
        logger.error('Failed to load data:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [resolvedRange, sensitivity]);

  const handleTransactionClick = (tx: DuplicateTransactionItem) => {
    router.push(`/transactions?search=${encodeURIComponent(tx.payeeName || '')}`);
  };

  const getConfidenceStyles = (confidence: DuplicateGroup['confidence']) => {
    switch (confidence) {
      case 'high':
        return {
          bg: 'bg-red-50 dark:bg-red-900/20',
          border: 'border-red-200 dark:border-red-800',
          badge: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400',
        };
      case 'medium':
        return {
          bg: 'bg-orange-50 dark:bg-orange-900/20',
          border: 'border-orange-200 dark:border-orange-800',
          badge: 'bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-400',
        };
      case 'low':
        return {
          bg: 'bg-yellow-50 dark:bg-yellow-900/20',
          border: 'border-yellow-200 dark:border-yellow-800',
          badge: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-400',
        };
    }
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

  const summary = reportData?.summary || {
    totalGroups: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    potentialSavings: 0,
  };

  const duplicateGroups = reportData?.groups || [];

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Potential Duplicates</div>
          <div className="text-2xl font-bold text-orange-600 dark:text-orange-400">
            {summary.totalGroups}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">groups found</div>
        </div>
        <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
          <div className="text-sm text-red-600 dark:text-red-400">High Confidence</div>
          <div className="text-xl font-bold text-red-700 dark:text-red-300">
            {summary.highCount}
          </div>
        </div>
        <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-4">
          <div className="text-sm text-orange-600 dark:text-orange-400">Medium Confidence</div>
          <div className="text-xl font-bold text-orange-700 dark:text-orange-300">
            {summary.mediumCount}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Potential Impact</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(summary.potentialSavings)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <DateRangeSelector
            ranges={['1m', '3m', '6m']}
            value={dateRange}
            onChange={setDateRange}
          />
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600 dark:text-gray-400">Sensitivity:</span>
            <select
              value={sensitivity}
              onChange={(e) => setSensitivity(e.target.value as 'high' | 'medium' | 'low')}
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm"
            >
              <option value="high">High (±3 days)</option>
              <option value="medium">Medium (±1 day)</option>
              <option value="low">Low (same day only)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Duplicate Groups */}
      {duplicateGroups.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-center py-8">
            <svg className="h-12 w-12 mx-auto text-green-500 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-gray-500 dark:text-gray-400">
              No potential duplicate transactions found. Your records look clean!
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {duplicateGroups.map((group) => {
            const styles = getConfidenceStyles(group.confidence);
            return (
              <div
                key={group.key}
                className={`rounded-lg border ${styles.bg} ${styles.border} overflow-hidden`}
              >
                <div className="px-4 py-3 flex items-center justify-between border-b border-inherit">
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${styles.badge}`}>
                      {group.confidence} confidence
                    </span>
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      {group.reason}
                    </span>
                  </div>
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {group.transactions.length} transactions
                  </span>
                </div>
                <div className="divide-y divide-gray-200 dark:divide-gray-700">
                  {group.transactions.map((tx) => (
                    <div
                      key={tx.id}
                      className="px-4 py-3 flex items-center justify-between hover:bg-white/50 dark:hover:bg-gray-800/50 cursor-pointer"
                      onClick={() => handleTransactionClick(tx)}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3">
                          <span className="text-sm text-gray-500 dark:text-gray-400">
                            {format(parseLocalDate(tx.transactionDate), 'MMM d, yyyy')}
                          </span>
                          <span className="font-medium text-gray-900 dark:text-gray-100 truncate">
                            {tx.payeeName || 'Unknown'}
                          </span>
                        </div>
                        {tx.description && (
                          <div className="text-sm text-gray-500 dark:text-gray-400 truncate mt-0.5">
                            {tx.description}
                          </div>
                        )}
                        <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                          {tx.accountName || 'Unknown account'}
                        </div>
                      </div>
                      <div className={`text-sm font-medium ${
                        tx.amount >= 0
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-red-600 dark:text-red-400'
                      }`}>
                        {formatCurrency(tx.amount)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Info */}
      <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
        <div className="flex gap-3">
          <svg className="h-5 w-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div className="text-sm text-blue-700 dark:text-blue-300">
            <p className="font-medium">How duplicates are detected:</p>
            <ul className="mt-1 list-disc list-inside space-y-0.5">
              <li>High: Same date, amount, and payee</li>
              <li>Medium: Same date and amount, or same payee and amount within a few days</li>
              <li>Low: Same amount within the date range</li>
            </ul>
            <p className="mt-2">
              Click a transaction to view it in the transactions page where you can delete duplicates.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
