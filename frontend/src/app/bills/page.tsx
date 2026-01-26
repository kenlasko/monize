'use client';

import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { ScheduledTransactionForm } from '@/components/scheduled-transactions/ScheduledTransactionForm';
import { ScheduledTransactionList } from '@/components/scheduled-transactions/ScheduledTransactionList';
import { AppHeader } from '@/components/layout/AppHeader';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { parseLocalDate } from '@/lib/utils';

export default function BillsPage() {
  const [scheduledTransactions, setScheduledTransactions] = useState<ScheduledTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<ScheduledTransaction | undefined>();
  const [filterType, setFilterType] = useState<'all' | 'bills' | 'deposits'>('all');

  const loadData = async () => {
    setIsLoading(true);
    try {
      const data = await scheduledTransactionsApi.getAll();
      setScheduledTransactions(data);
    } catch (error) {
      toast.error('Failed to load scheduled transactions');
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreateNew = () => {
    setEditingTransaction(undefined);
    setShowForm(true);
  };

  const handleEdit = (transaction: ScheduledTransaction) => {
    setEditingTransaction(transaction);
    setShowForm(true);
  };

  const handleFormSuccess = () => {
    setShowForm(false);
    setEditingTransaction(undefined);
    loadData();
  };

  const handleFormCancel = () => {
    setShowForm(false);
    setEditingTransaction(undefined);
  };

  // Filter transactions based on type
  const filteredTransactions = scheduledTransactions.filter((t) => {
    if (filterType === 'bills') return t.amount < 0;
    if (filterType === 'deposits') return t.amount > 0;
    return true;
  });

  // Calculate summary stats
  const summary = {
    totalBills: scheduledTransactions.filter((t) => t.amount < 0 && t.isActive).length,
    totalDeposits: scheduledTransactions.filter((t) => t.amount > 0 && t.isActive).length,
    monthlyBills: scheduledTransactions
      .filter((t) => t.amount < 0 && t.isActive)
      .reduce((sum, t) => {
        // Normalize to monthly amount
        const amount = Math.abs(t.amount);
        switch (t.frequency) {
          case 'DAILY':
            return sum + amount * 30;
          case 'WEEKLY':
            return sum + amount * 4.33;
          case 'BIWEEKLY':
            return sum + amount * 2.17;
          case 'MONTHLY':
            return sum + amount;
          case 'QUARTERLY':
            return sum + amount / 3;
          case 'YEARLY':
            return sum + amount / 12;
          default:
            return sum;
        }
      }, 0),
    monthlyDeposits: scheduledTransactions
      .filter((t) => t.amount > 0 && t.isActive)
      .reduce((sum, t) => {
        const amount = t.amount;
        switch (t.frequency) {
          case 'DAILY':
            return sum + amount * 30;
          case 'WEEKLY':
            return sum + amount * 4.33;
          case 'BIWEEKLY':
            return sum + amount * 2.17;
          case 'MONTHLY':
            return sum + amount;
          case 'QUARTERLY':
            return sum + amount / 3;
          case 'YEARLY':
            return sum + amount / 12;
          default:
            return sum;
        }
      }, 0),
    dueCount: scheduledTransactions.filter((t) => {
      if (!t.isActive) return false;
      const dueDate = parseLocalDate(t.nextDueDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return dueDate <= today;
    }).length,
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <AppHeader />

      {/* Page Header */}
      <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50">
        <div className="px-4 sm:px-6 lg:px-12 py-6">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Bills & Deposits</h1>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Manage your recurring transactions and scheduled payments
              </p>
            </div>
            <Button onClick={handleCreateNew}>+ New Schedule</Button>
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
                    className="h-6 w-6 text-red-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                    />
                  </svg>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">Active Bills</dt>
                    <dd className="text-lg font-semibold text-gray-900 dark:text-gray-100">{summary.totalBills}</dd>
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
                      d="M12 4v16m8-8H4"
                    />
                  </svg>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">Active Deposits</dt>
                    <dd className="text-lg font-semibold text-gray-900 dark:text-gray-100">{summary.totalDeposits}</dd>
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
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">Monthly Net</dt>
                    <dd
                      className={`text-lg font-semibold ${
                        summary.monthlyDeposits - summary.monthlyBills >= 0
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      ${(summary.monthlyDeposits - summary.monthlyBills).toFixed(2)}
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
                    className="h-6 w-6 text-yellow-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">Due Now</dt>
                    <dd
                      className={`text-lg font-semibold ${
                        summary.dueCount > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'
                      }`}
                    >
                      {summary.dueCount}
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
                {editingTransaction ? 'Edit Scheduled Transaction' : 'New Scheduled Transaction'}
              </h2>
              <ScheduledTransactionForm
                key={editingTransaction?.id || 'new'}
                scheduledTransaction={editingTransaction}
                onSuccess={handleFormSuccess}
                onCancel={handleFormCancel}
              />
            </div>
          </div>
        )}

        {/* Filter Tabs */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg mb-6">
          <div className="border-b border-gray-200 dark:border-gray-700">
            <nav className="-mb-px flex">
              <button
                onClick={() => setFilterType('all')}
                className={`py-4 px-6 text-sm font-medium border-b-2 ${
                  filterType === 'all'
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
                }`}
              >
                All ({scheduledTransactions.length})
              </button>
              <button
                onClick={() => setFilterType('bills')}
                className={`py-4 px-6 text-sm font-medium border-b-2 ${
                  filterType === 'bills'
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
                }`}
              >
                Bills ({scheduledTransactions.filter((t) => t.amount < 0).length})
              </button>
              <button
                onClick={() => setFilterType('deposits')}
                className={`py-4 px-6 text-sm font-medium border-b-2 ${
                  filterType === 'deposits'
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
                }`}
              >
                Deposits ({scheduledTransactions.filter((t) => t.amount > 0).length})
              </button>
            </nav>
          </div>
        </div>

        {/* Scheduled Transactions List */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {isLoading ? (
            <div className="p-12 text-center">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 dark:border-blue-400"></div>
              <p className="mt-2 text-gray-500 dark:text-gray-400">Loading scheduled transactions...</p>
            </div>
          ) : (
            <ScheduledTransactionList
              transactions={filteredTransactions}
              onEdit={handleEdit}
              onRefresh={loadData}
            />
          )}
        </div>
      </div>
    </div>
  );
}
