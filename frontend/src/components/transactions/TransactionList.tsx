'use client';

import React, { useState, useMemo, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Transaction, TransactionStatus } from '@/types/transaction';
import {
  nextCycleStatus,
  RECONCILED_UNDO_WINDOW_SECONDS,
} from '@/lib/transaction-status-cycle';
import { CategoryBudgetStatus } from '@/types/budget';
import { transactionsApi } from '@/lib/transactions';
import { getErrorMessage } from '@/lib/errors';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ListTopToolbar, LIST_TOOLBAR_BUTTON_CLASS } from '@/components/ui/ListTopToolbar';
import { ColumnChooserMenu, type ColumnChooserItem } from '@/components/ui/ColumnChooserMenu';
import { useHiddenColumns } from '@/hooks/useHiddenColumns';
import { useColumnHeaderActions } from '@/hooks/useColumnHeaderActions';
import type { HideableColumn } from '@/lib/hidden-columns';
import type { LongPressRowHandlers } from '@/hooks/useLongPress';
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
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { useTableDensity } from '@/hooks/useTableDensity';
import { useDensityPreference, type DensityView } from '@/store/densityStore';
import { useCompactMobileDates } from '@/store/dateDisplayStore';
import { useRegisterPhoneCard } from '@/hooks/useRegisterPhoneCard';
import { usePreferencesStore } from '@/store/preferencesStore';
import { EmptyState } from '@/components/ui/EmptyState';
import { SortableHeader } from '@/components/ui/SortableHeader';
import {
  isSortedByDate,
  PHONE_CARD_OMITTED_SORT_FIELDS,
  TRANSACTION_SORT_FIELDS,
  type TransactionSort,
  type TransactionSortField,
} from '@/lib/transaction-sort';
import { PHONE_HEADER_CLASS } from '@/components/ui/Table';
import { walkRunningBalances } from '@/lib/running-balance';
import { balanceColor, gainLossColor } from '@/lib/format';
import { DocumentArrowDownIcon } from '@heroicons/react/24/outline';

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
  /**
   * Why there is no running balance, where there would otherwise have been
   * one. The server sets it; the register turns it into one line of copy, so
   * a reader who has just sorted by payee is told how to get the column back
   * rather than left wondering where it went. Absent means there is nothing
   * to say -- an all-accounts register never had a balance to withhold.
   */
  startingBalanceWithheld?: 'sort';
  /**
   * The column the register is sorted by, where the surface offers sorting.
   * Undefined draws today's plain headers and takes the server's own order,
   * which is what every surface but the Transactions page does.
   */
  sort?: TransactionSort;
  /**
   * The order the rows on screen were actually fetched in, which is not the
   * order the headers show while a reload is in flight. A click changes `sort`
   * at once -- the header has to answer the press -- but `transactions` and
   * `startingBalance` still belong to the previous request for a debounce plus
   * a round trip. Every figure derived from the rows reads this one instead,
   * because a walk that reverses the old page under the new direction prints a
   * balance column that was never true of any state of the ledger.
   */
  rowsSort?: TransactionSort;
  onSortChange?: (field: TransactionSortField) => void;
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
  /**
   * The Table / Calendar switch for the screen this register is the table half
   * of, rendered in the top toolbar between the density button and the pager.
   * Absent on a screen that offers no calendar.
   */
  viewToggle?: React.ReactNode;
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
}

/**
 * A register column header: a sort control where the surface offers sorting,
 * and exactly today's cell where it does not.
 *
 * Seven surfaces draw this register and only the Transactions page passes a
 * sort, so the plain branch has to stay byte-identical -- the `inline-flex`
 * wrapper the Date column's year toggle sits in included.
 *
 * `className` is passed through whole rather than composed here: it carries
 * each column's `registerColumnClass(...)` call, and the register's column
 * guard reads those literals out of this file in source order to check them
 * against the column contract. Moving them into a lookup table would leave
 * that guard with nothing to read.
 *
 * `pressHandlers` (a hideable column's long-press / right-click "Hide column"
 * sheet, from `useColumnHeaderActions`) is forwarded on both branches: the
 * plain header spreads them so the sheet opens on every surface, and the sort
 * header hands them to `SortableHeader`, which sorts from their click instead
 * of its own so one press never both opens the sheet and sorts.
 */
