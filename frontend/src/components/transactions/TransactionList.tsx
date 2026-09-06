'use client';

import React, { useState, useMemo, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Transaction, TransactionStatus } from '@/types/transaction';
import { classifyStaleRow, type StaleUnreconciledReason } from '@/lib/stale-reconciliation';
import {
  nextCycleStatus,
  RECONCILED_UNDO_WINDOW_SECONDS,
} from '@/lib/transaction-status-cycle';
import { CategoryBudgetStatus } from '@/types/budget';
import { transactionsApi } from '@/lib/transactions';
import { getErrorMessage } from '@/lib/errors';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ListTopToolbar } from '@/components/ui/ListTopToolbar';
import { TransactionRow } from './TransactionRow';
import { registerDateColumnPadding } from './register-date-columns';
import {
  registerColumnClass,
  REGISTER_PAYEE_CELL_FLOOR,
  REGISTER_TABLE_CONTAINER,
} from './register-columns';
import { TransactionActionSheet } from './TransactionActionSheet';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { getLocalDateString } from '@/lib/utils';
import { useTableDensity } from '@/hooks/useTableDensity';
import { useDensityPreference, type DensityView } from '@/store/densityStore';
import { useCompactMobileDates } from '@/store/dateDisplayStore';
import { useIsMobile } from '@/hooks/useIsMobile';
import { usePreferencesStore } from '@/store/preferencesStore';
import { EmptyState } from '@/components/ui/EmptyState';

interface TransactionListProps {
  transactions: Transaction[];
  onEdit?: (transaction: Transaction) => void;
  onDuplicate?: (transaction: Transaction) => void;
  onScheduleRecurring?: (transaction: Transaction) => void;
  /**
   * Notification that the row has **already been deleted** -- this list owns the
   * confirmation, the `transactionsApi.delete`/`deleteTransfer` call and the
   * toast, and calls this afterwards with the id it removed. It is not a request
   * to perform the delete: a handler that deletes again issues a second request
   * for a row that no longer exists, so the user gets the success toast and a
   * "not found" error side by side (issue #1192). Past tense is the whole
   * contract -- reach for `onRefresh` to reload, and this only when the caller
   * needs the id (an optimistic removal, a counterpart to drop).
   */
  onDeleted?: (id: string) => void;
  onRefresh?: () => void;
  onTransactionUpdate?: (transaction: Transaction) => void;
  onPayeeClick?: (payeeId: string) => void;
  onTransferClick?: (linkedAccountId: string, linkedTransactionId: string) => void;
  onCategoryClick?: (categoryId: string) => void;
  onTagClick?: (tagId: string) => void;
  onDateFilterClick?: (date: string) => void;
  onAccountFilterClick?: (accountId: string) => void;
  onPayeeFilterClick?: (payeeId: string) => void;
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
  selectAllMatching?: boolean;
  excludedIds?: Set<string>;
  onToggleSelection?: (id: string) => void;
  onToggleAllOnPage?: () => void;
  isAllOnPageSelected?: boolean;
  categoryColorMap?: Map<string, string | null>;
  /** Inherited-aware icon per category id; see buildCategoryIconMap. */
  categoryIconMap?: Map<string, string | null>;
  categoryLabelMap?: Map<string, string>;
  budgetStatusMap?: Record<string, CategoryBudgetStatus>;
  /**
   * Which surface's remembered row density this list reads. Six places render
   * this component and each remembers its own level, so a caller that is not
   * the transactions register must say so -- `density-preference.guard.test.ts`
   * fails on one that does not.
   */
  densityView?: DensityView;
  showToolbar?: boolean;
  /** Transaction id to flash and scroll to (e.g. arriving from a deep link). */
  highlightTransactionId?: string | null;
  /**
   * Adds foreign-currency columns (paid currency, paid amount, fee paid) for
   * the account-detail Foreign Currency Transaction Fees section.
   */
  showFxColumns?: boolean;
  /**
   * Joint accounts: effective write permissions per shared account id. Rows
   * in a listed account hide the edit/delete affordances the grant does not
   * cover; rows in unlisted accounts (the caller's own) are unaffected.
   */
  jointPermissionsByAccount?: Map<
    string,
    { canCreate: boolean; canEdit: boolean; canDelete: boolean }
  >;
  /**
   * What the register needs to say which rows a reconciled statement left out:
   * the last reconciled date of each account the user reconciles, and the date
   * the server chose as the overdue boundary. Undefined means the caller has no
   * information -- a page that has not asked, or whose request failed -- and no
   * row is marked, which is the right answer for both. An account absent from
   * the map has never been reconciled and so has nothing outstanding at all.
   *
   * The register draws only the `missed` half of the classification; see
   * `registerStaleReason` below for why.
   */
  staleContext?: {
    lastReconciledByAccount: Map<string, string>;
    overdueBefore: string;
  };
}

