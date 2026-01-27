'use client';

import { useState, useMemo, useCallback } from 'react';
import { format } from 'date-fns';
import { InvestmentTransaction } from '@/types/investment';

// Density levels: 'normal' | 'compact' | 'dense'
export type DensityLevel = 'normal' | 'compact' | 'dense';

interface InvestmentTransactionListProps {
  transactions: InvestmentTransaction[];
  isLoading: boolean;
  onDelete?: (id: string) => void;
  onEdit?: (transaction: InvestmentTransaction) => void;
  density?: DensityLevel;
  onDensityChange?: (density: DensityLevel) => void;
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
  density: propDensity,
  onDensityChange,
}: InvestmentTransactionListProps) {
  const [localDensity, setLocalDensity] = useState<DensityLevel>('normal');

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
      <div className="p-6 pb-0 flex justify-between items-center">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Recent Transactions
        </h3>
      </div>
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
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Date
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Action
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Symbol
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Shares
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Price
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Total
              </th>
              {(onDelete || onEdit) && (
                <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                  Actions
                </th>
              )}
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
            {transactions.map((tx, index) => {
              const actionInfo = ACTION_LABELS[tx.action] || {
                label: tx.action,
                color: 'text-gray-600 dark:text-gray-400',
              };
              return (
                <tr
                  key={tx.id}
                  className={`hover:bg-gray-50 dark:hover:bg-gray-700/30 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-gray-800/50' : ''}`}
                >
                  <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100`}>
                    {format(new Date(tx.transactionDate), density === 'dense' ? 'MM/dd/yy' : 'MMM d, yyyy')}
                  </td>
                  <td className={`${cellPadding} whitespace-nowrap`}>
                    <span className={`text-sm font-medium ${actionInfo.color}`}>
                      {density === 'dense' ? actionInfo.label.substring(0, 3) : actionInfo.label}
                    </span>
                  </td>
                  <td className={`${cellPadding}`}>
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {tx.security.symbol}
                    </div>
                    {density === 'normal' && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {tx.security.name}
                      </div>
                    )}
                  </td>
                  <td className={`${cellPadding} whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100`}>
                    {formatQuantity(tx.quantity)}
                  </td>
                  <td className={`${cellPadding} whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100`}>
                    {formatCurrency(tx.price)}
                  </td>
                  <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium text-gray-900 dark:text-gray-100`}>
                    {formatCurrency(tx.totalAmount)}
                  </td>
                  {(onDelete || onEdit) && (
                    <td className={`${cellPadding} whitespace-nowrap text-right text-sm space-x-3`}>
                      {onEdit && (
                        <button
                          onClick={() => onEdit(tx)}
                          className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
                        >
                          {density === 'dense' ? '✎' : 'Edit'}
                        </button>
                      )}
                      {onDelete && (
                        <button
                          onClick={() => onDelete(tx.id)}
                          className="text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300"
                        >
                          {density === 'dense' ? '✕' : 'Delete'}
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
