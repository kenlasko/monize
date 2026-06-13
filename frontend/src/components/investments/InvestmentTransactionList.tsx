'use client';

import { useState, useMemo, useCallback, useRef, memo, Fragment } from 'react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/hooks/useDateFormat';
import { DateInput } from '@/components/ui/DateInput';
import { InvestmentTransaction } from '@/types/investment';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DensityLevel, nextDensity } from '@/hooks/useTableDensity';
import { Account } from '@/types/account';
import { getLocalDateString } from '@/lib/utils';

export interface TransactionFilters {
  symbol?: string;
  action?: string;
  startDate?: string;
  endDate?: string;
}

interface InvestmentTransactionListProps {
  transactions: InvestmentTransaction[];
  accounts?: Account[];
  isLoading: boolean;
  onDelete?: (id: string) => void;
  onEdit?: (transaction: InvestmentTransaction) => void;
  onNewTransaction?: () => void;
  density?: DensityLevel;
  onDensityChange?: (density: DensityLevel) => void;
  filters?: TransactionFilters;
  onFiltersChange?: (filters: TransactionFilters) => void;
  availableSymbols?: string[];
  viewToggle?: React.ReactNode;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  onSortChange?: (column: string) => void;
}

/**
 * Decide whether a SPLIT transaction's stored quantity looks like a ratio a
 * user (or the current QIF parser) would actually have set. Older buggy
 * imports left stray integers like 5, 10, 20, 30 in the quantity column;
 * those would render as misleading "5:1" / "20:1" splits if shown verbatim.
 * Mirror the SPLIT form's logic so the list and the editor agree on which
 * quantities count as "set" and which are blank.
 */
function isPlausibleSplitRatio(quantity: number | null | undefined): boolean {
  if (quantity === null || quantity === undefined) return false;
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) return false;
  if (!Number.isInteger(q)) return true; // 1.5, 0.5, 0.333...
  return q === 2 || q === 3 || q === 4;
}

/**
 * Render a SPLIT transaction's stored ratio (new shares per old share)
 * as human-readable "N:M" notation. Examples: 2 -> "2:1", 0.5 -> "1:2",
 * 1.5 -> "3:2". Returns "-" when the stored quantity is missing or doesn't
 * look like an actual user-set ratio so the list never advertises a split
 * the user didn't author.
 */
function formatSplitRatio(quantity: number | null | undefined): string {
  if (!isPlausibleSplitRatio(quantity)) return '-';
  const ratio = Number(quantity);
  const trim = (n: number) =>
    Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
  // Probe small denominators for the most natural ratio rendering.
  for (const denom of [1, 2, 3, 4, 5, 6, 8, 10]) {
    const numer = ratio * denom;
    if (Math.abs(numer - Math.round(numer)) < 1e-6) {
      const n = Math.round(numer);
      if (n > 0) return `${trim(n)}:${denom}`;
    }
  }
  if (ratio >= 1) return `${trim(ratio)}:1`;
  return `1:${trim(1 / ratio)}`;
}

const ACTION_COLORS: Record<string, string> = {
  BUY: 'text-green-600 dark:text-green-400',
  SELL: 'text-red-600 dark:text-red-400',
  DIVIDEND: 'text-blue-600 dark:text-blue-400',
  INTEREST: 'text-blue-600 dark:text-blue-400',
  CAPITAL_GAIN: 'text-purple-600 dark:text-purple-400',
  SPLIT: 'text-yellow-600 dark:text-yellow-400',
  TRANSFER_IN: 'text-green-600 dark:text-green-400',
  TRANSFER_OUT: 'text-red-600 dark:text-red-400',
  REINVEST: 'text-indigo-600 dark:text-indigo-400',
  ADD_SHARES: 'text-teal-600 dark:text-teal-400',
  REMOVE_SHARES: 'text-orange-600 dark:text-orange-400',
};

