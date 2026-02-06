'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { SpendingAnomaly, SpendingAnomaliesResponse } from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { createLogger } from '@/lib/logger';

const logger = createLogger('SpendingAnomaliesReport');

export function SpendingAnomaliesReport() {
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [anomaliesData, setAnomaliesData] = useState<SpendingAnomaliesResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [threshold, setThreshold] = useState(2); // Standard deviations

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const data = await builtInReportsApi.getSpendingAnomalies(threshold);
        setAnomaliesData(data);
      } catch (error) {
        logger.error('Failed to load data:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [threshold]);

  const handleTransactionClick = (anomaly: SpendingAnomaly) => {
    if (anomaly.transactionId && anomaly.payeeName) {
      router.push(`/transactions?search=${encodeURIComponent(anomaly.payeeName)}`);
    }
  };

  const handleCategoryClick = (categoryId: string | undefined) => {
    if (categoryId && categoryId !== 'uncategorized') {
      router.push(`/transactions?categoryId=${categoryId}`);
    }
  };

  const getSeverityStyles = (severity: SpendingAnomaly['severity']) => {
    switch (severity) {
      case 'high':
        return 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800';
      case 'medium':
        return 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800';
      case 'low':
        return 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800';
    }
  };

  const getSeverityBadge = (severity: SpendingAnomaly['severity']) => {
    switch (severity) {
      case 'high':
        return 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400';
      case 'medium':
        return 'bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-400';
      case 'low':
        return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-400';
    }
  };

  const getTypeIcon = (type: SpendingAnomaly['type']) => {
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

  const anomalies = anomaliesData?.anomalies ?? [];
  const counts = anomaliesData?.counts ?? { high: 0, medium: 0, low: 0 };

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
          <div className="text-sm text-red-600 dark:text-red-400">High Priority</div>
          <div className="text-2xl font-bold text-red-700 dark:text-red-300">
            {counts.high}
          </div>
        </div>
        <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-4">
          <div className="text-sm text-orange-600 dark:text-orange-400">Medium Priority</div>
          <div className="text-2xl font-bold text-orange-700 dark:text-orange-300">
            {counts.medium}
          </div>
        </div>
        <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-4">
          <div className="text-sm text-yellow-600 dark:text-yellow-400">Low Priority</div>
          <div className="text-2xl font-bold text-yellow-700 dark:text-yellow-300">
            {counts.low}
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
                anomaly.transactionId || anomaly.categoryId ? 'cursor-pointer hover:opacity-80' : ''
              }`}
              onClick={() => {
                if (anomaly.type === 'category_spike') {
                  handleCategoryClick(anomaly.categoryId);
                } else {
                  handleTransactionClick(anomaly);
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
