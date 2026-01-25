'use client';

import { useRouter } from 'next/navigation';
import { Account, AccountType } from '@/types/account';
import { Button } from '@/components/ui/Button';
import { accountsApi } from '@/lib/accounts';
import toast from 'react-hot-toast';

interface AccountListProps {
  accounts: Account[];
  onEdit: (account: Account) => void;
  onRefresh: () => void;
}

export function AccountList({ accounts, onEdit, onRefresh }: AccountListProps) {
  const router = useRouter();

  const handleViewTransactions = (account: Account) => {
    router.push(`/transactions?accountId=${account.id}`);
  };

  const handleClose = async (account: Account) => {
    if (!confirm(`Are you sure you want to close "${account.name}"?`)) {
      return;
    }

    try {
      await accountsApi.close(account.id);
      toast.success('Account closed successfully');
      onRefresh();
    } catch (error) {
      toast.error('Failed to close account');
      console.error(error);
    }
  };

  const handleReopen = async (account: Account) => {
    try {
      await accountsApi.reopen(account.id);
      toast.success('Account reopened successfully');
      onRefresh();
    } catch (error) {
      toast.error('Failed to reopen account');
      console.error(error);
    }
  };

  const formatCurrency = (amount: number, currency: string) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
    }).format(amount);
  };

  const formatAccountType = (type: AccountType) => {
    const labels: Record<AccountType, string> = {
      CHEQUING: 'Chequing',
      SAVINGS: 'Savings',
      CREDIT_CARD: 'Credit Card',
      INVESTMENT: 'Investment',
      LOAN: 'Loan',
      MORTGAGE: 'Mortgage',
      RRSP: 'RRSP',
      TFSA: 'TFSA',
      RESP: 'RESP',
      CASH: 'Cash',
      LINE_OF_CREDIT: 'Line of Credit',
      OTHER: 'Other',
    };
    return labels[type] || type;
  };

  const getAccountTypeColor = (type: AccountType) => {
    switch (type) {
      case 'CHEQUING':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
      case 'SAVINGS':
        return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
      case 'CREDIT_CARD':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200';
      case 'INVESTMENT':
        return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200';
      case 'LOAN':
        return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
      case 'MORTGAGE':
        return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200';
      case 'RRSP':
        return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200';
      case 'TFSA':
        return 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200';
      case 'RESP':
        return 'bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200';
      case 'CASH':
        return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200';
      case 'LINE_OF_CREDIT':
        return 'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200';
    }
  };

  if (accounts.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 dark:text-gray-400">No accounts found. Create your first account to get started!</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Account Name
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Type
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Balance
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Status
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
          {accounts.map((account) => (
            <tr key={account.id} className={`hover:bg-gray-50 dark:hover:bg-gray-800 ${!account.isClosed ? '' : 'opacity-50'}`}>
              <td className="px-6 py-4 whitespace-nowrap">
                <button
                  onClick={() => handleViewTransactions(account)}
                  className="text-left hover:underline"
                >
                  <div className="flex items-center text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300">
                    {account.isFavourite && (
                      <svg
                        className="w-4 h-4 mr-1 text-yellow-500"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                        aria-label="Favourite"
                      >
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                    )}
                    {account.name}
                  </div>
                  {account.description && (
                    <div className="text-sm text-gray-500 dark:text-gray-400">{account.description}</div>
                  )}
                </button>
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                <span
                  className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getAccountTypeColor(
                    account.accountType
                  )}`}
                >
                  {formatAccountType(account.accountType)}
                </span>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-right">
                <div
                  className={`text-sm font-medium ${
                    account.currentBalance >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                  }`}
                >
                  {formatCurrency(account.currentBalance, account.currencyCode)}
                </div>
                {account.creditLimit && (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Limit: {formatCurrency(account.creditLimit, account.currencyCode)}
                  </div>
                )}
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
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
              <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2">
                {!account.isClosed ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onEdit(account)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleClose(account)}
                    >
                      Close
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleReopen(account)}
                  >
                    Reopen
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
