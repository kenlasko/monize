'use client';

import React, { useState, useMemo, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { Transaction, TransactionStatus } from '@/types/transaction';
import { CategoryBudgetStatus } from '@/types/budget';
import { transactionsApi } from '@/lib/transactions';
import { getErrorMessage } from '@/lib/errors';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Pagination } from '@/components/ui/Pagination';
import { TransactionRow } from './TransactionRow';
import { TransactionActionSheet } from './TransactionActionSheet';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { DensityLevel, nextDensity } from '@/hooks/useTableDensity';

interface TransactionListProps {
  transactions: Transaction[];
  onEdit?: (transaction: Transaction) => void;
  onDuplicate?: (transaction: Transaction) => void;
  onDelete?: (id: string) => void;
  onRefresh?: () => void;
  onTransactionUpdate?: (transaction: Transaction) => void;
  onPayeeClick?: (payeeId: string) => void;
  onTransferClick?: (linkedAccountId: string, linkedTransactionId: string) => void;
  onCategoryClick?: (categoryId: string) => void;
  onDateFilterClick?: (date: string) => void;
  onAccountFilterClick?: (accountId: string) => void;
  onPayeeFilterClick?: (payeeId: string) => void;
  density?: DensityLevel;
  onDensityChange?: (density: DensityLevel) => void;
  onExport?: () => void;
  isExporting?: boolean;
  startingBalance?: number;
  isSingleAccountView?: boolean;
  currentPage?: number;
  totalPages?: number;
  totalItems?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  selectionMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelection?: (id: string) => void;
  onToggleAllOnPage?: () => void;
  isAllOnPageSelected?: boolean;
  categoryColorMap?: Map<string, string | null>;
  budgetStatusMap?: Record<string, CategoryBudgetStatus>;
  showToolbar?: boolean;
}

