'use client';

import { useTranslations } from 'next-intl';
import {
  ArrowTopRightOnSquareIcon,
  ChevronLeftIcon,
} from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/Button';
import { useDateFormat } from '@/hooks/useDateFormat';
import { parseLocalDate } from '@/lib/utils';
import { toSafeExternalUrl } from '@/lib/external-url';
import type { Payee } from '@/types/payee';
import { PayeeLogo } from '@/components/payees/PayeeLogo';
import { PayeeSwitcher } from './PayeeSwitcher';

interface PayeeDetailHeaderProps {
  payee: Payee;
  /**
   * Transactions can predate the payee record (imports assign them to a payee
   * created afterwards), so "Payee since" is the earlier of the first
   * transaction and the record's creation.
   */
  firstTransactionDate: string | null;
  onBack: () => void;
  onViewTransactions: () => void;
  onEdit: () => void;
  onMerge: () => void;
  /** Deactivate for an active payee, reactivate for an inactive one. */
  onToggleActive: () => void;
  isTogglePending: boolean;
  /** Payees the caret beside the name can jump to. */
  payees: readonly Payee[];
  onSelectPayee: (id: string) => void;
}

/**
 * The identity block: which payee this is and the actions on it. Default
 * category and dates live in the Key information card below, so the header
 * stays one line -- the same division the security detail header settled on.
 */
export function PayeeDetailHeader({
  payee,
  firstTransactionDate,
  onBack,
  onViewTransactions,
  onEdit,
  onMerge,
  onToggleActive,
  isTogglePending,
  payees,
  onSelectPayee,
}: PayeeDetailHeaderProps) {
  const t = useTranslations('payeeDetail');
  const { formatDate } = useDateFormat();

  // Null unless the stored address is really http(s); a link built from an
  // unchecked string is a link that can run something.
  const websiteUrl = toSafeExternalUrl(payee.website);

  // Compare calendar days (parseLocalDate drops the time), matching what
  // formatDate renders.
  const sinceDate =
    firstTransactionDate &&
    parseLocalDate(firstTransactionDate) < parseLocalDate(payee.createdAt)
      ? firstTransactionDate
      : payee.createdAt;

  return (
    <div className="mb-6">
      <button
        type="button"
        onClick={onBack}
        className="mb-2 -ml-1 inline-flex items-center gap-1 rounded text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
        {t('backToPayees')}
      </button>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-1">
            <PayeeLogo payee={payee} size={28} className="mr-2" />
            <h1 className="truncate text-2xl font-bold text-gray-900 dark:text-gray-100">
              {payee.name}
            </h1>
            {/* Jump straight to another payee instead of going back to the
                list and clicking again. */}
            <PayeeSwitcher
              currentId={payee.id}
              payees={payees}
              onSelect={onSelectPayee}
            />
            {websiteUrl && (
              // `noopener` is the security control, not decoration: without it
              // the opened page gets a handle on this one via window.opener.
              <a
                href={websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t('header.visitWebsite', { name: payee.name })}
                title={websiteUrl}
                className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              >
                <ArrowTopRightOnSquareIcon
                  className="h-5 w-5"
                  aria-hidden="true"
                />
              </a>
            )}
          </div>

          {!payee.isActive && (
            <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300">
              {t('header.inactiveBadge')}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onViewTransactions}>
            {t('header.viewTransactions')}
          </Button>
          {payee.isActive && (
            <Button variant="outline" size="sm" onClick={onMerge}>
              {t('header.merge')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onEdit}>
            {t('header.edit')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onToggleActive}
            isLoading={isTogglePending}
          >
            {payee.isActive ? t('header.deactivate') : t('header.reactivate')}
          </Button>
        </div>
      </div>

      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        {t('header.since', { date: formatDate(sinceDate) })}
      </p>
    </div>
  );
}