/**
 * The reconciliation mark the *register* draws, which is not every mark
 * `classifyStaleRow` can produce.
 *
 * A `missed` row is a fact about the ledger: the statement covering it was
 * reconciled without it, so the account's reconciled balance and its real one
 * disagree until somebody looks. That is worth an amber chip anywhere the row
 * appears.
 *
 * `overdue` is not that. It only says nobody has reconciled recently, which is
 * true of every row in the account at once -- so on a register showing months
 * of history it marked page after page of ordinary transactions with nothing
 * wrong with them, for a condition about the *account* rather than about any
 * row. The reconcile screen still shows it (`ReconcileTable`), where it is
 * about the statement being worked on, and the header badge still counts it.
 */
function registerStaleReason(
  staleContext:
    | { lastReconciledByAccount: Map<string, string>; overdueBefore: string }
    | undefined,
  transaction: Transaction,
): StaleUnreconciledReason | undefined {
  if (!staleContext) return undefined;
  const reason = classifyStaleRow(
    transaction.status,
    transaction.transactionDate,
    staleContext.lastReconciledByAccount.get(transaction.accountId) ?? null,
    staleContext.overdueBefore,
  );
  return reason === 'missed' ? reason : undefined;
}

/**
 * The day/month date-view toggle that drops the year from the Date column. It
 * lives in the register's column header and, on a phone at Normal density, in
 * the wrapped card's slim control header -- one button, so the two cannot
 * drift.
 */
function CompactDatesToggle({
  active,
  onToggle,
  label,
  title,
}: {
  active: boolean;
  onToggle: () => void;
  label: string;
  title: string;
}) {
  return (
    <button
      onClick={onToggle}
      aria-pressed={active}
      aria-label={label}
      title={title}
      className={`rounded p-0.5 focus-visible:outline-2 focus-visible:outline-blue-500 ${
        active
          ? 'text-blue-600 dark:text-blue-400'
          : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'
      }`}
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V6a2 2 0 012-2h2M4 16v2a2 2 0 002 2h2m8-16h2a2 2 0 012 2v2m-4 12h2a2 2 0 002-2v-2M9 12h6" />
      </svg>
    </button>
  );
}

