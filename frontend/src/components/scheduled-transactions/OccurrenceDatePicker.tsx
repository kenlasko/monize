'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ScheduledTransaction,
  ScheduledTransactionOverride,
  FrequencyType,
  LoanOccurrence,
  LoanOccurrencesProjection,
  SelectedLoanOccurrence,
} from '@/types/scheduled-transaction';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { parseLocalDate } from '@/lib/utils';
import { advanceByFrequency, isOneTime } from '@/lib/frequency';
import { Modal } from '@/components/ui/Modal';
import { LOAN_OCCURRENCES_MAX_COUNT, scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { isLoanBillCandidate } from '@/lib/loan-occurrence';
import { createLogger } from '@/lib/logger';
import { useLoanOccurrenceMissingText } from './useLoanOccurrenceMissingText';

const logger = createLogger('OccurrenceDatePicker');

interface OccurrenceDatePickerProps {
  isOpen: boolean;
  scheduledTransaction: ScheduledTransaction;
  overrides?: ScheduledTransactionOverride[];
  /**
   * Called with the chosen date and, for a loan bill the server prices per
   * occurrence, that occurrence's projection, so the editor opens on its own
   * figures rather than the template's.
   */
  onSelect: (date: string, loanOccurrence?: SelectedLoanOccurrence) => void;
  onClose: () => void;
}

/**
 * Where the per-occurrence amounts of a loan bill stand. `none`: the bill is
 * not one the loan pricing re-prices, and the picker lists dates only.
 */
type LoanAmountsState =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'priced'; projection: LoanOccurrencesProjection };

function calculateNextDates(startDate: string, frequency: FrequencyType, count: number): string[] {
  const dates: string[] = [];
  let currentDate = parseLocalDate(startDate);

  for (let i = 0; i < count; i++) {
    // Format as YYYY-MM-DD
    const year = currentDate.getFullYear();
    const month = String(currentDate.getMonth() + 1).padStart(2, '0');
    const day = String(currentDate.getDate()).padStart(2, '0');
    dates.push(`${year}-${month}-${day}`);

    // One-time schedules have no next occurrence.
    if (isOneTime(frequency)) return dates;
    currentDate = advanceByFrequency(currentDate, frequency);
  }

  return dates;
}

