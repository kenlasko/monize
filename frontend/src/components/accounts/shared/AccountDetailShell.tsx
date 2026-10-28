'use client';

import { CashReportingNotice } from '@/components/reports/CashReportingNotice';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { ChevronLeftIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/Button';
import { InstitutionLogo, InstitutionLogoData } from '@/components/institutions/InstitutionLogo';
import { formatAccountType } from '@/lib/account-utils';
import type { Account } from '@/types/account';
import { AccountSwitcher } from './AccountSwitcher';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import { createLogger } from '@/lib/logger';

const logger = createLogger('AccountDetailShell');

export interface AccountDetailShellProps {
  account: Account;
  /** Institution for the header logo; omit to render no logo. */
  institution?: InstitutionLogoData | null;
  /** Standard header actions -- each button appears only when its handler is set. */
  onViewTransactions?: () => void;
  onReconcile?: () => void;
  onEdit?: () => void;
  onExport?: () => void;
  /** Renders the "Back to Accounts" link above the name. */
  onBack?: () => void;
  /** Accounts the caret beside the name can jump to. Empty hides the caret. */
  accounts?: readonly Account[];
  onSelectAccount?: (id: string) => void;
  /** Type-specific action buttons rendered before the standard set. */
  headerActions?: ReactNode;
  /** Render a loading placeholder in place of the body. */
  isLoading?: boolean;
  /** Inline error rendered in place of the body, with an optional retry. */
  error?: string | null;
  onRetry?: () => void;
  /** The type-specific detail view body. */
  children: ReactNode;
}

/**
 * Shared chrome for every account detail page: the page header (name, formatted
 * type + currency, optional institution logo, standard actions) plus loading
 * and error handling. Each per-type view composes its panels as `children`.
 *
 * Actions are opt-in: a view passes only the handlers that make sense for its
 * account type, so the debt views (which pass just view-transactions and back)
 * render exactly as before.
 */
export function AccountDetailShell({
  account,
  institution,
  onViewTransactions,
  onReconcile,
  onEdit,
  onExport,
  onBack,
  accounts,
  onSelectAccount,
  headerActions,
  isLoading,
  error,
  onRetry,
  children,
}: AccountDetailShellProps) {
  const t = useTranslations('accountDetail');
  const tc = useTranslations('common');
  // An investment pair's stored name carries the ledger suffix; the page is
  // about the account, so the title drops it.
  const displayName = useMainAccountName()(account.name);
  const [isExporting, setIsExporting] = useState(false);
  // Guards the async export's setState against an unmount mid-generation.
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const handleExport = async () => {
    if (!onExport) return;
    setIsExporting(true);
    try {
      await onExport();
    } catch (error) {
      logger.error('PDF export failed:', error);
      toast.error(tc('exportDropdown.failedPdf'));
    } finally {
      if (mountedRef.current) setIsExporting(false);
    }
  };

  // Export PDF leads the action row, set off from the navigation actions by a
  // minimalist vertical divider. Every action is the same outline Button so the
  // row reads as one consistent set. Going back is no longer among them: it is
  // the link above the name, matching the securities and payees detail pages.
  const hasNavActions = !!(
    onViewTransactions ||
    onReconcile ||
    onEdit ||
    headerActions
  );

  return (
    <div>
      <div className="mb-6">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="mb-2 -ml-1 inline-flex items-center gap-1 rounded text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
            {t('header.back')}
          </button>
        )}

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            {institution && <InstitutionLogo institution={institution} size={28} />}
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1">
                <h1 className="truncate text-2xl font-bold text-gray-900 dark:text-gray-100">
                  {displayName}
                </h1>
                {(account.isJoint || account.jointGranteeCount !== undefined) && (
                  <span className="ml-1 px-2 inline-flex flex-shrink-0 text-xs leading-5 font-semibold rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                    {t('header.jointBadge')}
                  </span>
                )}
                {/* Jump straight to another account instead of going back to
                    the list and clicking again. */}
                {accounts && onSelectAccount && (
                  <AccountSwitcher
                    currentId={account.id}
                    accounts={accounts}
                    onSelect={onSelectAccount}
                  />
                )}
              </div>
              <p className="text-gray-500 dark:text-gray-400">
                {`${formatAccountType(account.accountType, tc)} - ${account.currencyCode}`}
              </p>
              {account.isJoint && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  {t('header.jointSharedBy', { owner: account.ownerLabel ?? '' })}
                </p>
              )}
              {!account.isJoint && account.jointGranteeCount !== undefined && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  {t('header.jointSharedWith', { count: account.jointGranteeCount })}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {onExport && (
              <Button variant="outline" onClick={handleExport} isLoading={isExporting}>
                {tc('exportDropdown.exportPdf')}
              </Button>
            )}
            {onExport && hasNavActions && (
              <span
                aria-hidden="true"
                className="hidden sm:block h-6 border-l border-gray-300 dark:border-gray-600"
              />
            )}
            {onViewTransactions && (
              <Button variant="outline" onClick={onViewTransactions}>
                {t('header.viewTransactions')}
              </Button>
            )}
            {onReconcile && (
              <Button variant="outline" onClick={onReconcile}>
                {t('header.reconcile')}
              </Button>
            )}
            {headerActions}
            {/* Last, so Edit sits at the top right of the page. */}
            {onEdit && (
              <Button variant="outline" onClick={onEdit}>
                {t('header.edit')}
              </Button>
            )}
          </div>
        </div>
      </div>
      <CashReportingNotice />
      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950"
        >
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="text-sm font-medium text-red-600 hover:text-red-700 dark:text-red-400"
              >
                {t('error.retry')}
              </button>
            )}
          </div>
        </div>
      ) : isLoading ? (
        <div className="py-12 text-center text-gray-500 dark:text-gray-400" aria-busy="true">
          {t('loading')}
        </div>
      ) : (
        children
      )}
    </div>
  );
}