export function TransactionList({
  transactions,
  onEdit,
  onDuplicate,
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
  onExport,
  isExporting,
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

  // Action sheet state for mobile long-press
  const [actionSheet, setActionSheet] = useState<{ isOpen: boolean; transaction: Transaction | null }>({
    isOpen: false,
    transaction: null,
  });

  // Long-press handling
  const longPressTimer = useRef<NodeJS.Timeout | null>(null);
  const longPressTriggered = useRef(false);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const LONG_PRESS_MOVE_THRESHOLD = 10;

  const handleLongPressStart = useCallback((transaction: Transaction) => {
    touchStartPos.current = null;
    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      setActionSheet({ isOpen: true, transaction });
    }, 750);
  }, []);

  const handleLongPressStartTouch = useCallback((transaction: Transaction, e: React.TouchEvent) => {
    if (e?.touches?.[0]) {
      touchStartPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else {
      touchStartPos.current = null;
    }
    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      setActionSheet({ isOpen: true, transaction });
    }, 750);
  }, []);

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

  const handleRowClick = useCallback((transaction: Transaction) => {
    if (longPressTriggered.current) {
      longPressTriggered.current = false;
      return;
    }
    onEdit?.(transaction);
  }, [onEdit]);

  const density = propDensity ?? localDensity;

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

  const actionHeaderPadding = useMemo(() => {
    switch (density) {
      case 'dense': return 'px-3 py-2';
      case 'compact': return 'px-4 py-2';
      default: return 'px-4 py-3';
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

  const handleActionSheetClose = useCallback(() => {
    setActionSheet({ isOpen: false, transaction: null });
  }, []);

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
    if (transaction.status === TransactionStatus.VOID) {
      toast.error('Edit the transaction to change its status from Void');
      return;
    }

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

  // Find the index where future transactions end and today/past begin
  // Transactions are sorted DESC by date, so future ones come first
  const futureBoundaryIndex = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < transactions.length; i++) {
      if (transactions[i].transactionDate <= today) {
        return i;
      }
    }
    // All transactions are future-dated
    return transactions.length;
  }, [transactions]);

  const showRunningBalance = isSingleAccountView || startingBalance !== undefined;

  // Compute display amounts for split transactions.  When a filter
  // causes only some splits to be returned, the sum of visible splits
  // will differ from the parent transaction amount.  In that case show
  // only the filtered total so the amount column matches what the user
  // sees in the category column.
  const displayAmounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const tx of transactions) {
      if (tx.isSplit && tx.splits && tx.splits.length > 0) {
        const splitsSumCents = tx.splits.reduce(
          (sum, s) => sum + Math.round(Number(s.amount) * 10000),
          0,
        );
        const txAmountCents = Math.round(Number(tx.amount) * 10000);
        if (splitsSumCents !== txAmountCents) {
          map.set(tx.id, splitsSumCents / 10000);
        }
      }
    }
    return map;
  }, [transactions]);

  // Calculate running balances using the backend-provided starting
  // balance and display amounts (which may be filtered split totals).
  const runningBalances = useMemo(() => {
    if (startingBalance === undefined || transactions.length === 0) {
      return new Map<string, number>();
    }

    const balances = new Map<string, number>();
    let cumulativeSum = 0;

    for (const tx of transactions) {
      const amount = displayAmounts.get(tx.id) ?? Number(tx.amount);
      balances.set(tx.id, startingBalance - cumulativeSum);
      cumulativeSum += amount;
    }

    return balances;
  }, [transactions, startingBalance, displayAmounts]);

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
        <svg className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">No transactions</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Get started by creating a new transaction.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Density toggle and top pagination */}
      {showToolbar && (() => {
        const toolbarButtons = (
          <div className="flex items-center gap-1 flex-shrink-0">
            {onExport && (
              <button
                onClick={onExport}
                disabled={isExporting}
                className="inline-flex items-center px-2 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded disabled:opacity-50 disabled:cursor-not-allowed"
                title="Export transactions to CSV"
              >
                {isExporting ? (
                  <svg className="w-4 h-4 sm:mr-1 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4 sm:mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                )}
                <span className="hidden sm:inline">{isExporting ? 'Exporting...' : 'Export'}</span>
              </button>
            )}
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
          </div>
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
                  infoRight={toolbarButtons}
                />
              </div>
            ) : (
              toolbarButtons
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
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>Date</th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden md:table-cell`}>Account</th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>Payee</th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden lg:table-cell`}>Category</th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden xl:table-cell`}>Description</th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden xl:table-cell`}>Tags</th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>Amount</th>
              {showRunningBalance && (
                <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>Balance</th>
              )}
              <th className={`${headerPadding} text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>Status</th>
              <th className={`${actionHeaderPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden min-[480px]:table-cell`}>Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {transactions.map((transaction, index) => {
              const isFuture = index < futureBoundaryIndex;
              const colCount = 9
                + (selectionMode ? 1 : 0)
                + (showRunningBalance ? 1 : 0);
              return (
                <React.Fragment key={transaction.id}>
                  {index === futureBoundaryIndex && futureBoundaryIndex > 0 && (
                    <tr>
                      <td colSpan={colCount} className="px-0 py-0">
                        <div className="flex items-center gap-3 px-4 py-1.5">
                          <div className="flex-1 border-t border-blue-300 dark:border-blue-700" />
                          <span className="text-xs font-medium text-blue-500 dark:text-blue-400 uppercase tracking-wider whitespace-nowrap">Today</span>
                          <div className="flex-1 border-t border-blue-300 dark:border-blue-700" />
                        </div>
                      </td>
                    </tr>
                  )}
                  <TransactionRow
                    transaction={transaction}
                    index={index}
                    density={density}
                    cellPadding={cellPadding}
                    isSingleAccountView={isSingleAccountView}
                    showRunningBalance={showRunningBalance}
                    runningBalance={runningBalances.get(transaction.id)}
                    displayAmount={displayAmounts.get(transaction.id)}
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
                    onDuplicate={onDuplicate}
                    onDeleteClick={handleDeleteClick}
                    selectionMode={selectionMode}
                    isSelected={selectionMode ? selectedIds?.has(transaction.id) : undefined}
                    onToggleSelection={selectionMode ? () => onToggleSelection?.(transaction.id) : undefined}
                    categoryColorMap={categoryColorMap}
                    budgetStatusMap={budgetStatusMap}
                    isFuture={isFuture}
                  />
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Long-press Action Sheet */}
      <TransactionActionSheet
        isOpen={actionSheet.isOpen}
        transaction={actionSheet.transaction}
        formatDate={formatDate}
        onClose={handleActionSheetClose}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        onDeleteClick={handleDeleteClick}
        onDateFilterClick={onDateFilterClick}
        onAccountFilterClick={onAccountFilterClick}
        onPayeeFilterClick={onPayeeFilterClick}
        onCategoryClick={onCategoryClick}
      />

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
