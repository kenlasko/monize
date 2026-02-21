'use client';

import { useState, useMemo, useCallback, useRef, memo, type JSX } from 'react';
import toast from 'react-hot-toast';
import { Transaction, TransactionStatus } from '@/types/transaction';
import { CategoryBudgetStatus } from '@/types/budget';
import { transactionsApi } from '@/lib/transactions';
import { getErrorMessage } from '@/lib/errors';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Modal } from '@/components/ui/Modal';
import { Pagination } from '@/components/ui/Pagination';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';

// Density levels: 'normal' | 'compact' | 'dense'
export type DensityLevel = 'normal' | 'compact' | 'dense';

interface TransactionRowProps {
  transaction: Transaction;
  index: number;
  density: DensityLevel;
  cellPadding: string;
  isSingleAccountView: boolean;
  runningBalance: number | undefined;
  isDeleting: boolean;
  formatDate: (date: string) => string;
  formatAmount: (amount: number, currencyCode?: string) => JSX.Element;
  formatBalance: (balance: number, currencyCode?: string) => JSX.Element;
  onRowClick: (transaction: Transaction) => void;
  onLongPressStart: (transaction: Transaction) => void;
  onLongPressStartTouch: (transaction: Transaction, e: React.TouchEvent) => void;
  onLongPressEnd: () => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onPayeeClick?: (payeeId: string) => void;
  onTransferClick?: (linkedAccountId: string, linkedTransactionId: string) => void;
  onCategoryClick?: (categoryId: string) => void;
  onCycleStatus: (transaction: Transaction) => void;
  onEdit?: (transaction: Transaction) => void;
  onDeleteClick: (transaction: Transaction) => void;
  isSelected?: boolean;
  selectionMode?: boolean;
  onToggleSelection?: () => void;
  categoryColorMap?: Map<string, string | null>;
  budgetStatusMap?: Record<string, CategoryBudgetStatus>;
}

