'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { DateInput } from '@/components/ui/DateInput';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { investmentReportsApi } from '@/lib/investment-reports';
import {
  InvestmentReport,
  InvestmentReportResult,
  InvestmentReportRow,
  InvestmentGroupBy,
  INVESTMENT_COLUMN_MAP,
  InvestmentColumnType,
  InvestmentCellValue,
} from '@/types/investment-report';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { exportToCsv } from '@/lib/csv-export';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('InvestmentReportViewer');

const NUMERIC_TYPES: InvestmentColumnType[] = [
  'currency',
  'percent',
  'integer',
  'number',
  'shares',
];

interface InvestmentReportViewerProps {
  reportId: string;
}

export function InvestmentReportViewer({ reportId }: InvestmentReportViewerProps) {
  const router = useRouter();
  const { formatNumber, formatPercent } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const [report, setReport] = useState<InvestmentReport | null>(null);
  const [result, setResult] = useState<InvestmentReportResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isExecuting, setIsExecuting] = useState(false);
  const [asOfOverride, setAsOfOverride] = useState('');

  const { sortField, sortDirection, handleSort } = useSortableTable<string>(
    'reports.investment.table.sort',
    { field: 'symbol', direction: 'asc' },
  );

  const loadReport = useCallback(async () => {
    try {
      const data = await investmentReportsApi.getById(reportId);
      setReport(data);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to load report'));
      logger.error(error);
    }
  }, [reportId]);

  const executeReport = useCallback(async () => {
    setIsExecuting(true);
    try {
      const data = await investmentReportsApi.execute(
        reportId,
        asOfOverride ? { asOfDate: asOfOverride } : {},
      );
      setResult(data);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to run report'));
      logger.error(error);
    } finally {
      setIsExecuting(false);
    }
  }, [reportId, asOfOverride]);

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
    executeReport();
  }, [report, executeReport]);

  const formatCell = (value: InvestmentCellValue, type: InvestmentColumnType): string => {
    if (value === null || value === undefined || value === '') return '—';
    switch (type) {
      case 'currency':
        return formatNumber(Number(value), 2);
      case 'number':
        return formatNumber(Number(value), 4);
      case 'integer':
        return formatNumber(Number(value), 0);
      case 'percent':
        return formatPercent(Number(value), 2);
      case 'shares':
        return Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 });
      case 'date':
        return formatDate(String(value));
      default:
        return String(value);
    }
  };

  const sortRows = (rows: InvestmentReportRow[]): InvestmentReportRow[] => {
    return [...rows].sort((a, b) => {
      const av = a.values[sortField];
      const bv = b.values[sortField];
      if (av === null && bv === null) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const cmp = compareValues(av, bv);
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  };

  const handleExportCsv = () => {
    if (!result) return;
    const cols = result.columns;
    const grouped = result.groupBy !== InvestmentGroupBy.NONE;
    const headers = [
      ...(grouped ? [GROUP_HEADINGS[result.groupBy]] : []),
      ...cols.map((key) => INVESTMENT_COLUMN_MAP[key]?.label ?? key),
    ];
    const rows = result.groups.flatMap((g) =>
      g.rows.map((row) => [
        ...(grouped ? [g.label] : []),
        ...cols.map((key) => {
          const v = row.values[key];
          return v === null || v === undefined ? '' : v;
        }),
      ]),
    );
    const filename = `${report?.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase() || 'investment-report'}`;
    exportToCsv(filename, headers, rows);
  };

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

  const columns = result?.columns ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={report.name}
        subtitle={report.description ?? undefined}
        actions={
          <>
            <Button
              variant="outline"
              className="shrink-0"
              onClick={() => router.push(`/reports/investment/${reportId}/edit`)}
            >
              Edit
            </Button>
            <Link href="/reports">
              <Button variant="outline">Back to Reports</Button>
            </Link>
          </>
        }
      />

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="w-56">
            <DateInput
              label="As of date"
              value={asOfOverride}
              onChange={(e) => setAsOfOverride(e.target.value)}
              onDateChange={(date) => setAsOfOverride(date)}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {asOfOverride ? (
                <button
                  type="button"
                  className="text-blue-600 dark:text-blue-400 hover:underline"
                  onClick={() => setAsOfOverride('')}
                >
                  Reset to latest market day
                </button>
              ) : (
                'Showing the latest market day.'
              )}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {isExecuting && (
              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                <span>Updating...</span>
              </div>
            )}
            <Button
              variant="outline"
              onClick={handleExportCsv}
              disabled={!result || result.rowCount === 0}
            >
              Export CSV
            </Button>
          </div>
        </div>
      </div>

      {/* Results */}
      {isExecuting && !result ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-12">
          <div className="flex flex-col items-center justify-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
            <p className="text-gray-500 dark:text-gray-400">Generating report...</p>
          </div>
        </div>
      ) : result ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm text-gray-500 dark:text-gray-400">
              As of {formatDate(result.asOfDate)} · {result.rowCount} holding
              {result.rowCount === 1 ? '' : 's'}
            </span>
          </div>

          {result.rowCount === 0 ? (
            <div className="py-12 text-center text-gray-500 dark:text-gray-400">
              No holdings found for the selected accounts and date.
            </div>
          ) : (
            <div className="space-y-6">
              {result.groups.map((group) => (
                <div key={group.key}>
                  {result.groupBy !== InvestmentGroupBy.NONE && (
                    <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
                      {group.label || 'Ungrouped'}
                    </h4>
                  )}
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                      <thead className="bg-gray-50 dark:bg-gray-900/50">
                        <tr>
                          {columns.map((key) => {
                            const col = INVESTMENT_COLUMN_MAP[key];
                            const numeric = col && NUMERIC_TYPES.includes(col.type);
                            return (
                              <SortableHeader<string>
                                key={key}
                                field={key}
                                sortField={sortField}
                                sortDirection={sortDirection}
                                onSort={handleSort}
                                align={numeric ? 'right' : 'left'}
                                className="px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap"
                              >
                                {col?.label ?? key}
                              </SortableHeader>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                        {sortRows(group.rows).map((row) => (
                          <tr
                            key={row.id}
                            className="hover:bg-gray-50 dark:hover:bg-gray-700/50"
                          >
                            {columns.map((key) => {
                              const col = INVESTMENT_COLUMN_MAP[key];
                              const numeric = col && NUMERIC_TYPES.includes(col.type);
                              return (
                                <td
                                  key={key}
                                  className={`px-3 py-2 text-sm whitespace-nowrap ${
                                    numeric
                                      ? 'text-right tabular-nums text-gray-900 dark:text-gray-100'
                                      : 'text-gray-700 dark:text-gray-300'
                                  }`}
                                >
                                  {formatCell(row.values[key], col?.type ?? 'text')}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

const GROUP_HEADINGS: Record<InvestmentGroupBy, string> = {
  [InvestmentGroupBy.NONE]: 'Group',
  [InvestmentGroupBy.ACCOUNT]: 'Account',
  [InvestmentGroupBy.SYMBOL]: 'Symbol',
  [InvestmentGroupBy.CURRENCY]: 'Currency',
};
