'use client';

import { useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { categoriesApi } from '@/lib/categories';
import { transactionsApi } from '@/lib/transactions';
import { buildCategoryColorMap, buildCategoryIconMap } from '@/lib/categoryUtils';
import { showErrorToast } from '@/lib/errors';
import type { DuplicateConfidence, DuplicateTransactionItem } from '@/types/built-in-reports';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { exportToCsv } from '@/lib/csv-export';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';
import { useTranslations } from 'next-intl';
import { quoteSearchValue } from '@/lib/search-query';
import { CheckCircleIcon } from '@heroicons/react/24/outline';
import { EmptyState } from '@/components/ui/EmptyState';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DuplicateGroupCard } from '@/components/reports/DuplicateGroupCard';
import { useDuplicateLabels } from '@/components/reports/useDuplicateLabels';
import { usePreferencesStore } from '@/store/preferencesStore';
import {
  DUPLICATE_CONFIDENCE_LEVELS,
  groupsFullySelected,
  selectionInGroups,
  withDuplicatesAt,
} from '@/components/reports/duplicate-selection';

const DUPLICATE_RANGES = ['1m', '3m', '6m', '1y', '2y', '5y', '10y', 'all'] as const;

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

export function DuplicateTransactionReport() {
  const t = useTranslations('reports');
  const tc = useTranslations('common');
  const router = useRouter();
  const { formatCurrency } = useNumberFormat();
  const { dateRange, setDateRange, resolvedRange } = useDateRange({ defaultRange: '3m', alignment: 'day' });
  const [sensitivity, setSensitivity] = useState<'high' | 'medium' | 'low'>('medium');
  const [selected, setSelected] = useState<ReadonlySet<string>>(EMPTY_SELECTION);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Set synchronously, so a double click on Delete cannot send twice.
  const deleting = useRef(false);

  const { start: rangeStart, end: rangeEnd } = resolvedRange;

  const { data: reportData, isLoading, error, reload } = useReportData(
    () =>
      builtInReportsApi.getDuplicateTransactions({
        // "All" resolves to no start date, which the server reads as "from the
        // first transaction"; an empty string would fail its date validation.
        startDate: rangeStart || undefined,
        endDate: rangeEnd,
        sensitivity,
      }),
    [rangeStart, rangeEnd, sensitivity],
  );

  // Only the pill's colour and icon come from here; the name is the server's,
  // so a failed lookup leaves neutral pills rather than an unusable report.
  const { data: categories } = useReportData(() => categoriesApi.getAll(), []);
  const categoryColorMap = useMemo(() => buildCategoryColorMap(categories ?? []), [categories]);
  const categoryIconMap = useMemo(() => buildCategoryIconMap(categories ?? []), [categories]);

  const handleTransactionClick = (tx: DuplicateTransactionItem) => {
    // An exact payee term, so "Costco" does not also open "Costco Gas Bar".
    const search = tx.payeeName ? quoteSearchValue('payee', tx.payeeName) : '';
    router.push(`/transactions?search=${encodeURIComponent(search)}`);
  };

  // Loading and error render inside the tree below, never as an early return,
  // so the toolbar stays mounted across a reload.
  const dataUnavailable = isLoading || !!error;

  const summary = reportData?.summary || {
    totalGroups: 0,
    veryHighCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    potentialSavings: 0,
  };

  const duplicateGroups = useMemo(() => reportData?.groups ?? [], [reportData]);

  // What a delete would remove: the ticked rows this answer still lists, and
  // none while a newer answer is loading or failed to arrive.
  const selectedIds = dataUnavailable ? [] : selectionInGroups(duplicateGroups, selected);
  const selectedOnScreen = new Set(selectedIds);
  const fullySelectedGroups = groupsFullySelected(duplicateGroups, selectedOnScreen);

  const countAt = (level: DuplicateConfidence) =>
    duplicateGroups.filter((group) => group.confidence === level).length;

  const { confidenceLabel, reasonLabel, categoryLabel } = useDuplicateLabels();

  const toggleRow = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Under the strict lock a reconciled copy cannot be deleted, so selecting a
  // level leaves those for the user rather than letting one refuse the batch.
  const reconciledLocked = usePreferencesStore(
    (s) => s.preferences?.lockReconciledTransactions ?? false,
  );

  const selectLevel = (level: DuplicateConfidence) => {
    setSelected((current) => withDuplicatesAt(duplicateGroups, level, current, reconciledLocked));
  };

  const handleDelete = async () => {
    if (deleting.current || selectedIds.length === 0) return;
    deleting.current = true;
    try {
      const result = await transactionsApi.bulkDelete({ mode: 'ids', transactionIds: selectedIds });
      if (result.deleted > 0) {
        toast.success(t('duplicateTransactions.deletedToast', { count: result.deleted }));
      }
      setSelected(EMPTY_SELECTION);
      reload();
    } catch (err) {
      showErrorToast(err, t('duplicateTransactions.deleteFailed'));
    } finally {
      deleting.current = false;
      setConfirmOpen(false);
    }
  };

  const getExportData = () => {
    const headers = [t('duplicateTransactions.colDate'), t('duplicateTransactions.colPayee'), t('duplicateTransactions.colDescription'), t('duplicateTransactions.colCategory'), t('duplicateTransactions.colAccount'), t('duplicateTransactions.colAmount'), t('duplicateTransactions.colConfidence'), t('duplicateTransactions.colReason')];
    const rows: (string | number)[][] = [];
    for (const group of duplicateGroups) {
      for (const tx of group.transactions) {
        rows.push([
          format(parseLocalDate(tx.transactionDate), 'yyyy-MM-dd'),
          tx.payeeName || '',
          tx.description || '',
          categoryLabel(tx),
          tx.accountName || '',
          tx.amount,
          confidenceLabel(group.confidence),
          reasonLabel(group),
        ]);
      }
    }
    return { headers, rows };
  };

  const handleExportCsv = () => {
    const { headers, rows } = getExportData();
    exportToCsv('duplicate-transactions', headers, rows);
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const { headers, rows } = getExportData();
    await exportToPdf({
      title: t('duplicateTransactions.pdfTitle'),
      subtitle: `${summary.totalGroups} ${t('duplicateTransactions.groupsFound')} | ${t('duplicateTransactions.potentialImpact')}: ${formatCurrency(summary.potentialSavings)}`,
      summaryCards: [
        { label: t('duplicateTransactions.potentialDuplicates'), value: String(summary.totalGroups), color: '#ea580c' },
        { label: t('duplicateTransactions.veryHighConfidence'), value: String(summary.veryHighCount), color: '#9333ea' },
        { label: t('duplicateTransactions.highConfidence'), value: String(summary.highCount), color: '#dc2626' },
        { label: t('duplicateTransactions.mediumConfidence'), value: String(summary.mediumCount), color: '#ea580c' },
        { label: t('duplicateTransactions.potentialImpact'), value: formatCurrency(summary.potentialSavings), color: '#111827' },
      ],
      tableData: { headers, rows },
      filename: 'duplicate-transactions',
    });
  };

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      {dataUnavailable ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <Card padding="sm">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('duplicateTransactions.potentialDuplicates')}</div>
          <div className="text-2xl font-bold text-orange-600 dark:text-orange-400">
            {summary.totalGroups}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{t('duplicateTransactions.groupsFound')}</div>
        </Card>
        <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4">
          <div className="text-sm text-purple-600 dark:text-purple-400">{t('duplicateTransactions.veryHighConfidence')}</div>
          <div className="text-xl font-bold text-purple-700 dark:text-purple-300">
            {summary.veryHighCount}
          </div>
        </div>
        <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
          <div className="text-sm text-red-600 dark:text-red-400">{t('duplicateTransactions.highConfidence')}</div>
          <div className="text-xl font-bold text-red-700 dark:text-red-300">
            {summary.highCount}
          </div>
        </div>
        <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-4">
          <div className="text-sm text-orange-600 dark:text-orange-400">{t('duplicateTransactions.mediumConfidence')}</div>
          <div className="text-xl font-bold text-orange-700 dark:text-orange-300">
            {summary.mediumCount}
          </div>
        </div>
        <Card padding="sm">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('duplicateTransactions.potentialImpact')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(summary.potentialSavings)}
          </div>
        </Card>
      </div>
      )}

      {/* Controls */}
      <Card padding="sm">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <DateRangeSelector
            ranges={DUPLICATE_RANGES}
            // Only `all` needs translating; the rest are locale-neutral
            // abbreviations `formatLabel` handles.
            labels={{ all: t('duplicateTransactions.rangeAll') }}
            value={dateRange}
            onChange={setDateRange}
          />
          <div className="flex flex-wrap items-stretch gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600 dark:text-gray-400">{t('duplicateTransactions.sensitivityLabel')}</span>
              <select
                value={sensitivity}
                onChange={(e) => setSensitivity(e.target.value as 'high' | 'medium' | 'low')}
                className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm"
              >
                <option value="high">{t('duplicateTransactions.sensitivityHigh')}</option>
                <option value="medium">{t('duplicateTransactions.sensitivityMedium')}</option>
                <option value="low">{t('duplicateTransactions.sensitivityLow')}</option>
              </select>
            </div>
          </div>
          <ReportToolbarActions
            onExportCsv={handleExportCsv}
            onExportPdf={handleExportPdf}
            disabled={dataUnavailable || duplicateGroups.length === 0}
          />
        </div>
      </Card>

      {/* Bulk selection */}
      {!dataUnavailable && duplicateGroups.length > 0 && (
        <Card padding="sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-gray-600 dark:text-gray-400">
              {t('duplicateTransactions.selectDuplicatesLabel')}
            </span>
            {DUPLICATE_CONFIDENCE_LEVELS.filter((level) => countAt(level) > 0).map((level) => (
              <Button key={level} variant="outline" size="sm" onClick={() => selectLevel(level)}>
                {t('duplicateTransactions.selectLevel', { level: confidenceLabel(level), count: countAt(level) })}
              </Button>
            ))}
            <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto sm:ml-auto">
              <span className="text-sm text-gray-600 dark:text-gray-400" aria-live="polite">
                {t('duplicateTransactions.selectedCount', { count: selectedIds.length })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected(EMPTY_SELECTION)}
                disabled={selectedIds.length === 0}
              >
                {t('duplicateTransactions.clearSelection')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => setConfirmOpen(true)}
                disabled={selectedIds.length === 0}
              >
                {t('duplicateTransactions.deleteSelected', { count: selectedIds.length })}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Duplicate Groups */}
      {error ? (
        <ReportError onRetry={reload} />
      ) : isLoading ? (
        <Card padding="md">
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-64 w-full" />
          </div>
        </Card>
      ) : duplicateGroups.length === 0 ? (
        <Card padding="md">
          <EmptyState icon={<CheckCircleIcon />} title={t('duplicateTransactions.empty')} />
        </Card>
      ) : (
        <div className="space-y-4">
          {duplicateGroups.map((group) => (
            <DuplicateGroupCard
              key={group.key}
              group={group}
              selected={selectedOnScreen}
              onToggle={toggleRow}
              onOpen={handleTransactionClick}
              categoryColorMap={categoryColorMap}
              categoryIconMap={categoryIconMap}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        isOpen={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleDelete}
        title={t('duplicateTransactions.deleteConfirmTitle')}
        message={
          fullySelectedGroups > 0
            ? t('duplicateTransactions.deleteConfirmMessageAllCopies', {
                count: selectedIds.length,
                groups: fullySelectedGroups,
              })
            : t('duplicateTransactions.deleteConfirmMessage', { count: selectedIds.length })
        }
        confirmLabel={tc('delete')}
        variant="danger"
      />

      {/* Info */}
      <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
        <div className="flex gap-3">
          <svg className="h-5 w-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div className="text-sm text-blue-700 dark:text-blue-300">
            <p className="font-medium">{t('duplicateTransactions.howDetectedTitle')}</p>
            <ul className="mt-1 list-disc list-inside space-y-0.5">
              <li>{t('duplicateTransactions.howDetectedVeryHigh')}</li>
              <li>{t('duplicateTransactions.howDetectedHigh')}</li>
              <li>{t('duplicateTransactions.howDetectedMedium')}</li>
              <li>{t('duplicateTransactions.howDetectedLow')}</li>
            </ul>
            <p className="mt-2">
              {t('duplicateTransactions.howDetectedNote')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