function RegisterHeader({
  field,
  sort,
  onSortChange,
  align = 'left',
  className,
  controls,
  pressHandlers,
  children,
}: {
  field: TransactionSortField;
  sort?: TransactionSort;
  onSortChange?: (field: TransactionSortField) => void;
  align?: 'left' | 'right' | 'center';
  className: string;
  controls?: React.ReactNode;
  pressHandlers?: LongPressRowHandlers;
  children: React.ReactNode;
}) {
  if (!sort || !onSortChange) {
    return (
      <th className={className} {...pressHandlers}>
        {controls ? (
          <span className="inline-flex items-center gap-1">
            {children}
            {controls}
          </span>
        ) : (
          children
        )}
      </th>
    );
  }

  return (
    <SortableHeader<TransactionSortField>
      field={field}
      sortField={sort.field}
      sortDirection={sort.direction}
      onSort={onSortChange}
      align={align}
      className={className}
      controls={controls}
      pressHandlers={pressHandlers}
    >
      {children}
    </SortableHeader>
  );
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
  onExport,
  isExporting,
  startingBalance,
  startingBalanceWithheld,
  sort,
  rowsSort,
  onSortChange,
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
  viewToggle,
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
  // Model B: the phone card or the tier table. Exactly one branch renders per
  // row, chosen here.
  const wrapped = useRegisterPhoneCard(densityView, showFxColumns);
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
  // A row is future by its own date, never by where it sits: running
  // oldest-first the future rows are at the BOTTOM of the page, so an index
  // threshold marks exactly the wrong half of it.
  // The user's own calendar, not the browser's: whether a row is still to come
  // is a financial decision, and a traveller's laptop is on the wrong day for
  // it. `useFinancialToday` is the one answer every other such decision reads.
  const today = useFinancialToday();
  // Everything below is a statement about the rows on screen, so it reads the
  // order those rows were fetched in, not the order the headers are showing.
  // The two differ for a debounce plus a round trip after every header click,
  // and for good after a reload that failed. A register with no sorting at all
  // passes neither and takes the server's own order.
  const dataSort = rowsSort ?? sort;
  // Where the page crosses today, which is before the first non-future row
  // running newest-first and before the first future row running oldest-first.
  // A page that does not cross it -- and a register ordered by anything but
  // the date, where "future" is not a place on the page at all -- draws none.
  const todayDividerIndex = useMemo(() => {
    if (!isSortedByDate(dataSort)) return -1;
    const ascending = (dataSort?.direction ?? 'desc') === 'asc';
    const boundary = transactions.findIndex((tx) =>
      ascending ? tx.transactionDate > today : tx.transactionDate <= today,
    );
    return boundary > 0 ? boundary : -1;
  }, [transactions, dataSort, today]);

  // Two halves of one decision: the column is drawn where a balance was asked
  // for and supplied, AND where the register is in date order -- a running
  // balance is a figure about the row above it, so beside rows ordered by
  // payee or amount it is arithmetic nobody can read. The server withholds
  // the seed under any other order, so this only ever hides a column it has
  // no number for anyway.
  // Exhaustive over the sort fields, so a field added to the union is a
  // compile error here rather than a column with no control on a phone -- and
  // a remembered sort with no control is one a reader cannot get back out of.
  const sortLabels: Record<TransactionSortField, string> = {
    date: t('list.header.date'),
    account: t('list.header.account'),
    payee: t('list.header.payee'),
    category: t('list.header.category'),
    description: t('list.header.description'),
    refNumber: t('list.header.refNumber'),
    amount: t('list.header.amount'),
    status: t('list.header.status'),
  };
  // The reader's hidden columns: one read for the whole list (the row takes
  // the set as a prop). A hidden column's header and cells are absent from the
  // DOM at every width, never hidden by a class; the tiers decide the rest.
  const {
    hidden: hiddenColumns,
    isVisible,
    hide: hideColumn,
    show: showColumn,
    showAll: showAllColumns,
    hideable,
  } = useHiddenColumns('transactions');
  const hideableColumns = useMemo<ColumnChooserItem<HideableColumn<'transactions'>>[]>(
    () => {
      const labels: Record<HideableColumn<'transactions'>, string> = {
        description: t('list.header.description'),
        refNumber: t('list.header.refNumber'),
        tags: t('list.header.tags'),
        attachments: t('list.header.attachments'),
        status: t('list.header.status'),
      };
      return hideable.map((id) => ({ id, label: labels[id] }));
    },
    [hideable, t],
  );
  // A plain click on a hideable header is the sort it always was, where the
  // column sorts and the surface offers sorting; Tags and Attachments sort
  // nowhere, so their click does nothing.
  const handleHideableHeaderClick = useCallback(
    (id: HideableColumn<'transactions'>) => {
      if ((TRANSACTION_SORT_FIELDS as readonly string[]).includes(id)) {
        onSortChange?.(id as TransactionSortField);
      }
    },
    [onSortChange],
  );
  const { headerHandlers, sheet: columnHeaderSheet } = useColumnHeaderActions({
    columns: hideableColumns,
    onHide: hideColumn,
    onHeaderClick: handleHideableHeaderClick,
  });

  // The Account column is not drawn on a single account's page, so it gets no
  // chip there either (the page resolves a remembered account sort away). A
  // hidden column's chip is omitted the same way: the page resolves a
  // remembered sort on it to the date sort. The strip is drawn only above the
  // phone card, which shows no description or ref #, so those two get no chip
  // either, and the page resolves a remembered sort on them the same way.
  const sortChipFields = TRANSACTION_SORT_FIELDS.filter(
    (field) =>
      (field !== 'account' || !isSingleAccountView) &&
      isVisible(field) &&
      !PHONE_CARD_OMITTED_SORT_FIELDS.has(field),
  );

  // The rows' own order, not the headers': turning the column back on the
  // instant a reader clicks Date would draw it over rows that still carry no
  // balance, a strip of dashes under the line promising one.
  const sortedByDate = isSortedByDate(dataSort);
  const showRunningBalance =
    (isSingleAccountView || startingBalance !== undefined) && sortedByDate;
  // Row-invariant, so computed once rather than per row: ten unconditional
  // columns (register-columns.ts order, minus Account/FX/Balance, which are
  // conditional) plus the ones this render actually drew, minus the ones the
  // reader has hidden. Used by the "today" divider's colSpan in the tier table.
  const colCount = 10
    + (isSingleAccountView ? 0 : 1)
    + (selectionMode ? 1 : 0)
    + (showRunningBalance ? 1 : 0)
    + (showFxColumns ? 3 : 0)
    - hiddenColumns.size;

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

  // The running balance beside each row: the backend's starting balance run
  // down the page, with a filtered split's visible total standing in where it
  // differs. A VOID row and a split child take a balance but move none, which
  // is what the backend's own sums exclude.
  //
  // The walk lives in `lib/running-balance.ts` because it has to answer for
  // both directions: the seed is the balance after the page's NEWEST row, so
  // an oldest-first page is reversed before it is walked.
  const runningBalances = useMemo(
    () => walkRunningBalances(transactions, startingBalance, dataSort?.direction ?? 'desc', displayAmounts),
    [transactions, startingBalance, dataSort?.direction, displayAmounts],
  );

  const formatAmount = useCallback((amount: number, currencyCode?: string) => {
    const isNegative = amount < 0;
    const absAmount = Math.abs(amount);
    const formatted = formatCurrency(absAmount, currencyCode);

    return (
      <span className={gainLossColor(amount)}>
        {isNegative ? '-' : '+'}{formatted}
      </span>
    );
  }, [formatCurrency]);

  const formatBalance = useCallback((balance: number, currencyCode?: string) => {
    const formatted = formatCurrency(Math.abs(balance), currencyCode);
    return (
      <span className={balanceColor(balance)}>
        {balance < 0 ? `-${formatted}` : formatted}
      </span>
    );
  }, [formatCurrency]);

  if (transactions.length === 0) {
    return (
      <div>
        {/* The switch survives an empty register: "there is nothing here" is
            exactly when a reader reaches for another view of it, and a control
            that vanishes with the last row is one they cannot get back to
            without a transaction. The pager does not come with it -- there are
            no pages of nothing to step through. */}
        {showToolbar && viewToggle && (
          <ListTopToolbar densityView={densityView} viewToggle={viewToggle} />
        )}
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
      </div>
    );
  }

  // The phone card's header controls: the select-all-on-page box in selection
  // mode and the day/month date toggle. They lead the sort strip where the
  // surface sorts, and stand in a slim row of their own where it does not.
  const wrappedHeaderControls = (
    <>
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
    </>
  );

  return (
    <div>
      {/* Density toggle and top pagination */}
      {showToolbar && (
        <ListTopToolbar
          densityView={densityView}
          viewToggle={viewToggle}
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={totalItems}
          pageSize={pageSize}
          onPageChange={onPageChange}
          itemName={t('list.itemNamePlural')}
          actions={
            <>
              {/* The one way to bring a hidden column back, so it is first and
                  always drawn; its trigger carries the count of hidden ones. */}
              <ColumnChooserMenu
                columns={hideableColumns}
                hidden={hiddenColumns}
                onHide={hideColumn}
                onShow={showColumn}
                onShowAll={showAllColumns}
              />
              {/* Withholding a figure is only honest if the reader learns why
                  and what to do: the Balance column is gone because the
                  register is not in date order, and sorting by date brings it
                  back. Drawn from the server's own flag, so it appears only
                  where a balance would otherwise have been shown. */}
              {startingBalanceWithheld === 'sort' && (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {t('list.sort.balanceHiddenHint')}
                </span>
              )}
              {onExport && (
                <button
                  onClick={onExport}
                  disabled={isExporting}
                  className={`${LIST_TOOLBAR_BUTTON_CLASS} gap-1`}
                  title={t('list.export.title')}
                >
                  {isExporting ? (
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : (
                    <DocumentArrowDownIcon className="w-4 h-4" aria-hidden="true" />
                  )}
                    <span className="hidden sm:inline">{isExporting ? t('list.export.exporting') : t('list.export.button')}</span>
                  </button>
              )}
            </>
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
              mode, the select-all-on-page box. They share one row with the
              sort chips where there are any, so the header costs a phone a
              single line. */}
          <thead className="bg-gray-50 dark:bg-gray-800">
            {wrapped ? (
              // A header that holds controls is replaced, never hidden: the
              // card labels its own values, but the sort controls have to
              // come back or a phone can be left in an order it cannot
              // change. Same component as the column headers, at chip size.
              sort && onSortChange ? (
                <tr role="row" aria-label={t('list.sort.stripLabel')} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2">
                  {/* The same controls-only cell as the slim row below, its
                      role restated because the flex row drops the implicit one. */}
                  <th role="columnheader" className="flex items-center gap-3 pr-1">
                    {wrappedHeaderControls}
                  </th>
                  {sortChipFields.map((field) => (
                    <SortableHeader<TransactionSortField>
                      key={field}
                      field={field}
                      sortField={sort.field}
                      sortDirection={sort.direction}
                      onSort={onSortChange}
                      className={PHONE_HEADER_CLASS}
                    >
                      {sortLabels[field]}
                    </SortableHeader>
                  ))}
                </tr>
              ) : (
                <tr>
                  {/* Controls only, no column label: the single card cell below
                      carries payee, amount, status and the rest, so naming this
                      header "Date" would misdescribe the column to a screen
                      reader. The toggle names itself through its own aria-label. */}
                  <th className={`${headerPadding} text-left`}>
                    <div className="flex items-center gap-3">{wrappedHeaderControls}</div>
                  </th>
                </tr>
              )
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
              <RegisterHeader
                field="date"
                sort={sort}
                onSortChange={onSortChange}
                className={`${headerPadding} ${compactPadding.date} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}
                controls={
                  /* Drops the year from the Date column. Born on phones -- where the
                     payee is what runs out of room and the year is the part a register
                     row can spare -- and now offered at every width, so the day/month
                     view is a choice rather than something only phones get. It sits in
                     the header's controls slot, which is what stops a press on it also
                     sorting the column. */
                  <CompactDatesToggle
                    active={compactMobileDates}
                    onToggle={toggleCompactMobileDates}
                    label={t('list.dateDisplay.toggleLabel')}
                    title={t('list.dateDisplay.toggleTitle')}
                  />
                }
              >
                {t('list.header.date')}
              </RegisterHeader>
              {/* Structural, not responsive: on a single account's page every
                  row would repeat the page's own title, so the column is
                  omitted from the DOM entirely (see register-columns.ts). */}
              {!isSingleAccountView && (
                <RegisterHeader
                  field="account"
                  sort={sort}
                  onSortChange={onSortChange}
                  className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider ${registerColumnClass('account')}`}
                >
                  {t('list.header.account')}
                </RegisterHeader>
              )}
              {/* The floor travels with the header: a column's minimum is the
                  largest of its cells', so a `<th>` that does not carry it
                  would leave the label and the values it labels disagreeing
                  about where the column starts. */}
              <RegisterHeader
                field="payee"
                sort={sort}
                onSortChange={onSortChange}
                className={`${headerPadding} ${compactPadding.payee} ${REGISTER_PAYEE_CELL_FLOOR} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}
              >
                {t('list.header.payee')}
              </RegisterHeader>
              <RegisterHeader
                field="category"
                sort={sort}
                onSortChange={onSortChange}
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider ${registerColumnClass('category')}`}
              >
                {t('list.header.category')}
              </RegisterHeader>
              {/* The five hideable columns (description, ref #, tags,
                  attachments, status) are gated on the reader's hidden set:
                  absent from the DOM, never hidden by a class. Each header
                  also takes the long-press / right-click "Hide column" sheet. */}
              {isVisible('description') && (
                <RegisterHeader
                  field="description"
                  sort={sort}
                  onSortChange={onSortChange}
                  className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider ${registerColumnClass('description')}`}
                  pressHandlers={headerHandlers('description')}
                >
                  {t('list.header.description')}
                </RegisterHeader>
              )}
              {isVisible('refNumber') && (
                <RegisterHeader
                  field="refNumber"
                  sort={sort}
                  onSortChange={onSortChange}
                  className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider ${registerColumnClass('refNumber')}`}
                  pressHandlers={headerHandlers('refNumber')}
                >
                  {t('list.header.refNumber')}
                </RegisterHeader>
              )}
              {isVisible('tags') && (
                <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider ${registerColumnClass('tags')}`} {...headerHandlers('tags')}>{t('list.header.tags')}</th>
              )}
              {isVisible('attachments') && (
                <th
                  className={`${headerPadding} text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider ${registerColumnClass('attachments')}`}
                  title={t('list.header.attachments')}
                  aria-label={t('list.header.attachments')}
                  {...headerHandlers('attachments')}
                >
                  <svg className="w-4 h-4 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                </th>
              )}
              <RegisterHeader
                field="amount"
                sort={sort}
                onSortChange={onSortChange}
                align="right"
                className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}
              >
                {t('list.header.amount')}
              </RegisterHeader>
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
              {isVisible('status') && (
                <RegisterHeader
                  field="status"
                  sort={sort}
                  onSortChange={onSortChange}
                  align="center"
                  className={`${headerPadding} text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider ${registerColumnClass('status')}`}
                  pressHandlers={headerHandlers('status')}
                >
                  {t('list.header.status')}
                </RegisterHeader>
              )}
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider ${registerColumnClass('actions')} sticky right-0 bg-gray-50 dark:bg-gray-800`}>{t('list.header.actions')}</th>
            </tr>
            )}
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {transactions.map((transaction, index) => {
              const isFuture = transaction.transactionDate > today;
              return (
                <React.Fragment key={transaction.id}>
                  {index === todayDividerIndex && (
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
                    hidden={hiddenColumns}
                  />
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* A hideable header's long-press / right-click sheet: "Hide column". */}
      {columnHeaderSheet}

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
