'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { format, subMonths } from 'date-fns';
import { PlusCircleIcon } from '@heroicons/react/24/outline';
import { transactionsApi } from '@/lib/transactions';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { Modal } from '@/components/ui/Modal';
import { createLogger } from '@/lib/logger';
import type { RecurringChargeInfo, Transaction } from '@/types/transaction';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';

// The scheduled-transaction form is heavy and only needed once the user opens
// the "create bill" modal, so load it lazily.
const ScheduledTransactionForm = dynamic(
  () =>
    import('@/components/scheduled-transactions/ScheduledTransactionForm').then(
      (m) => m.ScheduledTransactionForm,
    ),
  { ssr: false },
);

const logger = createLogger('RecurringChargesPanel');

// Cadences worth surfacing as a "subscription"; irregular activity is noise.
const SUBSCRIPTION_CADENCES = new Set(['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']);

interface RecurringChargesPanelProps {
  accountId: string;
  currencyCode: string;
}

/** Normalise a payee/name for loose matching between a schedule and a charge. */
function normaliseName(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Colour a scheduled bill's amount by kind, matching the app convention:
 * transfers blue, income (positive) green, expense (negative) red.
 */
function scheduledAmountClass(s: ScheduledTransaction): string {
  if (s.isTransfer) return 'text-blue-600 dark:text-blue-400';
  return Number(s.amount) < 0
    ? 'text-red-600 dark:text-red-400'
    : 'text-green-600 dark:text-green-400';
}

/** Signed prefix for a scheduled bill amount; transfers carry no +/-. */
function scheduledAmountSign(s: ScheduledTransaction): string {
  if (s.isTransfer) return '';
  return Number(s.amount) < 0 ? '-' : '+';
}

/**
 * Build a template transaction from a detected charge so the scheduled-bill
 * form opens pre-filled. Detection reports the charge magnitude as a positive
 * number, but the underlying transactions are expenses, so seed a negative
 * amount to keep the sign correct.
 */
function toTemplate(
  charge: RecurringChargeInfo,
  accountId: string,
  currencyCode: string,
): Transaction {
  return {
    accountId,
    payeeId: charge.payeeId,
    payeeName: charge.payeeName,
    categoryId: charge.categoryId,
    amount: -Math.abs(charge.currentAmount),
    currencyCode,
    isTransfer: false,
    isSplit: false,
  } as Transaction;
}

/**
 * Recurring charges on an account. Lists the scheduled bills already defined
 * against the account, then flags likely subscriptions found in its transaction
 * history that are not yet scheduled -- each of those can be turned into a
 * scheduled bill (pre-filled) in one click. Shared by the credit-card and
 * banking detail views.
 */
export function RecurringChargesPanel({ accountId, currencyCode }: RecurringChargesPanelProps) {
  const t = useTranslations('accountDetail');
  const tf = useTranslations('scheduledTransactions');
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();

  const [scheduled, setScheduled] = useState<ScheduledTransaction[]>([]);
  const [detected, setDetected] = useState<RecurringChargeInfo[]>([]);
  const [loadedForId, setLoadedForId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [template, setTemplate] = useState<Transaction | null>(null);
  const isLoading = loadedForId !== accountId;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const now = new Date();
      const endDate = format(now, 'yyyy-MM-dd');
      const startDate = format(subMonths(now, 12), 'yyyy-MM-dd');

      // Kick off both loads in parallel (each call issued synchronously) with
      // independent error handling, so a failure in one never blanks the other
      // and neither is deferred behind the other's request.
      const [schedules, charges] = await Promise.all([
        scheduledTransactionsApi.getAll().catch((error) => {
          logger.error('Failed to load scheduled transactions:', error);
          return [] as ScheduledTransaction[];
        }),
        transactionsApi
          .getAll({ accountId, startDate, endDate, limit: 500, page: 1 })
          .then((page) => {
            const payeeIds = Array.from(
              new Set(page.data.map((tx) => tx.payeeId).filter((id): id is string => !!id)),
            );
            return payeeIds.length
              ? transactionsApi.getRecurringCharges({ payeeIds, startDate, endDate })
              : [];
          })
          .catch((error) => {
            logger.error('Failed to load recurring charges:', error);
            return [] as RecurringChargeInfo[];
          }),
      ]);

      if (cancelled) return;
      setScheduled(schedules);
      setDetected(charges.filter((c) => SUBSCRIPTION_CADENCES.has(c.frequency)));
      setLoadedForId(accountId);
    })();
    return () => {
      cancelled = true;
    };
    // reloadKey re-runs the load after a schedule is created so it moves from
    // the "possible" list into the "scheduled" list.
  }, [accountId, reloadKey]);

  // Active bills booked against this account, most-imminent first.
  const scheduledForAccount = useMemo(
    () =>
      scheduled
        .filter((s) => s.accountId === accountId && s.isActive)
        .sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate)),
    [scheduled, accountId],
  );

  // Detected charges that are not already covered by a scheduled bill, matched
  // by payee id (preferred) or a loose payee-name comparison.
  const potential = useMemo(() => {
    const scheduledPayeeIds = new Set(
      scheduledForAccount.map((s) => s.payeeId).filter((id): id is string => !!id),
    );
    const scheduledNames = new Set(
      scheduledForAccount
        .flatMap((s) => [normaliseName(s.payeeName), normaliseName(s.name)])
        .filter(Boolean),
    );
    return [...detected]
      .filter((c) => {
        if (c.payeeId && scheduledPayeeIds.has(c.payeeId)) return false;
        const name = normaliseName(c.payeeName);
        return !(name && scheduledNames.has(name));
      })
      .sort((a, b) => b.dates.length - a.dates.length);
  }, [detected, scheduledForAccount]);

  const isEmpty = scheduledForAccount.length === 0 && potential.length === 0;

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('recurring.title')}
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{t('recurring.subtitle')}</p>
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 space-y-6">
        {isLoading ? (
          <div className="h-20 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
        ) : isEmpty ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('recurring.empty')}</p>
        ) : (
          <>
            {scheduledForAccount.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
                  {t('recurring.scheduledTitle')}
                </h3>
                <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                  {scheduledForAccount.map((s) => (
                    <li key={s.id} className="flex items-center justify-between py-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                          {s.payeeName || s.name}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {tf(`frequency.${s.frequency}` as 'frequency.MONTHLY')}
                          {' · '}
                          {t('recurring.nextDue', { date: formatDate(s.nextDueDate) })}
                        </div>
                      </div>
                      <div
                        className={`text-sm font-medium tabular-nums ${scheduledAmountClass(s)}`}
                      >
                        {scheduledAmountSign(s)}
                        {formatCurrency(Math.abs(Number(s.amount)), s.currencyCode)}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {potential.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
                  {t('recurring.detectedTitle')}
                </h3>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                  {t('recurring.detectedSubtitle')}
                </p>
                <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                  {potential.map((c, i) => (
                    <li
                      key={`${c.payeeId ?? c.payeeName}-${i}`}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                          {c.payeeName}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {t(`recurring.frequency.${c.frequency}` as 'recurring.frequency.monthly')}
                          {c.categoryName ? ` · ${c.categoryName}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100 tabular-nums">
                          {formatCurrency(Math.abs(c.currentAmount), currencyCode)}
                        </span>
                        <button
                          type="button"
                          onClick={() => setTemplate(toTemplate(c, accountId, currencyCode))}
                          aria-label={t('recurring.createBillAria', { payee: c.payeeName })}
                          title={t('recurring.createBill')}
                          className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 px-2 py-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-700/60 transition-colors"
                        >
                          <PlusCircleIcon className="h-4 w-4" />
                          <span className="hidden sm:inline">{t('recurring.createBill')}</span>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      <Modal
        isOpen={template !== null}
        onClose={() => setTemplate(null)}
        maxWidth="6xl"
        className="p-6 !max-w-[69rem]"
        pushHistory
      >
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
          {t('recurring.createTitle')}
        </h2>
        {template && (
          <ScheduledTransactionForm
            templateTransaction={template}
            onSuccess={() => {
              setTemplate(null);
              setReloadKey((k) => k + 1);
            }}
            onCancel={() => setTemplate(null)}
          />
        )}
      </Modal>
    </section>
  );
}
