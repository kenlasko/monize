'use client';

import { useRouter } from 'next/navigation';
import { Account } from '@/types/account';

interface FavouriteAccountsProps {
  accounts: Account[];
  isLoading: boolean;
}

export function FavouriteAccounts({ accounts, isLoading }: FavouriteAccountsProps) {
  const router = useRouter();
  const favouriteAccounts = accounts.filter((a) => a.isFavourite && !a.isClosed);

  const formatCurrency = (amount: number, currency: string) => {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: currency,
    }).format(amount);
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
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
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        Favourite Accounts
      </h3>
      <div className="space-y-3">
        {favouriteAccounts.map((account) => (
          <button
            key={account.id}
            onClick={() => router.push(`/transactions?accountId=${account.id}`)}
            className="w-full flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors text-left"
          >
            <div className="flex items-center gap-2">
              <svg
                className="w-4 h-4 text-yellow-500"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
              <div>
                <div className="font-medium text-gray-900 dark:text-gray-100">
                  {account.name}
                </div>
                {account.institution && (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {account.institution}
                  </div>
                )}
              </div>
            </div>
            <div
              className={`font-semibold ${
                account.currentBalance >= 0
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {formatCurrency(account.currentBalance, account.currencyCode)}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
