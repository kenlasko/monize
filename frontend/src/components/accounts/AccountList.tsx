'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Account, AccountType } from '@/types/account';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { accountsApi } from '@/lib/accounts';
import { usePreferencesStore } from '@/store/preferencesStore';
import toast from 'react-hot-toast';

type SortField = 'name' | 'type' | 'balance' | 'status';
type SortDirection = 'asc' | 'desc';

interface AccountListProps {
  accounts: Account[];
  onEdit: (account: Account) => void;
  onRefresh: () => void;
}

export function AccountList({ accounts, onEdit, onRefresh }: AccountListProps) {
  const router = useRouter();
  const { preferences } = usePreferencesStore();
  const defaultCurrency = preferences?.defaultCurrency || 'CAD';
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [accountToClose, setAccountToClose] = useState<Account | null>(null);
  const [accountToDelete, setAccountToDelete] = useState<Account | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deletableAccounts, setDeletableAccounts] = useState<Set<string>>(new Set());

  // Sorting state
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  // Filter state
  const [showFilters, setShowFilters] = useState(false);
  const [filterAccountType, setFilterAccountType] = useState<AccountType | ''>('');
  const [filterStatus, setFilterStatus] = useState<'active' | 'closed' | ''>('');

  // Check which accounts can be deleted (have no transactions)
  useEffect(() => {
    const checkDeletableAccounts = async () => {
      const deletable = new Set<string>();
      for (const account of accounts) {
        try {
          const result = await accountsApi.canDelete(account.id);
          if (result.canDelete) {
            deletable.add(account.id);
          }
        } catch {
          // Ignore errors, account just won't show delete button
        }
      }
      setDeletableAccounts(deletable);
    };

    if (accounts.length > 0) {
      checkDeletableAccounts();
    }
  }, [accounts]);

  // Get unique account types from the accounts
  const availableAccountTypes = useMemo(() => {
    const types = new Set<AccountType>();
    accounts.forEach((a) => types.add(a.accountType));
    return Array.from(types).sort();
  }, [accounts]);

  // Filter and sort accounts
  const filteredAndSortedAccounts = useMemo(() => {
    let result = [...accounts];

    // Apply filters
    if (filterAccountType) {
      result = result.filter((a) => a.accountType === filterAccountType);
    }
    if (filterStatus) {
      result = result.filter((a) =>
        filterStatus === 'active' ? !a.isClosed : a.isClosed
      );
    }

    // Apply sorting
    result.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'type':
          comparison = a.accountType.localeCompare(b.accountType);
          break;
        case 'balance':
          comparison = Number(a.currentBalance) - Number(b.currentBalance);
          break;
        case 'status':
          comparison = (a.isClosed ? 1 : 0) - (b.isClosed ? 1 : 0);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [accounts, filterAccountType, filterStatus, sortField, sortDirection]);

  // Count active filters
  const activeFilterCount = [filterAccountType, filterStatus].filter(Boolean).length;

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const clearFilters = () => {
    setFilterAccountType('');
    setFilterStatus('');
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return (
        <svg className="w-4 h-4 ml-1 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
      );
    }
    return sortDirection === 'asc' ? (
      <svg className="w-4 h-4 ml-1 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
      </svg>
    ) : (
      <svg className="w-4 h-4 ml-1 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    );
  };

  const handleViewTransactions = (account: Account) => {
    router.push(`/transactions?accountId=${account.id}`);
  };

  const handleReconcile = (account: Account) => {
    router.push(`/reconcile?accountId=${account.id}`);
  };

  const handleCloseClick = (account: Account) => {
    setAccountToClose(account);
    setCloseDialogOpen(true);
  };

  const handleDeleteClick = (account: Account) => {
    setAccountToDelete(account);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!accountToDelete) return;

    setIsDeleting(true);
    try {
      await accountsApi.delete(accountToDelete.id);
      toast.success('Account deleted successfully');
      setDeleteDialogOpen(false);
      setAccountToDelete(null);
      onRefresh();
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to delete account';
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteDialogOpen(false);
    setAccountToDelete(null);
  };

  const handleCloseConfirm = async () => {
    if (!accountToClose) return;

    setIsClosing(true);
    try {
      await accountsApi.close(accountToClose.id);
      toast.success('Account closed successfully');
      setCloseDialogOpen(false);
      setAccountToClose(null);
      onRefresh();
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to close account';
      toast.error(message);
    } finally {
      setIsClosing(false);
    }
  };

  const handleCloseCancel = () => {
    setCloseDialogOpen(false);
    setAccountToClose(null);
  };

  const handleReopen = async (account: Account) => {
    try {
      await accountsApi.reopen(account.id);
      toast.success('Account reopened successfully');
      onRefresh();
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to reopen account';
      toast.error(message);
    }
  };

  const formatCurrency = (amount: number | string | null | undefined, currency: string) => {
    const numericAmount = Number(amount) || 0;
    const formatted = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
      currencyDisplay: 'narrowSymbol',
    }).format(numericAmount);

    // Only show currency code if it differs from user's default currency
    if (currency !== defaultCurrency) {
      return `${formatted} ${currency}`;
    }
    return formatted;
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
    <div>
      {/* Filter Bar */}
      <div className="px-6 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="inline-flex items-center px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
          >
            <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center px-2 py-0.5 text-xs font-bold leading-none text-white bg-blue-600 rounded-full">
                {activeFilterCount}
              </span>
            )}
          </button>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {filteredAndSortedAccounts.length} of {accounts.length} accounts
          </span>
        </div>

        {/* Expandable Filter Options */}
        {showFilters && (
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-600 dark:text-gray-400">Type:</label>
              <select
                value={filterAccountType}
                onChange={(e) => setFilterAccountType(e.target.value as AccountType | '')}
                className="text-sm font-sans border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              >
                <option value="">All Types</option>
                {availableAccountTypes.map((type) => (
                  <option key={type} value={type}>
                    {formatAccountType(type)}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-600 dark:text-gray-400">Status:</label>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value as 'active' | 'closed' | '')}
                className="text-sm font-sans border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              >
                <option value="">All</option>
                <option value="active">Active</option>
                <option value="closed">Closed</option>
              </select>
            </div>

            {activeFilterCount > 0 && (
              <button
                onClick={clearFilters}
                className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
              >
                Clear Filters
              </button>
            )}
          </div>
        )}
      </div>

      {filteredAndSortedAccounts.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 dark:text-gray-400">No accounts match your filters.</p>
          <button
            onClick={clearFilters}
            className="mt-2 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
          >
            Clear Filters
          </button>
        </div>
      ) : (
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none"
                onClick={() => handleSort('name')}
              >
                <div className="flex items-center">
                  Account Name
                  <SortIcon field="name" />
                </div>
              </th>
              <th
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none"
                onClick={() => handleSort('type')}
              >
                <div className="flex items-center">
                  Type
                  <SortIcon field="type" />
                </div>
              </th>
              <th
                className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none"
                onClick={() => handleSort('balance')}
              >
                <div className="flex items-center justify-end">
                  Balance
                  <SortIcon field="balance" />
                </div>
              </th>
              <th
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none"
                onClick={() => handleSort('status')}
              >
                <div className="flex items-center">
                  Status
                  <SortIcon field="status" />
                </div>
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {filteredAndSortedAccounts.map((account) => (
            <tr key={account.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
              <td className={`px-6 py-4 whitespace-nowrap ${account.isClosed ? 'opacity-50' : ''}`}>
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
              <td className={`px-6 py-4 whitespace-nowrap ${account.isClosed ? 'opacity-50' : ''}`}>
                <span
                  className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getAccountTypeColor(
                    account.accountType
                  )}`}
                >
                  {formatAccountType(account.accountType)}
                </span>
              </td>
              <td className={`px-6 py-4 whitespace-nowrap text-right ${account.isClosed ? 'opacity-50' : ''}`}>
                <div
                  className={`text-sm font-medium ${
                    Number(account.currentBalance) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
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
                    {account.accountSubType !== 'INVESTMENT_BROKERAGE' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleReconcile(account)}
                        title="Reconcile account against a statement"
                      >
                        Reconcile
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCloseClick(account)}
                      disabled={Number(account.currentBalance) !== 0}
                      title={Number(account.currentBalance) !== 0 ? 'Account must have zero balance to close' : 'Close account'}
                    >
                      Close
                    </Button>
                    {deletableAccounts.has(account.id) && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleDeleteClick(account)}
                        title="Permanently delete account (no transactions)"
                      >
                        Delete
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleReopen(account)}
                    >
                      Reopen
                    </Button>
                    {deletableAccounts.has(account.id) && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleDeleteClick(account)}
                        title="Permanently delete account (no transactions)"
                      >
                        Delete
                      </Button>
                    )}
                  </>
                )}
              </td>
            </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      {/* Close Account Confirmation Dialog */}
      <ConfirmDialog
        isOpen={closeDialogOpen}
        title="Close Account"
        message={accountToClose
          ? `Are you sure you want to close "${accountToClose.name}"? The account must have a zero balance to be closed.`
          : ''
        }
        confirmLabel={isClosing ? 'Closing...' : 'Close Account'}
        cancelLabel="Cancel"
        variant="warning"
        onConfirm={handleCloseConfirm}
        onCancel={handleCloseCancel}
      />

      {/* Delete Account Confirmation Dialog */}
      <ConfirmDialog
        isOpen={deleteDialogOpen}
        title="Delete Account"
        message={accountToDelete
          ? `Are you sure you want to permanently delete "${accountToDelete.name}"? This action cannot be undone.`
          : ''
        }
        confirmLabel={isDeleting ? 'Deleting...' : 'Delete Account'}
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
    </div>
  );
}
