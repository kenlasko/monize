'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { Transaction } from '@/types/transaction';
import { transactionsApi } from '@/lib/transactions';
import { Button } from '@/components/ui/Button';

// Density levels: 'normal' | 'compact' | 'dense'
export type DensityLevel = 'normal' | 'compact' | 'dense';

interface TransactionListProps {
  transactions: Transaction[];
  onEdit?: (transaction: Transaction) => void;
  onDelete?: (id: string) => void;
  onRefresh?: () => void;
  density?: DensityLevel;
  onDensityChange?: (density: DensityLevel) => void;
}

export function TransactionList({
  transactions,
  onEdit,
  onDelete,
  onRefresh,
  density: propDensity,
  onDensityChange,
}: TransactionListProps) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [localDensity, setLocalDensity] = useState<DensityLevel>('normal');

  // Use prop density if provided, otherwise use local state
  const density = propDensity ?? localDensity;

  // Get padding classes based on density
  const getCellPadding = () => {
    switch (density) {
      case 'dense': return 'px-3 py-1';
      case 'compact': return 'px-4 py-2';
      default: return 'px-6 py-4';
    }
  };

  const getHeaderPadding = () => {
    switch (density) {
      case 'dense': return 'px-3 py-2';
      case 'compact': return 'px-4 py-2';
      default: return 'px-6 py-3';
    }
  };

  const cycleDensity = () => {
    const nextDensity = density === 'normal' ? 'compact' : density === 'compact' ? 'dense' : 'normal';
    if (onDensityChange) {
      onDensityChange(nextDensity);
    } else {
      setLocalDensity(nextDensity);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this transaction?')) {
      return;
    }

    setDeletingId(id);
    try {
      await transactionsApi.delete(id);
      toast.success('Transaction deleted');
      onDelete?.(id);
      onRefresh?.();
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to delete transaction';
      toast.error(message);
    } finally {
      setDeletingId(null);
    }
  };

  const handleToggleCleared = async (transaction: Transaction) => {
    try {
      await transactionsApi.markCleared(transaction.id, !transaction.isCleared);
      toast.success(transaction.isCleared ? 'Marked as uncleared' : 'Marked as cleared');
      onRefresh?.();
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to update transaction';
      toast.error(message);
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
      <span className={isNegative ? 'text-red-600' : 'text-green-600'}>
        {isNegative ? '-' : '+'}{formatted}
      </span>
    );
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

  const cellPadding = getCellPadding();
  const headerPadding = getHeaderPadding();

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
              <th className={`${headerPadding} text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Status
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {transactions.map((transaction, index) => (
              <tr
                key={transaction.id}
                className={`hover:bg-gray-100 dark:hover:bg-gray-800 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-gray-800/50' : ''}`}
              >
                <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100`}>
                  {format(new Date(transaction.transactionDate), density === 'dense' ? 'MM/dd/yy' : 'MMM d, yyyy')}
                </td>
                <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100`}>
                  {transaction.account?.name || '-'}
                </td>
                <td className={`${cellPadding}`}>
                  <div
                    className={`text-sm font-medium text-gray-900 dark:text-gray-100 truncate ${
                      density === 'normal' ? 'max-w-[120px]' : 'max-w-[200px]'
                    }`}
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
                <td className={`${cellPadding}`}>
                  {transaction.isSplit ? (
                    <div>
                      <span className={`inline-flex text-xs leading-5 font-semibold rounded-full bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200 ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}>
                        Split{density !== 'dense' && transaction.splits ? ` (${transaction.splits.length})` : ''}
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
                      className={`inline-flex text-xs leading-5 font-semibold rounded-full ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
                      style={{
                        backgroundColor: transaction.category.color
                          ? `${transaction.category.color}20`
                          : '#e5e7eb',
                        color: transaction.category.color || '#6b7280',
                      }}
                    >
                      {transaction.category.name}
                    </span>
                  ) : (
                    <span className="text-sm text-gray-400 dark:text-gray-500">-</span>
                  )}
                </td>
                <td className={`${cellPadding} text-sm text-gray-500 dark:text-gray-400`}>
                  <div
                    className={`truncate ${
                      density === 'normal' ? 'max-w-[120px]' : 'max-w-[200px]'
                    }`}
                    title={transaction.description || undefined}
                  >
                    {transaction.description || '-'}
                  </div>
                </td>
                <td className={`${cellPadding} whitespace-nowrap text-sm font-medium text-right`}>
                  {formatAmount(transaction.amount)}
                </td>
                <td className={`${cellPadding} whitespace-nowrap text-center`}>
                  <button
                    onClick={() => handleToggleCleared(transaction)}
                    className="text-sm"
                    title={transaction.isCleared ? 'Click to mark as uncleared' : 'Click to mark as cleared'}
                  >
                    {transaction.isCleared ? (
                      <span className="text-green-600 dark:text-green-400">{density === 'dense' ? '✓' : '✓ Cleared'}</span>
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
                    onClick={() => handleDelete(transaction.id)}
                    disabled={deletingId === transaction.id}
                    className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 disabled:opacity-50"
                  >
                    {deletingId === transaction.id ? '...' : density === 'dense' ? '✕' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
