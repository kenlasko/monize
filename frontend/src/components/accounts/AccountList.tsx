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

  const getAccountTypeColor = (type: AccountType) => {
    switch (type) {
      case 'CHEQUING':
        return 'bg-blue-100 text-blue-800';
      case 'SAVINGS':
        return 'bg-green-100 text-green-800';
      case 'CREDIT_CARD':
        return 'bg-purple-100 text-purple-800';
      case 'INVESTMENT':
        return 'bg-yellow-100 text-yellow-800';
      case 'LOAN':
        return 'bg-red-100 text-red-800';
      case 'MORTGAGE':
        return 'bg-orange-100 text-orange-800';
      case 'RRSP':
        return 'bg-indigo-100 text-indigo-800';
      case 'TFSA':
        return 'bg-teal-100 text-teal-800';
      case 'RESP':
        return 'bg-pink-100 text-pink-800';
      case 'CASH':
        return 'bg-emerald-100 text-emerald-800';
      case 'LINE_OF_CREDIT':
        return 'bg-rose-100 text-rose-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  if (accounts.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">No accounts found. Create your first account to get started!</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Account Name
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Type
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Balance
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Status
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {accounts.map((account) => (
            <tr key={account.id} className={!account.isClosed ? '' : 'opacity-50'}>
              <td className="px-6 py-4 whitespace-nowrap">
                <button
                  onClick={() => handleViewTransactions(account)}
                  className="text-left hover:underline"
                >
                  <div className="text-sm font-medium text-blue-600 hover:text-blue-800">
                    {account.name}
                  </div>
                  {account.description && (
                    <div className="text-sm text-gray-500">{account.description}</div>
                  )}
                </button>
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                <span
                  className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getAccountTypeColor(
                    account.accountType
                  )}`}
                >
                  {account.accountType}
                </span>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-right">
                <div
                  className={`text-sm font-medium ${
                    account.currentBalance >= 0 ? 'text-green-600' : 'text-red-600'
                  }`}
                >
                  {formatCurrency(account.currentBalance, account.currencyCode)}
                </div>
                {account.creditLimit && (
                  <div className="text-xs text-gray-500">
                    Limit: {formatCurrency(account.creditLimit, account.currencyCode)}
                  </div>
                )}
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                <span
                  className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                    !account.isClosed
                      ? 'bg-green-100 text-green-800'
                      : 'bg-gray-100 text-gray-800'
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
