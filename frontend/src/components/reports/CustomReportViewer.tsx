'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { ReportChart } from './ReportChart';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { customReportsApi } from '@/lib/custom-reports';
import {
  CustomReport,
  ReportResult,
  ReportViewType,
  TimeframeType,
  GroupByType,
  TIMEFRAME_LABELS,
  VIEW_TYPE_LABELS,
} from '@/types/custom-report';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { getIconComponent } from '@/components/ui/IconPicker';

interface CustomReportViewerProps {
  reportId: string;
}

export function CustomReportViewer({ reportId }: CustomReportViewerProps) {
  const router = useRouter();
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const [report, setReport] = useState<CustomReport | null>(null);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isExecuting, setIsExecuting] = useState(false);
  const [overrideTimeframe, setOverrideTimeframe] = useState<TimeframeType | ''>('');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');

  const loadReport = useCallback(async () => {
    try {
      const reportData = await customReportsApi.getById(reportId);
      setReport(reportData);
    } catch (error) {
      toast.error('Failed to load report');
      console.error(error);
    }
  }, [reportId]);

  const executeReport = useCallback(async () => {
    if (!report) return;

    setIsExecuting(true);
    try {
      let params: { timeframeType?: TimeframeType; startDate?: string; endDate?: string } = {};

      // Use override timeframe if selected
      if (overrideTimeframe) {
        params.timeframeType = overrideTimeframe;

        // Include custom dates if custom timeframe is selected
        if (overrideTimeframe === TimeframeType.CUSTOM && customStartDate && customEndDate) {
          params.startDate = customStartDate;
          params.endDate = customEndDate;
        }
      }

      const resultData = await customReportsApi.execute(reportId, params);
      setResult(resultData);
    } catch (error) {
      toast.error('Failed to execute report');
      console.error(error);
    } finally {
      setIsExecuting(false);
    }
  }, [reportId, report, overrideTimeframe, customStartDate, customEndDate]);

  useEffect(() => {
    const init = async () => {
      setIsLoading(true);
      await loadReport();
      setIsLoading(false);
    };
    init();
  }, [loadReport]);

  useEffect(() => {
    if (!report) return;

    // Don't auto-execute if custom range is selected but dates are incomplete
    if (overrideTimeframe === TimeframeType.CUSTOM && (!customStartDate || !customEndDate)) {
      return;
    }

    executeReport();
  }, [report, executeReport, overrideTimeframe, customStartDate, customEndDate]);

  const handleDataPointClick = (id: string) => {
    if (!result) return;

    // Navigate to transactions filtered by the clicked item
    const params = new URLSearchParams();
    if (result.timeframe.startDate) {
      params.set('startDate', result.timeframe.startDate);
    }
    if (result.timeframe.endDate) {
      params.set('endDate', result.timeframe.endDate);
    }

    if (result.groupBy === GroupByType.CATEGORY) {
      params.set('categoryId', id);
    } else if (result.groupBy === GroupByType.PAYEE) {
      params.set('payeeId', id);
    }

    router.push(`/transactions?${params.toString()}`);
  };

  const timeframeOptions = [
    { value: '', label: 'Use saved timeframe' },
    ...Object.entries(TIMEFRAME_LABELS).map(([value, label]) => ({ value, label })),
  ];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 dark:text-gray-400">Report not found</p>
        <Button variant="outline" onClick={() => router.push('/reports')} className="mt-4">
          Back to Reports
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.push('/reports')}
              className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              title="Back to Reports"
            >
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            {report.icon && (
              <div
                className="w-12 h-12 rounded-lg flex items-center justify-center text-white"
                style={{ backgroundColor: report.backgroundColor || '#3b82f6' }}
              >
                {getIconComponent(report.icon)}
              </div>
            )}
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {report.name}
              </h1>
              {report.description && (
                <p className="text-gray-500 dark:text-gray-400 mt-1">
                  {report.description}
                </p>
              )}
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() => router.push(`/reports/custom/${reportId}/edit`)}
          >
            Edit
          </Button>
        </div>

        {/* Timeframe Override */}
        <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
          <div className="flex flex-wrap items-end gap-4">
            <div className="w-48">
              <Select
                label="Timeframe"
                options={timeframeOptions}
                value={overrideTimeframe}
                onChange={(e) => setOverrideTimeframe(e.target.value as TimeframeType | '')}
              />
            </div>
            {overrideTimeframe === TimeframeType.CUSTOM && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Start Date
                  </label>
                  <input
                    type="date"
                    value={customStartDate}
                    onChange={(e) => setCustomStartDate(e.target.value)}
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    End Date
                  </label>
                  <input
                    type="date"
                    value={customEndDate}
                    onChange={(e) => setCustomEndDate(e.target.value)}
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                  />
                </div>
              </>
            )}
            {isExecuting && (
              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                <span>Updating...</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Results */}
      {isExecuting ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-12">
          <div className="flex flex-col items-center justify-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
            <p className="text-gray-500 dark:text-gray-400">Generating report...</p>
          </div>
        </div>
      ) : result ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          {/* Summary */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {result.timeframe.label}
                {result.timeframe.startDate && result.timeframe.endDate && (
                  <span className="ml-1">
                    ({formatDate(result.timeframe.startDate)} – {formatDate(result.timeframe.endDate)})
                  </span>
                )}
              </span>
              <span className="mx-2 text-gray-300 dark:text-gray-600">|</span>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {VIEW_TYPE_LABELS[result.viewType as ReportViewType]}
              </span>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {formatCurrency(result.summary.total)}
              </div>
              <div className="text-sm text-gray-500 dark:text-gray-400">
                {result.summary.count} transactions
              </div>
            </div>
          </div>

          {/* Chart */}
          {result.data.length > 0 ? (
            <ReportChart
              viewType={result.viewType as ReportViewType}
              data={result.data}
              groupBy={result.groupBy as GroupByType}
              onDataPointClick={handleDataPointClick}
              tableColumns={result.tableColumns}
            />
          ) : (
            <div className="py-12 text-center text-gray-500 dark:text-gray-400">
              No data found for the selected criteria
            </div>
          )}

          {/* Legend for pie/bar charts */}
          {(result.viewType === ReportViewType.PIE_CHART || result.viewType === ReportViewType.BAR_CHART) &&
            result.data.length > 0 && (
              <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                  {result.data.slice(0, 15).map((item, index) => (
                    <button
                      key={index}
                      onClick={() => item.id && handleDataPointClick(item.id)}
                      className="flex items-center gap-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-700 p-1 rounded"
                    >
                      <div
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: item.color || '#3b82f6' }}
                      />
                      <span className="text-gray-600 dark:text-gray-400 truncate">
                        {item.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
        </div>
      ) : null}
    </div>
  );
}
