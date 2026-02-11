'use client';

import { useState, useMemo, useCallback, useRef, memo } from 'react';
import { useDateFormat } from '@/hooks/useDateFormat';
import { InvestmentTransaction } from '@/types/investment';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

// Density levels: 'normal' | 'compact' | 'dense'
export type DensityLevel = 'normal' | 'compact' | 'dense';

export interface TransactionFilters {
  symbol?: string;
  action?: string;
  startDate?: string;
  endDate?: string;
}

interface InvestmentTransactionListProps {
  transactions: InvestmentTransaction[];
  isLoading: boolean;
  onDelete?: (id: string) => void;
  onEdit?: (transaction: InvestmentTransaction) => void;
  onNewTransaction?: () => void;
  density?: DensityLevel;
  onDensityChange?: (density: DensityLevel) => void;
  filters?: TransactionFilters;
  onFiltersChange?: (filters: TransactionFilters) => void;
  availableSymbols?: string[];
}

const ACTION_LABELS: Record<string, { label: string; shortLabel: string; color: string }> = {
  BUY: { label: 'Buy', shortLabel: 'Buy', color: 'text-green-600 dark:text-green-400' },
  SELL: { label: 'Sell', shortLabel: 'Sell', color: 'text-red-600 dark:text-red-400' },
  DIVIDEND: { label: 'Dividend', shortLabel: 'Div', color: 'text-blue-600 dark:text-blue-400' },
  INTEREST: { label: 'Interest', shortLabel: 'Int', color: 'text-blue-600 dark:text-blue-400' },
  CAPITAL_GAIN: { label: 'Capital Gain', shortLabel: 'Cap', color: 'text-purple-600 dark:text-purple-400' },
  SPLIT: { label: 'Split', shortLabel: 'Split', color: 'text-yellow-600 dark:text-yellow-400' },
  TRANSFER_IN: { label: 'Transfer In', shortLabel: 'In', color: 'text-green-600 dark:text-green-400' },
  TRANSFER_OUT: { label: 'Transfer Out', shortLabel: 'Out', color: 'text-red-600 dark:text-red-400' },
  REINVEST: { label: 'Reinvest', shortLabel: 'Reinv', color: 'text-indigo-600 dark:text-indigo-400' },
  ADD_SHARES: { label: 'Add Shares', shortLabel: 'Add', color: 'text-teal-600 dark:text-teal-400' },
  REMOVE_SHARES: { label: 'Remove Shares', shortLabel: 'Rem', color: 'text-orange-600 dark:text-orange-400' },
};

const ACTION_OPTIONS = [
  { value: '', label: 'All Actions' },
  { value: 'BUY', label: 'Buy' },
  { value: 'SELL', label: 'Sell' },
  { value: 'DIVIDEND', label: 'Dividend' },
  { value: 'INTEREST', label: 'Interest' },
  { value: 'CAPITAL_GAIN', label: 'Capital Gain' },
  { value: 'REINVEST', label: 'Reinvest' },
  { value: 'SPLIT', label: 'Split' },
  { value: 'TRANSFER_IN', label: 'Transfer In' },
  { value: 'TRANSFER_OUT', label: 'Transfer Out' },
  { value: 'ADD_SHARES', label: 'Add Shares' },
  { value: 'REMOVE_SHARES', label: 'Remove Shares' },
];

interface InvestmentTransactionRowProps {
  tx: InvestmentTransaction;
  index: number;
  density: DensityLevel;
  cellPadding: string;
  defaultCurrency: string;
  formatDate: (date: string) => string;
  formatCurrency: (amount: number, currencyCode?: string) => string;
  formatQuantity: (value: number) => string;
  onRowClick: (tx: InvestmentTransaction) => void;
  onLongPressStart: (tx: InvestmentTransaction, e?: React.TouchEvent) => void;
  onLongPressEnd: () => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onEdit?: (tx: InvestmentTransaction) => void;
  onDeleteClick: (tx: InvestmentTransaction) => void;
  hasActions: boolean;
}

