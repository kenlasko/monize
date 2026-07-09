'use client';

import { memo } from 'react';
import { useTranslations } from 'next-intl';
import { gainLossColor } from '@/lib/format';
import { Account, AccountType } from '@/types/account';
import { InstitutionLogo, InstitutionLogoData } from '@/components/institutions/InstitutionLogo';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import type { LongPressRowHandlers } from '@/hooks/useLongPress';
import type { RowAction } from '@/components/ui/row-actions/rowAction';

export interface AccountActionLabels {
  viewTransactions: string;
  details: string;
  edit: string;
  reconcile: string;
  close: string;
  closeTitleDisabled: string;
  closeTitleEnabled: string;
  reopen: string;
  delete: string;
}

export interface AccountActionHandlers {
  onViewTransactions?: (account: Account) => void;
  onDetails?: (account: Account) => void;
  onEdit: (account: Account) => void;
  onReconcile: (account: Account) => void;
  onCloseClick: (account: Account) => void;
  onReopen: (account: Account) => void;
  onDeleteClick: (account: Account) => void;
}

/**
 * Account types with a dedicated detail page (the "Details" row action). Grows
 * as per-type detail views land; today it is the debt accounts.
 */
export const DETAIL_ACCOUNT_TYPES: AccountType[] = [
  'LOAN',
  'MORTGAGE',
  'LINE_OF_CREDIT',
  'CREDIT_CARD',
  'CHEQUING',
  'SAVINGS',
  'CASH',
  'INVESTMENT',
  'ASSET',
  'OTHER',
];

/**
 * Builds the standard row actions for an account. Shared by the desktop
 * `RowActions` cell and the mobile `RowActionSheet`. The desktop surface omits
 * "View transactions" (a row tap already opens it) by leaving `onViewTransactions`
 * undefined; the action sheet supplies it.
 */
export function buildAccountActions(
  account: Account,
  isDeletable: boolean,
  labels: AccountActionLabels,
  handlers: AccountActionHandlers,
  brokerageMarketValue?: number,
): RowAction[] {
  // Brokerage accounts display their holdings' market value rather than the
  // cash `currentBalance` (which is usually zero), so a brokerage with
  // securities must block closure based on that market value instead.
  const balanceNonZero =
    account.accountSubType === 'INVESTMENT_BROKERAGE' && brokerageMarketValue !== undefined
      ? Math.round(brokerageMarketValue * 10000) !== 0
      : Number(account.currentBalance) !== 0;
  return [
    {
      key: 'view',
      label: labels.viewTransactions,
      icon: 'transactions',
      tone: 'neutral',
      onClick: () => handlers.onViewTransactions?.(account),
      hidden: !handlers.onViewTransactions,
    },
    {
      key: 'details',
      label: labels.details,
      icon: 'prices',
      tone: 'primary',
      onClick: () => handlers.onDetails?.(account),
      hidden:
        !handlers.onDetails || !DETAIL_ACCOUNT_TYPES.includes(account.accountType),
    },
    {
      key: 'edit',
      label: labels.edit,
      icon: 'edit',
      tone: 'primary',
      onClick: () => handlers.onEdit(account),
      hidden: account.isClosed,
    },
    {
      key: 'reconcile',
      label: labels.reconcile,
      icon: 'reconcile',
      tone: 'success',
      onClick: () => handlers.onReconcile(account),
      hidden: account.isClosed || account.accountSubType === 'INVESTMENT_BROKERAGE',
    },
    {
      key: 'close',
      label: labels.close,
      icon: 'close',
      tone: 'warning',
      onClick: () => handlers.onCloseClick(account),
      hidden: account.isClosed,
      disabled: balanceNonZero,
      title: balanceNonZero ? labels.closeTitleDisabled : labels.closeTitleEnabled,
    },
    {
      key: 'reopen',
      label: labels.reopen,
      icon: 'reopen',
      tone: 'primary',
      onClick: () => handlers.onReopen(account),
      hidden: !account.isClosed,
    },
    {
      key: 'delete',
      label: labels.delete,
      icon: 'delete',
      tone: 'delete',
      destructive: true,
      onClick: () => handlers.onDeleteClick(account),
      hidden: !isDeletable,
    },
  ];
}

