'use client';

import { useReportExportMetadata } from '@/hooks/useReportExportMetadata';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useRouter } from 'next/navigation';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { SpendingAnomaly } from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';
import { PartialDataNotice } from '@/components/reports/PartialDataNotice';
import { quoteSearchValue } from '@/lib/search-query';

export function SpendingAnomaliesReport() {
  const { withPdfBasis } = useReportExportMetadata('cash');
  const t = useTranslations('reports');
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency, defaultCurrency } = useNumberFormat();
  const [threshold, setThreshold] = useState(2); // Standard deviations

  const { data: anomaliesData, isLoading, error, reload } = useReportData(
    () => builtInReportsApi.getSpendingAnomalies(threshold),
    [threshold],
  );

  const handleTransactionClick = (anomaly: SpendingAnomaly) => {
    if (anomaly.transactionId && anomaly.payeeName) {
      router.push(
        `/transactions?search=${encodeURIComponent(quoteSearchValue('payee', anomaly.payeeName))}`,
      );
    }
  };

  const handleCategoryClick = (categoryId: string | undefined) => {
    if (categoryId && categoryId !== 'uncategorized') {
      router.push(`/transactions?categoryId=${categoryId}`);
    }
  };

  const getTypeName = (type: SpendingAnomaly['type']): string => {
    switch (type) {
      case 'large_transaction': return t('spendingAnomalies.anomalyLargeTransaction');
      case 'category_spike': return t('spendingAnomalies.anomalyCategorySpike');
      case 'unusual_payee': return t('spendingAnomalies.anomalyUnusualPayee');
      default: return type;
    }
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const anomalies = anomaliesData?.anomalies || [];
    const headers = [
      t('spendingAnomalies.pdfColType'),
      t('spendingAnomalies.pdfColSeverity'),
      t('spendingAnomalies.pdfColTitle'),
      t('spendingAnomalies.pdfColAmount'),
    ];
    const rows = anomalies.map((a) => [
      getTypeName(a.type),
      a.severity.charAt(0).toUpperCase() + a.severity.slice(1),
      a.title,
      a.amount != null ? formatCurrency(a.amount) : '',
    ]);
    const c = anomaliesData?.counts ?? { high: 0, medium: 0, low: 0 };
    await exportToPdf(withPdfBasis({
      title: t('spendingAnomalies.pdfTitle'),
      subtitle: t('spendingAnomalies.pdfSubtitle', { count: threshold }),
      summaryCards: [
        { label: t('spendingAnomalies.highPriority'), value: String(c.high), color: '#dc2626' },
        { label: t('spendingAnomalies.mediumPriority'), value: String(c.medium), color: '#ea580c' },
        { label: t('spendingAnomalies.lowPriority'), value: String(c.low), color: '#ca8a04' },
      ],
      tableData: { headers, rows },
      filename: 'spending-anomalies',
    }));
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

  const anomalies = anomaliesData?.anomalies ?? [];
  const counts = anomaliesData?.counts ?? { high: 0, medium: 0, low: 0 };

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
          <div className="text-sm text-red-600 dark:text-red-400">{t('spendingAnomalies.highPriority')}</div>
          <div className="text-2xl font-bold text-red-700 dark:text-red-300">
            {counts.high}
          </div>
        </div>
        <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-4">
          <div className="text-sm text-orange-600 dark:text-orange-400">{t('spendingAnomalies.mediumPriority')}</div>
          <div className="text-2xl font-bold text-orange-700 dark:text-orange-300">
            {counts.medium}
          </div>
        </div>
        <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-4">
          <div className="text-sm text-yellow-600 dark:text-yellow-400">{t('spendingAnomalies.lowPriority')}</div>
          <div className="text-2xl font-bold text-yellow-700 dark:text-yellow-300">
            {counts.low}
          </div>
        </div>
      </div>

      {/* The statistics, the anomalies and the counts leave out a transaction
          whose currency has no rate, so a quiet result is not the whole answer. */}
      <PartialDataNotice
        missingCurrencies={anomaliesData?.missingCurrencies ?? []}
        excludedCount={anomaliesData?.excludedCount ?? 0}
        displayCurrency={anomaliesData?.currency ?? defaultCurrency}
      />

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        {/* The export is the height of the sensitivity picker beside it, not
            of its own text: `self-stretch` on the box it sits in and `h-full`
            on the button, so the two read as one row of controls. On a phone
            the row wraps and the export takes a line of its own. */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">
            {t('spendingAnomalies.sensitivityLabel')}
          </label>
          <select
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="w-24 rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm"
          >
            <option value={1.5}>{t('spendingAnomalies.sensitivityHigh')}</option>
            <option value={2}>{t('spendingAnomalies.sensitivityMedium')}</option>
            <option value={2.5}>{t('spendingAnomalies.sensitivityLow')}</option>
            <option value={3}>{t('spendingAnomalies.sensitivityVeryLow')}</option>
          </select>
          <ReportToolbarActions onExportPdf={handleExportPdf} />
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
              {t('spendingAnomalies.noAnomalies')}
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
                        {t('spendingAnomalies.lastMonth', { amount: formatCurrency(anomaly.previousPeriodAmount) })}
                      </span>
                      <span className="text-gray-600 dark:text-gray-400">→</span>
                      <span className="text-red-600 dark:text-red-400">
                        {t('spendingAnomalies.thisMonth', { amount: formatCurrency(anomaly.currentPeriodAmount) })}
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