interface InvestmentTransactionRowProps {
  tx: InvestmentTransaction;
  accountName?: string;
  index: number;
  density: DensityLevel;
  cellPadding: string;
  defaultCurrency: string;
  formatDate: (date: string) => string;
  formatCurrency: (amount: number, currencyCode?: string, fractionDigits?: number) => string;
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
  accountName,
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
  const t = useTranslations('investments');
  const ACTION_LABELS: Record<string, { label: string; shortLabel: string; color: string }> = {
    BUY: { label: t('transactionList.actionBuy'), shortLabel: t('transactionList.actionBuy'), color: ACTION_COLORS.BUY },
    SELL: { label: t('transactionList.actionSell'), shortLabel: t('transactionList.actionSell'), color: ACTION_COLORS.SELL },
    DIVIDEND: { label: t('transactionList.actionDividend'), shortLabel: 'Div', color: ACTION_COLORS.DIVIDEND },
    INTEREST: { label: t('transactionList.actionInterest'), shortLabel: 'Int', color: ACTION_COLORS.INTEREST },
    CAPITAL_GAIN: { label: t('transactionList.actionCapitalGain'), shortLabel: 'Cap', color: ACTION_COLORS.CAPITAL_GAIN },
    SPLIT: { label: t('transactionList.actionSplit'), shortLabel: t('transactionList.actionSplit'), color: ACTION_COLORS.SPLIT },
    TRANSFER_IN: { label: t('transactionList.actionTransferIn'), shortLabel: 'In', color: ACTION_COLORS.TRANSFER_IN },
    TRANSFER_OUT: { label: t('transactionList.actionTransferOut'), shortLabel: 'Out', color: ACTION_COLORS.TRANSFER_OUT },
    REINVEST: { label: t('transactionList.actionReinvest'), shortLabel: 'Reinv', color: ACTION_COLORS.REINVEST },
    ADD_SHARES: { label: t('transactionList.actionAddShares'), shortLabel: 'Add', color: ACTION_COLORS.ADD_SHARES },
    REMOVE_SHARES: { label: t('transactionList.actionRemoveShares'), shortLabel: 'Rem', color: ACTION_COLORS.REMOVE_SHARES },
  };
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
      className={`group hover:bg-gray-100 dark:hover:bg-gray-800 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} ${onEdit ? 'cursor-pointer' : ''}`}
    >
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100`}>
        {formatDate(tx.transactionDate)}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 hidden lg:table-cell`}>
        <span title={accountName}>{accountName || '-'}</span>
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
        {tx.action === 'SPLIT'
          ? formatSplitRatio(tx.quantity)
          : formatQuantity(tx.quantity ?? 0)}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100 hidden md:table-cell`}>
        {tx.action === 'SPLIT' && !tx.price ? (
          '-'
        ) : (
          <>
            {formatCurrency(tx.price ?? 0, tx.security?.currencyCode, 4)}
            {tx.security?.currencyCode && tx.security.currencyCode !== defaultCurrency && (
              <span className="ml-1">{tx.security.currencyCode}</span>
            )}
          </>
        )}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium text-gray-900 dark:text-gray-100`}>
        {formatCurrency(tx.totalAmount, tx.security?.currencyCode)}
        {tx.security?.currencyCode && tx.security.currencyCode !== defaultCurrency && (
          <span className="ml-1 font-normal">{tx.security.currencyCode}</span>
        )}
      </td>
      {hasActions && (
        <td className={`${cellPadding} whitespace-nowrap text-right text-sm space-x-3 hidden min-[480px]:table-cell sticky right-0 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} group-hover:bg-gray-100 dark:group-hover:bg-gray-800`}>
          {onEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(tx); }}
              className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
            >
              {density === 'dense' ? '✎' : t('transactionList.editButton')}
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onDeleteClick(tx); }}
            className="text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300"
          >
            {density === 'dense' ? '✕' : t('transactionList.deleteButton')}
          </button>
        </td>
      )}
    </tr>
  );
});

