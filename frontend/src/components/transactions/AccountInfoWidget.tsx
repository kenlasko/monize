'use client';

import { useTranslations } from 'next-intl';
import { PencilSquareIcon, ChevronDoubleLeftIcon } from '@heroicons/react/24/outline';
import { Account } from '@/types/account';
import { formatAccountType } from '@/lib/account-utils';
import { getOrdinal } from '@/lib/ordinal';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { InstitutionLogo, InstitutionLogoData } from '@/components/institutions/InstitutionLogo';
import { InfoTooltip } from '@/components/ui/InfoTooltip';

interface AccountInfoWidgetProps {
  account: Account;
  /** The account's institution, when assigned, for the logo + name. */
  institution?: InstitutionLogoData | null;
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
export function AccountInfoWidget({ account, institution, onEdit, onCollapse }: AccountInfoWidgetProps) {
  const t = useTranslations('transactions');
  const tc = useTranslations('common');
  const { formatCurrency } = useNumberFormat();

  const isLiability = ['CREDIT_CARD', 'LOAN', 'MORTGAGE', 'LINE_OF_CREDIT'].includes(
    account.accountType,
  );
  const balance = Number(account.currentBalance) || 0;
  // Prefer the linked institution's canonical name; fall back to the legacy
  // free-text field stored on the account.
  const institutionName = institution?.name ?? account.institution ?? null;

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
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6 mb-6 min-h-[420px] h-full flex flex-col">
      <div className="flex items-start justify-between gap-2 mb-4">
        <div className="flex items-start gap-3 min-w-0">
          <InstitutionLogo institution={institution ?? undefined} size={32} fallbackGlyph="$" />
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
              {account.name}
            </h3>
            {institutionName && (
              <p className="text-sm text-gray-500 dark:text-gray-400 truncate">
                {institutionName}
              </p>
            )}
            {account.isClosed && (
              <span className="inline-block mt-1 text-xs font-medium px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                {t('accountWidget.closed')}
              </span>
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

      <dl className="space-y-2 text-sm">
        {details.map((detail) => (
          <div key={detail.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-gray-500 dark:text-gray-400 flex-shrink-0 flex items-center">
              {detail.label}
              {detail.tooltip && <InfoTooltip text={detail.tooltip} />}
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
