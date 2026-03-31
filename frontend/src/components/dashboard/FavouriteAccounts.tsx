'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Account } from '@/types/account';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { accountsApi } from '@/lib/accounts';

function getOrdinal(day: number): string {
  const suffix =
    day >= 11 && day <= 13
      ? 'th'
      : day % 10 === 1
        ? 'st'
        : day % 10 === 2
          ? 'nd'
          : day % 10 === 3
            ? 'rd'
            : 'th';
  return `${day}${suffix}`;
}

interface FavouriteAccountsProps {
  accounts: Account[];
  isLoading: boolean;
  onAccountsChanged?: () => void;
}

export function FavouriteAccounts({ accounts, isLoading, onAccountsChanged }: FavouriteAccountsProps) {
  const router = useRouter();
  const { preferences } = usePreferencesStore();
  const { formatCurrency: formatCurrencyBase } = useNumberFormat();
  const defaultCurrency = preferences?.defaultCurrency || 'CAD';
  const [reordering, setReordering] = useState(false);
  const [localOrder, setLocalOrder] = useState<Account[] | null>(null);

  const favouriteAccounts = localOrder ??
    [...accounts]
      .filter((a) => a.isFavourite && !a.isClosed)
      .sort((a, b) => a.favouriteSortOrder - b.favouriteSortOrder);

  const formatCurrency = (amount: number | string | null | undefined, currency: string) => {
    const numericAmount = Number(amount) || 0;
    const formatted = formatCurrencyBase(numericAmount, currency);

    // Only show currency code if it differs from user's default currency
    if (currency !== defaultCurrency) {
      return `${formatted} ${currency}`;
    }
    return formatted;
  };

  const moveAccount = useCallback(
    async (index: number, direction: -1 | 1) => {
      const newIndex = index + direction;
      const current = localOrder ??
        [...accounts]
          .filter((a) => a.isFavourite && !a.isClosed)
          .sort((a, b) => a.favouriteSortOrder - b.favouriteSortOrder);

      if (newIndex < 0 || newIndex >= current.length) return;

      const reordered = [...current];
      const [moved] = reordered.splice(index, 1);
      reordered.splice(newIndex, 0, moved);

      setLocalOrder(reordered);

      try {
        await accountsApi.reorderFavourites(reordered.map((a) => a.id));
        onAccountsChanged?.();
      } catch {
        setLocalOrder(null);
      }
    },
    [accounts, localOrder, onAccountsChanged],
  );

  // Reset local order when accounts change from parent
  const prevAccountsRef = useState({ accounts })[0];
  if (prevAccountsRef.accounts !== accounts) {
    prevAccountsRef.accounts = accounts;
    setLocalOrder(null);
  }

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Favourite Accounts
        </h3>
        <div className="animate-pulse space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-gray-200 dark:bg-gray-700 rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (favouriteAccounts.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Favourite Accounts
        </h3>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          No favourite accounts yet. Mark accounts as favourites to see them here.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Favourite Accounts
        </h3>
        {favouriteAccounts.length > 1 && (
          <button
            onClick={() => setReordering(!reordering)}
            className={`text-xs px-2 py-1 rounded transition-colors ${
              reordering
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
            title={reordering ? 'Done reordering' : 'Reorder favourites'}
          >
            {reordering ? 'Done' : 'Reorder'}
          </button>
        )}
      </div>
      <div className="space-y-2 sm:space-y-3">
        {favouriteAccounts.map((account, index) => (
          <div key={account.id} className="flex items-center gap-1">
            {reordering && (
              <div className="flex flex-col gap-0.5 flex-shrink-0">
                <button
                  onClick={() => moveAccount(index, -1)}
                  disabled={index === 0}
                  className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="Move up"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
                  </svg>
                </button>
                <button
                  onClick={() => moveAccount(index, 1)}
                  disabled={index === favouriteAccounts.length - 1}
                  className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="Move down"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </button>
              </div>
            )}
            <button
              onClick={() => !reordering && router.push(`/transactions?accountId=${account.id}`)}
              className={`flex-1 flex items-center justify-between p-2 sm:p-3 rounded-lg border border-gray-200 dark:border-gray-700 transition-colors text-left ${
                reordering
                  ? 'cursor-default'
                  : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <svg
                  className="w-4 h-4 text-yellow-500"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 dark:text-gray-100 truncate">
                    {account.name}
                  </div>
                  {account.institution && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {account.institution}
                    </div>
                  )}
                  {account.accountType === 'CREDIT_CARD' &&
                    (account.statementDueDay || account.statementSettlementDay) && (
                    <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2 text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {account.statementDueDay && (
                        <span className="flex items-center gap-0.5">
                          Due: {getOrdinal(account.statementDueDay)}
                          <span
                            className="hidden sm:inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-gray-200 dark:bg-gray-600 text-gray-500 dark:text-gray-400 text-[10px] cursor-help"
                            title="The day of each month when your credit card payment is due"
                          >
                            ?
                          </span>
                        </span>
                      )}
                      {account.statementSettlementDay && (
                        <span className="flex items-center gap-0.5">
                          Settlement: {getOrdinal(account.statementSettlementDay)}
                          <span
                            className="hidden sm:inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-gray-200 dark:bg-gray-600 text-gray-500 dark:text-gray-400 text-[10px] cursor-help"
                            title="The last day of the billing cycle. Transactions posted on or before this day appear on the current statement."
                          >
                            ?
                          </span>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {(() => {
                const totalBalance = (Number(account.currentBalance) || 0) + (Number(account.futureTransactionsSum) || 0);
                return (
                  <div
                    className={`font-semibold whitespace-nowrap ml-2 ${
                      totalBalance >= 0
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-red-600 dark:text-red-400'
                    }`}
                  >
                    {formatCurrency(totalBalance, account.currencyCode)}
                  </div>
                );
              })()}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