export function OccurrenceDatePicker({
  isOpen,
  scheduledTransaction,
  overrides = [],
  onSelect,
  onClose,
}: OccurrenceDatePickerProps) {
  const t = useTranslations('scheduledTransactions');
  const tc = useTranslations('common');
  const { formatDate } = useDateFormat();

  const { formatCurrency } = useNumberFormat();
  const missingText = useLoanOccurrenceMissingText();

  // Create maps for O(1) lookups
  // originalDateToOverrideDate: maps original calculated dates to their override dates
  // overrideDateSet: set of all override dates (to mark them as "modified")
  // overrideByDate: maps override dates to full override objects (to show what changed)
  const { originalDateToOverrideDate, overrideDateSet, overrideByDate } = useMemo(() => {
    const dateMap = new Map<string, string>();
    const dateSet = new Set<string>();
    const byDate = new Map<string, ScheduledTransactionOverride>();
    for (const override of overrides) {
      dateMap.set(override.originalDate, override.overrideDate);
      dateSet.add(override.overrideDate);
      byDate.set(override.overrideDate, override);
    }
    return { originalDateToOverrideDate: dateMap, overrideDateSet: dateSet, overrideByDate: byDate };
  }, [overrides]);

  // Calculate next dates based on frequency
  // Use occurrencesRemaining if set (finite schedule), otherwise default to 5
  const calculatedDates = useMemo(() => {
    const count = scheduledTransaction.occurrencesRemaining ?? 5;
    return calculateNextDates(
      scheduledTransaction.nextDueDate,
      scheduledTransaction.frequency,
      count
    );
  }, [scheduledTransaction.nextDueDate, scheduledTransaction.frequency, scheduledTransaction.occurrencesRemaining]);

  // Build the final list of dates to display:
  // - For each calculated date, if it has an override, show the override date instead
  // - This ensures we don't show BOTH the original and override dates
  const nextDates = useMemo(() => {
    const resultDates: string[] = [];
    const addedDates = new Set<string>();

    for (const calculatedDate of calculatedDates) {
      const overrideDate = originalDateToOverrideDate.get(calculatedDate);
      const dateToShow = overrideDate || calculatedDate;

      // Avoid duplicates (in case an override date matches another calculated date)
      if (!addedDates.has(dateToShow)) {
        resultDates.push(dateToShow);
        addedDates.add(dateToShow);
      }
    }

    // Also add any override dates that aren't already included
    // (for overrides of dates outside the calculated window)
    for (const override of overrides) {
      if (!addedDates.has(override.overrideDate)) {
        resultDates.push(override.overrideDate);
        addedDates.add(override.overrideDate);
      }
    }

    return resultDates.sort();
  }, [calculatedDates, originalDateToOverrideDate, overrides]);

  // A loan bill's occurrences are priced by the server, each at its own due
  // date (INV-LOAN-009): the template's amount is the next installment's at
  // most. The payload is kept with the request that produced it, and a retry
  // is a new request, so neither a late answer nor an earlier failure is read
  // as the current one.
  const isLoanCandidate = isLoanBillCandidate(scheduledTransaction);
  const requestCount = Math.min(Math.max(nextDates.length, 1), LOAN_OCCURRENCES_MAX_COUNT);
  const [attempt, setAttempt] = useState(0);
  const requestKey =
    isOpen && isLoanCandidate ? `${scheduledTransaction.id}:${requestCount}:${attempt}` : null;
  const [loaded, setLoaded] = useState<{ key: string; projection: LoanOccurrencesProjection } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!requestKey) return;
    let cancelled = false;
    scheduledTransactionsApi
      .getLoanOccurrences(scheduledTransaction.id, requestCount)
      .then((projection) => {
        if (!cancelled) setLoaded({ key: requestKey, projection });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error('Failed to load loan occurrences:', error);
        setFailedKey(requestKey);
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey, scheduledTransaction.id, requestCount]);

  const loanAmounts: LoanAmountsState = !requestKey
    ? { kind: 'none' }
    : loaded?.key === requestKey
      ? loaded.projection.status === 'priced'
        ? { kind: 'priced', projection: loaded.projection }
        : { kind: 'none' }
      : failedKey === requestKey
        ? { kind: 'failed' }
        : { kind: 'loading' };

  // The projection's rows by the date each falls on, which is the date this
  // list shows (an override's date when one moved the occurrence).
  const pricedProjection = loanAmounts.kind === 'priced' ? loanAmounts.projection : null;
  const occurrenceByDueDate = useMemo(() => {
    const byDate = new Map<string, LoanOccurrence>();
    for (const occurrence of pricedProjection?.occurrences ?? []) {
      byDate.set(occurrence.dueDate, occurrence);
    }
    return byDate;
  }, [pricedProjection]);

  // Track which date is the next due date
  const nextDueDate = scheduledTransaction.nextDueDate.split('T')[0];

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="sm" className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
          {t('occurrencePicker.title')}
        </h3>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {t('occurrencePicker.description', { name: scheduledTransaction.name })}
      </p>

      {loanAmounts.kind === 'loading' && (
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4" role="status">
          {t('loanOccurrence.loading')}
        </p>
      )}
      {loanAmounts.kind === 'failed' && (
        <div
          className="flex flex-wrap items-center gap-2 text-sm text-red-700 dark:text-red-300 mb-4"
          role="alert"
        >
          <span>{t('loanOccurrence.loadFailed')}</span>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            {t('loanOccurrence.retry')}
          </button>
        </div>
      )}

      <div className="space-y-2">
        {nextDates.map((date, index) => {
          const occurrence = pricedProjection ? occurrenceByDueDate.get(date) : undefined;
          // The payment changes where this occurrence's known amount differs
          // from the one listed before it: the dated payment of a rate change
          // first applying (INV-LOAN-009), or an override's amount.
          const previous = index > 0 ? occurrenceByDueDate.get(nextDates[index - 1]) : undefined;
          const paymentChanges =
            occurrence?.amount != null &&
            previous?.amount != null &&
            occurrence.amount !== previous.amount;
          const hasOverride = overrideDateSet.has(date);
          const isNextDue = date === nextDueDate;
          const override = hasOverride ? overrideByDate.get(date) : undefined;
          const changes: string[] = [];
          if (override) {
            if (override.originalDate !== override.overrideDate) {
              changes.push(t('occurrencePicker.dateMoved', { date: formatDate(override.originalDate) }));
            }
            // A priced loan occurrence shows its own amount below, override
            // included; comparing the override with the template would set it
            // against a figure the occurrence never had.
            if (!pricedProjection && override.amount != null && Number(override.amount) !== Number(scheduledTransaction.amount)) {
              changes.push(t('occurrencePicker.amountChange', { amount: formatCurrency(Math.abs(override.amount), scheduledTransaction.currencyCode) }));
            }
            if (override.category && override.categoryId !== scheduledTransaction.categoryId) {
              changes.push(t('occurrencePicker.categoryChange', { category: override.category.name }));
            }
            if (override.description != null && override.description !== (scheduledTransaction.description ?? '')) {
              changes.push(t('occurrencePicker.noteChange', { note: override.description }));
            }
            if (override.isSplit != null && override.isSplit !== scheduledTransaction.isSplit) {
              changes.push(t('occurrencePicker.splitModified'));
            }
          }
          return (
            <button
              key={date}
              onClick={() =>
                occurrence && pricedProjection
                  ? onSelect(date, { loanAccountId: pricedProjection.loanAccountId, occurrence })
                  : onSelect(date)
              }
              disabled={loanAmounts.kind === 'loading'}
              className={`w-full px-4 py-3 text-left rounded-lg border transition-colors ${
                hasOverride
                  ? 'border-purple-300 dark:border-purple-600 bg-purple-50 dark:bg-purple-900/20'
                  : 'border-gray-200 dark:border-gray-700'
              } hover:bg-gray-50 dark:hover:bg-gray-700 hover:border-purple-300 dark:hover:border-purple-600 disabled:cursor-wait disabled:opacity-60`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {formatDate(date)}
                </span>
                <div className="flex items-center space-x-2">
                  {paymentChanges && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                      {t('loanOccurrence.paymentChangesBadge')}
                    </span>
                  )}
                  {hasOverride && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
                      {t('occurrencePicker.modifiedBadge')}
                    </span>
                  )}
                  {isNextDue && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                      {t('occurrencePicker.nextDueBadge')}
                    </span>
                  )}
                </div>
              </div>
              {pricedProjection && (
                <div className="mt-1 text-sm">
                  {occurrence?.amount != null ? (
                    <span className="text-gray-900 dark:text-gray-100">
                      {formatCurrency(occurrence.amount, pricedProjection.currencyCode)}
                    </span>
                  ) : occurrence ? (
                    <>
                      <span className="text-gray-700 dark:text-gray-300">
                        {t('loanOccurrence.amountUnknown')}
                      </span>
                      <span className="block text-xs text-gray-500 dark:text-gray-400">
                        {missingText(occurrence.missing)}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {t('loanOccurrence.notProjected')}
                    </span>
                  )}
                </div>
              )}
              {changes.length > 0 && (
                <div className="mt-1.5 text-xs text-purple-700 dark:text-purple-300 space-y-0.5">
                  {changes.map((change) => (
                    <div key={change}>{change}</div>
                  ))}
                </div>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
        <button
          onClick={onClose}
          className="w-full px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600"
        >
          {tc('cancel')}
        </button>
      </div>
    </Modal>
  );
}
