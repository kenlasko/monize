'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { PencilSquareIcon, ChevronDoubleLeftIcon } from '@heroicons/react/24/outline';
import { Account } from '@/types/account';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { formatAccountType } from '@/lib/account-utils';
import { getOrdinal } from '@/lib/ordinal';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { InstitutionLogo, InstitutionLogoData } from '@/components/institutions/InstitutionLogo';
import { InfoTooltip } from '@/components/ui/InfoTooltip';

interface AccountInfoWidgetProps {
  account: Account;
  /** The account's institution, when assigned, for the logo + name. The
   *  optional website makes the logo a link to the institution's site. */
  institution?: (InstitutionLogoData & { website?: string }) | null;
  /** Scheduled bills/deposits; the soonest for this account is surfaced. */
  scheduledTransactions?: ScheduledTransaction[];
  /** Open the shared account edit modal for this account. */
  onEdit: () => void;
  /** Collapse the widget so the chart can use the full width. */
  onCollapse: () => void;
}

/**
 * Compact account summary shown beside the Account Balance chart when the
 * Transactions list is filtered to a single account. The pencil opens the same
 * edit modal used on the Accounts page via the supplied `onEdit` callback.
 */
export function AccountInfoWidget({
  account,
  institution,
  scheduledTransactions = [],
  onEdit,
  onCollapse,
}: AccountInfoWidgetProps) {
  const t = useTranslations('transactions');
  const tc = useTranslations('common');
  const router = useRouter();
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();

  const isLiability = ['CREDIT_CARD', 'LOAN', 'MORTGAGE', 'LINE_OF_CREDIT'].includes(
    account.accountType,
  );
  const balance = Number(account.currentBalance) || 0;
  // Prefer the linked institution's canonical name; fall back to the legacy
  // free-text field stored on the account.
  const institutionName = institution?.name ?? account.institution ?? null;
  // Only treat http(s) URLs as a safe link target, to avoid javascript:/data:
  // URIs ever reaching the href.
  const institutionWebsite =
    institution?.website && /^https?:\/\//i.test(institution.website)
      ? institution.website
      : undefined;

  // The soonest active scheduled bill/deposit booked against this account.
  // Honours a per-occurrence override for both the date and the amount.
  const nextPayment = useMemo(() => {
    const candidates = scheduledTransactions
      .filter((st) => st.isActive && st.accountId === account.id)
      .map((st) => ({
        date: (st.nextOverride?.overrideDate ?? st.nextDueDate).split('T')[0],
        amount: st.nextOverride?.amount ?? st.amount,
        currencyCode: st.currencyCode,
        payeeName: st.payee?.name ?? st.payeeName ?? null,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return candidates[0] ?? null;
  }, [scheduledTransactions, account.id]);

  const details: Array<{ label: string; value: string; tooltip?: string }> = [];
  details.push({
    label: t('accountWidget.type'),
    value: formatAccountType(account.accountType, tc),
  });
  if (account.accountNumber) {
    details.push({ label: t('accountWidget.accountNumber'), value: account.accountNumber });
  }
  details.push({ label: t('accountWidget.currency'), value: account.currencyCode });
  if (account.creditLimit != null && Number(account.creditLimit) !== 0) {
    details.push({
      label: t('accountWidget.creditLimit'),
      value: formatCurrency(Number(account.creditLimit), account.currencyCode),
    });
  }
  if (account.interestRate != null && Number(account.interestRate) !== 0) {
    details.push({
      label: t('accountWidget.interestRate'),
      value: `${Number(account.interestRate)}%`,
    });
  }
  if (account.statementSettlementDay) {
    details.push({
      label: t('accountWidget.statementSettlement'),
      value: getOrdinal(account.statementSettlementDay),
      tooltip: t('accountWidget.statementSettlementTooltip'),
    });
  }
  if (account.statementDueDay) {
    details.push({
      label: t('accountWidget.statementDue'),
      value: getOrdinal(account.statementDueDay),
    });
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6 mb-6 lg:mb-0 lg:absolute lg:inset-x-0 lg:top-0 lg:bottom-6 lg:overflow-y-auto flex flex-col">
      <div className="flex items-start justify-between gap-2 mb-4">
        <div className="flex items-center gap-3 min-w-0">
          {institutionWebsite ? (
            <a
              href={institutionWebsite}
              target="_blank"
              rel="noopener noreferrer"
              title={institutionWebsite}
              className="flex-shrink-0 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <InstitutionLogo institution={institution} size={40} fallbackGlyph="$" />
            </a>
          ) : (
            <InstitutionLogo institution={institution ?? undefined} size={40} fallbackGlyph="$" />
          )}
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
              {account.name}
            </h3>
            {(institutionName || account.isClosed) && (
              <div className="flex items-center gap-2 min-w-0">
                {institutionName && (
                  <p className="text-sm text-gray-500 dark:text-gray-400 truncate">
                    {institutionName}
                  </p>
                )}
                {account.isClosed && (
                  <span className="flex-shrink-0 text-xs font-medium px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                    {t('accountWidget.closed')}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            type="button"
            onClick={onEdit}
            aria-label={t('accountWidget.editAria')}
            title={t('accountWidget.editAria')}
            className="text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded p-1"
          >
            <PencilSquareIcon className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={onCollapse}
            aria-label={t('accountWidget.collapseAria')}
            title={t('accountWidget.collapseAria')}
            className="text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded p-1"
          >
            <ChevronDoubleLeftIcon className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div className="mb-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('accountWidget.currentBalance')}
        </p>
        <p
          className={`text-2xl font-bold ${
            balance < 0 || isLiability
              ? 'text-red-600 dark:text-red-400'
              : 'text-gray-900 dark:text-gray-100'
          }`}
        >
          {formatCurrency(balance, account.currencyCode)}
        </p>
      </div>

      {nextPayment && (
        <button
          type="button"
          onClick={() => router.push('/bills')}
          title={t('accountWidget.viewBills')}
          className="mb-4 w-full text-left rounded-md bg-gray-50 dark:bg-gray-700/40 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors px-3 py-2"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('accountWidget.nextPayment')}
              </p>
              <p
                className={`text-base font-semibold ${
                  nextPayment.amount < 0
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-green-600 dark:text-green-400'
                }`}
              >
                {formatCurrency(Math.abs(nextPayment.amount), nextPayment.currencyCode)}
              </p>
            </div>
            <div className="text-right min-w-0">
              {nextPayment.payeeName && (
                <p className="text-sm text-gray-700 dark:text-gray-300 truncate">
                  {nextPayment.payeeName}
                </p>
              )}
              <p className="text-base font-semibold text-gray-700 dark:text-gray-300">
                {formatDate(nextPayment.date)}
              </p>
            </div>
          </div>
        </button>
      )}

      <dl className="space-y-2 text-sm">
        {details.map((detail) => (
          <div key={detail.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-gray-500 dark:text-gray-400 flex-shrink-0 flex items-center">
              {detail.label}
              {detail.tooltip && <InfoTooltip text={detail.tooltip} usePortal />}
            </dt>
            <dd className="text-gray-900 dark:text-gray-100 text-right truncate">
              {detail.value}
            </dd>
          </div>
        ))}
      </dl>

      {account.description && (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400 break-words">
          {account.description}
        </p>
      )}
    </div>
  );
}