const TransactionRow = memo(function TransactionRow({
  transaction,
  index,
  density,
  cellPadding,
  isSingleAccountView,
  runningBalance,
  isDeleting,
  formatDate,
  formatAmount,
  formatBalance,
  onRowClick,
  onLongPressStart,
  onLongPressStartTouch,
  onLongPressEnd,
  onTouchMove,
  onPayeeClick,
  onTransferClick,
  onCategoryClick,
  onCycleStatus,
  onEdit,
  onDeleteClick,
  isSelected,
  selectionMode,
  onToggleSelection,
  categoryColorMap,
  budgetStatusMap,
}: TransactionRowProps) {
  const isVoid = transaction.status === TransactionStatus.VOID;
  const categoryColor = transaction.category
    ? (categoryColorMap?.get(transaction.category.id) ?? transaction.category.color)
    : null;

  return (
    <tr
      onClick={() => onRowClick(transaction)}
      onMouseDown={() => onLongPressStart(transaction)}
      onMouseUp={onLongPressEnd}
      onMouseLeave={onLongPressEnd}
      onTouchStart={(e) => onLongPressStartTouch(transaction, e)}
      onTouchMove={onTouchMove}
      onTouchEnd={onLongPressEnd}
      onTouchCancel={onLongPressEnd}
      className={`hover:bg-gray-100 dark:hover:bg-gray-800 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-gray-800/50' : ''} ${isVoid ? 'opacity-50' : ''} ${onEdit ? 'cursor-pointer' : ''} ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
    >
      {selectionMode && (
        <td className={`${cellPadding} whitespace-nowrap w-10`} onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isSelected || false}
            onChange={() => onToggleSelection?.()}
            className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 h-4 w-4 cursor-pointer"
          />
        </td>
      )}
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 ${isVoid ? 'line-through' : ''}`}>
        {formatDate(transaction.transactionDate)}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 ${isVoid ? 'line-through' : ''} hidden md:table-cell`}>
        {transaction.account?.name || '-'}
      </td>
      <td className={`${cellPadding} max-w-[100px] sm:max-w-none overflow-hidden`}>
        {transaction.payeeId && onPayeeClick ? (
          <button
            onClick={(e) => { e.stopPropagation(); onPayeeClick(transaction.payeeId!); }}
            className={`text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline block truncate sm:max-w-[280px] text-left ${isVoid ? 'line-through' : ''}`}
            title={`Edit payee: ${transaction.payeeName}`}
          >
            {transaction.payeeName || '-'}
          </button>
        ) : (
          <div
            className={`text-sm font-medium text-gray-900 dark:text-gray-100 truncate sm:max-w-[280px] ${isVoid ? 'line-through' : ''}`}
            title={transaction.payeeName || undefined}
          >
            {transaction.payeeName || '-'}
          </div>
        )}
        {density === 'normal' && transaction.referenceNumber && (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Ref: {transaction.referenceNumber}
          </div>
        )}
      </td>
      <td className={`${cellPadding} ${density !== 'normal' ? 'whitespace-nowrap' : ''} hidden lg:table-cell`}>
        {transaction.linkedInvestmentTransactionId ? (
          <span
            className={`inline-flex text-xs leading-5 font-semibold rounded-full bg-emerald-100 dark:bg-emerald-900 text-emerald-800 dark:text-emerald-200 ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
            title="This transaction is linked to an investment transaction"
          >
            Investment
          </span>
        ) : transaction.isTransfer ? (
          onTransferClick && transaction.linkedTransaction?.account?.id && transaction.linkedTransactionId ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onTransferClick(transaction.linkedTransaction!.account!.id, transaction.linkedTransactionId!);
              }}
              className={`inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 truncate max-w-[160px] hover:bg-blue-200 dark:hover:bg-blue-800 transition-colors ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
              title={`Click to view in ${transaction.linkedTransaction.account.name}`}
            >
              {Number(transaction.amount) < 0
                ? `→ ${transaction.linkedTransaction.account.name}`
                : `${transaction.linkedTransaction.account.name} →`}
            </button>
          ) : (
            <span
              className={`inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 truncate max-w-[160px] ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
              title={transaction.linkedTransaction?.account?.name
                ? `Transfer ${Number(transaction.amount) < 0 ? 'to' : 'from'} ${transaction.linkedTransaction.account.name}`
                : 'Transfer'}
            >
              {transaction.linkedTransaction?.account?.name
                ? (Number(transaction.amount) < 0
                    ? `→ ${transaction.linkedTransaction.account.name}`
                    : `${transaction.linkedTransaction.account.name} →`)
                : 'Transfer'}
            </span>
          )
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
                    {split.transferAccount ? (
                      <span className="text-blue-600 dark:text-blue-400">
                        {Number(split.amount) < 0
                          ? `→ ${split.transferAccount.name}`
                          : `${split.transferAccount.name} →`}: ${Math.abs(Number(split.amount)).toFixed(2)}
                      </span>
                    ) : (
                      <>{split.category?.name || 'Uncategorized'}: ${Math.abs(Number(split.amount)).toFixed(2)}</>
                    )}
                  </div>
                ))}
                {transaction.splits.length > 3 && (
                  <div className="text-gray-400 dark:text-gray-500">+{transaction.splits.length - 3} more</div>
                )}
              </div>
            )}
          </div>
        ) : transaction.category ? (
          (() => {
            const budgetStatus = budgetStatusMap?.[transaction.category!.id];
            const budgetIndicator = budgetStatus && budgetStatus.budgeted > 0 ? (
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full ml-1 flex-shrink-0 ${
                  budgetStatus.percentUsed > 100
                    ? 'bg-red-500'
                    : budgetStatus.percentUsed >= 80
                      ? 'bg-amber-500'
                      : ''
                }`}
                title={
                  budgetStatus.percentUsed > 100
                    ? `Over budget: ${budgetStatus.percentUsed.toFixed(0)}% used ($${budgetStatus.spent.toFixed(2)} / $${budgetStatus.budgeted.toFixed(2)})`
                    : budgetStatus.percentUsed >= 80
                      ? `Approaching limit: ${budgetStatus.percentUsed.toFixed(0)}% used ($${budgetStatus.remaining.toFixed(2)} remaining)`
                      : undefined
                }
              />
            ) : null;

            return onCategoryClick ? (
              <span className="inline-flex items-center">
                <button
                  onClick={(e) => { e.stopPropagation(); onCategoryClick(transaction.category!.id); }}
                  className={`inline-flex text-xs leading-5 font-semibold rounded-full truncate max-w-[160px] hover:opacity-80 transition-opacity ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
                  style={{
                    backgroundColor: categoryColor
                      ? `color-mix(in srgb, ${categoryColor} 15%, var(--category-bg-base, #e5e7eb))`
                      : 'var(--category-bg-base, #e5e7eb)',
                    color: categoryColor
                      ? `color-mix(in srgb, ${categoryColor} 85%, var(--category-text-mix, #000))`
                      : 'var(--category-text-base, #6b7280)',
                  }}
                  title={`Filter by ${transaction.category!.name}`}
                >
                  {transaction.category!.name}
                </button>
                {budgetIndicator}
              </span>
            ) : (
              <span className="inline-flex items-center">
                <span
                  className={`inline-flex text-xs leading-5 font-semibold rounded-full truncate max-w-[160px] ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
                  style={{
                    backgroundColor: categoryColor
                      ? `color-mix(in srgb, ${categoryColor} 15%, var(--category-bg-base, #e5e7eb))`
                      : 'var(--category-bg-base, #e5e7eb)',
                    color: categoryColor
                      ? `color-mix(in srgb, ${categoryColor} 85%, var(--category-text-mix, #000))`
                      : 'var(--category-text-base, #6b7280)',
                  }}
                  title={transaction.category!.name}
                >
                  {transaction.category!.name}
                </span>
                {budgetIndicator}
              </span>
            );
          })()
        ) : (
          <span className="text-sm text-gray-400 dark:text-gray-500">-</span>
        )}
      </td>
      <td className={`${cellPadding} text-sm text-gray-500 dark:text-gray-400 hidden xl:table-cell`}>
        <div
          className={`truncate max-w-[320px] ${isVoid ? 'line-through' : ''}`}
          title={transaction.description || undefined}
        >
          {transaction.description || '-'}
        </div>
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-sm font-medium text-right ${isVoid ? 'line-through' : ''}`}>
        {formatAmount(transaction.amount, transaction.currencyCode)}
      </td>
      {isSingleAccountView && (
        <td className={`${cellPadding} whitespace-nowrap text-sm font-medium text-right`}>
          {runningBalance !== undefined
            ? formatBalance(runningBalance, transaction.currencyCode)
            : '-'}
        </td>
      )}
      <td className={`${cellPadding} whitespace-nowrap text-center hidden sm:table-cell`}>
        <button
          onClick={(e) => { e.stopPropagation(); onCycleStatus(transaction); }}
          className="text-sm px-3 py-1.5 -my-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
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
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium space-x-2 hidden min-[480px]:table-cell`}>
        {onEdit && (
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(transaction); }}
            className={transaction.linkedInvestmentTransactionId
              ? "text-emerald-600 hover:text-emerald-900 dark:text-emerald-400 dark:hover:text-emerald-300"
              : "text-blue-600 hover:text-blue-900 dark:text-blue-400 dark:hover:text-blue-300"
            }
            title={transaction.linkedInvestmentTransactionId ? "View in Investments" : undefined}
          >
            {transaction.linkedInvestmentTransactionId
              ? (density === 'dense' ? '📈' : 'View')
              : (density === 'dense' ? '✎' : 'Edit')}
          </button>
        )}
        {!transaction.linkedInvestmentTransactionId && (
          <button
            onClick={(e) => { e.stopPropagation(); onDeleteClick(transaction); }}
            disabled={isDeleting}
            className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 disabled:opacity-50"
          >
            {isDeleting ? '...' : density === 'dense' ? '✕' : 'Delete'}
          </button>
        )}
      </td>
    </tr>
  );
});

