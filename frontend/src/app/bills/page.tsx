'use client';

import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { ScheduledTransactionForm } from '@/components/scheduled-transactions/ScheduledTransactionForm';
import { ScheduledTransactionList } from '@/components/scheduled-transactions/ScheduledTransactionList';
import { OverrideEditorDialog } from '@/components/scheduled-transactions/OverrideEditorDialog';
import { OccurrenceDatePicker } from '@/components/scheduled-transactions/OccurrenceDatePicker';
import { AppHeader } from '@/components/layout/AppHeader';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { categoriesApi } from '@/lib/categories';
import { ScheduledTransaction, ScheduledTransactionOverride } from '@/types/scheduled-transaction';
import { Category } from '@/types/category';
import { parseLocalDate } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

interface OverrideEditorState {
  isOpen: boolean;
  transaction: ScheduledTransaction | null;
  date: string;
  existingOverride: ScheduledTransactionOverride | null;
}

export default function BillsPage() {
  const [scheduledTransactions, setScheduledTransactions] = useState<ScheduledTransaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<ScheduledTransaction | undefined>();
  const [filterType, setFilterType] = useState<'all' | 'bills' | 'deposits'>('all');
  const [overrideEditor, setOverrideEditor] = useState<OverrideEditorState>({
    isOpen: false,
    transaction: null,
    date: '',
    existingOverride: null,
  });
  const [overrideConfirm, setOverrideConfirm] = useState<{
    isOpen: boolean;
    transaction: ScheduledTransaction | null;
    overrideCount: number;
  }>({ isOpen: false, transaction: null, overrideCount: 0 });
  const [datePicker, setDatePicker] = useState<{
    isOpen: boolean;
    transaction: ScheduledTransaction | null;
    overrideDates: string[];
  }>({ isOpen: false, transaction: null, overrideDates: [] });

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [transactionsData, categoriesData] = await Promise.all([
        scheduledTransactionsApi.getAll(),
        categoriesApi.getAll(),
      ]);
      setScheduledTransactions(transactionsData);
      setCategories(categoriesData);
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

  const handleEdit = async (transaction: ScheduledTransaction) => {
    try {
      // Check if there are any overrides for this scheduled transaction
      const { hasOverrides, count } = await scheduledTransactionsApi.hasOverrides(transaction.id);
      if (hasOverrides) {
        // Show confirmation dialog
        setOverrideConfirm({
          isOpen: true,
          transaction,
          overrideCount: count,
        });
      } else {
        // No overrides, proceed directly to edit
        setEditingTransaction(transaction);
        setShowForm(true);
      }
    } catch (error) {
      // If check fails, proceed anyway
      console.error('Failed to check overrides:', error);
      setEditingTransaction(transaction);
      setShowForm(true);
    }
  };

  const handleOverrideConfirmKeep = () => {
    // Keep overrides and edit the base template
    if (overrideConfirm.transaction) {
      setEditingTransaction(overrideConfirm.transaction);
      setShowForm(true);
    }
    setOverrideConfirm({ isOpen: false, transaction: null, overrideCount: 0 });
  };

  const handleOverrideConfirmDelete = async () => {
    // Delete all overrides and then edit
    if (overrideConfirm.transaction) {
      try {
        await scheduledTransactionsApi.deleteAllOverrides(overrideConfirm.transaction.id);
        toast.success('Overrides deleted');
        setEditingTransaction(overrideConfirm.transaction);
        setShowForm(true);
      } catch (error) {
        toast.error('Failed to delete overrides');
        console.error(error);
      }
    }
    setOverrideConfirm({ isOpen: false, transaction: null, overrideCount: 0 });
  };

  const handleOverrideConfirmCancel = () => {
    setOverrideConfirm({ isOpen: false, transaction: null, overrideCount: 0 });
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

  const handleEditOccurrence = async (transaction: ScheduledTransaction) => {
    // Fetch existing overrides to show which dates are modified
    let overrideDates: string[] = [];
    try {
      const overrides = await scheduledTransactionsApi.getOverrides(transaction.id);
      overrideDates = overrides.map(o => o.overrideDate);
    } catch (error) {
      console.error('Failed to fetch overrides:', error);
    }

    // Show the date picker to let user choose which occurrence to edit
    setDatePicker({
      isOpen: true,
      transaction,
      overrideDates,
    });
  };

  const handleDatePickerSelect = async (date: string) => {
    const transaction = datePicker.transaction;
    if (!transaction) return;

    // Close the date picker
    setDatePicker({ isOpen: false, transaction: null, overrideDates: [] });

    try {
      // Check if an override already exists for this date
      const existingOverride = await scheduledTransactionsApi.getOverrideByDate(transaction.id, date);
      setOverrideEditor({
        isOpen: true,
        transaction,
        date,
        existingOverride,
      });
    } catch (error) {
      console.error('Failed to check for existing override:', error);
      // Open the editor anyway, without existing override data
      setOverrideEditor({
        isOpen: true,
        transaction,
        date,
        existingOverride: null,
      });
    }
  };

  const handleDatePickerClose = () => {
    setDatePicker({ isOpen: false, transaction: null, overrideDates: [] });
  };

  const handleOverrideEditorClose = () => {
    setOverrideEditor({
      isOpen: false,
      transaction: null,
      date: '',
      existingOverride: null,
    });
  };

  const handleOverrideEditorSave = () => {
    loadData();
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
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl dark:shadow-gray-700/50 max-w-4xl w-full max-h-[90vh] overflow-y-auto p-6">
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
              onEditOccurrence={handleEditOccurrence}
              onRefresh={loadData}
            />
          )}
        </div>
      </div>

      {/* Occurrence Date Picker */}
      {datePicker.transaction && (
        <OccurrenceDatePicker
          isOpen={datePicker.isOpen}
          scheduledTransaction={datePicker.transaction}
          overrideDates={datePicker.overrideDates}
          onSelect={handleDatePickerSelect}
          onClose={handleDatePickerClose}
        />
      )}

      {/* Override Editor Dialog */}
      {overrideEditor.transaction && (
        <OverrideEditorDialog
          isOpen={overrideEditor.isOpen}
          scheduledTransaction={overrideEditor.transaction}
          overrideDate={overrideEditor.date}
          categories={categories}
          existingOverride={overrideEditor.existingOverride}
          onClose={handleOverrideEditorClose}
          onSave={handleOverrideEditorSave}
        />
      )}

      {/* Override Confirmation Dialog */}
      {overrideConfirm.isOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:p-0">
            <div className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75 dark:bg-gray-900 dark:bg-opacity-75" />
            <div className="inline-block px-6 py-5 overflow-hidden text-left align-bottom transition-all transform bg-white dark:bg-gray-800 rounded-lg shadow-xl sm:my-8 sm:align-middle sm:max-w-lg sm:w-full">
              <div className="mb-4">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  Existing Overrides Found
                </h3>
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  This scheduled transaction has {overrideConfirm.overrideCount} individual occurrence{overrideConfirm.overrideCount !== 1 ? 's' : ''} with custom modifications.
                </p>
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  What would you like to do with these modifications when you update the base template?
                </p>
              </div>
              <div className="flex flex-col space-y-3 sm:flex-row sm:space-y-0 sm:space-x-3 sm:justify-end">
                <Button variant="outline" onClick={handleOverrideConfirmCancel}>
                  Cancel
                </Button>
                <Button variant="outline" onClick={handleOverrideConfirmKeep}>
                  Keep Modifications
                </Button>
                <Button onClick={handleOverrideConfirmDelete} className="bg-red-600 hover:bg-red-700">
                  Delete All Modifications
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
