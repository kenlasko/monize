'use client';

import { memo } from 'react';
import { Account, AccountType } from '@/types/account';
import { Button } from '@/components/ui/Button';

export interface AccountRowProps {
  account: Account;
  density: 'normal' | 'compact' | 'dense';
  cellPadding: string;
  isDeletable: boolean;
  accountNameMap: Map<string, string>;
  brokerageMarketValue: number | undefined;
  defaultCurrency: string;
  formatCurrency: (amount: number | string | null | undefined, currency: string) => string;
  formatCurrencyBase: (value: number, currencyCode?: string) => string;
  convertToDefault: (value: number, fromCurrency: string) => number;
  formatAccountType: (type: AccountType) => string;
  getAccountTypeColor: (type: AccountType) => string;
  onRowClick: (account: Account) => void;
  onEdit: (account: Account) => void;
  onReconcile: (account: Account) => void;
  onCloseClick: (account: Account) => void;
  onDeleteClick: (account: Account) => void;
  onReopen: (account: Account) => void;
  onLongPressStart: (account: Account) => void;
  onLongPressStartTouch: (account: Account, e: React.TouchEvent) => void;
  onLongPressEnd: () => void;
  onTouchMove: (e: React.TouchEvent) => void;
}

export const AccountRow = memo(function AccountRow({
  account,
  density,
  cellPadding,
  isDeletable,
  accountNameMap,
  brokerageMarketValue,
  defaultCurrency,
  formatCurrency,
  formatCurrencyBase,
  convertToDefault,
  formatAccountType,
  getAccountTypeColor,
  onRowClick,
  onEdit,
  onReconcile,
  onCloseClick,
  onDeleteClick,
  onReopen,
  onLongPressStart,
  onLongPressStartTouch,
  onLongPressEnd,
  onTouchMove,
}: AccountRowProps) {
  return (
    <tr
      className="hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer select-none"
      onClick={() => onRowClick(account)}
      onMouseDown={() => onLongPressStart(account)}
      onMouseUp={onLongPressEnd}
      onMouseLeave={onLongPressEnd}
      onTouchStart={(e) => onLongPressStartTouch(account, e)}
      onTouchMove={onTouchMove}
      onTouchEnd={onLongPressEnd}
      onTouchCancel={onLongPressEnd}
    >
      <td className={`${cellPadding} ${account.isClosed ? 'opacity-50' : ''} max-w-[50vw] sm:max-w-[180px] md:max-w-none`}>
        <div
          className="text-left w-full"
          title={account.linkedAccountId && (account.accountSubType === 'INVESTMENT_CASH' || account.accountSubType === 'INVESTMENT_BROKERAGE')
            ? `${account.name} — Paired with ${accountNameMap.get(account.linkedAccountId) || 'linked account'}`
            : account.name}
        >
          <div className="flex items-center text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300">
            {account.isFavourite && (
              <svg
                className="w-4 h-4 mr-1 flex-shrink-0 text-yellow-500"
                fill="currentColor"
                viewBox="0 0 20 20"
                aria-label="Favourite"
              >
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
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
              Paired with {accountNameMap.get(account.linkedAccountId) || 'linked account'}
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
          {account.accountSubType === 'INVESTMENT_BROKERAGE' ? 'Brokerage' :
           account.accountSubType === 'INVESTMENT_CASH' ? 'Inv. Cash' :
           formatAccountType(account.accountType)}
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
                Market value
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
            <div
              className={`text-sm font-medium ${
                Number(account.currentBalance) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
              }`}
            >
              {formatCurrency(account.currentBalance, account.currencyCode)}
            </div>
            {density !== 'dense' && account.currencyCode !== defaultCurrency && (
              <div className="text-xs text-gray-400 dark:text-gray-500">
                {'\u2248 '}{formatCurrencyBase(convertToDefault(Number(account.currentBalance) || 0, account.currencyCode), defaultCurrency)}
              </div>
            )}
            {density !== 'dense' && account.creditLimit && (
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Limit: {formatCurrency(account.creditLimit, account.currencyCode)}
              </div>
            )}
          </>
        )}
      </td>
      <td className={`${cellPadding} whitespace-nowrap hidden md:table-cell`}>
        <span
          className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
            !account.isClosed
              ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
              : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
          }`}
        >
          {!account.isClosed ? 'Active' : 'Closed'}
        </span>
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium ${density === 'dense' ? 'space-x-1' : 'space-x-2'} hidden min-[480px]:table-cell`} onClick={(e) => e.stopPropagation()}>
        {!account.isClosed ? (
          <ActiveAccountActions
            account={account}
            density={density}
            isDeletable={isDeletable}
            onEdit={onEdit}
            onReconcile={onReconcile}
            onCloseClick={onCloseClick}
            onDeleteClick={onDeleteClick}
          />
        ) : (
          <ClosedAccountActions
            account={account}
            density={density}
            isDeletable={isDeletable}
            onReopen={onReopen}
            onDeleteClick={onDeleteClick}
          />
        )}
      </td>
    </tr>
  );
});

