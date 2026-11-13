'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { NextScheduledItem } from '@/lib/scheduled-utils';
import type { RecurringChargeInfo } from '@/types/transaction';

/** Cadences the recurring detector can report that mean an actual rhythm. */
const CADENCE_KEYS = new Set(['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']);

interface PayeeRecurringPanelProps {
  charges: RecurringChargeInfo[];
  nextBill: NextScheduledItem | null;
  isLoading: boolean;
}

/** The most common day-of-month across the detected charge dates, or null. */
function usualDayOfMonth(dates: string[]): number | null {
  if (dates.length === 0) return null;
  const counts = new Map<number, number>();
  for (const date of dates) {
    const day = Number(date.slice(8, 10));
    if (!Number.isNaN(day)) counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  // A "usual" day needs at least two hits; otherwise every date is its own mode.
  return best && best[1] >= 2 ? best[0] : null;
}

/**
 * What this payee charges on a rhythm: each detected cadence with its latest
 * amount, a price-change note when the amount moved, and the next scheduled
 * bill. The detector reports one row per category and currency, so a payee
 * with a phone plan and a hardware charge shows both; each amount is shown in
 * the currency it was billed in.
 */
export function PayeeRecurringPanel({
  charges,
  nextBill,
  isLoading,
}: PayeeRecurringPanelProps) {
  const t = useTranslations('payeeDetail');
  const router = useRouter();
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();

  const rows = useMemo(
    () =>
      charges
        .filter((charge) => CADENCE_KEYS.has(charge.frequency))
        .sort((a, b) => b.dates.length - a.dates.length),
    [charges],
  );

  return (
    <section>
      <div className="mb-4 flex items-center">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('recurringPanel.title')}
        </h2>
        <InfoTooltip text={t('recurringPanel.detectedTooltip')} usePortal />
      </div>
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        {nextBill && (
          <button
            type="button"
            onClick={() => router.push('/bills')}
            title={t('recurringPanel.viewBills')}
            className="mb-4 w-full text-left rounded-md bg-gray-50 dark:bg-gray-700/40 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors px-3 py-2"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t('recurringPanel.nextBill')}
                </p>
                <p
                  className={`text-base font-semibold ${
                    nextBill.amount !== null && nextBill.amount < 0
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-green-600 dark:text-green-400'
                  }`}
                >
                  {/* Unresolvable current amount: shown as unavailable rather
                      than as the stale stored figure (issue #1247). */}
                  {nextBill.amount === null ? (
                    <UnknownAmount />
                  ) : (
                    formatCurrency(Math.abs(nextBill.amount), nextBill.currencyCode)
                  )}
                </p>
              </div>
              <p className="text-base font-semibold text-gray-700 dark:text-gray-300 text-right">
                {formatDate(nextBill.date)}
              </p>
            </div>
          </button>
        )}

        {isLoading ? (
          <div className="h-24 rounded bg-gray-100 dark:bg-gray-700 animate-pulse skeleton-shimmer" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
            {t('recurringPanel.empty')}
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.map((charge, index) => {
              const day = charge.frequency === 'monthly' ? usualDayOfMonth(charge.dates) : null;
              const priceChanged = charge.previousAmount !== charge.currentAmount;
              return (
                <li
                  key={`${charge.categoryId ?? 'none'}-${index}`}
                  className="flex items-start justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {t('recurringPanel.frequencyValue', {
                        cadence: t(`cadence.${charge.frequency}`),
                        amount: formatCurrency(
                          charge.currentAmount,
                          // Billed in the charge's own currency, not converted.
                          charge.currencyCode,
                        ),
                      })}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {charge.categoryName ?? ''}
                      {day !== null && (
                        <>
                          {charge.categoryName ? ' · ' : ''}
                          {t('recurringPanel.usualDay', { day })}
                        </>
                      )}
                    </p>
                  </div>
                  {priceChanged && (
                    <span
                      className={`shrink-0 text-xs font-medium ${
                        charge.currentAmount > charge.previousAmount
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-green-600 dark:text-green-400'
                      }`}
                    >
                      {t('recurringPanel.wasAmount', {
                        amount: formatCurrency(
                          charge.previousAmount,
                          // Billed in the charge's own currency, not converted.
                          charge.currencyCode,
                        ),
                      })}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