interface TransactionListProps {
  transactions: Transaction[];
  onEdit?: (transaction: Transaction) => void;
  onDelete?: (id: string) => void;
  onRefresh?: () => void;
  /** Callback to update a single transaction in place without full refresh */
  onTransactionUpdate?: (transaction: Transaction) => void;
  /** Callback when clicking on a payee name to edit it */
  onPayeeClick?: (payeeId: string) => void;
  /** Callback when clicking on a transfer badge to navigate to linked account */
  onTransferClick?: (linkedAccountId: string, linkedTransactionId: string) => void;
  /** Callback when clicking on a category badge to filter by that category */
  onCategoryClick?: (categoryId: string) => void;
  /** Callback to filter transactions by a specific date */
  onDateFilterClick?: (date: string) => void;
  /** Callback to filter transactions by a specific account */
  onAccountFilterClick?: (accountId: string) => void;
  /** Callback to filter transactions by a specific payee */
  onPayeeFilterClick?: (payeeId: string) => void;
  density?: DensityLevel;
  onDensityChange?: (density: DensityLevel) => void;
  /** Starting balance for running balance calculation (balance after first tx on page) */
  startingBalance?: number;
  /** Whether we're viewing a single account (enables running balance column) */
  isSingleAccountView?: boolean;
  /** Pagination props for top pagination controls */
  currentPage?: number;
  totalPages?: number;
  totalItems?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  /** Selection mode props */
  selectionMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelection?: (id: string) => void;
  onToggleAllOnPage?: () => void;
  isAllOnPageSelected?: boolean;
  categoryColorMap?: Map<string, string | null>;
  budgetStatusMap?: Record<string, CategoryBudgetStatus>;
  /** Hide the built-in density/pagination toolbar (when parent controls density externally) */
  showToolbar?: boolean;
}

