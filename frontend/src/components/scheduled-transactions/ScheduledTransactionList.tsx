'use client';

import { useState } from 'react';
import { isPast, isToday, addDays, isBefore } from 'date-fns';
import toast from 'react-hot-toast';
import { ScheduledTransaction, FREQUENCY_LABELS } from '@/types/scheduled-transaction';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { parseLocalDate } from '@/lib/utils';
import { useDateFormat } from '@/hooks/useDateFormat';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

type ConfirmAction = 'post' | 'skip' | 'delete';

interface ConfirmState {
  isOpen: boolean;
  action: ConfirmAction | null;
  transaction: ScheduledTransaction | null;
}

interface ScheduledTransactionListProps {
  transactions: ScheduledTransaction[];
  onEdit?: (transaction: ScheduledTransaction) => void;
  onEditOccurrence?: (transaction: ScheduledTransaction) => void;
  onPost?: (transaction: ScheduledTransaction) => void;
  onRefresh?: () => void;
}

export function ScheduledTransactionList({
  transactions,
  onEdit,
  onEditOccurrence,
  onPost,
  onRefresh,
}: ScheduledTransactionListProps) {
  const { formatDate } = useDateFormat();
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>({
    isOpen: false,
    action: null,
    transaction: null,
  });

  const openConfirm = (action: ConfirmAction, transaction: ScheduledTransaction) => {
    setConfirmState({ isOpen: true, action, transaction });
  };

  const closeConfirm = () => {
    setConfirmState({ isOpen: false, action: null, transaction: null });
  };

  const handleConfirm = async () => {
    const { action, transaction } = confirmState;
    if (!action || !transaction) return;

    closeConfirm();
    setActionInProgress(transaction.id);

    try {
      switch (action) {
        case 'post':
          await scheduledTransactionsApi.post(transaction.id);
          toast.success('Transaction posted');
          break;
        case 'skip':
          await scheduledTransactionsApi.skip(transaction.id);
          toast.success('Occurrence skipped');
          break;
        case 'delete':
          await scheduledTransactionsApi.delete(transaction.id);
          toast.success('Scheduled transaction deleted');
          break;
      }
      onRefresh?.();
    } catch (error: any) {
      const messages = {
        post: 'Failed to post transaction',
        skip: 'Failed to skip occurrence',
        delete: 'Failed to delete',
      };
      const message = error.response?.data?.message || messages[action];
      toast.error(message);
    } finally {
      setActionInProgress(null);
    }
  };

  const getConfirmConfig = () => {
    const { action, transaction } = confirmState;
    if (!action || !transaction) {
      return { title: '', message: '', confirmLabel: '', variant: 'info' as const };
    }

    switch (action) {
      case 'post':
        return {
          title: 'Post Transaction',
          message: `Post "${transaction.name}" and record it in your ${transaction.account?.name || 'account'}?`,
          confirmLabel: 'Post',
          variant: 'info' as const,
        };
      case 'skip':
        return {
          title: 'Skip Occurrence',
          message: `Skip this occurrence of "${transaction.name}" and advance to the next due date?`,
          confirmLabel: 'Skip',
          variant: 'warning' as const,
        };
      case 'delete':
        return {
          title: 'Delete Scheduled Transaction',
          message: `Are you sure you want to delete "${transaction.name}"? This cannot be undone.`,
          confirmLabel: 'Delete',
          variant: 'danger' as const,
        };
    }
  };

  const formatAmount = (amount: number) => {
    const isNegative = amount < 0;
    const absAmount = Math.abs(amount);
    const formatted = new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: 'CAD',
    }).format(absAmount);

    return (
      <span className={isNegative ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}>
        {isNegative ? '-' : '+'}
        {formatted}
      </span>
    );
  };

  const getDueDateStatus = (nextDueDate: string) => {
    const date = parseLocalDate(nextDueDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (isPast(date) && !isToday(date)) {
      return { label: 'Overdue', className: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200' };
    }
    if (isToday(date)) {
      return { label: 'Due Today', className: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200' };
    }
    if (isBefore(date, addDays(today, 7))) {
      return { label: 'Due Soon', className: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' };
    }
    return null;
  };

  if (transactions.length === 0) {
    return (
      <div className="text-center py-12 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <svg
          className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">No scheduled transactions</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Get started by creating a bill or deposit schedule.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Name / Payee
            </th>
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell">
              Account
            </th>
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden md:table-cell">
              Category
            </th>
            <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Amount
            </th>
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Schedule
            </th>
            <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
          {transactions.map((transaction) => {
            const dueDateStatus = getDueDateStatus(transaction.nextDueDate);
            const isProcessing = actionInProgress === transaction.id;
            const payee = transaction.payeeName || transaction.payee?.name;

            return (
              <tr
                key={transaction.id}
                className={`hover:bg-gray-50 dark:hover:bg-gray-800 ${!transaction.isActive ? 'opacity-50' : ''}`}
              >
                {/* Name / Payee */}
                <td className="px-4 py-3">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{transaction.name}</div>
                  {payee && payee !== transaction.name && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">{payee}</div>
                  )}
                </td>

                {/* Account */}
                <td className="px-4 py-3 hidden sm:table-cell">
                  <div className="text-sm text-gray-900 dark:text-gray-100">{transaction.account?.name}</div>
                </td>

                {/* Category */}
                <td className="px-4 py-3 hidden md:table-cell">
                  {transaction.isTransfer ? (
                    <span
                      className="inline-flex text-xs font-medium rounded-full px-2 py-0.5 bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                      title={`Transfer to ${transaction.transferAccount?.name || 'account'}`}
                    >
                      Transfer
                    </span>
                  ) : transaction.isSplit ? (
                    <span
                      className="inline-flex text-xs font-medium rounded-full px-2 py-0.5 bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200"
                      title={transaction.splits?.map(s => s.category?.name || 'Uncategorized').join(', ')}
                    >
                      Split ({transaction.splits?.length || 0})
                    </span>
                  ) : transaction.category ? (
                    <span
                      className="inline-flex text-xs font-medium rounded-full px-2 py-0.5"
                      style={{
                        backgroundColor: transaction.category.color
                          ? `color-mix(in srgb, ${transaction.category.color} 15%, var(--category-bg-base, #e5e7eb))`
                          : 'var(--category-bg-base, #e5e7eb)',
                        color: transaction.category.color
                          ? `color-mix(in srgb, ${transaction.category.color} 85%, var(--category-text-mix, #000))`
                          : 'var(--category-text-base, #6b7280)',
                      }}
                    >
                      {transaction.category.name}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                  )}
                </td>

                {/* Amount */}
                <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-right">
                  {transaction.nextOverride?.amount !== undefined && transaction.nextOverride?.amount !== null ? (
                    <div className="flex flex-col items-end">
                      <span className="text-xs text-gray-400 dark:text-gray-500 line-through">
                        {formatAmount(transaction.amount)}
                      </span>
                      <span title="Modified for next occurrence">
                        {formatAmount(transaction.nextOverride.amount)}
                      </span>
                    </div>
                  ) : (
                    formatAmount(transaction.amount)
                  )}
                </td>

                {/* Schedule (Frequency + Next Due + Remaining) */}
                <td className="px-4 py-3">
                  <div className="text-sm text-gray-900 dark:text-gray-100">
                    {formatDate(transaction.nextDueDate)}
                    {dueDateStatus && (
                      <span
                        className={`ml-1.5 inline-flex text-xs font-medium rounded-full px-1.5 py-0.5 ${dueDateStatus.className}`}
                      >
                        {dueDateStatus.label}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {FREQUENCY_LABELS[transaction.frequency]}
                    {transaction.occurrencesRemaining !== null && (
                      <span className="ml-1">· {transaction.occurrencesRemaining} left</span>
                    )}
                    {transaction.overrideCount !== undefined && transaction.overrideCount > 0 && (
                      <span
                        className="ml-1.5 inline-flex text-xs font-medium rounded-full px-1.5 py-0.5 bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200"
                        title={`${transaction.overrideCount} upcoming occurrence${transaction.overrideCount !== 1 ? 's' : ''} modified`}
                      >
                        {transaction.overrideCount} modified
                      </span>
                    )}
                  </div>
                </td>

                {/* Actions */}
                <td className="px-4 py-3 whitespace-nowrap text-right">
                  <div className="flex justify-end items-center space-x-1">
                    {transaction.isActive && (
                      <>
                        <button
                          onClick={() => onPost ? onPost(transaction) : openConfirm('post', transaction)}
                          disabled={isProcessing}
                          className="p-1 text-green-600 dark:text-green-400 hover:text-green-900 dark:hover:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/50 rounded disabled:opacity-50"
                          title="Post transaction"
                        >
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        </button>
                        {transaction.frequency !== 'ONCE' && (
                          <button
                            onClick={() => openConfirm('skip', transaction)}
                            disabled={isProcessing}
                            className="p-1 text-yellow-600 dark:text-yellow-400 hover:text-yellow-900 dark:hover:text-yellow-300 hover:bg-yellow-50 dark:hover:bg-yellow-900/50 rounded disabled:opacity-50"
                            title="Skip this occurrence"
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                            </svg>
                          </button>
                        )}
                      </>
                    )}
                    {onEditOccurrence && transaction.isActive && (
                      <button
                        onClick={() => onEditOccurrence(transaction)}
                        className="p-1 text-purple-600 dark:text-purple-400 hover:text-purple-900 dark:hover:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-900/50 rounded"
                        title="Edit occurrence"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      </button>
                    )}
                    {onEdit && (
                      <button
                        onClick={() => onEdit(transaction)}
                        className="p-1 text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/50 rounded"
                        title="Edit schedule"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                    )}
                    <button
                      onClick={() => openConfirm('delete', transaction)}
                      disabled={isProcessing}
                      className="p-1 text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/50 rounded disabled:opacity-50"
                      title="Delete"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <ConfirmDialog
        isOpen={confirmState.isOpen}
        onConfirm={handleConfirm}
        onCancel={closeConfirm}
        {...getConfirmConfig()}
      />
    </div>
  );
}