export function InvestmentTransactionList({
  transactions,
  accounts = [],
  isLoading,
  onDelete,
  onEdit,
  onNewTransaction,
  density: propDensity,
  onDensityChange,
  filters,
  onFiltersChange,
  availableSymbols = [],
  viewToggle,
  sortBy,
  sortOrder,
  onSortChange,
}: InvestmentTransactionListProps) {
  const t = useTranslations('investments');
  const ACTION_OPTIONS = [
    { value: '', label: t('transactionList.allActions') },
    { value: 'BUY', label: t('transactionList.actionBuy') },
    { value: 'SELL', label: t('transactionList.actionSell') },
    { value: 'DIVIDEND', label: t('transactionList.actionDividend') },
    { value: 'INTEREST', label: t('transactionList.actionInterest') },
    { value: 'CAPITAL_GAIN', label: t('transactionList.actionCapitalGain') },
    { value: 'REINVEST', label: t('transactionList.actionReinvest') },
    { value: 'SPLIT', label: t('transactionList.actionSplit') },
    { value: 'TRANSFER_IN', label: t('transactionList.actionTransferIn') },
    { value: 'TRANSFER_OUT', label: t('transactionList.actionTransferOut') },
    { value: 'ADD_SHARES', label: t('transactionList.actionAddShares') },
    { value: 'REMOVE_SHARES', label: t('transactionList.actionRemoveShares') },
  ];
  const { formatCurrency, formatQuantity } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const { defaultCurrency } = useExchangeRates();
  const accountMap = useMemo(() => new Map(accounts.map(a => [a.id, a.name])), [accounts]);

  // Find the index where future investments end and today/past begin.
  // Mirrors TransactionList: rows are sorted DESC by transactionDate so the
  // future block leads. "Today" is the user's local date so users west of
  // UTC don't see a tomorrow-local row classified as past.
  const futureBoundaryIndex = useMemo(() => {
    const today = getLocalDateString();
    for (let i = 0; i < transactions.length; i++) {
      if (transactions[i].transactionDate <= today) {
        return i;
      }
    }
    return transactions.length;
  }, [transactions]);
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
    const next = nextDensity(density);
    if (onDensityChange) {
      onDensityChange(next);
    } else {
      setLocalDensity(next);
    }
  }, [density, onDensityChange]);

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
        <div className="flex items-center gap-3 mb-3">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('transactionList.title')}
          </h3>
          {viewToggle}
        </div>
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

  if (transactions.length === 0 && !hasActiveFilters) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
        <div className="flex flex-wrap justify-between items-center gap-2 mb-3">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('transactionList.title')}
            </h3>
            {viewToggle}
          </div>
          {onNewTransaction && (
            <button
              onClick={onNewTransaction}
              className="inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 sm:min-w-[14rem]"
            >
              {t('transactionList.newBrokerageTransaction')}
            </button>
          )}
        </div>
        <p className="text-gray-500 dark:text-gray-400">
          {t('transactionList.noTransactions')}
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

  const ACTION_LABEL_MAP: Record<string, string> = {
    BUY: t('transactionList.actionBuy'),
    SELL: t('transactionList.actionSell'),
    DIVIDEND: t('transactionList.actionDividend'),
    INTEREST: t('transactionList.actionInterest'),
    CAPITAL_GAIN: t('transactionList.actionCapitalGain'),
    SPLIT: t('transactionList.actionSplit'),
    TRANSFER_IN: t('transactionList.actionTransferIn'),
    TRANSFER_OUT: t('transactionList.actionTransferOut'),
    REINVEST: t('transactionList.actionReinvest'),
    ADD_SHARES: t('transactionList.actionAddShares'),
    REMOVE_SHARES: t('transactionList.actionRemoveShares'),
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
      <div className="px-3 pt-3 sm:px-4 sm:pt-4 flex flex-wrap justify-between items-center gap-2">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('transactionList.title')}
            {hasActiveFilters && (
              <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
                {t('transactionList.filtered')}
              </span>
            )}
          </h3>
          {viewToggle}
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
        {onNewTransaction && (
          <button
            onClick={onNewTransaction}
            className="inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 sm:min-w-[14rem]"
          >
            <span className="sm:hidden">{t('transactionList.newBrokerageTransactionShort')}</span>
            <span className="hidden sm:inline">{t('transactionList.newBrokerageTransaction')}</span>
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
            {t('transactionList.filter')}
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
          title={t('transactionList.densityToggleTitle')}
        >
          <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          {density === 'normal' ? t('transactionList.densityNormal') : density === 'compact' ? t('transactionList.densityCompact') : t('transactionList.densityDense')}
        </button>
        </div>
      </div>

      {/* Filter Bar */}
      {showFilters && onFiltersChange && (
        <div className="px-3 sm:px-4 py-3 bg-gray-50 dark:bg-gray-700/30 border-b border-gray-200 dark:border-gray-700">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Symbol Filter */}
            <div>
              <label
                htmlFor="investment-tx-filter-symbol"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t('transactionList.symbolFilterLabel')}
              </label>
              <select
                id="investment-tx-filter-symbol"
                name="investment-tx-filter-symbol"
                value={filters?.symbol || ''}
                onChange={(e) => handleFilterChange('symbol', e.target.value)}
                className="w-full text-sm font-sans border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">{t('transactionList.allSymbols')}</option>
                {availableSymbols.map((symbol) => (
                  <option key={symbol} value={symbol}>{symbol}</option>
                ))}
              </select>
            </div>

            {/* Action Filter */}
            <div>
              <label
                htmlFor="investment-tx-filter-action"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t('transactionList.actionFilterLabel')}
              </label>
              <select
                id="investment-tx-filter-action"
                name="investment-tx-filter-action"
                value={filters?.action || ''}
                onChange={(e) => handleFilterChange('action', e.target.value)}
                className="w-full text-sm font-sans border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500"
              >
                {ACTION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Date Range — onDateChange always emits an ISO date string;
                pairing it with a manual onChange caused the user's date
                format preference to be ignored on these two inputs. */}
            <DateInput
              label={t('transactionList.fromDateLabel')}
              value={filters?.startDate || ''}
              onDateChange={(date) => handleFilterChange('startDate', date)}
            />
            <DateInput
              label={t('transactionList.toDateLabel')}
              value={filters?.endDate || ''}
              onDateChange={(date) => handleFilterChange('endDate', date)}
            />
          </div>

          {/* Clear Filters */}
          {hasActiveFilters && (
            <div className="mt-3 flex justify-end">
              <button
                onClick={clearFilters}
                className="text-sm text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 font-medium"
              >
                {t('transactionList.clearFilters')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Spacer between controls and table */}
      <div className="mt-3 sm:mt-4" />

      {/* Brokerage Transactions Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                <button
                  onClick={() => onSortChange?.('date')}
                  className="group inline-flex items-center gap-1 hover:text-gray-900 dark:hover:text-gray-100 focus:outline-none"
                >
                  <span>{t('transactionList.dateColumn')}</span>
                  <span className="inline-flex w-3.5 h-3.5 items-center justify-center">
                    {sortBy === 'date' ? (
                      sortOrder === 'asc' ? (
                        <svg className="w-3 h-3 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" />
                        </svg>
                      ) : (
                        <svg className="w-3 h-3 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                        </svg>
                      )
                    ) : (
                      <svg className="w-3 h-3 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    )}
                  </span>
                </button>
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden lg:table-cell`}>
                <button
                  onClick={() => onSortChange?.('account')}
                  className="group inline-flex items-center gap-1 hover:text-gray-900 dark:hover:text-gray-100 focus:outline-none"
                >
                  <span>{t('transactionList.accountColumn')}</span>
                  <span className="inline-flex w-3.5 h-3.5 items-center justify-center">
                    {sortBy === 'account' ? (
                      sortOrder === 'asc' ? (
                        <svg className="w-3 h-3 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" />
                        </svg>
                      ) : (
                        <svg className="w-3 h-3 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                        </svg>
                      )
                    ) : (
                      <svg className="w-3 h-3 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    )}
                  </span>
                </button>
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                <button
                  onClick={() => onSortChange?.('action')}
                  className="group inline-flex items-center gap-1 hover:text-gray-900 dark:hover:text-gray-100 focus:outline-none"
                >
                  <span>{t('transactionList.actionColumn')}</span>
                  <span className="inline-flex w-3.5 h-3.5 items-center justify-center">
                    {sortBy === 'action' ? (
                      sortOrder === 'asc' ? (
                        <svg className="w-3 h-3 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" />
                        </svg>
                      ) : (
                        <svg className="w-3 h-3 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                        </svg>
                      )
                    ) : (
                      <svg className="w-3 h-3 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    )}
                  </span>
                </button>
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                <button
                  onClick={() => onSortChange?.('symbol')}
                  className="group inline-flex items-center gap-1 hover:text-gray-900 dark:hover:text-gray-100 focus:outline-none"
                >
                  <span>{t('transactionList.symbolColumn')}</span>
                  <span className="inline-flex w-3.5 h-3.5 items-center justify-center">
                    {sortBy === 'symbol' ? (
                      sortOrder === 'asc' ? (
                        <svg className="w-3 h-3 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" />
                        </svg>
                      ) : (
                        <svg className="w-3 h-3 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                        </svg>
                      )
                    ) : (
                      <svg className="w-3 h-3 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    )}
                  </span>
                </button>
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
                <button
                  onClick={() => onSortChange?.('shares')}
                  className="group inline-flex items-center gap-1 hover:text-gray-900 dark:hover:text-gray-100 focus:outline-none ml-auto flex-row-reverse"
                >
                  <span>{t('transactionList.sharesColumn')}</span>
                  <span className="inline-flex w-3.5 h-3.5 items-center justify-center">
                    {sortBy === 'shares' ? (
                      sortOrder === 'asc' ? (
                        <svg className="w-3 h-3 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" />
                        </svg>
                      ) : (
                        <svg className="w-3 h-3 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                        </svg>
                      )
                    ) : (
                      <svg className="w-3 h-3 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    )}
                  </span>
                </button>
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden md:table-cell`}>
                <button
                  onClick={() => onSortChange?.('price')}
                  className="group inline-flex items-center gap-1 hover:text-gray-900 dark:hover:text-gray-100 focus:outline-none ml-auto flex-row-reverse"
                >
                  <span>{t('transactionList.priceColumn')}</span>
                  <span className="inline-flex w-3.5 h-3.5 items-center justify-center">
                    {sortBy === 'price' ? (
                      sortOrder === 'asc' ? (
                        <svg className="w-3 h-3 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" />
                        </svg>
                      ) : (
                        <svg className="w-3 h-3 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                        </svg>
                      )
                    ) : (
                      <svg className="w-3 h-3 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    )}
                  </span>
                </button>
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                <button
                  onClick={() => onSortChange?.('total')}
                  className="group inline-flex items-center gap-1 hover:text-gray-900 dark:hover:text-gray-100 focus:outline-none ml-auto flex-row-reverse"
                >
                  <span>{t('transactionList.totalColumn')}</span>
                  <span className="inline-flex w-3.5 h-3.5 items-center justify-center">
                    {sortBy === 'total' ? (
                      sortOrder === 'asc' ? (
                        <svg className="w-3 h-3 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" />
                        </svg>
                      ) : (
                        <svg className="w-3 h-3 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                        </svg>
                      )
                    ) : (
                      <svg className="w-3 h-3 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    )}
                  </span>
                </button>
              </th>
              {(onDelete || onEdit) && (
                <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden min-[480px]:table-cell sticky right-0 bg-gray-50 dark:bg-gray-800`}>
                  {t('transactionList.actionsColumn')}
                </th>
              )}
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {transactions.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-6 py-8 text-center text-gray-500 dark:text-gray-400">
                  {t('transactionList.noTransactionsFiltered')}
                </td>
              </tr>
            ) : transactions.map((tx, index) => {
              const colCount = 7 + (onDelete || onEdit ? 1 : 0);
              return (
                <Fragment key={tx.id}>
                  {index === futureBoundaryIndex && futureBoundaryIndex > 0 && (
                    <tr>
                      <td colSpan={colCount} className="px-0 py-0">
                        <div className="flex items-center gap-3 px-4 py-1.5">
                          <div className="flex-1 border-t border-blue-300 dark:border-blue-700" />
                          <span className="text-xs font-medium text-blue-500 dark:text-blue-400 uppercase tracking-wider whitespace-nowrap">{t('transactionList.today')}</span>
                          <div className="flex-1 border-t border-blue-300 dark:border-blue-700" />
                        </div>
                      </td>
                    </tr>
                  )}
                  <InvestmentTransactionRow
                    tx={tx}
                    accountName={accountMap.get(tx.accountId)}
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
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={deleteConfirm.isOpen}
        title={t('transactionList.deleteTitle')}
        message={deleteConfirm.transaction
          ? t('transactionList.deleteConfirmMessage', {
              action: ACTION_LABEL_MAP[deleteConfirm.transaction.action] || deleteConfirm.transaction.action,
              security: deleteConfirm.transaction.security ? ` for ${deleteConfirm.transaction.security.symbol}` : '',
            })
          : t('transactionList.deleteConfirmGeneric')}
        confirmLabel={t('transactionList.deleteConfirmLabel')}
        cancelLabel={t('transactionList.cancelLabel')}
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
    </div>
  );
}