export interface AccountRowProps {
  account: Account;
  index: number;
  density: 'normal' | 'compact' | 'dense';
  cellPadding: string;
  isDeletable: boolean;
  accountNameMap: Map<string, string>;
  // Institution the account belongs to (for the brand icon). Undefined for
  // cashflow-only accounts, which render a neutral fallback badge.
  institution?: InstitutionLogoData;
  brokerageMarketValue: number | undefined;
  defaultCurrency: string;
  formatCurrency: (amount: number | string | null | undefined, currency: string) => string;
  formatCurrencyBase: (value: number, currencyCode?: string) => string;
  convertToDefault: (value: number, fromCurrency: string) => number;
  formatAccountType: (type: AccountType) => string;
  getAccountTypeColor: (type: AccountType) => string;
  actionLabels: AccountActionLabels;
  onDetails: (account: Account) => void;
  onEdit: (account: Account) => void;
  onReconcile: (account: Account) => void;
  onCloseClick: (account: Account) => void;
  onDeleteClick: (account: Account) => void;
  onReopen: (account: Account) => void;
  getRowHandlers: (account: Account) => LongPressRowHandlers;
  // Provided only in delegate (acting) view: makes the favourite star an
  // interactive toggle for the delegate's own (non-shared) favourites.
  onToggleFavourite?: (account: Account) => void;
}

