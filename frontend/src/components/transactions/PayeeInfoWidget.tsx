'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
  PencilSquareIcon,
  ChevronDoubleLeftIcon,
  EyeIcon,
} from '@heroicons/react/24/outline';
import { Payee, PayeeAlias } from '@/types/payee';
import { Category } from '@/types/category';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { GroupedTotal, TransactionSummary } from '@/types/transaction';
import { transactionsApi } from '@/lib/transactions';
import { payeesApi } from '@/lib/payees';
import { getNextScheduled } from '@/lib/scheduled-utils';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { buildCategoryLabelMap } from '@/lib/categoryUtils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { PayeeLogo } from '@/components/payees/PayeeLogo';
import { createLogger } from '@/lib/logger';
import {
  WidgetFilterParams,
  buildDisplayCurrencyStrategy,
  summarizeInDisplayCurrency,
  aggregateGroupedTotals,
} from './widget-shared';

const logger = createLogger('PayeeInfoWidget');

const CADENCE_KEYS = new Set(['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']);

interface PayeeInfoWidgetProps {
  payee: Payee;
  categories: Category[];
  /** Scheduled bills/deposits; the soonest for this payee is surfaced. */
  scheduledTransactions?: ScheduledTransaction[];
  /** Active page filters (date range, accounts, ...) minus any payee ids. */
  filterParams: WidgetFilterParams;
  /** Bumped by the page on every reload so the summary refetches in lockstep. */
  refreshKey?: number;
  /** Open the shared payee edit modal for this payee. */
  onEdit: () => void;
  /** Collapse the widget so the chart can use the full width. */
  onCollapse: () => void;
  /** Narrow the transaction filter to one of the payee's top categories. */
  onCategoryClick?: (categoryId: string) => void;
}

/**
 * Compact payee summary shown beside the chart when the Transactions list is
 * filtered to a single payee. Mirrors the AccountInfoWidget card: period
 * totals from the summary endpoint, the soonest scheduled bill, the payee's
 * top categories, recurring-cadence detection, and descriptive details.
 */