const InvestmentTransactionRow = memo(function InvestmentTransactionRow({
  tx,
  index,
  density,
  cellPadding,
  defaultCurrency,
  formatDate,
  formatCurrency,
  formatQuantity,
  onRowClick,
  onLongPressStart,
  onLongPressEnd,
  onTouchMove,
  onEdit,
  onDeleteClick,
  hasActions,
}: InvestmentTransactionRowProps) {
  const actionInfo = ACTION_LABELS[tx.action] || {
    label: tx.action,
    shortLabel: tx.action,
    color: 'text-gray-600 dark:text-gray-400',
  };

  return (
    <tr
      onClick={() => onRowClick(tx)}
      onMouseDown={() => onLongPressStart(tx)}
      onMouseUp={onLongPressEnd}
      onMouseLeave={onLongPressEnd}
      onTouchStart={(e) => onLongPressStart(tx, e)}
      onTouchMove={onTouchMove}
      onTouchEnd={onLongPressEnd}
      onTouchCancel={onLongPressEnd}
      className={`hover:bg-gray-50 dark:hover:bg-gray-700/30 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-gray-800/50' : ''} ${onEdit ? 'cursor-pointer' : ''}`}
    >
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100`}>
        {formatDate(tx.transactionDate)}
      </td>
      <td className={`${cellPadding} whitespace-nowrap`}>
        <span className={`text-sm font-medium ${actionInfo.color}`}>
          {density === 'dense' ? actionInfo.shortLabel : actionInfo.label}
        </span>
      </td>
      <td className={`${cellPadding}`}>
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {tx.security?.symbol || '-'}
        </div>
        {density === 'normal' && (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {tx.security?.name || ''}
          </div>
        )}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100 hidden sm:table-cell`}>
        {formatQuantity(tx.quantity ?? 0)}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100 hidden md:table-cell`}>
        {formatCurrency(tx.price ?? 0, tx.security?.currencyCode)}
        {tx.security?.currencyCode && tx.security.currencyCode !== defaultCurrency && (
          <span className="ml-1">{tx.security.currencyCode}</span>
        )}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium text-gray-900 dark:text-gray-100`}>
        {formatCurrency(tx.totalAmount, tx.security?.currencyCode)}
        {tx.security?.currencyCode && tx.security.currencyCode !== defaultCurrency && (
          <span className="ml-1 font-normal">{tx.security.currencyCode}</span>
        )}
      </td>
      {hasActions && (
        <td className={`${cellPadding} whitespace-nowrap text-right text-sm space-x-3 hidden min-[480px]:table-cell`}>
          {onEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(tx); }}
              className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
            >
              {density === 'dense' ? '✎' : 'Edit'}
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onDeleteClick(tx); }}
            className="text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300"
          >
            {density === 'dense' ? '✕' : 'Delete'}
          </button>
        </td>
      )}
    </tr>
  );
});

