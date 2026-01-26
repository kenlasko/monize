'use client';

import { format } from 'date-fns';
import { InvestmentTransaction } from '@/types/investment';

interface InvestmentTransactionListProps {
  transactions: InvestmentTransaction[];
  isLoading: boolean;
  onDelete?: (id: string) => void;
  onEdit?: (transaction: InvestmentTransaction) => void;
}

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  BUY: { label: 'Buy', color: 'text-green-600 dark:text-green-400' },
  SELL: { label: 'Sell', color: 'text-red-600 dark:text-red-400' },
  DIVIDEND: { label: 'Dividend', color: 'text-blue-600 dark:text-blue-400' },
  INTEREST: { label: 'Interest', color: 'text-blue-600 dark:text-blue-400' },
  CAPITAL_GAIN: { label: 'Capital Gain', color: 'text-purple-600 dark:text-purple-400' },
  SPLIT: { label: 'Split', color: 'text-yellow-600 dark:text-yellow-400' },
  TRANSFER_IN: { label: 'Transfer In', color: 'text-green-600 dark:text-green-400' },
  TRANSFER_OUT: { label: 'Transfer Out', color: 'text-red-600 dark:text-red-400' },
  REINVEST: { label: 'Reinvest', color: 'text-indigo-600 dark:text-indigo-400' },
};

export function InvestmentTransactionList({
  transactions,
  isLoading,
  onDelete,
  onEdit,
}: InvestmentTransactionListProps) {
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: 'CAD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  const formatQuantity = (value: number) => {
    return new Intl.NumberFormat('en-CA', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 4,
    }).format(value);
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Recent Transactions
        </h3>
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="animate-pulse flex justify-between">
              <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
              <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/4" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Recent Transactions
        </h3>
        <p className="text-gray-500 dark:text-gray-400">
          No investment transactions yet.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
      <div className="p-6 pb-0">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Recent Transactions
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Date
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Action
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Symbol
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Shares
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Price
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Total
              </th>
              {(onDelete || onEdit) && (
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Actions
                </th>
              )}
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
            {transactions.map((tx) => {
              const actionInfo = ACTION_LABELS[tx.action] || {
                label: tx.action,
                color: 'text-gray-600 dark:text-gray-400',
              };
              return (
                <tr key={tx.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                    {format(new Date(tx.transactionDate), 'MMM d, yyyy')}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`text-sm font-medium ${actionInfo.color}`}>
                      {actionInfo.label}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {tx.security.symbol}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[100px]">
                      {tx.security.name}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100">
                    {formatQuantity(tx.quantity)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100">
                    {formatCurrency(tx.price)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                    {formatCurrency(tx.totalAmount)}
                  </td>
                  {(onDelete || onEdit) && (
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm space-x-3">
                      {onEdit && (
                        <button
                          onClick={() => onEdit(tx)}
                          className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
                        >
                          Edit
                        </button>
                      )}
                      {onDelete && (
                        <button
                          onClick={() => onDelete(tx.id)}
                          className="text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
