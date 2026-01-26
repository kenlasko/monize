'use client';

import { useState, useMemo, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Transaction, TransactionStatus } from '@/types/transaction';
import { transactionsApi } from '@/lib/transactions';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useDateFormat } from '@/hooks/useDateFormat';

// Density levels: 'normal' | 'compact' | 'dense'
export type DensityLevel = 'normal' | 'compact' | 'dense';

interface TransactionListProps {
  transactions: Transaction[];
  onEdit?: (transaction: Transaction) => void;
  onDelete?: (id: string) => void;
  onRefresh?: () => void;
  /** Callback to update a single transaction in place without full refresh */
  onTransactionUpdate?: (transaction: Transaction) => void;
  density?: DensityLevel;
  onDensityChange?: (density: DensityLevel) => void;
  /** Starting balance for running balance calculation (balance after first tx on page) */
  startingBalance?: number;
  /** Whether we're viewing a single account (enables running balance column) */
  isSingleAccountView?: boolean;
}

export function TransactionList({
  transactions,
  onEdit,
  onDelete,
  onRefresh,
  onTransactionUpdate,
  density: propDensity,
  onDensityChange,
  startingBalance,
  isSingleAccountView = false,
}: TransactionListProps) {
  const { formatDate } = useDateFormat();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [localDensity, setLocalDensity] = useState<DensityLevel>('normal');
  const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; transaction: Transaction | null }>({
    isOpen: false,
    transaction: null,
  });

  // Use prop density if provided, otherwise use local state
  const density = propDensity ?? localDensity;

  // Memoize padding classes based on density
  const cellPadding = useMemo(() => {
    switch (density) {
      case 'dense': return 'px-3 py-1';
      case 'compact': return 'px-4 py-2';
      default: return 'px-6 py-4';
    }
  }, [density]);

  const headerPadding = useMemo(() => {
    switch (density) {
      case 'dense': return 'px-3 py-2';
      case 'compact': return 'px-4 py-2';
      default: return 'px-6 py-3';
    }
  }, [density]);

  const cycleDensity = useCallback(() => {
    const nextDensity = density === 'normal' ? 'compact' : density === 'compact' ? 'dense' : 'normal';
    if (onDensityChange) {
      onDensityChange(nextDensity);
    } else {
      setLocalDensity(nextDensity);
    }
  }, [density, onDensityChange]);

  const handleDeleteClick = useCallback((transaction: Transaction) => {
    setDeleteConfirm({ isOpen: true, transaction });
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    const transaction = deleteConfirm.transaction;
    if (!transaction) return;

    setDeleteConfirm({ isOpen: false, transaction: null });
    setDeletingId(transaction.id);

    try {
      if (transaction.isTransfer) {
        await transactionsApi.deleteTransfer(transaction.id);
        toast.success('Transfer deleted');
      } else {
        await transactionsApi.delete(transaction.id);
        toast.success('Transaction deleted');
      }
      onDelete?.(transaction.id);
      onRefresh?.();
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to delete transaction';
      toast.error(message);
    } finally {
      setDeletingId(null);
    }
  }, [deleteConfirm.transaction, onDelete, onRefresh]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteConfirm({ isOpen: false, transaction: null });
  }, []);

  const handleCycleStatus = useCallback(async (transaction: Transaction) => {
    // Don't allow cycling VOID transactions - must edit to change
    if (transaction.status === TransactionStatus.VOID) {
      toast.error('Edit the transaction to change its status from Void');
      return;
    }

    // Cycle through: UNRECONCILED -> CLEARED -> RECONCILED -> UNRECONCILED (skip VOID)
    const statusOrder = [
      TransactionStatus.UNRECONCILED,
      TransactionStatus.CLEARED,
      TransactionStatus.RECONCILED,
    ];
    const currentIndex = statusOrder.indexOf(transaction.status);
    const nextStatus = statusOrder[(currentIndex + 1) % statusOrder.length];

    try {
      const updatedTransaction = await transactionsApi.updateStatus(transaction.id, nextStatus);
      const statusLabels: Record<TransactionStatus, string> = {
        [TransactionStatus.UNRECONCILED]: 'Unreconciled',
        [TransactionStatus.CLEARED]: 'Cleared',
        [TransactionStatus.RECONCILED]: 'Reconciled',
        [TransactionStatus.VOID]: 'Void',
      };
      toast.success(`Status changed to ${statusLabels[nextStatus]}`);

      if (onTransactionUpdate) {
        onTransactionUpdate(updatedTransaction);
      } else {
        onRefresh?.();
      }
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to update status';
      toast.error(message);
    }
  }, [onRefresh, onTransactionUpdate]);

  // Memoize the number formatter
  const currencyFormatter = useMemo(() => new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
  }), []);

  // Calculate running balances when viewing a single account
  // startingBalance = balance AFTER the first (newest) transaction on this page
  // For each tx: balance = startingBalance - sum of all preceding transactions on this page
  const runningBalances = useMemo(() => {
    if (!isSingleAccountView || startingBalance === undefined || transactions.length === 0) {
      return new Map<string, number>();
    }

    const balances = new Map<string, number>();
    let cumulativeSum = 0;

    for (const tx of transactions) {
      balances.set(tx.id, startingBalance - cumulativeSum);
      cumulativeSum += Number(tx.amount);
    }

    return balances;
  }, [transactions, startingBalance, isSingleAccountView]);

  const formatAmount = useCallback((amount: number) => {
    const isNegative = amount < 0;
    const absAmount = Math.abs(amount);
    const formatted = currencyFormatter.format(absAmount);

    return (
      <span className={isNegative ? 'text-red-600' : 'text-green-600'}>
        {isNegative ? '-' : '+'}{formatted}
      </span>
    );
  }, [currencyFormatter]);

  const formatBalance = useCallback((balance: number) => {
    const formatted = currencyFormatter.format(Math.abs(balance));
    return (
      <span className={balance < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'}>
        {balance < 0 ? `-${formatted}` : formatted}
      </span>
    );
  }, [currencyFormatter]);

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
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">No transactions</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Get started by creating a new transaction.
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Density toggle */}
      <div className="flex justify-end p-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <button
          onClick={cycleDensity}
          className="inline-flex items-center px-2 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
          title="Toggle row density"
        >
          <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          {density === 'normal' ? 'Normal' : density === 'compact' ? 'Compact' : 'Dense'}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Date
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Account
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Payee
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Category
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Description
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Amount
              </th>
              {isSingleAccountView && (
                <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                  Balance
                </th>
              )}
              <th className={`${headerPadding} text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Status
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {transactions.map((transaction, index) => {
              const isVoid = transaction.status === TransactionStatus.VOID;
              return (
              <tr
                key={transaction.id}
                className={`hover:bg-gray-100 dark:hover:bg-gray-800 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-gray-800/50' : ''} ${isVoid ? 'opacity-50' : ''}`}
              >
                <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 ${isVoid ? 'line-through' : ''}`}>
                  {formatDate(transaction.transactionDate)}
                </td>
                <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 ${isVoid ? 'line-through' : ''}`}>
                  {transaction.account?.name || '-'}
                </td>
                <td className={`${cellPadding}`}>
                  <div
                    className={`text-sm font-medium text-gray-900 dark:text-gray-100 truncate max-w-[280px] ${isVoid ? 'line-through' : ''}`}
                    title={transaction.payeeName || undefined}
                  >
                    {transaction.payeeName || '-'}
                  </div>
                  {density === 'normal' && transaction.referenceNumber && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      Ref: {transaction.referenceNumber}
                    </div>
                  )}
                </td>
                <td className={`${cellPadding} ${density !== 'normal' ? 'whitespace-nowrap' : ''}`}>
                  {transaction.isTransfer ? (
                    <span className={`inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}>
                      Transfer
                    </span>
                  ) : transaction.isSplit ? (
                    <div>
                      <span className={`inline-flex text-xs leading-5 font-semibold rounded-full bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200 ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}>
                        Split{transaction.splits ? ` (${transaction.splits.length})` : ''}
                      </span>
                      {density === 'normal' && transaction.splits && transaction.splits.length > 0 && (
                        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
                          {[...transaction.splits]
                            .sort((a, b) => Math.abs(Number(b.amount)) - Math.abs(Number(a.amount)))
                            .slice(0, 3)
                            .map((split, idx) => (
                            <div key={split.id || idx} className="truncate max-w-[180px]">
                              {split.category?.name || 'Uncategorized'}: ${Math.abs(Number(split.amount)).toFixed(2)}
                            </div>
                          ))}
                          {transaction.splits.length > 3 && (
                            <div className="text-gray-400 dark:text-gray-500">+{transaction.splits.length - 3} more</div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : transaction.category ? (
                    <span
                      className={`inline-flex text-xs leading-5 font-semibold rounded-full truncate max-w-[120px] ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
                      style={{
                        backgroundColor: transaction.category.color
                          ? `color-mix(in srgb, ${transaction.category.color} 15%, var(--category-bg-base, #e5e7eb))`
                          : 'var(--category-bg-base, #e5e7eb)',
                        color: transaction.category.color
                          ? `color-mix(in srgb, ${transaction.category.color} 85%, var(--category-text-mix, #000))`
                          : 'var(--category-text-base, #6b7280)',
                      }}
                      title={transaction.category.name}
                    >
                      {transaction.category.name}
                    </span>
                  ) : (
                    <span className="text-sm text-gray-400 dark:text-gray-500">-</span>
                  )}
                </td>
                <td className={`${cellPadding} text-sm text-gray-500 dark:text-gray-400`}>
                  <div
                    className={`truncate max-w-[320px] ${isVoid ? 'line-through' : ''}`}
                    title={transaction.description || undefined}
                  >
                    {transaction.description || '-'}
                  </div>
                </td>
                <td className={`${cellPadding} whitespace-nowrap text-sm font-medium text-right ${isVoid ? 'line-through' : ''}`}>
                  {formatAmount(transaction.amount)}
                </td>
                {isSingleAccountView && (
                  <td className={`${cellPadding} whitespace-nowrap text-sm font-medium text-right`}>
                    {runningBalances.has(transaction.id)
                      ? formatBalance(runningBalances.get(transaction.id)!)
                      : '-'}
                  </td>
                )}
                <td className={`${cellPadding} whitespace-nowrap text-center`}>
                  <button
                    onClick={() => handleCycleStatus(transaction)}
                    className="text-sm"
                    title="Click to cycle status"
                  >
                    {transaction.status === TransactionStatus.RECONCILED ? (
                      <span className="text-blue-600 dark:text-blue-400">{density === 'dense' ? 'R' : 'Reconciled'}</span>
                    ) : transaction.status === TransactionStatus.CLEARED ? (
                      <span className="text-green-600 dark:text-green-400">{density === 'dense' ? 'C' : 'Cleared'}</span>
                    ) : transaction.status === TransactionStatus.VOID ? (
                      <span className="text-red-600 dark:text-red-400">{density === 'dense' ? 'V' : 'VOID'}</span>
                    ) : (
                      <span className="text-gray-400 dark:text-gray-500">{density === 'dense' ? '○' : 'Pending'}</span>
                    )}
                  </button>
                </td>
                <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium space-x-2`}>
                  {onEdit && (
                    <button
                      onClick={() => onEdit(transaction)}
                      className="text-blue-600 hover:text-blue-900 dark:text-blue-400 dark:hover:text-blue-300"
                    >
                      {density === 'dense' ? '✎' : 'Edit'}
                    </button>
                  )}
                  <button
                    onClick={() => handleDeleteClick(transaction)}
                    disabled={deletingId === transaction.id}
                    className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 disabled:opacity-50"
                  >
                    {deletingId === transaction.id ? '...' : density === 'dense' ? '✕' : 'Delete'}
                  </button>
                </td>
              </tr>
            );
            })}
          </tbody>
        </table>
      </div>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={deleteConfirm.isOpen}
        title={deleteConfirm.transaction?.isTransfer ? 'Delete Transfer' : 'Delete Transaction'}
        message={
          deleteConfirm.transaction?.isTransfer
            ? 'Are you sure you want to delete this transfer? Both linked transactions will be deleted.'
            : 'Are you sure you want to delete this transaction? This action cannot be undone.'
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
    </div>
  );
}