export const AccountRow = memo(function AccountRow({
  account,
  index,
  density,
  cellPadding,
  isDeletable,
  accountNameMap,
  institution,
  brokerageMarketValue,
  defaultCurrency,
  formatCurrency,
  formatCurrencyBase,
  convertToDefault,
  formatAccountType,
  getAccountTypeColor,
  actionLabels,
  onDetails,
  onEdit,
  onReconcile,
  onCloseClick,
  onDeleteClick,
  onReopen,
  getRowHandlers,
  onToggleFavourite,
}: AccountRowProps) {
  const t = useTranslations('accounts');
  const actions = buildAccountActions(account, isDeletable, actionLabels, {
    onDetails,
    onEdit,
    onReconcile,
    onCloseClick,
    onReopen,
    onDeleteClick,
  }, brokerageMarketValue);
  return (
    <tr
      className={`group hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer select-none ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'}`}
      {...getRowHandlers(account)}
    >
      <td className={`${cellPadding} ${account.isClosed ? 'opacity-50' : ''} max-w-[50vw] sm:max-w-[180px] md:max-w-none`}>
        <div
          className="text-left w-full"
          title={account.linkedAccountId && (account.accountSubType === 'INVESTMENT_CASH' || account.accountSubType === 'INVESTMENT_BROKERAGE')
            ? `${account.name} — ${t('row.pairedWith', { name: accountNameMap.get(account.linkedAccountId) || 'linked account' })}`
            : account.name}
        >
          <div className="flex items-center text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300">
            {density !== 'dense' && (
              <InstitutionLogo institution={institution} size={20} className="mr-2" fallbackGlyph="$" />
            )}
            {onToggleFavourite ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFavourite(account);
                }}
                className={`mr-1 flex-shrink-0 ${account.isFavourite ? 'text-yellow-500' : 'text-gray-300 dark:text-gray-600 hover:text-yellow-500'}`}
                aria-label={
                  account.isFavourite
                    ? t('row.removeFromFavourites')
                    : t('row.addToFavourites')
                }
                aria-pressed={account.isFavourite}
                title={
                  account.isFavourite
                    ? t('row.removeFromFavourites')
                    : t('row.addToFavourites')
                }
              >
                <svg
                  className="w-4 h-4"
                  fill={account.isFavourite ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
              </button>
            ) : (
              account.isFavourite && (
                <svg
                  className="w-4 h-4 mr-1 flex-shrink-0 text-yellow-500"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                  aria-label={t('row.favourite')}
                >
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
              )
            )}
            <span className="truncate">{account.name}</span>
            {density !== 'normal' && account.linkedAccountId && (account.accountSubType === 'INVESTMENT_CASH' || account.accountSubType === 'INVESTMENT_BROKERAGE') && (
              <svg className="w-3.5 h-3.5 ml-1 flex-shrink-0 text-gray-400 dark:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
            )}
          </div>
          {density === 'normal' && account.linkedAccountId && (account.accountSubType === 'INVESTMENT_CASH' || account.accountSubType === 'INVESTMENT_BROKERAGE') && (
            <div className="text-xs text-gray-400 dark:text-gray-500 truncate flex items-center gap-1">
              <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              {t('row.pairedWith', { name: accountNameMap.get(account.linkedAccountId) || 'linked account' })}
            </div>
          )}
          {density === 'normal' && account.description && !account.linkedAccountId && (
            <div className="text-sm text-gray-500 dark:text-gray-400 truncate">{account.description}</div>
          )}
        </div>
      </td>
      <td className={`${cellPadding} whitespace-nowrap ${account.isClosed ? 'opacity-50' : ''} hidden sm:table-cell`}>
        <span
          className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getAccountTypeColor(
            account.accountType
          )}`}
        >
          {account.accountSubType === 'INVESTMENT_BROKERAGE' ? t('row.subtypeBrokerage') :
           account.accountSubType === 'INVESTMENT_CASH' ? t('row.subtypeInvCash') :
           formatAccountType(account.accountType)}
        </span>
      </td>
      <td className={`${cellPadding} whitespace-nowrap hidden md:table-cell w-1`}>
        <span
          className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
            !account.isClosed
              ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
              : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
          }`}
        >
          {!account.isClosed ? t('row.statusActive') : t('row.statusClosed')}
        </span>
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right ${account.isClosed ? 'opacity-50' : ''}`}>
        {account.accountSubType === 'INVESTMENT_BROKERAGE' && brokerageMarketValue !== undefined ? (
          <>
            <div className="text-sm font-medium text-green-600 dark:text-green-400">
              {formatCurrency(brokerageMarketValue, account.currencyCode)}
            </div>
            {density === 'normal' && (
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {t('row.marketValue')}
              </div>
            )}
            {density !== 'dense' && account.currencyCode !== defaultCurrency && (
              <div className="text-xs text-gray-400 dark:text-gray-500">
                {'\u2248 '}{formatCurrencyBase(convertToDefault(brokerageMarketValue, account.currencyCode), defaultCurrency)}
              </div>
            )}
          </>
        ) : (
          <>
            {(() => {
              const totalBalance = (Number(account.currentBalance) || 0) + (Number(account.futureTransactionsSum) || 0);
              return (
                <>
                  <div
                    className={`text-sm font-medium ${
                      gainLossColor(totalBalance)
                    }`}
                  >
                    {formatCurrency(totalBalance, account.currencyCode)}
                  </div>
                  {density !== 'dense' && account.currencyCode !== defaultCurrency && (
                    <div className="text-xs text-gray-400 dark:text-gray-500">
                      {'\u2248 '}{formatCurrencyBase(convertToDefault(totalBalance, account.currencyCode), defaultCurrency)}
                    </div>
                  )}
                </>
              );
            })()}
            {density !== 'dense' && account.creditLimit && (
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {t('row.limit', { amount: formatCurrency(account.creditLimit, account.currencyCode) })}
              </div>
            )}
          </>
        )}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium hidden min-[480px]:table-cell sticky right-0 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} group-hover:bg-gray-100 dark:group-hover:bg-gray-800`} onClick={(e) => e.stopPropagation()}>
        <RowActions actions={actions} density={density} />
      </td>
    </tr>
  );
});

