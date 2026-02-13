'use client';

import { useState, useEffect, useMemo } from 'react';
import toast from 'react-hot-toast';
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameMonth,
  isToday as checkIsToday,
  addMonths,
  subMonths,
  getDay,
  addWeeks,
  addDays,
  addYears,
} from 'date-fns';
import { Button } from '@/components/ui/Button';
import { ScheduledTransactionForm } from '@/components/scheduled-transactions/ScheduledTransactionForm';
import { CashFlowForecastChart } from '@/components/bills/CashFlowForecastChart';
import { ScheduledTransactionList } from '@/components/scheduled-transactions/ScheduledTransactionList';
import { OverrideEditorDialog } from '@/components/scheduled-transactions/OverrideEditorDialog';
import { OccurrenceDatePicker } from '@/components/scheduled-transactions/OccurrenceDatePicker';
import { PostTransactionDialog } from '@/components/scheduled-transactions/PostTransactionDialog';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { categoriesApi } from '@/lib/categories';
import { accountsApi } from '@/lib/accounts';
import { ScheduledTransaction, ScheduledTransactionOverride } from '@/types/scheduled-transaction';
import { Category } from '@/types/category';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { useFormModal } from '@/hooks/useFormModal';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('Bills');

interface OverrideEditorState {
  isOpen: boolean;
  transaction: ScheduledTransaction | null;
  date: string;
  existingOverride: ScheduledTransactionOverride | null;
}

export default function BillsPage() {
  return (
    <ProtectedRoute>
      <BillsContent />
    </ProtectedRoute>
  );
}