export function TransactionList({
  transactions,
  onEdit,
  onDelete,
  onRefresh,
  onTransactionUpdate,
  onPayeeClick,
  onTransferClick,
  onCategoryClick,
  onDateFilterClick,
  onAccountFilterClick,
  onPayeeFilterClick,
  density: propDensity,
  onDensityChange,
  startingBalance,
  isSingleAccountView = false,
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  selectionMode,
  selectedIds,
  onToggleSelection,
  onToggleAllOnPage,
  isAllOnPageSelected,
  categoryColorMap,
  budgetStatusMap,
  showToolbar = true,
}: TransactionListProps) {
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [localDensity, setLocalDensity] = useState<DensityLevel>('normal');
  const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; transaction: Transaction | null }>({
    isOpen: false,
    transaction: null,
  });

  // Action sheet state for mobile long-press (shows filter + delete options)
  const [actionSheet, setActionSheet] = useState<{ isOpen: boolean; transaction: Transaction | null }>({
    isOpen: false,
    transaction: null,
  });

  // Long-press handling for context menu on mobile
  const longPressTimer = useRef<NodeJS.Timeout | null>(null);
  const longPressTriggered = useRef(false);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const LONG_PRESS_MOVE_THRESHOLD = 10; // pixels - cancel long-press if user moves finger this much

  const handleLongPressStart = useCallback((transaction: Transaction) => {
    touchStartPos.current = null;

    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      setActionSheet({ isOpen: true, transaction });
    }, 750); // 750ms long-press threshold
  }, []);

  const handleLongPressStartTouch = useCallback((transaction: Transaction, e: React.TouchEvent) => {
    // Track initial touch position for scroll detection
    if (e?.touches?.[0]) {
      touchStartPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else {
      touchStartPos.current = null;
    }

    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      setActionSheet({ isOpen: true, transaction });
    }, 750); // 750ms long-press threshold
  }, []);

  const handleLongPressEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    touchStartPos.current = null;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    // If user moves finger beyond threshold, cancel the long-press (they're scrolling)
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

  const handleRowClick = useCallback((transaction: Transaction) => {
    // Don't trigger edit if long-press was triggered
    if (longPressTriggered.current) {
      longPressTriggered.current = false;
      return;
    }
    onEdit?.(transaction);
  }, [onEdit]);

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

  const handleActionSheetClose = useCallback(() => {
    setActionSheet({ isOpen: false, transaction: null });
  }, []);

  const handleActionSheetFilterCategory = useCallback(() => {
    const tx = actionSheet.transaction;
    if (!tx) return;
    setActionSheet({ isOpen: false, transaction: null });
    if (tx.category?.id && onCategoryClick) {
      onCategoryClick(tx.category.id);
    }
  }, [actionSheet.transaction, onCategoryClick]);

  const handleActionSheetFilterDate = useCallback(() => {
    const tx = actionSheet.transaction;
    if (!tx) return;
    setActionSheet({ isOpen: false, transaction: null });
    if (tx.transactionDate && onDateFilterClick) {
      onDateFilterClick(tx.transactionDate);
    }
  }, [actionSheet.transaction, onDateFilterClick]);

  const handleActionSheetFilterAccount = useCallback(() => {
    const tx = actionSheet.transaction;
    if (!tx) return;
    setActionSheet({ isOpen: false, transaction: null });
    if (tx.account?.id && onAccountFilterClick) {
      onAccountFilterClick(tx.account.id);
    }
  }, [actionSheet.transaction, onAccountFilterClick]);

  const handleActionSheetFilterPayee = useCallback(() => {
    const tx = actionSheet.transaction;
    if (!tx) return;
    setActionSheet({ isOpen: false, transaction: null });
    if (tx.payeeId && onPayeeFilterClick) {
      onPayeeFilterClick(tx.payeeId);
    }
  }, [actionSheet.transaction, onPayeeFilterClick]);

  const handleActionSheetDelete = useCallback(() => {
    const tx = actionSheet.transaction;
    if (!tx) return;
    setActionSheet({ isOpen: false, transaction: null });
    setDeleteConfirm({ isOpen: true, transaction: tx });
  }, [actionSheet.transaction]);

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
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to delete transaction'));
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
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to update status'));
    }
  }, [onRefresh, onTransactionUpdate]);

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

  const formatAmount = useCallback((amount: number, currencyCode?: string) => {
    const isNegative = amount < 0;
    const absAmount = Math.abs(amount);
    const formatted = formatCurrency(absAmount, currencyCode);

    return (
      <span className={isNegative ? 'text-red-600' : 'text-green-600'}>
        {isNegative ? '-' : '+'}{formatted}
      </span>
    );
  }, [formatCurrency]);

  const formatBalance = useCallback((balance: number, currencyCode?: string) => {
    const formatted = formatCurrency(Math.abs(balance), currencyCode);
    return (
      <span className={balance < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'}>
        {balance < 0 ? `-${formatted}` : formatted}
      </span>
    );
  }, [formatCurrency]);

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
      {/* Density toggle and top pagination */}
      {showToolbar && (() => {
        const densityButton = (
          <button
            onClick={cycleDensity}
            className="inline-flex items-center px-2 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded flex-shrink-0"
            title="Toggle row density"
          >
            <svg className="w-4 h-4 sm:mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            <span className="hidden sm:inline">{density === 'normal' ? 'Normal' : density === 'compact' ? 'Compact' : 'Dense'}</span>
          </button>
        );
        const showPagination = currentPage !== undefined && totalPages !== undefined && totalPages > 1 && totalItems !== undefined && pageSize !== undefined && onPageChange;
        return (
          <div className="flex items-center justify-end p-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
            {showPagination ? (
              <div className="flex-1">
                <Pagination
                  currentPage={currentPage!}
                  totalPages={totalPages!}
                  totalItems={totalItems!}
                  pageSize={pageSize!}
                  onPageChange={onPageChange!}
                  itemName="transactions"
                  minimal
                  infoRight={densityButton}
                />
              </div>
            ) : (
              densityButton
            )}
          </div>
        );
      })()}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              {selectionMode && (
                <th className={`${headerPadding} w-10`}>
                  <input
                    type="checkbox"
                    checked={isAllOnPageSelected || false}
                    onChange={() => onToggleAllOnPage?.()}
                    className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 h-4 w-4 cursor-pointer"
                  />
                </th>
              )}
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Date
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden md:table-cell`}>
                Account
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Payee
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden lg:table-cell`}>
                Category
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden xl:table-cell`}>
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
              <th className={`${headerPadding} text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
                Status
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden min-[480px]:table-cell`}>
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {transactions.map((transaction, index) => (
              <TransactionRow
                key={transaction.id}
                transaction={transaction}
                index={index}
                density={density}
                cellPadding={cellPadding}
                isSingleAccountView={isSingleAccountView}
                runningBalance={runningBalances.get(transaction.id)}
                isDeleting={deletingId === transaction.id}
                formatDate={formatDate}
                formatAmount={formatAmount}
                formatBalance={formatBalance}
                onRowClick={handleRowClick}
                onLongPressStart={handleLongPressStart}
                onLongPressStartTouch={handleLongPressStartTouch}
                onLongPressEnd={handleLongPressEnd}
                onTouchMove={handleTouchMove}
                onPayeeClick={onPayeeClick}
                onTransferClick={onTransferClick}
                onCategoryClick={onCategoryClick}
                onCycleStatus={handleCycleStatus}
                onEdit={onEdit}
                onDeleteClick={handleDeleteClick}
                selectionMode={selectionMode}
                isSelected={selectionMode ? selectedIds?.has(transaction.id) : undefined}
                onToggleSelection={selectionMode ? () => onToggleSelection?.(transaction.id) : undefined}
                categoryColorMap={categoryColorMap}
                budgetStatusMap={budgetStatusMap}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Long-press Action Sheet */}
      <Modal isOpen={actionSheet.isOpen} onClose={handleActionSheetClose} maxWidth="sm" className="p-0">
        <div className="py-2">
          <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
              {actionSheet.transaction?.payeeName || 'Transaction'}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {actionSheet.transaction && formatDate(actionSheet.transaction.transactionDate)}
            </p>
          </div>
          {onDateFilterClick && actionSheet.transaction?.transactionDate && (
            <button
              onClick={handleActionSheetFilterDate}
              className="w-full px-4 py-3 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3"
            >
              <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              Filter by date &ldquo;{formatDate(actionSheet.transaction.transactionDate)}&rdquo;
            </button>
          )}
          {onAccountFilterClick && actionSheet.transaction?.account && (
            <button
              onClick={handleActionSheetFilterAccount}
              className="w-full px-4 py-3 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3"
            >
              <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
              </svg>
              Filter by &ldquo;{actionSheet.transaction.account.name}&rdquo;
            </button>
          )}
          {onPayeeFilterClick && actionSheet.transaction?.payeeId && (
            <button
              onClick={handleActionSheetFilterPayee}
              className="w-full px-4 py-3 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3"
            >
              <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              Filter by &ldquo;{actionSheet.transaction.payeeName || 'Payee'}&rdquo;
            </button>
          )}
          {onCategoryClick && actionSheet.transaction?.category && (
            <button
              onClick={handleActionSheetFilterCategory}
              className="w-full px-4 py-3 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3"
            >
              <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
              Filter by &ldquo;{actionSheet.transaction.category.name}&rdquo;
            </button>
          )}
          {onEdit && (
            <button
              onClick={() => { handleActionSheetClose(); onEdit!(actionSheet.transaction!); }}
              className="w-full px-4 py-3 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3"
            >
              <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Edit
            </button>
          )}
          {!actionSheet.transaction?.linkedInvestmentTransactionId && (
            <button
              onClick={handleActionSheetDelete}
              className="w-full px-4 py-3 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-3"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              Delete
            </button>
          )}
        </div>
      </Modal>

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