function ActiveAccountActions({ account, density, isDeletable, onEdit, onReconcile, onCloseClick, onDeleteClick }: {
  account: Account;
  density: 'normal' | 'compact' | 'dense';
  isDeletable: boolean;
  onEdit: (account: Account) => void;
  onReconcile: (account: Account) => void;
  onCloseClick: (account: Account) => void;
  onDeleteClick: (account: Account) => void;
}) {
  if (density === 'dense') {
    return (
      <>
        <button onClick={() => onEdit(account)} className="inline-flex items-center justify-center p-1.5 text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded" title="Edit">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
        </button>
        {account.accountSubType !== 'INVESTMENT_BROKERAGE' && (
          <button onClick={() => onReconcile(account)} className="inline-flex items-center justify-center p-1.5 text-gray-600 dark:text-gray-300 hover:text-green-600 dark:hover:text-green-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded" title="Reconcile">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          </button>
        )}
        <button onClick={() => onCloseClick(account)} disabled={Number(account.currentBalance) !== 0} className={`inline-flex items-center justify-center p-1.5 rounded ${Number(account.currentBalance) !== 0 ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed' : 'text-gray-600 dark:text-gray-300 hover:text-orange-600 dark:hover:text-orange-400 hover:bg-gray-100 dark:hover:bg-gray-700'}`} title={Number(account.currentBalance) !== 0 ? 'Account must have zero balance to close' : 'Close account'}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" /></svg>
        </button>
        {isDeletable && (
          <button onClick={() => onDeleteClick(account)} className="inline-flex items-center justify-center p-1.5 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30 rounded" title="Permanently delete account (no transactions)">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        )}
      </>
    );
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => onEdit(account)}>Edit</Button>
      {account.accountSubType !== 'INVESTMENT_BROKERAGE' && (
        <Button variant="outline" size="sm" onClick={() => onReconcile(account)} title="Reconcile account against a statement">Reconcile</Button>
      )}
      <Button variant="outline" size="sm" onClick={() => onCloseClick(account)} disabled={Number(account.currentBalance) !== 0} title={Number(account.currentBalance) !== 0 ? 'Account must have zero balance to close' : 'Close account'}>Close</Button>
      {isDeletable && (
        <Button variant="danger" size="sm" onClick={() => onDeleteClick(account)} title="Permanently delete account (no transactions)">Delete</Button>
      )}
    </>
  );
}

function ClosedAccountActions({ account, density, isDeletable, onReopen, onDeleteClick }: {
  account: Account;
  density: 'normal' | 'compact' | 'dense';
  isDeletable: boolean;
  onReopen: (account: Account) => void;
  onDeleteClick: (account: Account) => void;
}) {
  if (density === 'dense') {
    return (
      <>
        <button onClick={() => onReopen(account)} className="inline-flex items-center justify-center p-1.5 text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded" title="Reopen">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
        </button>
        {isDeletable && (
          <button onClick={() => onDeleteClick(account)} className="inline-flex items-center justify-center p-1.5 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30 rounded" title="Permanently delete account (no transactions)">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        )}
      </>
    );
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => onReopen(account)}>Reopen</Button>
      {isDeletable && (
        <Button variant="danger" size="sm" onClick={() => onDeleteClick(account)} title="Permanently delete account (no transactions)">Delete</Button>
      )}
    </>
  );
}
