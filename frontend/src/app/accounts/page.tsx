'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { AccountForm } from '@/components/accounts/AccountForm';
import { AccountList } from '@/components/accounts/AccountList';
import { AppHeader } from '@/components/layout/AppHeader';
import { accountsApi } from '@/lib/accounts';
import { Account } from '@/types/account';

export default function AccountsPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | undefined>();
  const [showClosedAccounts, setShowClosedAccounts] = useState(true);

  const loadAccounts = async () => {
    setIsLoading(true);
    try {
      const data = await accountsApi.getAll(true); // Always fetch all accounts
      setAccounts(data);
    } catch (error) {
      toast.error('Failed to load accounts');
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  // Filter accounts based on showClosedAccounts toggle
  const filteredAccounts = showClosedAccounts
    ? accounts
    : accounts.filter((a) => !a.isClosed);

  const closedAccountCount = accounts.filter((a) => a.isClosed).length;

  useEffect(() => {
    loadAccounts();
  }, []);

  const handleCreateNew = () => {
    setEditingAccount(undefined);
    setShowForm(true);
  };

  const handleEdit = (account: Account) => {
    setEditingAccount(account);
    setShowForm(true);
  };

  const handleFormSubmit = async (data: any) => {
    try {
      // Clean up optional numeric fields - remove if undefined, null, or NaN
      const cleanedData = {
        ...data,
        openingBalance: data.openingBalance || data.openingBalance === 0 ? data.openingBalance : undefined,
        creditLimit: data.creditLimit || data.creditLimit === 0 ? data.creditLimit : undefined,
        interestRate: data.interestRate || data.interestRate === 0 ? data.interestRate : undefined,
      };

      // Remove undefined fields
      Object.keys(cleanedData).forEach(key => {
        if (cleanedData[key] === undefined || cleanedData[key] === '' || (typeof cleanedData[key] === 'number' && isNaN(cleanedData[key]))) {
          delete cleanedData[key];
        }
      });

      if (editingAccount) {
        await accountsApi.update(editingAccount.id, cleanedData);
        toast.success('Account updated successfully');
      } else {
        await accountsApi.create(cleanedData);
        toast.success('Account created successfully');
      }
      setShowForm(false);
      setEditingAccount(undefined);
      loadAccounts();
    } catch (error: any) {
      const message =
        error.response?.data?.message || `Failed to ${editingAccount ? 'update' : 'create'} account`;
      toast.error(message);
      throw error;
    }
  };

  const handleFormCancel = () => {
    setShowForm(false);
    setEditingAccount(undefined);
  };

  const calculateSummary = () => {
    const activeAccounts = accounts.filter((a) => !a.isClosed);
    const totalBalance = activeAccounts.reduce((sum, a) => sum + (Number(a.currentBalance) || 0), 0);
    const totalAssets = activeAccounts
      .filter((a) => (Number(a.currentBalance) || 0) > 0)
      .reduce((sum, a) => sum + (Number(a.currentBalance) || 0), 0);
    const totalLiabilities = activeAccounts
      .filter((a) => (Number(a.currentBalance) || 0) < 0)
      .reduce((sum, a) => sum + Math.abs(Number(a.currentBalance) || 0), 0);

    return { totalBalance, totalAssets, totalLiabilities, accountCount: activeAccounts.length };
  };

  const summary = calculateSummary();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <AppHeader />

      {/* Page Header */}
      <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50">
        <div className="px-4 sm:px-6 lg:px-12 py-6">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Accounts</h1>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Manage your bank accounts, credit cards, and investments
              </p>
            </div>
            <Button onClick={handleCreateNew}>+ New Account</Button>
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-6 lg:px-12 py-8">
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
          <div className="bg-white dark:bg-gray-800 overflow-hidden shadow dark:shadow-gray-700/50 rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg
                    className="h-6 w-6 text-gray-400 dark:text-gray-500"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                    />
                  </svg>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">Total Accounts</dt>
                    <dd className="text-lg font-semibold text-gray-900 dark:text-gray-100">{summary.accountCount}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 overflow-hidden shadow dark:shadow-gray-700/50 rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg
                    className="h-6 w-6 text-blue-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">Net Worth</dt>
                    <dd
                      className={`text-lg font-semibold ${
                        summary.totalBalance >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      ${summary.totalBalance.toFixed(2)}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 overflow-hidden shadow dark:shadow-gray-700/50 rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg
                    className="h-6 w-6 text-green-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">Total Assets</dt>
                    <dd className="text-lg font-semibold text-green-600 dark:text-green-400">
                      ${summary.totalAssets.toFixed(2)}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 overflow-hidden shadow dark:shadow-gray-700/50 rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg
                    className="h-6 w-6 text-red-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">Total Liabilities</dt>
                    <dd className="text-lg font-semibold text-red-600 dark:text-red-400">
                      ${summary.totalLiabilities.toFixed(2)}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Form Modal */}
        {showForm && (
          <div className="fixed inset-0 bg-gray-500 dark:bg-gray-900 bg-opacity-75 dark:bg-opacity-80 flex items-center justify-center p-4 z-50">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl dark:shadow-gray-700/50 max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
                {editingAccount ? 'Edit Account' : 'New Account'}
              </h2>
              <AccountForm
                account={editingAccount}
                onSubmit={handleFormSubmit}
                onCancel={handleFormCancel}
              />
            </div>
          </div>
        )}

        {/* Accounts List */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {/* Toggle for closed accounts */}
          {closedAccountCount > 0 && (
            <div className="px-6 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between bg-gray-50 dark:bg-gray-800">
              <label className="flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={showClosedAccounts}
                  onChange={(e) => setShowClosedAccounts(e.target.checked)}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded dark:border-gray-600 dark:bg-gray-700"
                />
                <span className="ml-2 text-sm text-gray-600 dark:text-gray-400">
                  Show closed accounts ({closedAccountCount})
                </span>
              </label>
            </div>
          )}

          {isLoading ? (
            <div className="p-12 text-center">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 dark:border-blue-400"></div>
              <p className="mt-2 text-gray-500 dark:text-gray-400">Loading accounts...</p>
            </div>
          ) : (
            <AccountList accounts={filteredAccounts} onEdit={handleEdit} onRefresh={loadAccounts} />
          )}
        </div>
      </div>
    </div>
  );
}