function BillsContent() {
  const { formatCurrency } = useNumberFormat();
  const [scheduledTransactions, setScheduledTransactions] = useState<ScheduledTransaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { showForm, editingItem: editingTransaction, openCreate, openEdit, close, isEditing, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef } = useFormModal<ScheduledTransaction>();
  const [filterType, setFilterType] = useState<'all' | 'bills' | 'deposits'>('all');
  const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list');
  const [calendarMonth, setCalendarMonth] = useState(new Date());
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
    overrides: Array<{ originalDate: string; overrideDate: string }>;
  }>({ isOpen: false, transaction: null, overrides: [] });
  const [postDialog, setPostDialog] = useState<{
    isOpen: boolean;
    transaction: ScheduledTransaction | null;
  }>({ isOpen: false, transaction: null });

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [transactionsData, categoriesData, accountsData] = await Promise.all([
        scheduledTransactionsApi.getAll(),
        categoriesApi.getAll(),
        accountsApi.getAll(),
      ]);
      setScheduledTransactions(transactionsData);
      setCategories(categoriesData);
      setAccounts(accountsData);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to load scheduled transactions'));
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreateNew = () => {
    openCreate();
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
        openEdit(transaction);
      }
    } catch (error) {
      // If check fails, proceed anyway
      logger.error('Failed to check overrides:', error);
      openEdit(transaction);
    }
  };

  const handleOverrideConfirmKeep = () => {
    // Keep overrides and edit the base template
    if (overrideConfirm.transaction) {
      openEdit(overrideConfirm.transaction);
    }
    setOverrideConfirm({ isOpen: false, transaction: null, overrideCount: 0 });
  };

  const handleOverrideConfirmDelete = async () => {
    // Delete all overrides and then edit
    if (overrideConfirm.transaction) {
      try {
        await scheduledTransactionsApi.deleteAllOverrides(overrideConfirm.transaction.id);
        toast.success('Overrides deleted');
        openEdit(overrideConfirm.transaction);
      } catch (error) {
        toast.error(getErrorMessage(error, 'Failed to delete overrides'));
        logger.error(error);
      }
    }
    setOverrideConfirm({ isOpen: false, transaction: null, overrideCount: 0 });
  };

  const handleOverrideConfirmCancel = () => {
    setOverrideConfirm({ isOpen: false, transaction: null, overrideCount: 0 });
  };

  const handleFormSuccess = () => {
    close();
    loadData();
  };

  const handleFormCancel = () => {
    close();
  };

  const handleEditOccurrence = async (transaction: ScheduledTransaction) => {
    // Fetch existing overrides to show which dates are modified
    let overrides: Array<{ originalDate: string; overrideDate: string }> = [];
    try {
      const fetchedOverrides = await scheduledTransactionsApi.getOverrides(transaction.id);
      overrides = fetchedOverrides.map(o => ({
        originalDate: o.originalDate,
        overrideDate: o.overrideDate,
      }));
    } catch (error) {
      logger.error('Failed to fetch overrides:', error);
    }

    // Show the date picker to let user choose which occurrence to edit
    setDatePicker({
      isOpen: true,
      transaction,
      overrides,
    });
  };

  const handleDatePickerSelect = async (date: string) => {
    const transaction = datePicker.transaction;
    if (!transaction) return;

    // Check if the selected date is an override date (user clicked on a modified occurrence)
    // or an original calculated date (user clicked on an unmodified occurrence)
    const overrideByOverrideDate = datePicker.overrides.find(o => o.overrideDate === date);
    const overrideByOriginalDate = datePicker.overrides.find(o => o.originalDate === date);

    // Close the date picker
    setDatePicker({ isOpen: false, transaction: null, overrides: [] });

    try {
      let existingOverride: ScheduledTransactionOverride | null = null;

      if (overrideByOverrideDate) {
        // User clicked on a date that is the override date - fetch the full override
        existingOverride = await scheduledTransactionsApi.getOverrideByDate(
          transaction.id,
          overrideByOverrideDate.originalDate
        );
      } else if (overrideByOriginalDate) {
        // User clicked on an original date that has been overridden (shouldn't happen with new logic)
        existingOverride = await scheduledTransactionsApi.getOverrideByDate(
          transaction.id,
          overrideByOriginalDate.originalDate
        );
      }

      setOverrideEditor({
        isOpen: true,
        transaction,
        date: overrideByOverrideDate?.originalDate || date, // Use original date if this was an override
        existingOverride,
      });
    } catch (error) {
      logger.error('Failed to check for existing override:', error);
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
    setDatePicker({ isOpen: false, transaction: null, overrides: [] });
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

  const handlePost = (transaction: ScheduledTransaction) => {
    setPostDialog({ isOpen: true, transaction });
  };

  const handlePostDialogClose = () => {
    setPostDialog({ isOpen: false, transaction: null });
  };

  const handlePostDialogPosted = () => {
    loadData();
  };

  // Filter transactions based on type
  const filteredTransactions = scheduledTransactions.filter((t) => {
    if (filterType === 'bills') return t.amount < 0;
    if (filterType === 'deposits') return t.amount > 0;
    return true;
  });

  // Calculate summary stats in a single pass (exclude transfers from bills/deposits)
  const summary = useMemo(() => {
    const normalizeToMonthly = (amount: number, frequency: string): number => {
      switch (frequency) {
        case 'DAILY': return amount * 30;
        case 'WEEKLY': return amount * 4.33;
        case 'BIWEEKLY': return amount * 2.17;
        case 'MONTHLY': return amount;
        case 'QUARTERLY': return amount / 3;
        case 'YEARLY': return amount / 12;
        default: return 0;
      }
    };

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let totalBills = 0;
    let totalDeposits = 0;
    let monthlyBills = 0;
    let monthlyDeposits = 0;
    let dueCount = 0;

    for (const t of scheduledTransactions) {
      const amount = Number(t.amount);
      const isActiveNonTransfer = t.isActive && !t.isTransfer;

      if (isActiveNonTransfer) {
        if (amount < 0) {
          totalBills++;
          monthlyBills += normalizeToMonthly(Math.abs(amount), t.frequency);
        } else if (amount > 0) {
          totalDeposits++;
          monthlyDeposits += normalizeToMonthly(amount, t.frequency);
        }
      }

      if (t.isActive && t.nextDueDate) {
        try {
          const dueDate = parseLocalDate(t.nextDueDate);
          if (dueDate && !isNaN(dueDate.getTime()) && dueDate <= today) {
            dueCount++;
          }
        } catch { /* skip invalid dates */ }
      }
    }

    return { totalBills, totalDeposits, monthlyBills, monthlyDeposits, dueCount };
  }, [scheduledTransactions]);

  // Generate upcoming occurrences for calendar view
  const getNextOccurrences = (st: ScheduledTransaction, _monthsAhead: number = 3): Date[] => {
    if (!st.nextDueDate) return [];
    const occurrences: Date[] = [];
    const startDate = subMonths(startOfMonth(calendarMonth), 1);
    const endDate = addMonths(endOfMonth(calendarMonth), 1);
    let nextDate = parseLocalDate(st.nextDueDate);
    let count = 0;

    while (nextDate <= endDate && count < 100) {
      if (nextDate >= startDate) {
        occurrences.push(new Date(nextDate));
      }
      switch (st.frequency) {
        case 'ONCE': return occurrences;
        case 'DAILY': nextDate = addDays(nextDate, 1); break;
        case 'WEEKLY': nextDate = addWeeks(nextDate, 1); break;
        case 'BIWEEKLY': nextDate = addWeeks(nextDate, 2); break;
        case 'MONTHLY': nextDate = addMonths(nextDate, 1); break;
        case 'QUARTERLY': nextDate = addMonths(nextDate, 3); break;
        case 'YEARLY': nextDate = addYears(nextDate, 1); break;
      }
      count++;
    }
    return occurrences;
  };

  const calendarDays = useMemo(() => {
    const monthStart = startOfMonth(calendarMonth);
    const monthEnd = endOfMonth(calendarMonth);
    const calStart = new Date(monthStart);
    calStart.setDate(calStart.getDate() - getDay(monthStart));
    const calEnd = new Date(monthEnd);
    calEnd.setDate(calEnd.getDate() + (6 - getDay(monthEnd)));

    const days = eachDayOfInterval({ start: calStart, end: calEnd });
    const billsByDate = new Map<string, ScheduledTransaction[]>();

    const activeNonTransfer = scheduledTransactions.filter((st) => st.isActive && !st.isTransfer);
    activeNonTransfer.forEach((st) => {
      getNextOccurrences(st).forEach((date) => {
        const key = format(date, 'yyyy-MM-dd');
        const existing = billsByDate.get(key) || [];
        existing.push(st);
        billsByDate.set(key, existing);
      });
    });

    return days.map((date) => ({
      date,
      isCurrentMonth: isSameMonth(date, calendarMonth),
      isToday: checkIsToday(date),
      bills: billsByDate.get(format(date, 'yyyy-MM-dd')) || [],
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarMonth, scheduledTransactions]);

  return (
    <PageLayout>

      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title="Bills & Deposits"
          subtitle="Manage your recurring transactions and scheduled payments"
          actions={<Button onClick={handleCreateNew}>+ New Schedule</Button>}
        />
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
          <SummaryCard label="Active Bills" value={summary.totalBills} icon={SummaryIcons.clipboard} />
          <SummaryCard label="Active Deposits" value={summary.totalDeposits} icon={SummaryIcons.plus} />
          <SummaryCard
            label="Monthly Net"
            value={formatCurrency(summary.monthlyDeposits - summary.monthlyBills)}
            icon={SummaryIcons.money}
            valueColor={summary.monthlyDeposits - summary.monthlyBills >= 0 ? 'green' : 'red'}
          />
          <SummaryCard
            label="Due Now"
            value={summary.dueCount}
            icon={SummaryIcons.clock}
            valueColor={summary.dueCount > 0 ? 'red' : 'default'}
          />
        </div>

        {/* Cash Flow Forecast Chart */}
        <ErrorBoundary fallback={
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 mb-6">
            <p className="text-gray-500 dark:text-gray-400">Chart temporarily unavailable</p>
          </div>
        }>
          <CashFlowForecastChart
            scheduledTransactions={scheduledTransactions}
            accounts={accounts}
            isLoading={isLoading}
          />
        </ErrorBoundary>

        {/* Form Modal */}
        <Modal isOpen={showForm} onClose={close} {...modalProps} maxWidth="5xl" className="p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {isEditing ? 'Edit Scheduled Transaction' : 'New Scheduled Transaction'}
          </h2>
          <ScheduledTransactionForm
            key={editingTransaction?.id || 'new'}
            scheduledTransaction={editingTransaction}
            onSuccess={handleFormSuccess}
            onCancel={close}
            onDirtyChange={setFormDirty}
            submitRef={formSubmitRef}
          />
        </Modal>
        <UnsavedChangesDialog {...unsavedChangesDialog} />

        {/* View Toggle + Filter Tabs */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg mb-6">
          <div className="border-b border-gray-200 dark:border-gray-700 flex flex-wrap items-center justify-between">
            <nav className="-mb-px flex">
              <button
                onClick={() => setViewMode('list')}
                className={`py-4 px-6 text-sm font-medium border-b-2 ${
                  viewMode === 'list'
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
                }`}
              >
                List
              </button>
              <button
                onClick={() => setViewMode('calendar')}
                className={`py-4 px-6 text-sm font-medium border-b-2 ${
                  viewMode === 'calendar'
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
                }`}
              >
                Calendar
              </button>
            </nav>
            {viewMode === 'list' && (
              <div className="hidden sm:flex pr-4 gap-2">
                {(['all', 'bills', 'deposits'] as const).map((type) => (
                  <button
                    key={type}
                    onClick={() => setFilterType(type)}
                    className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                      filterType === type
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                    }`}
                  >
                    {type === 'all' ? `All (${scheduledTransactions.length})` :
                     type === 'bills' ? `Bills (${scheduledTransactions.filter((t) => t.amount < 0).length})` :
                     `Deposits (${scheduledTransactions.filter((t) => t.amount > 0).length})`}
                  </button>
                ))}
              </div>
            )}
            {viewMode === 'calendar' && (
              <div className="flex items-center gap-2 px-4 py-2 sm:py-0 sm:pr-4 sm:pl-0 w-full sm:w-auto justify-center sm:justify-end">
                <button
                  onClick={() => setCalendarMonth(subMonths(calendarMonth, 1))}
                  className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <svg className="h-5 w-5 text-gray-600 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 min-w-[130px] text-center">
                  {format(calendarMonth, 'MMMM yyyy')}
                </span>
                <button
                  onClick={() => setCalendarMonth(addMonths(calendarMonth, 1))}
                  className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <svg className="h-5 w-5 text-gray-600 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
                <button
                  onClick={() => setCalendarMonth(new Date())}
                  className="ml-1 px-3 py-1 text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-md"
                >
                  Today
                </button>
              </div>
            )}
          </div>
        </div>

        {viewMode === 'list' ? (
          /* Scheduled Transactions List */
          <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
            {isLoading ? (
              <LoadingSpinner text="Loading scheduled transactions..." />
            ) : (
              <ScheduledTransactionList
                transactions={filteredTransactions}
                onEdit={handleEdit}
                onEditOccurrence={handleEditOccurrence}
                onPost={handlePost}
                onRefresh={loadData}
              />
            )}
          </div>
        ) : (
          /* Calendar View */
          <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
            <div className="grid grid-cols-7">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                <div
                  key={day}
                  className="px-2 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700"
                >
                  {day}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {calendarDays.map((day, index) => (
                <div
                  key={index}
                  className={`min-h-[100px] p-1 border-b border-r border-gray-200 dark:border-gray-700 ${
                    !day.isCurrentMonth
                      ? 'bg-gray-50 dark:bg-gray-900/50'
                      : 'bg-white dark:bg-gray-800'
                  }`}
                >
                  <div
                    className={`text-sm font-medium mb-1 w-7 h-7 flex items-center justify-center rounded-full ${
                      day.isToday
                        ? 'bg-blue-600 text-white'
                        : day.isCurrentMonth
                        ? 'text-gray-900 dark:text-gray-100'
                        : 'text-gray-400 dark:text-gray-600'
                    }`}
                  >
                    {format(day.date, 'd')}
                  </div>
                  <div className="space-y-0.5">
                    {day.bills.slice(0, 3).map((bill, billIndex) => {
                      const isExpense = bill.amount < 0;
                      return (
                        <div
                          key={billIndex}
                          onClick={() => handleEdit(bill)}
                          className={`px-1 py-0.5 text-xs rounded truncate cursor-pointer ${
                            isExpense
                              ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                              : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                          } hover:opacity-80`}
                        >
                          {bill.name}
                        </div>
                      );
                    })}
                    {day.bills.length > 3 && (
                      <div className="text-xs text-gray-500 dark:text-gray-400 px-1">
                        +{day.bills.length - 3} more
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Occurrence Date Picker */}
      {datePicker.transaction && (
        <OccurrenceDatePicker
          isOpen={datePicker.isOpen}
          scheduledTransaction={datePicker.transaction}
          overrides={datePicker.overrides}
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
          accounts={accounts}
          existingOverride={overrideEditor.existingOverride}
          onClose={handleOverrideEditorClose}
          onSave={handleOverrideEditorSave}
        />
      )}

      {/* Post Transaction Dialog */}
      {postDialog.transaction && (
        <PostTransactionDialog
          isOpen={postDialog.isOpen}
          scheduledTransaction={postDialog.transaction}
          categories={categories}
          accounts={accounts}
          onClose={handlePostDialogClose}
          onPosted={handlePostDialogPosted}
        />
      )}

      {/* Override Confirmation Dialog */}
      <Modal isOpen={overrideConfirm.isOpen} onClose={handleOverrideConfirmCancel} maxWidth="lg" className="px-6 py-5">
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
      </Modal>
    </PageLayout>
  );
}
