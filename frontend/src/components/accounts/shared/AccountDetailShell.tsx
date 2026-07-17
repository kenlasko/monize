'use client';

import { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { PageHeader } from '@/components/layout/PageHeader';
import { InstitutionLogo, InstitutionLogoData } from '@/components/institutions/InstitutionLogo';
import { formatAccountType } from '@/lib/account-utils';
import type { Account } from '@/types/account';

export interface AccountDetailShellProps {
  account: Account;
  /** Institution for the header logo; omit to render no logo. */
  institution?: InstitutionLogoData | null;
  /** Standard header actions -- each button appears only when its handler is set. */
  onViewTransactions?: () => void;
  onReconcile?: () => void;
  onEdit?: () => void;
  onExport?: () => void;
  onBack?: () => void;
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
  headerActions,
  isLoading,
  error,
  onRetry,
  children,
}: AccountDetailShellProps) {
  const t = useTranslations('accountDetail');
  const tc = useTranslations('common');

  // "Back to Accounts" leads the action row, set off from the page-specific
  // actions by a minimalist vertical divider.
  const hasTrailingActions = !!(
    headerActions ||
    onViewTransactions ||
    onReconcile ||
    onEdit ||
    onExport
  );

  const actions = (
    <>
      {onBack && (
        <Button variant="outline" onClick={onBack}>
          {t('header.back')}
        </Button>
      )}
      {onBack && hasTrailingActions && (
        <span
          aria-hidden="true"
          className="hidden sm:block h-6 border-l border-gray-300 dark:border-gray-600"
        />
      )}
      {headerActions}
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
      {onEdit && (
        <Button variant="outline" onClick={onEdit}>
          {t('header.edit')}
        </Button>
      )}
      {onExport && <ExportDropdown onExportPdf={onExport} />}
    </>
  );

  return (
    <div>
      <PageHeader
        title={account.name}
        subtitle={`${formatAccountType(account.accountType, tc)} - ${account.currencyCode}`}
        icon={institution ? <InstitutionLogo institution={institution} size={28} /> : undefined}
        actions={actions}
      />
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