export function TransactionList({
  transactions,
  onEdit,
  onDuplicate,
  onScheduleRecurring,
  onDeleted,
  onRefresh,
  onTransactionUpdate,
  onPayeeClick,
  onTransferClick,
  onCategoryClick,
  onTagClick,
  onDateFilterClick,
  onAccountFilterClick,
  onPayeeFilterClick,
  staleContext,
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
  selectAllMatching,
  excludedIds,
  onToggleSelection,
  onToggleAllOnPage,
  isAllOnPageSelected,
  categoryColorMap,
  categoryIconMap,
  categoryLabelMap,
  budgetStatusMap,
  densityView = 'transactions',
  showToolbar = true,
  highlightTransactionId,
  showFxColumns = false,
  jointPermissionsByAccount,
}: TransactionListProps) {
  const t = useTranslations('transactions');
  const tc = useTranslations('common');
  const { formatDate, formatDateWithoutYear } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { density } = useDensityPreference(densityView);
  // Model B: on a phone, density picks the LAYOUT rather than only the row
  // height. At Normal each row is a wrapped two-line card that shows more of
  // the register than a phone-width tier table can without scrolling
  // sideways; Compact and Dense keep the tier table, unchanged, and so does
  // every non-phone width. Exactly one branch renders per row, chosen here.
  const isMobile = useIsMobile();
  // The foreign-currency fee surfaces (`showFxColumns`) keep the tier table on
  // a phone: their whole subject is the paid-currency, paid-amount and fee
  // columns, which the card does not carry, so wrapping there would hide the
  // very data the surface exists to show.
  const wrapped = isMobile && density === 'normal' && !showFxColumns;
  const { compactMobileDates, toggleCompactMobileDates } = useCompactMobileDates();
  const compactPadding = registerDateColumnPadding(compactMobileDates);

  // The year is the least informative part of a register date -- a page of
  // rows is mostly one or two years -- so it is what the narrow column gives
  // up. Day and month keep the user's own ordering and separators.
  const formatCompactDate = useCallback(
    (date: string) => formatDateWithoutYear(date),
    [formatDateWithoutYear]
  );
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

  const handleLongPressStart = useCallback((transaction: Transaction, e: React.MouseEvent) => {
    if (e.button !== 0) return;
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

  const handleContextMenu = useCallback((transaction: Transaction, e: React.MouseEvent) => {
    e.preventDefault();
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    longPressTriggered.current = true;
    setActionSheet({ isOpen: true, transaction });
  }, []);

  const handleRowClick = useCallback((transaction: Transaction) => {
    if (longPressTriggered.current) {
      longPressTriggered.current = false;
      return;
    }
    onEdit?.(transaction);
  }, [onEdit]);

  const { cellPadding, headerPadding } = useTableDensity(density);

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
        toast.success(t('list.delete.transferSuccess'));
      } else {
        await transactionsApi.delete(transaction.id);
        toast.success(t('list.delete.success'));
      }
      onDeleted?.(transaction.id);
      onRefresh?.();
    } catch (error) {
      toast.error(getErrorMessage(error, t('list.delete.error')));
    } finally {
      setDeletingId(null);
    }
  }, [deleteConfirm.transaction, onDeleted, onRefresh, t]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteConfirm({ isOpen: false, transaction: null });
  }, []);

  // Whether the strict lock is on, which is what makes a reconcile from this
  // register a one-way door after the undo window closes.
  const reconciledLocked = usePreferencesStore(
    (s) => s.preferences?.lockReconciledTransactions ?? false,
  );

  const handleCycleStatus = useCallback(async (transaction: Transaction) => {
    const nextStatus = nextCycleStatus(transaction.status);
    if (nextStatus === null) {
      toast.error(t('list.status.voidError'));
      return;
    }

    try {
      const updatedTransaction = await transactionsApi.updateStatus(transaction.id, nextStatus);
      const statusLabels: Record<TransactionStatus, string> = {
        [TransactionStatus.UNRECONCILED]: t('list.status.unreconciled'),
        [TransactionStatus.CLEARED]: t('list.status.cleared'),
        [TransactionStatus.RECONCILED]: t('list.status.reconciled'),
        [TransactionStatus.VOID]: t('list.status.void'),
      };
      // With the strict lock on, reconciling here is the last freely reversible
      // click on this row: the server allows the undo for a few seconds and
      // refuses it afterwards. Saying so is the difference between a window and
      // a trap -- the plain "status changed" toast gives the user no reason to
      // look at the row again until the next click has already been refused.
      toast.success(
        reconciledLocked && nextStatus === TransactionStatus.RECONCILED
          ? t('list.status.changedLockedUndo', {
              status: statusLabels[nextStatus],
              seconds: RECONCILED_UNDO_WINDOW_SECONDS,
            })
          : t('list.status.changed', { status: statusLabels[nextStatus] }),
      );

      if (onTransactionUpdate) {
        // The status endpoint returns the plain transaction; list-only
        // enrichment (attachment count, investment link) is not part of that
        // payload, so carry it over from the row we already have. Otherwise
        // the attachment column blanks out until the next refetch.
        onTransactionUpdate({
          ...updatedTransaction,
          linkedInvestmentTransactionId: transaction.linkedInvestmentTransactionId,
          attachmentCount: transaction.attachmentCount,
        });
      } else {
        onRefresh?.();
      }
    } catch (error) {
      toast.error(getErrorMessage(error, t('list.status.updateError')));
    }
  }, [onRefresh, onTransactionUpdate, reconciledLocked, t]);

  // Find the index where future transactions end and today/past begin.
  // Transactions are sorted DESC by date, so future ones come first.
  // "Today" is the user's local date -- using toISOString() would return
  // the UTC date and mis-classify a tomorrow-local-dated transaction as
  // past for users west of UTC in the late evening.
  const futureBoundaryIndex = useMemo(() => {
    const today = getLocalDateString();
    for (let i = 0; i < transactions.length; i++) {
      if (transactions[i].transactionDate <= today) {
        return i;
      }
    }
    // All transactions are future-dated
    return transactions.length;
  }, [transactions]);

  const showRunningBalance = isSingleAccountView || startingBalance !== undefined;
  // Row-invariant, so computed once rather than per row: ten unconditional
  // columns (register-columns.ts order, minus Account/FX/Balance, which are
  // conditional) plus the ones this render actually drew. Used by the "today"
  // divider's colSpan in the tier table.
  const colCount = 10
    + (isSingleAccountView ? 0 : 1)
    + (selectionMode ? 1 : 0)
    + (showRunningBalance ? 1 : 0)
    + (showFxColumns ? 3 : 0);

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

  // Calculate running balances using the backend-provided starting balance
  // and display amounts (which may be filtered split totals). The row for
  // each transaction still displays a running balance, but VOID transactions
  // and split children (parentTransactionId != null) contribute 0 to the
  // cumulative sum so the math matches the backend's balance calculations
  // (which exclude both from currentBalance and futureTransactionsSum).
  const runningBalances = useMemo(() => {
    const safeStart = Number(startingBalance);
    if (isNaN(safeStart) || transactions.length === 0) {
      return new Map<string, number>();
    }

    const balances = new Map<string, number>();
    let cumulativeCents = 0;

    for (const tx of transactions) {
      balances.set(tx.id, Math.round((safeStart * 10000) - cumulativeCents) / 10000);
      const affectsBalance =
        tx.status !== TransactionStatus.VOID && !tx.parentTransactionId;
      if (affectsBalance) {
        const raw = displayAmounts.get(tx.id) ?? Number(tx.amount);
        const amount = isNaN(raw) ? 0 : raw;
        cumulativeCents += Math.round(amount * 10000);
      }
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
      <EmptyState
        className="bg-gray-50 dark:bg-gray-800 rounded-lg"
        icon={
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        }
        title={t('list.empty.title')}
        description={t('list.empty.body')}
      />
    );
  }

  return (
    <div>
      {/* Density toggle and top pagination */}
      {showToolbar && (
        <ListTopToolbar
          densityView={densityView}
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={totalItems}
          pageSize={pageSize}
          onPageChange={onPageChange}
          itemName={t('list.itemNamePlural')}
          actions={
            onExport && (
              <button
                onClick={onExport}
                disabled={isExporting}
                className="inline-flex items-center px-2 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded disabled:opacity-50 disabled:cursor-not-allowed"
                title={t('list.export.title')}
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
                <span className="hidden sm:inline">{isExporting ? t('list.export.exporting') : t('list.export.button')}</span>
              </button>
            )
          }
        />
      )}
      {/* The container the column tiers measure: a column appears when the
          REGISTER itself is wide enough, not when the viewport is -- the
          viewport overstates this width by the page padding around it. */}
      <div className={`overflow-x-auto ${REGISTER_TABLE_CONTAINER}`}>
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          {/* On a phone the wrapped card labels its own values, so the full
              column header is dropped -- but the two controls that live in the
              header row must not go with it: the day/month date toggle (the
              register keeps it selectable at every width) and, in selection
              mode, the select-all-on-page box. A slim control header carries
              exactly those. */}
          <thead className="bg-gray-50 dark:bg-gray-800">
            {wrapped ? (
              <tr>
                {/* Controls only, no column label: the single card cell below
                    carries payee, amount, status and the rest, so naming this
                    header "Date" would misdescribe the column to a screen
                    reader. The toggle names itself through its own aria-label. */}
                <th className={`${headerPadding} text-left`}>
                  <div className="flex items-center gap-3">
                    {selectionMode && (
                      <input
                        type="checkbox"
                        checked={isAllOnPageSelected || false}
                        onChange={() => onToggleAllOnPage?.()}
                        className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 h-4 w-4 cursor-pointer"
                      />
                    )}
                    <CompactDatesToggle
                      active={compactMobileDates}
                      onToggle={toggleCompactMobileDates}
                      label={t('list.dateDisplay.toggleLabel')}
                      title={t('list.dateDisplay.toggleTitle')}
                    />
                  </div>
                </th>
              </tr>
            ) : (
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
              <th className={`${headerPadding} ${compactPadding.date} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                <span className="inline-flex items-center gap-1">
                  {t('list.header.date')}
                  {/* Drops the year from the Date column. Born on phones --
                      where the payee is what runs out of room and the year is
                      the part a register row can spare -- and now offered at
                      every width, so the day/month view is a choice rather
                      than something only phones get. */}
                  <CompactDatesToggle
                    active={compactMobileDates}
                    onToggle={toggleCompactMobileDates}
                    label={t('list.dateDisplay.toggleLabel')}
                    title={t('list.dateDisplay.toggleTitle')}
                  />
                </span>
              </th>
              {/* Structural, not responsive: on a single account's page every
                  row would repeat the page's own title, so the column is
                  omitted from the DOM entirely (see register-columns.ts). */}
              {!isSingleAccountView && (
                <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider ${registerColumnClass('account')}`}>{t('list.header.account')}</th>
              )}
              {/* The floor travels with the header: a column's minimum is the
                  largest of its cells', so a `<th>` that does not carry it
                  would leave the label and the values it labels disagreeing
                  about where the column starts. */}
              <th className={`${headerPadding} ${compactPadding.payee} ${REGISTER_PAYEE_CELL_FLOOR} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>{t('list.header.payee')}</th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider ${registerColumnClass('category')}`}>{t('list.header.category')}</th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider ${registerColumnClass('description')}`}>{t('list.header.description')}</th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider ${registerColumnClass('refNumber')}`}>{t('list.header.refNumber')}</th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider ${registerColumnClass('tags')}`}>{t('list.header.tags')}</th>
              <th
                className={`${headerPadding} text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider ${registerColumnClass('attachments')}`}
                title={t('list.header.attachments')}
                aria-label={t('list.header.attachments')}
              >
                <svg className="w-4 h-4 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>{t('list.header.amount')}</th>
              {showFxColumns && (
                <>
                  <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>{t('list.header.currency')}</th>
                  <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>{t('list.header.paidAmount')}</th>
                  <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>{t('list.header.feePaid')}</th>
                </>
              )}
              {showRunningBalance && (
                <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>{t('list.header.balance')}</th>
              )}
              <th className={`${headerPadding} text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider ${registerColumnClass('status')}`}>{t('list.header.status')}</th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider ${registerColumnClass('actions')} sticky right-0 bg-gray-50 dark:bg-gray-800`}>{t('list.header.actions')}</th>
            </tr>
            )}
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {transactions.map((transaction, index) => {
              const isFuture = index < futureBoundaryIndex;
              return (
                <React.Fragment key={transaction.id}>
                  {index === futureBoundaryIndex && futureBoundaryIndex > 0 && (
                    <tr>
                      {/* In the wrapped phone layout every header and body row
                          spans one column, so the divider does too; the tier
                          table keeps its full-width span. */}
                      <td colSpan={wrapped ? 1 : colCount} className="px-0 py-0">
                        <div className="flex items-center gap-3 px-4 py-1.5">
                          <div className="flex-1 border-t border-blue-300 dark:border-blue-700" />
                          <span className="text-xs font-medium text-blue-500 dark:text-blue-400 uppercase tracking-wider whitespace-nowrap">{t('list.today')}</span>
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
                    wrapped={wrapped}
                    showRunningBalance={showRunningBalance}
                    runningBalance={runningBalances.get(transaction.id)}
                    displayAmount={displayAmounts.get(transaction.id)}
                    isDeleting={deletingId === transaction.id}
                    formatDate={formatDate}
                    compactDates={compactMobileDates}
                    formatCompactDate={formatCompactDate}
                    formatAmount={formatAmount}
                    formatBalance={formatBalance}
                    onRowClick={handleRowClick}
                    onLongPressStart={handleLongPressStart}
                    onLongPressStartTouch={handleLongPressStartTouch}
                    onLongPressEnd={handleLongPressEnd}
                    onTouchMove={handleTouchMove}
                    onContextMenu={handleContextMenu}
                    onPayeeClick={onPayeeClick}
                    onTransferClick={onTransferClick}
                    onCategoryClick={onCategoryClick}
                    onTagClick={onTagClick}
                    onCycleStatus={handleCycleStatus}
                    onEdit={
                      jointPermissionsByAccount?.get(transaction.accountId) &&
                      !jointPermissionsByAccount.get(transaction.accountId)!.canEdit
                        ? undefined
                        : onEdit
                    }
                    onDuplicate={onDuplicate}
                    onScheduleRecurring={onScheduleRecurring}
                    onDeleteClick={handleDeleteClick}
                    hideDelete={
                      !!jointPermissionsByAccount?.get(transaction.accountId) &&
                      !jointPermissionsByAccount.get(transaction.accountId)!.canDelete
                    }
                    selectionMode={selectionMode}
                    isSelected={selectionMode ? (selectAllMatching ? !excludedIds?.has(transaction.id) : (selectedIds?.has(transaction.id) || false)) : undefined}
                    onToggleSelection={selectionMode ? () => onToggleSelection?.(transaction.id) : undefined}
                    categoryColorMap={categoryColorMap}
                    categoryIconMap={categoryIconMap}
                    budgetStatusMap={budgetStatusMap}
                    isFuture={isFuture}
                    isHighlighted={!!highlightTransactionId && transaction.id === highlightTransactionId}
                    showFxColumns={showFxColumns}
                    staleReason={registerStaleReason(staleContext, transaction)}
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
        onScheduleRecurring={onScheduleRecurring}
        onDeleteClick={handleDeleteClick}
        onDateFilterClick={onDateFilterClick}
        onAccountFilterClick={onAccountFilterClick}
        onPayeeFilterClick={onPayeeFilterClick}
        onCategoryClick={onCategoryClick}
        onTagFilterClick={onTagClick}
        categoryLabelMap={categoryLabelMap}
      />

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={deleteConfirm.isOpen}
        title={deleteConfirm.transaction?.isTransfer ? t('list.delete.transferTitle') : t('list.delete.transactionTitle')}
        message={
          (deleteConfirm.transaction?.isTransfer
            ? t('list.delete.transferMessage')
            : t('list.delete.transactionMessage')) +
          (deleteConfirm.transaction?.status === TransactionStatus.RECONCILED
            ? ` ${t('list.delete.reconciledWarning')}`
            : '')
        }
        confirmLabel={tc('delete')}
        cancelLabel={tc('cancel')}
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
    </div>
  );
}
