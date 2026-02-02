'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { format, subMonths, startOfMonth, endOfMonth } from 'date-fns';
import { transactionsApi } from '@/lib/transactions';
import { categoriesApi } from '@/lib/categories';
import { Transaction } from '@/types/transaction';
import { Category } from '@/types/category';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';

interface Anomaly {
  type: 'large_transaction' | 'category_spike' | 'unusual_payee' | 'frequency_change';
  severity: 'high' | 'medium' | 'low';
  title: string;
  description: string;
  amount?: number;
  transaction?: Transaction;
  categoryId?: string;
  categoryName?: string;
  currentPeriodAmount?: number;
  previousPeriodAmount?: number;
  percentChange?: number;
}

export function SpendingAnomaliesReport() {
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [threshold, setThreshold] = useState(2); // Standard deviations

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const now = new Date();
        const startDate = format(subMonths(now, 6), 'yyyy-MM-dd');
        const endDate = format(now, 'yyyy-MM-dd');

        const [txData, catData] = await Promise.all([
          transactionsApi.getAll({ startDate, endDate, limit: 50000 }),
          categoriesApi.getAll(),
        ]);

        setTransactions(txData.data.filter((tx) => !tx.isTransfer));
        setCategories(catData);
      } catch (error) {
        console.error('Failed to load data:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, []);

  const anomalies = useMemo((): Anomaly[] => {
    const results: Anomaly[] = [];

    // Get only expenses
    const expenses = transactions.filter((tx) => Number(tx.amount) < 0);

    // Calculate statistics for transaction amounts
    const amounts = expenses.map((tx) => Math.abs(Number(tx.amount)));
    if (amounts.length < 10) return [];

    const mean = amounts.reduce((sum, a) => sum + a, 0) / amounts.length;
    const variance = amounts.reduce((sum, a) => sum + Math.pow(a - mean, 2), 0) / amounts.length;
    const stdDev = Math.sqrt(variance);

    // 1. Large single transactions
    expenses.forEach((tx) => {
      const amount = Math.abs(Number(tx.amount));
      const zScore = (amount - mean) / stdDev;

      if (zScore > threshold) {
        const severity = zScore > threshold * 2 ? 'high' : zScore > threshold * 1.5 ? 'medium' : 'low';
        results.push({
          type: 'large_transaction',
          severity,
          title: `Unusually large transaction`,
          description: `${tx.payee?.name || tx.payeeName || 'Unknown payee'} - ${format(parseLocalDate(tx.transactionDate), 'MMM d, yyyy')}`,
          amount,
          transaction: tx,
        });
      }
    });

    // 2. Category spending spikes (compare current month to previous months)
    const now = new Date();
    const currentMonthStart = startOfMonth(now);
    const currentMonthEnd = endOfMonth(now);
    const previousMonthStart = startOfMonth(subMonths(now, 1));
    const previousMonthEnd = endOfMonth(subMonths(now, 1));

    const categoryLookup = new Map(categories.map((c) => [c.id, c]));
    const currentMonthByCategory = new Map<string, number>();
    const previousMonthByCategory = new Map<string, number>();

    expenses.forEach((tx) => {
      const txDate = parseLocalDate(tx.transactionDate);
      const amount = Math.abs(Number(tx.amount));
      const categoryId = tx.categoryId || 'uncategorized';

      if (txDate >= currentMonthStart && txDate <= currentMonthEnd) {
        currentMonthByCategory.set(categoryId, (currentMonthByCategory.get(categoryId) || 0) + amount);
      } else if (txDate >= previousMonthStart && txDate <= previousMonthEnd) {
        previousMonthByCategory.set(categoryId, (previousMonthByCategory.get(categoryId) || 0) + amount);
      }
    });

    currentMonthByCategory.forEach((currentAmount, categoryId) => {
      const previousAmount = previousMonthByCategory.get(categoryId) || 0;
      if (previousAmount < 50) return; // Skip if previous spending was minimal

      const percentChange = ((currentAmount - previousAmount) / previousAmount) * 100;

      if (percentChange > 100) {
        const category = categoryLookup.get(categoryId);
        const severity = percentChange > 300 ? 'high' : percentChange > 200 ? 'medium' : 'low';
        results.push({
          type: 'category_spike',
          severity,
          title: `Spending spike in ${category?.name || 'Uncategorized'}`,
          description: `${Math.round(percentChange)}% increase from last month`,
          categoryId,
          categoryName: category?.name || 'Uncategorized',
          currentPeriodAmount: currentAmount,
          previousPeriodAmount: previousAmount,
          percentChange,
        });
      }
    });

    // 3. Unusual/new payees (payees seen for the first time recently)
    const now6MonthsAgo = subMonths(now, 6);
    const now1MonthAgo = subMonths(now, 1);

    const payeeFirstSeen = new Map<string, Date>();
    const sortedExpenses = [...expenses].sort(
      (a, b) => new Date(a.transactionDate).getTime() - new Date(b.transactionDate).getTime()
    );

    sortedExpenses.forEach((tx) => {
      const payeeName = (tx.payee?.name || tx.payeeName || '').toLowerCase().trim();
      if (!payeeName) return;

      if (!payeeFirstSeen.has(payeeName)) {
        payeeFirstSeen.set(payeeName, parseLocalDate(tx.transactionDate));
      }
    });

    // Find new payees with significant spending
    payeeFirstSeen.forEach((firstSeen, payeeName) => {
      if (firstSeen >= now1MonthAgo) {
        const recentTx = expenses.filter(
          (tx) =>
            (tx.payee?.name || tx.payeeName || '').toLowerCase().trim() === payeeName &&
            parseLocalDate(tx.transactionDate) >= now1MonthAgo
        );

        const totalSpent = recentTx.reduce((sum, tx) => sum + Math.abs(Number(tx.amount)), 0);

        if (totalSpent > 100 && recentTx.length > 0) {
          results.push({
            type: 'unusual_payee',
            severity: totalSpent > 500 ? 'high' : totalSpent > 200 ? 'medium' : 'low',
            title: `New payee detected`,
            description: `${recentTx[0].payee?.name || recentTx[0].payeeName} - ${recentTx.length} transaction(s)`,
            amount: totalSpent,
            transaction: recentTx[0],
          });
        }
      }
    });

    // Sort by severity and amount
    const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return results.sort((a, b) => {
      const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
      if (severityDiff !== 0) return severityDiff;
      return (b.amount || 0) - (a.amount || 0);
    });
  }, [transactions, categories, threshold]);

  const handleTransactionClick = (tx: Transaction | undefined) => {
    if (tx) {
      router.push(`/transactions?search=${encodeURIComponent(tx.payee?.name || tx.payeeName || '')}`);
    }
  };

  const handleCategoryClick = (categoryId: string | undefined) => {
    if (categoryId && categoryId !== 'uncategorized') {
      router.push(`/transactions?categoryId=${categoryId}`);
    }
  };

  const getSeverityStyles = (severity: Anomaly['severity']) => {
    switch (severity) {
      case 'high':
        return 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800';
      case 'medium':
        return 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800';
      case 'low':
        return 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800';
    }
  };

  const getSeverityBadge = (severity: Anomaly['severity']) => {
    switch (severity) {
      case 'high':
        return 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400';
      case 'medium':
        return 'bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-400';
      case 'low':
        return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-400';
    }
  };

  const getTypeIcon = (type: Anomaly['type']) => {
    switch (type) {
      case 'large_transaction':
        return (
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
      case 'category_spike':
        return (
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
        );
      case 'unusual_payee':
        return (
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        );
      case 'frequency_change':
        return (
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        );
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
      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
          <div className="text-sm text-red-600 dark:text-red-400">High Priority</div>
          <div className="text-2xl font-bold text-red-700 dark:text-red-300">
            {anomalies.filter((a) => a.severity === 'high').length}
          </div>
        </div>
        <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-4">
          <div className="text-sm text-orange-600 dark:text-orange-400">Medium Priority</div>
          <div className="text-2xl font-bold text-orange-700 dark:text-orange-300">
            {anomalies.filter((a) => a.severity === 'medium').length}
          </div>
        </div>
        <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-4">
          <div className="text-sm text-yellow-600 dark:text-yellow-400">Low Priority</div>
          <div className="text-2xl font-bold text-yellow-700 dark:text-yellow-300">
            {anomalies.filter((a) => a.severity === 'low').length}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex items-center gap-4">
          <label className="text-sm text-gray-700 dark:text-gray-300">
            Sensitivity:
          </label>
          <select
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm"
          >
            <option value={1.5}>High (more anomalies)</option>
            <option value={2}>Medium</option>
            <option value={2.5}>Low (fewer anomalies)</option>
            <option value={3}>Very Low</option>
          </select>
        </div>
      </div>

      {/* Anomalies List */}
      {anomalies.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-center py-8">
            <svg className="h-12 w-12 mx-auto text-green-500 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-gray-500 dark:text-gray-400">
              No spending anomalies detected. Your spending patterns look normal.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {anomalies.map((anomaly, index) => (
            <div
              key={index}
              className={`rounded-lg border p-4 ${getSeverityStyles(anomaly.severity)} ${
                anomaly.transaction || anomaly.categoryId ? 'cursor-pointer hover:opacity-80' : ''
              }`}
              onClick={() => {
                if (anomaly.type === 'category_spike') {
                  handleCategoryClick(anomaly.categoryId);
                } else {
                  handleTransactionClick(anomaly.transaction);
                }
              }}
            >
              <div className="flex items-start gap-4">
                <div className={`p-2 rounded-lg ${getSeverityBadge(anomaly.severity)}`}>
                  {getTypeIcon(anomaly.type)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="font-medium text-gray-900 dark:text-gray-100">
                      {anomaly.title}
                    </h4>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getSeverityBadge(anomaly.severity)}`}>
                      {anomaly.severity}
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                    {anomaly.description}
                  </p>
                  {anomaly.amount !== undefined && (
                    <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 mt-2">
                      {formatCurrency(anomaly.amount)}
                    </p>
                  )}
                  {anomaly.type === 'category_spike' && anomaly.currentPeriodAmount && anomaly.previousPeriodAmount && (
                    <div className="flex gap-4 mt-2 text-sm">
                      <span className="text-gray-600 dark:text-gray-400">
                        Last month: {formatCurrency(anomaly.previousPeriodAmount)}
                      </span>
                      <span className="text-gray-600 dark:text-gray-400">→</span>
                      <span className="text-red-600 dark:text-red-400">
                        This month: {formatCurrency(anomaly.currentPeriodAmount)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