export function InvestmentTransactionList({
  transactions,
  isLoading,
  onDelete,
  onEdit,
  onNewTransaction,
  density: propDensity,
  onDensityChange,
  filters,
  onFiltersChange,
  availableSymbols = [],
}: InvestmentTransactionListProps) {
  const { formatCurrency, numberFormat } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const { defaultCurrency } = useExchangeRates();
  const [localDensity, setLocalDensity] = useState<DensityLevel>('normal');
  const [showFilters, setShowFilters] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; transaction: InvestmentTransaction | null }>({ isOpen: false, transaction: null });

  // Long-press handling for delete on mobile
  const longPressTimer = useRef<NodeJS.Timeout | null>(null);
  const longPressTriggered = useRef(false);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const LONG_PRESS_MOVE_THRESHOLD = 10;

  const handleLongPressStart = useCallback((transaction: InvestmentTransaction, e?: React.TouchEvent) => {
    if (!onDelete) return;

    if (e?.touches?.[0]) {
      touchStartPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else {
      touchStartPos.current = null;
    }

    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      setDeleteConfirm({ isOpen: true, transaction });
    }, 750);
  }, [onDelete]);

  const handleLongPressEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    touchStartPos.current = null;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartPos.current && longPressTimer.current && e.touches?.[0]) {
      const deltaX = Math.abs(e.touches[0].clientX - touchStartPos.current.x);
      const deltaY = Math.abs(e.touches[0].clientY - touchStartPos.current.y);
      if (deltaX > LONG_PRESS_MOVE_THRESHOLD || deltaY > LONG_PRESS_MOVE_THRESHOLD) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
        touchStartPos.current = null;
      }
    }
  }, []);

  const handleRowClick = useCallback((transaction: InvestmentTransaction) => {
    if (longPressTriggered.current) {
      longPressTriggered.current = false;
      return;
    }
    if (onEdit) {
      onEdit(transaction);
    }
  }, [onEdit]);

  const handleDeleteClick = useCallback((tx: InvestmentTransaction) => {
    setDeleteConfirm({ isOpen: true, transaction: tx });
  }, []);

  const handleDeleteConfirm = useCallback(() => {
    if (deleteConfirm.transaction && onDelete) {
      onDelete(deleteConfirm.transaction.id);
    }
    setDeleteConfirm({ isOpen: false, transaction: null });
  }, [deleteConfirm.transaction, onDelete]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteConfirm({ isOpen: false, transaction: null });
  }, []);

  // Check if any filters are active
  const hasActiveFilters = filters && (filters.symbol || filters.action || filters.startDate || filters.endDate);

  // Use prop density if provided, otherwise use local state
  const density = propDensity ?? localDensity;

  // Memoize padding classes based on density
  const cellPadding = useMemo(() => {
    switch (density) {
      case 'dense': return 'px-1.5 sm:px-3 py-1';
      case 'compact': return 'px-2 sm:px-4 py-2';
      default: return 'px-2 sm:px-6 py-3 sm:py-4';
    }
  }, [density]);

  const headerPadding = useMemo(() => {
    switch (density) {
      case 'dense': return 'px-1.5 sm:px-3 py-2';
      case 'compact': return 'px-2 sm:px-4 py-2';
      default: return 'px-2 sm:px-6 py-2 sm:py-3';
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

  const formatQuantity = useCallback((value: number) => {
    const locale = numberFormat === 'browser' ? undefined : numberFormat;
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 4,
    }).format(value);
  }, [numberFormat]);

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Recent Transactions
          </h3>
          {onNewTransaction && (
            <button
              onClick={onNewTransaction}
              className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
            >
              + New Transaction
            </button>
          )}
        </div>
        <p className="text-gray-500 dark:text-gray-400">
          No investment transactions yet.
        </p>
      </div>
    );
  }

  const handleFilterChange = (key: keyof TransactionFilters, value: string) => {
    if (onFiltersChange) {
      onFiltersChange({
        ...filters,
        [key]: value || undefined,
      });
    }
  };

  const clearFilters = () => {
    if (onFiltersChange) {
      onFiltersChange({});
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
      <div className="p-3 sm:p-6 pb-0 flex flex-wrap justify-between items-center gap-2">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Recent Transactions
          {hasActiveFilters && (
            <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
              (filtered)
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2 w-full sm:w-auto">
        {onNewTransaction && (
          <button
            onClick={onNewTransaction}
            className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
          >
            <span className="sm:hidden">+ New</span>
            <span className="hidden sm:inline">+ New Transaction</span>
          </button>
        )}
        {onFiltersChange && (
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md ${
              hasActiveFilters
                ? 'text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/30'
                : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            Filter
            {hasActiveFilters && (
              <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-blue-600 rounded-full">
                {[filters?.symbol, filters?.action, filters?.startDate, filters?.endDate].filter(Boolean).length}
              </span>
            )}
          </button>
        )}
        <button
          onClick={cycleDensity}
          className="ml-auto inline-flex items-center px-2 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md"
          title="Toggle row density"
        >
          <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          {density === 'normal' ? 'Normal' : density === 'compact' ? 'Compact' : 'Dense'}
        </button>
        </div>
      </div>

      {/* Filter Bar */}
      {showFilters && onFiltersChange && (
        <div className="px-3 sm:px-6 py-3 bg-gray-50 dark:bg-gray-700/30 border-b border-gray-200 dark:border-gray-700">
          <div className="flex flex-wrap items-center gap-3">
            {/* Symbol Filter */}
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Symbol:</label>
              <select
                value={filters?.symbol || ''}
                onChange={(e) => handleFilterChange('symbol', e.target.value)}
                className="text-sm font-sans border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500 min-w-36"
              >
                <option value="">All Symbols</option>
                {availableSymbols.map((symbol) => (
                  <option key={symbol} value={symbol}>{symbol}</option>
                ))}
              </select>
            </div>

            {/* Action Filter */}
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Action:</label>
              <select
                value={filters?.action || ''}
                onChange={(e) => handleFilterChange('action', e.target.value)}
                className="text-sm font-sans border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500 min-w-36"
              >
                {ACTION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Date Range */}
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400">From:</label>
              <input
                type="date"
                value={filters?.startDate || ''}
                onChange={(e) => handleFilterChange('startDate', e.target.value)}
                className="text-sm border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400">To:</label>
              <input
                type="date"
                value={filters?.endDate || ''}
                onChange={(e) => handleFilterChange('endDate', e.target.value)}
                className="text-sm border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            {/* Clear Filters */}
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="text-sm text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 font-medium"
              >
                Clear Filters
              </button>
            )}
          </div>
        </div>
      )}



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
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
                Shares
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden md:table-cell`}>
                Price
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Total
              </th>
              {(onDelete || onEdit) && (
                <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden min-[480px]:table-cell`}>
                  Actions
                </th>
              )}
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
            {transactions.map((tx, index) => (
              <InvestmentTransactionRow
                key={tx.id}
                tx={tx}
                index={index}
                density={density}
                cellPadding={cellPadding}
                defaultCurrency={defaultCurrency}
                formatDate={formatDate}
                formatCurrency={formatCurrency}
                formatQuantity={formatQuantity}
                onRowClick={handleRowClick}
                onLongPressStart={handleLongPressStart}
                onLongPressEnd={handleLongPressEnd}
                onTouchMove={handleTouchMove}
                onEdit={onEdit}
                onDeleteClick={handleDeleteClick}
                hasActions={!!(onDelete || onEdit)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={deleteConfirm.isOpen}
        title="Delete Transaction"
        message={deleteConfirm.transaction
          ? `Are you sure you want to delete this ${ACTION_LABELS[deleteConfirm.transaction.action]?.label || deleteConfirm.transaction.action} transaction${deleteConfirm.transaction.security ? ` for ${deleteConfirm.transaction.security.symbol}` : ''}?`
          : 'Are you sure you want to delete this transaction?'}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
    </div>
  );
}
