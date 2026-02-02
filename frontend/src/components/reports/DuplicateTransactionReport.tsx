'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { format, subMonths, differenceInDays } from 'date-fns';
import { transactionsApi } from '@/lib/transactions';
import { Transaction } from '@/types/transaction';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';

interface DuplicateGroup {
  key: string;
  transactions: Transaction[];
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

type DateRange = '1m' | '3m' | '6m';

export function DuplicateTransactionReport() {
  const router = useRouter();
  const { formatCurrency } = useNumberFormat();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [dateRange, setDateRange] = useState<DateRange>('3m');
  const [isLoading, setIsLoading] = useState(true);
  const [sensitivity, setSensitivity] = useState<'high' | 'medium' | 'low'>('medium');

  const getDateRange = useCallback((range: DateRange): { start: string; end: string } => {
    const now = new Date();
    const end = format(now, 'yyyy-MM-dd');
    let start: string;

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
    }

    return { start, end };
  }, []);

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const { start, end } = getDateRange(dateRange);
        const txData = await transactionsApi.getAll({
          startDate: start,
          endDate: end,
          limit: 50000,
        });

        setTransactions(txData.data.filter((tx) => !tx.isTransfer));
      } catch (error) {
        console.error('Failed to load transactions:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [dateRange, getDateRange]);

  const duplicateGroups = useMemo((): DuplicateGroup[] => {
    const groups: DuplicateGroup[] = [];
    const processed = new Set<string>();

    // Configure sensitivity
    const maxDaysDiff = sensitivity === 'high' ? 3 : sensitivity === 'medium' ? 1 : 0;
    const checkPayee = sensitivity !== 'low';

    // Sort transactions by date
    const sortedTx = [...transactions].sort(
      (a, b) => new Date(a.transactionDate).getTime() - new Date(b.transactionDate).getTime()
    );

    for (let i = 0; i < sortedTx.length; i++) {
      const tx1 = sortedTx[i];
      if (processed.has(tx1.id)) continue;

      const amount1 = Number(tx1.amount);
      const date1 = parseLocalDate(tx1.transactionDate);
      const payee1 = (tx1.payee?.name || tx1.payeeName || '').toLowerCase().trim();

      const matches: Transaction[] = [tx1];

      for (let j = i + 1; j < sortedTx.length; j++) {
        const tx2 = sortedTx[j];
        if (processed.has(tx2.id)) continue;

        const amount2 = Number(tx2.amount);
        const date2 = parseLocalDate(tx2.transactionDate);
        const payee2 = (tx2.payee?.name || tx2.payeeName || '').toLowerCase().trim();

        // Check if dates are within range
        const daysDiff = Math.abs(differenceInDays(date1, date2));
        if (daysDiff > maxDaysDiff) {
          // Since transactions are sorted, no more matches possible
          if (daysDiff > 7) break;
          continue;
        }

        // Check amount match
        if (Math.abs(amount1 - amount2) > 0.01) continue;

        // Check payee match if required
        if (checkPayee && payee1 && payee2 && payee1 !== payee2) continue;

        // Exclude if same transaction (shouldn't happen but just in case)
        if (tx1.id === tx2.id) continue;

        matches.push(tx2);
      }

      if (matches.length > 1) {
        // Mark all as processed
        matches.forEach((m) => processed.add(m.id));

        // Determine confidence based on match quality
        const allSameDate = matches.every(
          (m) => m.transactionDate === matches[0].transactionDate
        );
        const allSamePayee = matches.every(
          (m) =>
            (m.payee?.name || m.payeeName || '').toLowerCase().trim() ===
            (matches[0].payee?.name || matches[0].payeeName || '').toLowerCase().trim()
        );

        let confidence: 'high' | 'medium' | 'low' = 'low';
        let reason = 'Same amount';

        if (allSameDate && allSamePayee) {
          confidence = 'high';
          reason = 'Same date, amount, and payee';
        } else if (allSameDate) {
          confidence = 'medium';
          reason = 'Same date and amount';
        } else if (allSamePayee) {
          confidence = 'medium';
          reason = 'Same payee and amount within ' + maxDaysDiff + ' day(s)';
        } else {
          reason = 'Same amount within ' + maxDaysDiff + ' day(s)';
        }

        groups.push({
          key: `${matches[0].id}-${matches.length}`,
          transactions: matches,
          reason,
          confidence,
        });
      }
    }

    // Sort by confidence then by amount
    const confidenceOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return groups.sort((a, b) => {
      const confDiff = confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
      if (confDiff !== 0) return confDiff;
      return Math.abs(Number(b.transactions[0].amount)) - Math.abs(Number(a.transactions[0].amount));
    });
  }, [transactions, sensitivity]);

  const summary = useMemo(() => {
    const high = duplicateGroups.filter((g) => g.confidence === 'high');
    const medium = duplicateGroups.filter((g) => g.confidence === 'medium');
    const low = duplicateGroups.filter((g) => g.confidence === 'low');

    const potentialSavings = duplicateGroups.reduce((sum, group) => {
      // Count all but one as potential duplicates
      const duplicateCount = group.transactions.length - 1;
      return sum + Math.abs(Number(group.transactions[0].amount)) * duplicateCount;
    }, 0);

    return {
      totalGroups: duplicateGroups.length,
      highCount: high.length,
      mediumCount: medium.length,
      lowCount: low.length,
      potentialSavings,
    };
  }, [duplicateGroups]);

  const handleTransactionClick = (tx: Transaction) => {
    router.push(`/transactions?search=${encodeURIComponent(tx.payee?.name || tx.payeeName || '')}`);
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
          <div className="flex flex-wrap gap-2 items-center">
            {(['1m', '3m', '6m'] as DateRange[]).map((range) => (
              <button
                key={range}
                onClick={() => setDateRange(range)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  dateRange === range
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {range.toUpperCase()}
              </button>
            ))}
          </div>
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
                            {tx.payee?.name || tx.payeeName || 'Unknown'}
                          </span>
                        </div>
                        {tx.description && (
                          <div className="text-sm text-gray-500 dark:text-gray-400 truncate mt-0.5">
                            {tx.description}
                          </div>
                        )}
                        <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                          {tx.account?.name || 'Unknown account'}
                        </div>
                      </div>
                      <div className={`text-sm font-medium ${
                        Number(tx.amount) >= 0
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-red-600 dark:text-red-400'
                      }`}>
                        {formatCurrency(Number(tx.amount))}
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
