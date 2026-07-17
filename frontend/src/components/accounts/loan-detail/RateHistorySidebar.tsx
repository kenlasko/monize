'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ExportIconButton } from '@/components/ui/ExportIconButton';
import { LoanRateChange } from '@/types/loan-rate-change';
import { Account } from '@/types/account';
import { exportToCsv } from '@/lib/csv-export';
import { sanitizeFilename } from '@/lib/export-filename';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { LoanRateControls } from './LoanRateControls';
import { LoanRateEditing } from './useLoanRateEditing';

interface RateHistorySidebarProps {
  account: Account;
  /** Recorded rate history (loan_rate_changes), any order. */
  rateChanges: LoanRateChange[];
  /** Shared rate-timeline editing (add / edit / delete / detect). */
  editing: LoanRateEditing;
}

/**
 * The Rate History panel, full-width below the overpayment simulator. The
 * recorded rate changes -- effective date, rate, source badge, payment in
 * effect -- are listed, each editable, with "Detect from history" and
 * "Add rate change". The header bar collapses the panel when clicked.
 */
export function RateHistorySidebar({
  account,
  rateChanges,
  editing,
}: RateHistorySidebarProps) {
  const t = useTranslations('accounts');
  const tc = useTranslations('common');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const [collapsed, setCollapsed] = useState(false);

  const sorted = useMemo(
    () => [...rateChanges].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)),
    [rateChanges],
  );

  const sourceBadge = (change: LoanRateChange) => {
    if (change.source === 'inferred') {
      return (
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
          {t('loanDetail.rateHistory.badgeInferred')}
        </span>
      );
    }
    if (change.source === 'initial') {
      return (
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
          {t('loanDetail.rateHistory.badgeInitial')}
        </span>
      );
    }
    return null;
  };

  const paymentLabel = (change: LoanRateChange) =>
    change.newPaymentAmount != null
      ? formatCurrency(change.newPaymentAmount, account.currencyCode)
      : t('loanDetail.rateHistory.paymentUnchanged');

  const sourceLabel = (change: LoanRateChange) => {
    if (change.source === 'inferred') return t('loanDetail.rateHistory.badgeInferred');
    if (change.source === 'initial') return t('loanDetail.rateHistory.badgeInitial');
    return t('loanDetail.rateHistory.sourceManual');
  };

  // The recorded rate timeline with raw values (a null payment means the
  // payment did not change with the rate).
  const handleExportCsv = () => {
    const headers = [
      t('loanDetail.rateHistory.colDate'),
      t('loanDetail.rateHistory.colRate'),
      t('loanDetail.rateHistory.colSource'),
      t('loanDetail.rateHistory.colPayment'),
      t('loanDetail.rateHistory.colNote'),
    ];
    const rows = sorted.map((change) => [
      change.effectiveDate,
      change.annualRate,
      sourceLabel(change),
      change.newPaymentAmount ?? '',
      change.note ?? '',
    ]);
    exportToCsv(sanitizeFilename(t('loanDetail.rateHistory.title')), headers, rows);
  };

  return (
    <div
      className="relative flex flex-col overflow-hidden bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 scroll-mt-4"
    >
      <div className="relative z-10 min-h-0 flex-1 p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            className="flex items-start gap-2 text-left group"
          >
            <span className="text-gray-400 dark:text-gray-500 mt-0.5 group-hover:text-blue-600 dark:group-hover:text-blue-400">
              {collapsed ? '▸' : '▾'}
            </span>
            <span>
              <span className="block text-base font-semibold text-gray-900 dark:text-gray-100">
                {t('loanDetail.rateHistory.title')}
              </span>
              <span className="block text-sm text-gray-500 dark:text-gray-400">
                {t('loanDetail.rateHistory.description')}
              </span>
            </span>
          </button>
          <div className="flex items-center gap-2">
            <ExportIconButton
              onExport={handleExportCsv}
              title={tc('csvDownload.downloadAsCsv', {
                filename: t('loanDetail.rateHistory.title'),
              })}
              disabled={sorted.length === 0}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={editing.openDetect}
              isLoading={editing.isDetecting}
            >
              {t('loanDetail.rateHistory.detect')}
            </Button>
            {/* Add button + the add/edit/delete/scheduled-payment modals. */}
            <LoanRateControls editing={editing} />
          </div>
        </div>

        {!collapsed &&
          (sorted.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('loanDetail.rateHistory.empty')}
            </p>
          ) : (
            <ul
              className="max-h-96 overflow-y-auto min-h-0 divide-y divide-gray-200/70 dark:divide-gray-700/70"
            >
              {sorted.map((change) => (
                <li
                  key={change.id}
                  className="py-2 flex flex-wrap items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center gap-2">
                      <span>{formatDate(change.effectiveDate)}</span>
                      <span className="text-blue-600 dark:text-blue-400">
                        {t('loanDetail.rateHistory.rateValue', { rate: change.annualRate })}
                      </span>
                      {sourceBadge(change)}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                      {t('loanDetail.rateHistory.paymentSummary', { payment: paymentLabel(change) })}
                      {change.note ? ` — ${change.note}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="sm" onClick={() => editing.openEdit(change)}>
                      {t('loanDetail.rateHistory.edit')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => editing.requestDelete(change)}>
                      {t('loanDetail.rateHistory.delete')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ))}
      </div>

      <ConfirmDialog
        isOpen={editing.showDetectConfirm}
        title={t('loanDetail.rateHistory.detectTitle')}
        message={t('loanDetail.rateHistory.detectMessage')}
        confirmLabel={t('loanDetail.rateHistory.detect')}
        cancelLabel={t('loanDetail.rateHistory.cancel')}
        onConfirm={editing.runDetect}
        onCancel={editing.cancelDetect}
      />
    </div>
  );
}
