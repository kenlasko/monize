'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { Transaction } from '@/types/transaction';
import { transactionsApi } from '@/lib/transactions';
import { Button } from '@/components/ui/Button';

interface TransactionListProps {
  transactions: Transaction[];
  onEdit?: (transaction: Transaction) => void;
  onDelete?: (id: string) => void;
  onRefresh?: () => void;
}

export function TransactionList({
  transactions,
  onEdit,
  onDelete,
  onRefresh,
}: TransactionListProps) {
  const [deletingId, setDeletingId] = useState<string | null>(null);

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
      <div className="text-center py-12 bg-gray-50 rounded-lg">
        <svg
          className="mx-auto h-12 w-12 text-gray-400"
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
        <h3 className="mt-2 text-sm font-medium text-gray-900">No transactions</h3>
        <p className="mt-1 text-sm text-gray-500">
          Get started by creating a new transaction.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Date
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Payee
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Category
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Description
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Amount
            </th>
            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
              Status
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {transactions.map((transaction) => (
            <tr key={transaction.id} className="hover:bg-gray-50">
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                {format(new Date(transaction.transactionDate), 'MMM d, yyyy')}
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                <div className="text-sm font-medium text-gray-900">
                  {transaction.payeeName || '-'}
                </div>
                {transaction.referenceNumber && (
                  <div className="text-xs text-gray-500">
                    Ref: {transaction.referenceNumber}
                  </div>
                )}
              </td>
              <td className="px-6 py-4">
                {transaction.isSplit ? (
                  <div>
                    <span className="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full bg-purple-100 text-purple-800">
                      Split
                    </span>
                    {transaction.splits && transaction.splits.length > 0 && (
                      <div className="mt-1 text-xs text-gray-500 space-y-0.5">
                        {[...transaction.splits]
                          .sort((a, b) => Math.abs(Number(b.amount)) - Math.abs(Number(a.amount)))
                          .slice(0, 3)
                          .map((split, idx) => (
                          <div key={split.id || idx} className="truncate max-w-[180px]">
                            {split.category?.name || 'Uncategorized'}: ${Math.abs(Number(split.amount)).toFixed(2)}
                          </div>
                        ))}
                        {transaction.splits.length > 3 && (
                          <div className="text-gray-400">+{transaction.splits.length - 3} more</div>
                        )}
                      </div>
                    )}
                  </div>
                ) : transaction.category ? (
                  <span
                    className="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full"
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
                  <span className="text-sm text-gray-400">Uncategorized</span>
                )}
              </td>
              <td className="px-6 py-4 text-sm text-gray-500 max-w-xs truncate">
                {transaction.description || '-'}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-right">
                {formatAmount(transaction.amount)}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-center">
                <button
                  onClick={() => handleToggleCleared(transaction)}
                  className="text-sm"
                  title={transaction.isCleared ? 'Click to mark as uncleared' : 'Click to mark as cleared'}
                >
                  {transaction.isCleared ? (
                    <span className="text-green-600">✓ Cleared</span>
                  ) : (
                    <span className="text-gray-400">Pending</span>
                  )}
                </button>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2">
                {onEdit && (
                  <button
                    onClick={() => onEdit(transaction)}
                    className="text-blue-600 hover:text-blue-900"
                  >
                    Edit
                  </button>
                )}
                <button
                  onClick={() => handleDelete(transaction.id)}
                  disabled={deletingId === transaction.id}
                  className="text-red-600 hover:text-red-900 disabled:opacity-50"
                >
                  {deletingId === transaction.id ? 'Deleting...' : 'Delete'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