export function PayeeInfoWidget({
  payee,
  categories,
  scheduledTransactions = [],
  filterParams,
  refreshKey,
  onEdit,
  onCollapse,
  onCategoryClick,
}: PayeeInfoWidgetProps) {
  const t = useTranslations('transactions');
  const router = useRouter();
  const ts = useTranslations('settings.preferences');
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const { convertToDefault, defaultCurrency } = useExchangeRates();

  const [summary, setSummary] = useState<TransactionSummary | null>(null);
  const [topCategories, setTopCategories] = useState<GroupedTotal[]>([]);
  const [recurring, setRecurring] = useState<{ cadence: string; amount: number } | null>(null);
  const [aliases, setAliases] = useState<PayeeAlias[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Refetch when the payee or any surrounding filter changes; the params
  // object is rebuilt every render, so key the effect on its serialization.
  const filterKey = JSON.stringify(filterParams);

  useEffect(() => {
    let cancelled = false;
    const params: WidgetFilterParams = JSON.parse(filterKey);

    // Cadence detection needs a long enough window to see repeats, so fall
    // back to the trailing 12 months when no date filter is active.
    const today = new Date().toISOString().split('T')[0];
    const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];

    const load = async () => {
      setIsLoading(true);
      const [summaryResult, groupedResult, recurringResult, aliasesResult] = await Promise.all([
        transactionsApi
          .getSummary({ basis: 'cash', ...params, payeeIds: [payee.id] })
          .catch((error) => {
            logger.error(error);
            return null;
          }),
        transactionsApi
          .getGroupedTotals({ basis: 'cash', ...params, groupBy: 'category', payeeIds: [payee.id], limit: 25 })
          .catch((error) => {
            logger.error(error);
            return [] as GroupedTotal[];
          }),
        transactionsApi
          .getRecurringCharges({
            payeeIds: [payee.id],
            startDate: params.startDate ?? yearAgo,
            endDate: params.endDate ?? today,
          })
          .catch(() => []),
        payeesApi.getAliases(payee.id).catch(() => [] as PayeeAlias[]),
      ]);
      if (cancelled) return;
      setSummary(summaryResult);
      setTopCategories(groupedResult);
      // A payee can produce one row per category; the row with the most
      // observations is the payee's dominant cadence.
      const best = [...recurringResult]
        .filter((r) => CADENCE_KEYS.has(r.frequency))
        .sort((a, b) => b.dates.length - a.dates.length)[0];
      setRecurring(best ? { cadence: best.frequency, amount: best.currentAmount } : null);
      setAliases(aliasesResult);
      setIsLoading(false);
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [payee.id, filterKey, refreshKey]);

  const nextBill = useMemo(
    () =>
      getNextScheduled(
        scheduledTransactions,
        (st) => st.payeeId === payee.id || (!st.payeeId && st.payeeName === payee.name),
      ),
    [scheduledTransactions, payee.id, payee.name],
  );

  const currencyStrategy = useMemo(
    () => buildDisplayCurrencyStrategy(summary, defaultCurrency, convertToDefault),
    [summary, defaultCurrency, convertToDefault],
  );

  const totals = useMemo(
    () => (summary ? summarizeInDisplayCurrency(summary, currencyStrategy) : null),
    [summary, currencyStrategy],
  );

  const categoryLabelMap = useMemo(() => buildCategoryLabelMap(categories), [categories]);

  const topThreeCategories = useMemo(
    () => aggregateGroupedTotals(topCategories, currencyStrategy).slice(0, 3),
    [topCategories, currencyStrategy],
  );

  const transactionCount = summary?.transactionCount ?? 0;
  // Average over the transactions the figures actually sum, not the full count
  // (which includes transactions excluded for want of a rate).
  const averageAmount =
    totals && totals.includedTransactionCount > 0
      ? (totals.income + totals.expenses) / totals.includedTransactionCount
      : null;
  // A currency bucket with no rate is excluded from the summary figures, so each
  // headline is marked partial rather than presented as the complete total.
  const summaryMarker = {
    missingCurrencies: totals?.missingCurrencies ?? [],
    excludedCount: totals?.excludedTransactionCount ?? 0,
  };
  // The label map wins over the relation's own name: it carries the parent
  // ("Utilities: Hydro"), and the relation only ever holds the leaf, which is
  // ambiguous when several parents own a category of the same name.
  const defaultCategoryName = payee.defaultCategoryId
    ? (categoryLabelMap.get(payee.defaultCategoryId) ??
      payee.defaultCategory?.name ??
      null)
    : null;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6 mb-6 lg:mb-0 lg:absolute lg:inset-x-0 lg:top-0 lg:bottom-6 lg:overflow-y-auto flex flex-col">
      <div className="flex items-start justify-between gap-2 mb-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <PayeeLogo payee={payee} size={28} className="mt-0.5 max-sm:hidden" />
          <div className="min-w-0">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
            {payee.name}
          </h3>
          {!payee.isActive && (
            <span className="inline-block mt-1 text-xs font-medium px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
              {t('payeeWidget.inactive')}
            </span>
          )}
          </div>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            type="button"
            onClick={() => router.push(`/payees/${payee.id}${filterParams?.basis ? `?basis=${filterParams.basis}` : ''}`)}
            aria-label={t('payeeWidget.detailsAria')}
            title={t('payeeWidget.detailsAria')}
            className="text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded p-1"
          >
            <EyeIcon className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={onEdit}
            aria-label={t('payeeWidget.editAria')}
            title={t('payeeWidget.editAria')}
            className="text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded p-1"
          >
            <PencilSquareIcon className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={onCollapse}
            aria-label={t('payeeWidget.collapseAria')}
            title={t('payeeWidget.collapseAria')}
            className="text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded p-1"
          >
            <ChevronDoubleLeftIcon className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div className="mb-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('payeeWidget.totalSpent')}</p>
        <p className="text-2xl font-bold text-red-600 dark:text-red-400">
          {totals ? (
            <PartialTotal total={{ value: totals.expenses, ...summaryMarker }} displayCurrency={currencyStrategy.displayCurrency}>
              {formatCurrency(totals.expenses, currencyStrategy.displayCurrency)}
            </PartialTotal>
          ) : (
            '—'
          )}
        </p>
        {recurring && (
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 flex items-center">
            {t('payeeWidget.recurring', {
              cadence: t(`payeeWidget.cadence.${recurring.cadence}`),
              amount: formatCurrency(recurring.amount, currencyStrategy.displayCurrency),
            })}
            <span className="ml-1">({ts('reportingCash')})</span>
            <InfoTooltip text={t('payeeWidget.recurringTooltip')} usePortal />
          </p>
        )}
      </div>

      {nextBill && (
        <button
          type="button"
          onClick={() => router.push('/bills')}
          title={t('payeeWidget.viewBills')}
          className="mb-4 w-full text-left rounded-md bg-gray-50 dark:bg-gray-700/40 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors px-3 py-2"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('payeeWidget.nextBill')}
              </p>
              <p
                className={`text-base font-semibold ${
                  nextBill.amount !== null && nextBill.amount < 0
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-green-600 dark:text-green-400'
                }`}
              >
                {/* An occurrence whose current amount could not be resolved is shown
                  as unavailable, never as its stale stored figure (issue
                  #1247). */}
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

      <dl className="space-y-2 text-sm mb-4">
        {totals && totals.income > 0 && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-gray-500 dark:text-gray-400">{t('payeeWidget.income')}</dt>
            <dd className="text-green-600 dark:text-green-400 text-right">
              <PartialTotal total={{ value: totals.income, ...summaryMarker }} displayCurrency={currencyStrategy.displayCurrency}>
                {formatCurrency(totals.income, currencyStrategy.displayCurrency)}
              </PartialTotal>
            </dd>
          </div>
        )}
        {totals && totals.income > 0 && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-gray-500 dark:text-gray-400">{t('payeeWidget.net')}</dt>
            <dd className="text-gray-900 dark:text-gray-100 text-right">
              <PartialTotal total={{ value: totals.net, ...summaryMarker }} displayCurrency={currencyStrategy.displayCurrency}>
                {formatCurrency(totals.net, currencyStrategy.displayCurrency)}
              </PartialTotal>
            </dd>
          </div>
        )}
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-gray-500 dark:text-gray-400">{t('payeeWidget.transactions')}</dt>
          <dd className="text-gray-900 dark:text-gray-100 text-right">{transactionCount}</dd>
        </div>
        {averageAmount !== null && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-gray-500 dark:text-gray-400">{t('payeeWidget.averageAmount')}</dt>
            <dd className="text-gray-900 dark:text-gray-100 text-right">
              <PartialTotal total={{ value: averageAmount, ...summaryMarker }} displayCurrency={currencyStrategy.displayCurrency}>
                {formatCurrency(averageAmount, currencyStrategy.displayCurrency)}
              </PartialTotal>
            </dd>
          </div>
        )}
        {summary?.lastTransactionDate && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-gray-500 dark:text-gray-400">{t('payeeWidget.lastTransaction')}</dt>
            <dd className="text-gray-900 dark:text-gray-100 text-right">
              {formatDate(summary.lastTransactionDate)}
            </dd>
          </div>
        )}
        {defaultCategoryName && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-gray-500 dark:text-gray-400">
              {t('payeeWidget.defaultCategory')}
            </dt>
            <dd className="text-gray-900 dark:text-gray-100 text-right truncate">
              {defaultCategoryName}
            </dd>
          </div>
        )}
      </dl>

      {!isLoading && transactionCount === 0 && (
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          {t('payeeWidget.noTransactions')}
        </p>
      )}

      {topThreeCategories.length > 0 && (
        <div className="mb-4">
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
            {t('payeeWidget.topCategories')}
          </p>
          <ul className="space-y-1 text-sm">
            {topThreeCategories.map((row) => {
              const label = row.id
                ? (categoryLabelMap.get(row.id) ?? row.name ?? row.id)
                : t('payeeWidget.uncategorized');
              const amount =
                row.total === null
                  ? t('payeeWidget.amountUnavailable')
                  : formatCurrency(Math.abs(row.total), currencyStrategy.displayCurrency);
              return (
                <li key={row.id ?? 'uncategorized'}>
                  {row.id && onCategoryClick ? (
                    <button
                      type="button"
                      onClick={() => onCategoryClick(row.id!)}
                      className="w-full flex items-baseline justify-between gap-3 text-left rounded hover:bg-gray-50 dark:hover:bg-gray-700/40 px-1 -mx-1"
                    >
                      <span className="text-blue-600 dark:text-blue-400 truncate">{label}</span>
                      <span className="text-gray-900 dark:text-gray-100">{amount}</span>
                    </button>
                  ) : (
                    <div className="flex items-baseline justify-between gap-3 px-1 -mx-1">
                      <span className="text-gray-700 dark:text-gray-300 truncate">{label}</span>
                      <span className="text-gray-900 dark:text-gray-100">{amount}</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {aliases.length > 0 && (
        <div className="mb-4">
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
            {t('payeeWidget.aliases')}
          </p>
          <div className="flex flex-wrap gap-1">
            {aliases.map((alias) => (
              <span
                key={alias.id}
                className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 break-all"
              >
                {alias.alias}
              </span>
            ))}
          </div>
        </div>
      )}

      {payee.notes && (
        <p className="mt-auto text-sm text-gray-500 dark:text-gray-400 break-words">
          {payee.notes}
        </p>
      )}
    </div>
  );
}
