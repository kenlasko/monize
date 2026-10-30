'use client';

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { isSpecialCategoryFilterId } from '@/lib/categoryUtils';
import { TransactionFilterPanel } from '@/components/transactions/TransactionFilterPanel';
import { TagKeyBreakdownChart } from '@/components/transactions/TagKeyBreakdownChart';
import { ListBottomPager } from '@/components/ui/ListBottomPager';
import { TransactionList } from '@/components/transactions/TransactionList';
import dynamic from 'next/dynamic';

const TransactionForm = dynamic(() => import('@/components/transactions/TransactionForm').then(m => m.TransactionForm), { ssr: false });
const ScheduledTransactionForm = dynamic(() => import('@/components/scheduled-transactions/ScheduledTransactionForm').then(m => m.ScheduledTransactionForm), { ssr: false });
const PayeeForm = dynamic(() => import('@/components/payees/PayeeForm').then(m => m.PayeeForm), { ssr: false });
const CategoryForm = dynamic(() => import('@/components/categories/CategoryForm').then(m => m.CategoryForm), { ssr: false });
const BulkUpdateModal = dynamic(() => import('@/components/transactions/BulkUpdateModal').then(m => m.BulkUpdateModal), { ssr: false });
// Reserve the chart card's height while the chunk loads so the rest of the
// page (filter row, table) doesn't jump down when the chart hydrates.
const ChartLoadingPlaceholder = () => (
  <div className={`${CARD_CLASS} p-3 sm:p-6 mb-6 min-h-[420px]`} />
);
const BalanceHistoryChart = dynamic(() => import('@/components/transactions/BalanceHistoryChart').then(m => m.BalanceHistoryChart), { ssr: false, loading: ChartLoadingPlaceholder });
// Calendar mode's whole tree, loaded only once a reader switches to it, so the
// register keeps the bundle it had.
const TransactionsCalendarView = dynamic(() => import('@/components/calendar/TransactionsCalendarView').then(m => m.TransactionsCalendarView), { ssr: false });
const CategoryPayeeBarChart = dynamic(() => import('@/components/transactions/CategoryPayeeBarChart').then(m => m.CategoryPayeeBarChart), { ssr: false, loading: ChartLoadingPlaceholder });
const AccountBalancesBarChart = dynamic(() => import('@/components/transactions/AccountBalancesBarChart').then(m => m.AccountBalancesBarChart), { ssr: false, loading: ChartLoadingPlaceholder });
import { transferCsvLabel, transferPayeeCsvLabel } from '@/lib/transfer-label';
import { transactionsApi } from '@/lib/transactions';
import { accountsApi } from '@/lib/accounts';
import { institutionsApi } from '@/lib/institutions';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { categoriesApi } from '@/lib/categories';
import { payeesApi } from '@/lib/payees';
import { tagsApi } from '@/lib/tags';
import { Transaction, PaginationInfo, BulkUpdateData, BulkUpdateFilters, MonthlyTotal, BulkDeleteData, SearchInterpretation } from '@/types/transaction';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useTransactionSelection } from '@/hooks/useTransactionSelection';
import { useTransactionFilters } from '@/hooks/useTransactionFilters';
import { useSortableTable } from '@/hooks/useSortableTable';
import {
  DEFAULT_TRANSACTION_SORT,
  PHONE_CARD_OMITTED_SORT_FIELDS,
  TRANSACTION_SORT_STORAGE_KEY,
  nextTransactionSort,
  resolveRegisterSort,
  type TransactionSort,
  type TransactionSortField,
} from '@/lib/transaction-sort';
import { useHiddenColumns } from '@/hooks/useHiddenColumns';
import { useRegisterPhoneCard } from '@/hooks/useRegisterPhoneCard';
import { BulkSelectionBanner } from '@/components/transactions/BulkSelectionBanner';
import { Account, isLiabilityAccountType } from '@/types/account';
import { Institution } from '@/types/institution';
import { Category } from '@/types/category';
import { Payee } from '@/types/payee';
import { Tag } from '@/types/tag';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { useTransactionsPanelCollapsed } from '@/hooks/useTransactionsPanelCollapsed';
import { ChartCollapseButton, CollapsedChartStrip } from '@/components/transactions/ChartCollapseControls';
import { useDateFormat } from '@/hooks/useDateFormat';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useAuthStore } from '@/store/authStore';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useFormModal } from '@/hooks/useFormModal';
import { useSwipeToPaginate } from '@/hooks/useSwipeToPaginate';
import { SWIPE_PAGINATE_ATTR } from '@/hooks/swipe-gesture';
import { AccountFormModal } from '@/components/accounts/AccountFormModal';
import { AccountInfoWidget } from '@/components/transactions/AccountInfoWidget';
import { PayeeInfoWidget } from '@/components/transactions/PayeeInfoWidget';
import { CategoryInfoWidget } from '@/components/transactions/CategoryInfoWidget';
import { WidgetFilterParams } from '@/components/transactions/widget-shared';
import { computeBalanceSummary } from '@/lib/balance-history';
import { ChevronDoubleRightIcon } from '@heroicons/react/24/outline';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { CARD_CLASS } from '@/components/ui/Card';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { createLogger } from '@/lib/logger';
import { showErrorToast } from '@/lib/errors';
import { exportToCsv } from '@/lib/csv-export';
import { afterModalHistoryPop } from '@/lib/after-modal-history-pop';
import { PAGE_SIZE } from '@/lib/constants';
import { budgetsApi } from '@/lib/budgets';
import { CategoryBudgetStatus } from '@/types/budget';
import { preferredCurrency } from '@/lib/default-currency';
import { ViewModeToggle } from '@/components/ui/ViewModeToggle';
import { useViewMode } from '@/store/viewModeStore';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { docsUrl } from '@/lib/docs-links';

const logger = createLogger('Transactions');

/**
 * The entity behind the info widget beside the chart. Kept in state so the
 * last single-filtered entity stays mounted through the slide-out animation
 * when the filter widens. Precedence when several are single: payee, then
 * category, then account (matching the chart, which switches to the
 * category/payee bar chart whenever those filters are active).
 */
type RetainedWidget =
  | { kind: 'payee'; payee: Payee }
  | { kind: 'category'; category: Category }
  | { kind: 'account'; account: Account; currentBalance?: number };

export default function TransactionsPage() {
  return (
    <ProtectedRoute>
      <TransactionsContent />
    </ProtectedRoute>
  );
}

function TransactionsContent() {
  const t = useTranslations('transactions');
  const tc = useTranslations('common');
  const router = useRouter();
  const { formatDate } = useDateFormat();
  const weekStartsOn = (usePreferencesStore((s) => s.preferences?.weekStartsOn) ?? 1) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  const defaultCurrency = preferredCurrency(
    usePreferencesStore((s) => s.preferences?.defaultCurrency),
  );
  const { convertToDefault } = useExchangeRates();
  // An acting delegate never adds a warranty: every warranty write is the
  // owner's.
  const actingAsDelegate = useAuthStore((s) => s.actingAsUserId) !== null;
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  // Joint accounts: effective write permissions per shared account, used to
  // hide edit/delete affordances the grant does not cover.
  const jointPermissionsByAccount = useMemo(() => {
    const map = new Map<
      string,
      { canCreate: boolean; canEdit: boolean; canDelete: boolean }
    >();
    for (const a of accounts) {
      if (a.isJoint && a.jointPermissions) map.set(a.id, a.jointPermissions);
    }
    return map;
  }, [accounts]);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [scheduledTransactions, setScheduledTransactions] = useState<ScheduledTransaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [dailyBalances, setDailyBalances] = useState<Array<{ date: string; balance: number; accountId: string; currencyCode: string }>>([]);
  const [monthlyTotals, setMonthlyTotals] = useState<MonthlyTotal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { showForm, editingItem: editingTransaction, openCreate, openEdit, close, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef } = useFormModal<Transaction>();
  const { view, setView } = useViewMode('transactions');
  const financialToday = useFinancialToday();
  // The day a create was started from, when the calendar's "New transaction on
  // this day" started it. Undefined everywhere else, so the register's New
  // button keeps the remembered date it has always opened on.
  const [createOnDate, setCreateOnDate] = useState<string | undefined>(undefined);
  // Separate modal instances for editing the account/category behind a
  // single-entity filter, reusing the same forms as their own pages.
  const accountModal = useFormModal<Account>();
  const categoryModal = useFormModal<Category>();
  const [duplicatingFrom, setDuplicatingFrom] = useState<Transaction | undefined>();
  const [schedulingFrom, setSchedulingFrom] = useState<Transaction | undefined>();
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [showPayeeForm, setShowPayeeForm] = useState(false);
  const [editingPayee, setEditingPayee] = useState<Payee | undefined>();
  const [accountWidgetCollapsed, setAccountWidgetCollapsed] = useTransactionsPanelCollapsed('accountWidget');
  const [payeeWidgetCollapsed, setPayeeWidgetCollapsed] = useTransactionsPanelCollapsed('payeeWidget');
  const [categoryWidgetCollapsed, setCategoryWidgetCollapsed] = useTransactionsPanelCollapsed('categoryWidget');
  // The chart band (the chart and any info widget beside it) folds into one
  // strip; each widget keeps its own state for when the band comes back.
  const [chartCollapsed, setChartCollapsed] = useTransactionsPanelCollapsed('chart');
  const collapseChart = useCallback(() => setChartCollapsed(true), [setChartCollapsed]);
  const expandChart = useCallback(() => setChartCollapsed(false), [setChartCollapsed]);
  const [showBulkUpdate, setShowBulkUpdate] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [bulkSelectMode, setBulkSelectMode] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  // Ref to track whether any modal is open (used by popstate handler to avoid conflicts)
  const modalOpenRef = useRef(false);
  const anyModalOpen = showForm || showScheduleForm || showPayeeForm || showBulkUpdate || showBulkDeleteConfirm;
  useLayoutEffect(() => {
    modalOpenRef.current = anyModalOpen;
  });

  const filters = useTransactionFilters({ accounts, categories, payees, tags, weekStartsOn });
  // The hook's refs under local names, so they are written as refs rather than
  // as fields of the hook's return value, which must not be modified.
  const {
    isFilterChange: isFilterChangeRef,
    targetTransactionIdRef,
    syncingFromPopstateRef,
    filterDebounceRef,
  } = filters;
  // Which register rows are overdue for reconciliation. Undefined until known,
  // and left undefined on failure, so a lookup that did not answer marks no row.

  // Accounts every query should cover: an explicit account filter wins;
  // otherwise narrow to filteredAccounts (which strips brokerage and honours
  // the Active/Closed/All toggle). Without this, the "All" toggle would let
  // queries include brokerage accounts whose balances are not actionable
  // from the Transactions page.
  const accountIdsForQuery = useMemo(() => {
    if (filters.filterAccountIds.length > 0) return filters.filterAccountIds;
    if (filters.filteredAccounts.length > 0) return filters.filteredAccounts.map(a => a.id);
    return undefined;
  }, [filters.filterAccountIds, filters.filteredAccounts]);

  /**
   * What the calendar asks the register for: every filter the page holds
   * except the date range, which in calendar mode is the month on screen
   * (design decision 2). Derived from the same filter state the table's own
   * request reads, so the two cannot drift.
   */
  const calendarFilters = useMemo(
    () => ({
      accountIds: accountIdsForQuery,
      categoryIds: filters.filterCategoryIds.length > 0 ? filters.filterCategoryIds : undefined,
      payeeIds: filters.filterPayeeIds.length > 0 ? filters.filterPayeeIds : undefined,
      tagIds: filters.filterTagIds.length > 0 ? filters.filterTagIds : undefined,
      search: filters.filterSearch || undefined,
      amountFrom: filters.filterAmountFrom ? parseFloat(filters.filterAmountFrom) : undefined,
      amountTo: filters.filterAmountTo ? parseFloat(filters.filterAmountTo) : undefined,
      statuses: filters.filterStatuses.length > 0 ? filters.filterStatuses : undefined,
      originalCurrencyCodes:
        filters.filterOriginalCurrencyCodes.length > 0
          ? filters.filterOriginalCurrencyCodes
          : undefined,
      tagKey: filters.filterTagKey || undefined,
      tagKeyOp: filters.filterTagKeyOp,
      tagKeyValue: filters.filterTagKeyValue || undefined,
      hasAttachments:
        filters.filterHasAttachments === ''
          ? undefined
          : filters.filterHasAttachments === 'yes',
    }),
    [
      accountIdsForQuery,
      filters.filterCategoryIds,
      filters.filterPayeeIds,
      filters.filterTagIds,
      filters.filterSearch,
      filters.filterAmountFrom,
      filters.filterAmountTo,
      filters.filterStatuses,
      filters.filterOriginalCurrencyCodes,
      filters.filterTagKey,
      filters.filterTagKeyOp,
      filters.filterTagKeyValue,
      filters.filterHasAttachments,
    ],
  );


  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [startingBalance, setStartingBalance] = useState<number | undefined>();
  const [startingBalanceWithheld, setStartingBalanceWithheld] = useState<'sort' | undefined>();
  // How the server read the search, kept with the search string that produced
  // it so a reply for an earlier string is never shown under a newer one.
  const [searchEcho, setSearchEcho] = useState<{
    search: string;
    interpretation: SearchInterpretation | undefined;
  } | null>(null);
  // The order the rows currently on screen came back in. Held beside them
  // rather than read from the live sort, so a click that has not been answered
  // yet cannot make the register reinterpret the page it is still showing.
  const [rowsSort, setRowsSort] = useState<TransactionSort>(DEFAULT_TRANSACTION_SORT);

  // Which column the register is sorted by, remembered in this browser the way
  // the row density and the table/calendar view are. It is part of the request
  // key, not a filter: changing it re-asks the server (through the same
  // debounced reload a filter change takes) and returns to page 1, because
  // page 3 of one order is a different set of rows from page 3 of another.
  const { sortField, sortDirection, setSort } = useSortableTable<TransactionSortField>(
    TRANSACTION_SORT_STORAGE_KEY,
    DEFAULT_TRANSACTION_SORT,
  );
  const isSingleAccountView = filters.filterAccountIds.length === 1;
  const storedSort = useMemo<TransactionSort>(
    () => ({ field: sortField, direction: sortDirection }),
    [sortField, sortDirection],
  );
  // The Account column is not drawn on a single account's page, so a
  // remembered account sort would order the register by a header nobody can
  // reach. Storage is left alone: widening the filter brings it back. A column
  // the reader has hidden is the same shape (the register reads the same
  // stored set), and showing it again brings that sort back. A description or
  // ref # sort is the same while the phone card is drawn: the card shows
  // neither, and its sort strip offers no chip for them.
  const { hidden: hiddenColumns } = useHiddenColumns('transactions');
  const phoneCard = useRegisterPhoneCard('transactions', false);
  const registerSort = useMemo(
    () => resolveRegisterSort(storedSort, isSingleAccountView, hiddenColumns, phoneCard),
    [storedSort, isSingleAccountView, hiddenColumns, phoneCard],
  );
  // Whether the phone card is what holds the remembered sort back. A layout
  // switch (a phone's density, a window crossing `sm`) changes the resolved
  // sort with no click and so no tick, so the reload effect watches this too
  // and reads a switch as a new order, from page 1.
  const phoneCardHoldsSortBack =
    phoneCard && PHONE_CARD_OMITTED_SORT_FIELDS.has(storedSort.field);
  const phoneCardHoldsSortBackRef = useRef(phoneCardHoldsSortBack);
  // The loader reads the sort from here rather than closing over it, so
  // remembering a deep link's fallback order does not re-run the reload effect
  // and fire a second read for the same click. Every other thing the effect
  // watches is a filter it already depends on, so a sort change needs its own
  // trigger: the register is already on page 1 half the time, and nothing else
  // in the dependency list moves.
  const registerSortRef = useRef(registerSort);
  // Declared before the effects that read it, so they see this render's sort.
  useLayoutEffect(() => {
    registerSortRef.current = registerSort;
  });
  const [sortRequestTick, setSortRequestTick] = useState(0);
  // Which register read is the newest; only that one may write state.
  const requestSeqRef = useRef(0);

  const handleSortChange = useCallback(
    (field: TransactionSortField) => {
      isFilterChangeRef.current = true;
      // Toggled from the sort the header is DISPLAYING, not the one in
      // storage. They differ where a remembered account sort has been resolved
      // away on a single account's page, and toggling from the stored one
      // there returns exactly what is already on screen: a click that moves no
      // arrow, reverses nothing, and still drops the reader back to page 1.
      setSort(nextTransactionSort(registerSort, field));
      setSortRequestTick((tick) => tick + 1);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registerSort, setSort],
  );

  // A horizontal finger swipe on the register turns its page in place, so a
  // long list can be paged without scrolling to the pager. The zone owns the
  // horizontal swipe only when there is more than one page; a single-page
  // register yields it back to view navigation (SwipeShell).
  const { swipeRef, paginates } = useSwipeToPaginate({
    page: filters.currentPage,
    totalPages: pagination?.totalPages ?? 1,
    onPageChange: filters.goToPage,
  });

  // Bumped after every transaction reload so the entity info widgets (which
  // fetch their own summaries) refetch in lockstep with the chart and list,
  // instead of showing a stale count after a mutation, undo/redo, or AI write
  // until a full page refresh.
  const [reloadKey, setReloadKey] = useState(0);

  // Budget context for category indicators
  const [budgetStatusMap, setBudgetStatusMap] = useState<Record<string, CategoryBudgetStatus>>({});

  // Track if static data has been loaded
  const staticDataLoaded = useRef(false);

  // Load static data (accounts, categories, payees) - only runs once
  const loadStaticData = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      if (staticDataLoaded.current) return;
      try {
        const [accountsData, categoriesData, payeesData, tagsData, institutionsData, scheduledData] = await Promise.all([
          accountsApi.getAll(true),
          categoriesApi.getAll(),
          payeesApi.getAll(),
          tagsApi.getAll(),
          institutionsApi.getAll().catch(() => [] as Institution[]),
          scheduledTransactionsApi.getAll().catch(() => [] as ScheduledTransaction[]),
        ]);
        setAccounts(accountsData);
        setCategories(categoriesData);
        setPayees(payeesData);
        setTags(tagsData);
        setInstitutions(institutionsData);
        setScheduledTransactions(scheduledData);
        staticDataLoaded.current = true;
      } catch (error) {
        showErrorToast(error, t('toasts.loadFormDataFailed'));
        logger.error(error);
      }
    };
    return run();
  }, [t]);

  // Load transaction data and chart data in parallel
  const loadTransactions = useCallback((page: number) => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      const safePage = (!page || page < 1) ? 1 : page;
      // Which request this is. Two header clicks further apart than the debounce
      // put two register reads in flight, and without a sequence the display is
      // whichever one answered last rather than the one the reader asked for
      // last: amount-ordered rows under a Payee header, or page 1 over the page
      // a deep link had just resolved. Only the newest request may write state.
      const seq = ++requestSeqRef.current;
      const isCurrentRequest = () => seq === requestSeqRef.current;
      // Read, not consumed: the target is cleared only once the reply that
      // carried it is adopted (below). On a cold load the accounts arrive while
      // this read is in flight, the account scope changes and a newer read
      // supersedes this one; consuming the target here sent that newer read
      // without it, so the register stayed on page 1 and the row the link
      // pointed at was never shown.
      const targetTransactionId = targetTransactionIdRef.current;
      try {
        // A row's page is counted by comparing it with the register's order, and
        // only the date order has a comparison to make -- the server refuses the
        // pair outright. Arriving at a row therefore drops back to the date
        // order, keeping the direction, exactly as it already drops the filters
        // that would have hidden the row. Remembering it too keeps the headers
        // agreeing with the rows.
        //
        // Read from a ref rather than closed over, so that `setSort` below does
        // not change this callback's identity: it would re-run the reload effect
        // and fire a second register read for the same click, this time with the
        // target already consumed, racing the page the first one resolved.
        let effectiveSort = registerSortRef.current;
        if (targetTransactionId && effectiveSort.field !== 'date') {
          effectiveSort = { field: 'date', direction: effectiveSort.direction };
          setSort(effectiveSort);
        }

        const hasCategoryOrPayeeFilter = filters.filterCategoryIds.length > 0 || filters.filterPayeeIds.length > 0 || filters.filterTagIds.length > 0 || filters.filterSearch.length > 0;

        const chartParams: { startDate?: string; endDate?: string; accountIds?: string; allTime?: boolean } = {};
        if (filters.filterStartDate) chartParams.startDate = filters.filterStartDate;
        if (filters.filterEndDate) chartParams.endDate = filters.filterEndDate;
        // With no start-date filter the transaction list shows the account's full
        // history, so the Balance History chart should span it too (downsampled
        // server-side) rather than the backend's default one-year window.
        if (!filters.filterStartDate) chartParams.allTime = true;
        // Mirror the Show Accounts filter (Active/Closed/All) into the chart query
        // so the Account Balances and Balance History charts only include accounts
        // that the transaction list is actually showing.
        if (accountIdsForQuery) chartParams.accountIds = accountIdsForQuery.join(',');

        const parsedAmountFrom = filters.filterAmountFrom ? parseFloat(filters.filterAmountFrom) : undefined;
        const parsedAmountTo = filters.filterAmountTo ? parseFloat(filters.filterAmountTo) : undefined;

        const chartPromise = hasCategoryOrPayeeFilter
          ? transactionsApi.getMonthlyTotals({
              accountIds: accountIdsForQuery,
              startDate: filters.filterStartDate || undefined,
              endDate: filters.filterEndDate || undefined,
              categoryIds: filters.filterCategoryIds.length > 0 ? filters.filterCategoryIds : undefined,
              payeeIds: filters.filterPayeeIds.length > 0 ? filters.filterPayeeIds : undefined,
              tagIds: filters.filterTagIds.length > 0 ? filters.filterTagIds : undefined,
              search: filters.filterSearch || undefined,
              amountFrom: parsedAmountFrom,
              amountTo: parsedAmountTo,
            }).catch(() => [] as MonthlyTotal[])
          : accountsApi.getDailyBalances(
              Object.keys(chartParams).length > 0 ? chartParams : undefined,
            ).catch(() => [] as Array<{ date: string; balance: number; accountId: string; currencyCode: string }>);

        const requestedSearch = filters.filterSearch;
        const [transactionsResponse, chartResult] = await Promise.all([
          transactionsApi.getAll({
            accountIds: accountIdsForQuery,
            startDate: filters.filterStartDate || undefined,
            endDate: filters.filterEndDate || undefined,
            categoryIds: filters.filterCategoryIds.length > 0 ? filters.filterCategoryIds : undefined,
            payeeIds: filters.filterPayeeIds.length > 0 ? filters.filterPayeeIds : undefined,
            tagIds: filters.filterTagIds.length > 0 ? filters.filterTagIds : undefined,
            search: filters.filterSearch || undefined,
            page: safePage,
            limit: PAGE_SIZE,
            targetTransactionId: targetTransactionId || undefined,
            sortBy: effectiveSort.field,
            sortDirection: effectiveSort.direction,
            amountFrom: parsedAmountFrom,
            amountTo: parsedAmountTo,
            statuses: filters.filterStatuses.length > 0 ? filters.filterStatuses : undefined,
            originalCurrencyCodes: filters.filterOriginalCurrencyCodes.length > 0 ? filters.filterOriginalCurrencyCodes : undefined,
            tagKey: filters.filterTagKey || undefined,
            tagKeyOp: filters.filterTagKeyOp,
            tagKeyValue: filters.filterTagKeyValue || undefined,
            hasAttachments:
              filters.filterHasAttachments === ''
                ? undefined
                : filters.filterHasAttachments === 'yes',
          }),
          chartPromise,
        ]);

        // A reply that a newer request has already superseded is discarded whole
        // -- rows, pagination, balance, order and charts together -- rather than
        // written over half of the newer one's state.
        if (!isCurrentRequest()) return;

        // A newer deep link may have replaced the target while this read was in
        // flight; that one is still owed its own read.
        if (targetTransactionId && targetTransactionIdRef.current === targetTransactionId) {
          targetTransactionIdRef.current = null;
        }

        setTransactions(transactionsResponse.data);
        setPagination(transactionsResponse.pagination);
        setStartingBalance(transactionsResponse.startingBalance);
        // Adopted with the rows and the balance it belongs to: a reload that
        // keeps the rows has to keep the reason the balance is missing too.
        setStartingBalanceWithheld(transactionsResponse.startingBalanceWithheld);
        setSearchEcho({
          search: requestedSearch,
          interpretation: transactionsResponse.searchInterpretation,
        });
        // The order these rows were fetched in, adopted with them. The headers
        // moved the moment the reader clicked; the running balance, the today
        // divider and the Balance column itself must not, because they are
        // statements about rows that still belong to the previous request.
        setRowsSort(effectiveSort);

        if (hasCategoryOrPayeeFilter) {
          setMonthlyTotals(chartResult as MonthlyTotal[]);
          setDailyBalances([]);
        } else {
          setDailyBalances(chartResult as Array<{ date: string; balance: number; accountId: string; currencyCode: string }>);
          setMonthlyTotals([]);
        }

        if (targetTransactionId && transactionsResponse.pagination.page !== safePage) {
          filters.setCurrentPage(transactionsResponse.pagination.page);
        }

        // Fetch budget status for visible categories (non-blocking)
        const categoryIds = [
          ...new Set(
            transactionsResponse.data
              .filter((t) => t.category?.id && !t.isTransfer)
              .map((t) => t.category!.id),
          ),
        ];
        if (categoryIds.length > 0) {
          budgetsApi.getCategoryBudgetStatus(categoryIds).then(setBudgetStatusMap).catch(() => {});
        }
      } catch (error) {
        // A superseded request's failure is not this register's failure: the
        // reader is waiting on a newer one, and a toast for the one they
        // abandoned only tells them something is broken that is not.
        if (!isCurrentRequest()) return;
        // A target the newest read failed on is dropped, as before, so every
        // later read does not repeat the same failing request.
        if (targetTransactionIdRef.current === targetTransactionId) {
          targetTransactionIdRef.current = null;
        }
        showErrorToast(error, t('toasts.loadFailed'));
        logger.error(error);
      } finally {
        if (isCurrentRequest()) {
          setIsLoading(false);
          // Signal the entity info widgets to refetch their summaries in lockstep
          // with the freshly loaded chart/list data.
          setReloadKey((k) => k + 1);
        }
      }
    };
    return run();
  }, [accountIdsForQuery, filters.filterAccountStatus, filters.filterCategoryIds, filters.filterPayeeIds, filters.filterTagIds, filters.filterStartDate, filters.filterEndDate, filters.filterSearch, filters.filterAmountFrom, filters.filterAmountTo, filters.filterStatuses, filters.filterOriginalCurrencyCodes, filters.filterTagKey, filters.filterTagKeyOp, filters.filterTagKeyValue, filters.filterHasAttachments, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadData = useCallback(async (page: number = filters.currentPage) => {
    await loadTransactions(page);
  }, [filters.currentPage, loadTransactions]);

  const loadAllData = useCallback(async (page: number = filters.currentPage) => {
    staticDataLoaded.current = false;
    loadStaticData();
    await loadTransactions(page);
  }, [filters.currentPage, loadStaticData, loadTransactions]);

  // After undo/redo, just reset static data so next load refreshes everything.
  // Bump a counter to trigger the filter useEffect which handles the actual reload.
  const [undoRedoTick, setUndoRedoTick] = useState(0);
  const handleUndoRedo = useCallback(() => {
    staticDataLoaded.current = false;
    setUndoRedoTick((t) => t + 1);
  }, []);
  useOnUndoRedo(handleUndoRedo);
  // An AI write (e.g. a transaction created from the chat bubble) mutates the
  // same data as an undo/redo, so refresh the list the same way.
  useOnAiAction(handleUndoRedo);

  // Load static data once on mount
  useEffect(() => {
    loadStaticData();
  }, [loadStaticData]);

  // Update URL and load transactions when page or filters change
  useEffect(() => {
    // Tracked even before the filters are ready, so only a switch after the
    // first load counts as a new order.
    const sortLayoutChanged = phoneCardHoldsSortBackRef.current !== phoneCardHoldsSortBack;
    phoneCardHoldsSortBackRef.current = phoneCardHoldsSortBack;
    if (!filters.filtersInitialized) return;
    if (sortLayoutChanged) isFilterChangeRef.current = true;

    // Reload static data if invalidated (e.g. after undo/redo)
    loadStaticData();

    const page = isFilterChangeRef.current ? 1 : filters.currentPage;
    const wasFilterChange = isFilterChangeRef.current;
    if (isFilterChangeRef.current) {
      filters.setCurrentPage(1);
      isFilterChangeRef.current = false;
    }

    if (syncingFromPopstateRef.current) {
      syncingFromPopstateRef.current = false;
    } else {
      filters.updateUrl(page, {
        accountIds: filters.filterAccountIds,
        categoryIds: filters.filterCategoryIds,
        payeeIds: filters.filterPayeeIds,
        tagIds: filters.filterTagIds,
        startDate: filters.filterStartDate,
        endDate: filters.filterEndDate,
        search: filters.filterSearch,
        amountFrom: filters.filterAmountFrom,
        amountTo: filters.filterAmountTo,
        statuses: filters.filterStatuses,
        originalCurrencyCodes: filters.filterOriginalCurrencyCodes,
        tagKey: filters.filterTagKey,
        tagKeyOp: filters.filterTagKeyOp,
        tagKeyValue: filters.filterTagKeyValue,
        hasAttachments: filters.filterHasAttachments,
      }, wasFilterChange);
    }

    if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
    if (wasFilterChange) {
      filterDebounceRef.current = setTimeout(() => {
        loadTransactions(page);
      }, 150);
    } else {
      loadTransactions(page);
    }
  }, [filters.currentPage, filters.filterAccountIds, filters.filterCategoryIds, filters.filterPayeeIds, filters.filterTagIds, filters.filterStartDate, filters.filterEndDate, filters.filterSearch, filters.filterAmountFrom, filters.filterAmountTo, filters.filterStatuses, filters.filterOriginalCurrencyCodes, filters.filterTagKey, filters.filterTagKeyOp, filters.filterTagKeyValue, filters.filterHasAttachments, filters.updateUrl, loadTransactions, filters.filtersInitialized, undoRedoTick, sortRequestTick, phoneCardHoldsSortBack]); // eslint-disable-line react-hooks/exhaustive-deps

  // Once the deep-linked transaction is actually on the page, let the flash
  // linger briefly then clear it, so the highlight does not stick around on
  // later interactions.
  useEffect(() => {
    const id = filters.highlightTransactionId;
    if (!id || !transactions.some((tx) => tx.id === id)) return;
    const timer = setTimeout(() => filters.setHighlightTransactionId(null), 5000);
    return () => clearTimeout(timer);
  }, [transactions, filters.highlightTransactionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Patch popstate handler to skip when modals open
  useEffect(() => {
    const origHandler = (_e: PopStateEvent) => {
      if (modalOpenRef.current) return;
      // The popstate handler in the hook runs separately
    };
    window.addEventListener('popstate', origHandler);
    return () => window.removeEventListener('popstate', origHandler);
  }, []);

  const handleCreateNew = () => {
    setCreateOnDate(undefined);
    openCreate();
  };

  const handleCreateOnDay = (date: string) => {
    setCreateOnDate(date);
    openCreate();
  };

  const handleEdit = async (transaction: Transaction) => {
    if (transaction.linkedInvestmentTransactionId) {
      toast(t('page.toasts.investmentLinked'));
      router.push(`/investments?edit=${transaction.linkedInvestmentTransactionId}`);
      return;
    }
    if (transaction.isTransfer || transaction.isSplit) {
      try {
        const fullTransaction = await transactionsApi.getById(transaction.id);
        // The register row's warranty count is a list-only field; the form's
        // Warranties line reads it to decide whether to fetch the list.
        openEdit({ ...fullTransaction, warrantyCount: transaction.warrantyCount });
      } catch (error) {
        logger.error('Failed to load transaction details:', error);
        openEdit(transaction);
      }
    } else {
      openEdit(transaction);
    }
  };

  const handleDuplicate = async (transaction: Transaction) => {
    if (transaction.linkedInvestmentTransactionId) return;
    if (transaction.isTransfer || transaction.isSplit) {
      try {
        const fullTransaction = await transactionsApi.getById(transaction.id);
        setDuplicatingFrom(fullTransaction);
      } catch (error) {
        logger.error('Failed to load transaction details for duplication:', error);
        setDuplicatingFrom(transaction);
      }
    } else {
      setDuplicatingFrom(transaction);
    }
    openCreate();
  };

  const handleScheduleRecurring = async (transaction: Transaction) => {
    if (transaction.linkedInvestmentTransactionId) return;
    if (transaction.isTransfer || transaction.isSplit) {
      try {
        const fullTransaction = await transactionsApi.getById(transaction.id);
        setSchedulingFrom(fullTransaction);
      } catch (error) {
        logger.error('Failed to load transaction details for scheduling:', error);
        setSchedulingFrom(transaction);
      }
    } else {
      setSchedulingFrom(transaction);
    }
    setShowScheduleForm(true);
  };

  // Add warranty, or a linked warranty, from inside the edit window leaves the
  // page, so it goes through the window's own close: a dirty form asks first
  // (Save, Discard or keep editing) and the navigation waits on the answer. It
  // also waits for the closed Modal's history entry to be popped, which would
  // otherwise undo the push; a fixed delay lost that race on a slow render. A
  // bare link in the window is undone the same way, which is why the
  // Warranties line hands its links here too.
  const pendingFormNavigation = useRef<string | null>(null);
  const navigateAfterFormCloses = (href: string) => {
    afterModalHistoryPop(() => router.push(href));
  };

  const navigateFromForm = (href: string) => {
    if (modalProps.onBeforeClose() === false) {
      pendingFormNavigation.current = href;
      return;
    }
    handleClose();
    navigateAfterFormCloses(href);
  };

  const handleAddWarrantyFromForm = (transaction: Transaction) => {
    navigateFromForm(`/warranties?new=1&transactionId=${transaction.id}`);
  };

  // A new transaction's Add arrives once the form has saved it, so there is
  // nothing unsaved to ask about, and no register to refresh behind a page
  // that is about to be left: close and go on to the warranty.
  const handleAddWarrantyAfterCreate = (created: Transaction) => {
    handleClose();
    navigateAfterFormCloses(`/warranties?new=1&transactionId=${created.id}`);
  };

  const handleOpenWarrantyFromForm = (warrantyId: string) => {
    navigateFromForm(`/warranties/${warrantyId}`);
  };

  /** The navigation a dirty form's dialog was holding, now that it may go. */
  const releaseFormNavigation = () => {
    const href = pendingFormNavigation.current;
    pendingFormNavigation.current = null;
    if (href !== null) navigateAfterFormCloses(href);
  };

  const handleScheduleFormSuccess = () => {
    setSchedulingFrom(undefined);
    setShowScheduleForm(false);
    toast.success(t('page.toasts.scheduledCreated'));
  };

  const handleScheduleFormClose = () => {
    setSchedulingFrom(undefined);
    setShowScheduleForm(false);
  };

  const handleClose = () => {
    pendingFormNavigation.current = null;
    setDuplicatingFrom(undefined);
    close();
  };

  const [formKey, setFormKey] = useState(0);

  const handleFormSuccess = () => {
    setDuplicatingFrom(undefined);
    close();
    setFormKey(prev => prev + 1);
    loadData();
    // Save from the unsaved-changes dialog: the edits are kept, and the
    // navigation that asked for the close goes ahead.
    releaseFormNavigation();
  };

  // "Create & New" keeps the window open and the form resets itself, so the
  // page only refreshes the register behind it. Deliberately no state change
  // here: `duplicatingFrom` and `formKey` both feed the form's key, and
  // touching either would remount the form the user is still typing in.
  const handleCreateAndNew = () => {
    loadData();
  };

  // A payee name in a row opens that payee's page. Editing the payee lives
  // there (and on the payee info widget's pencil), so the row's primary click
  // goes to the fuller view rather than straight into a form.
  const handlePayeeView = (payeeId: string) => {
    router.push(`/payees/${payeeId}`);
  };

  const handlePayeeClick = async (payeeId: string) => {
    try {
      const payee = await payeesApi.getById(payeeId);
      setEditingPayee(payee);
      setShowPayeeForm(true);
    } catch (error) {
      showErrorToast(error, t('toasts.loadPayeeFailed'));
      logger.error(error);
    }
  };

  const handlePayeeFormSubmit = async (data: any) => {
    if (!editingPayee) return;
    try {
      const cleanedData = {
        ...data,
        defaultCategoryId: data.defaultCategoryId || undefined,
        notes: data.notes || undefined,
      };
      const updated = await payeesApi.update(editingPayee.id, cleanedData);
      toast.success(t('toasts.payeeUpdated'));
      setShowPayeeForm(false);
      setEditingPayee(undefined);
      setPayees(prev => prev.map(p => p.id === updated.id ? updated : p));
    } catch (error) {
      showErrorToast(error, t('toasts.payeeUpdateFailed'));
    }
  };

  const handlePayeeFormCancel = () => {
    setShowPayeeForm(false);
    setEditingPayee(undefined);
  };

  const handleCategoryFormSubmit = async (data: any) => {
    if (!categoryModal.editingItem) return;
    try {
      const cleanedData = {
        ...data,
        parentId: data.parentId || null,
        description: data.description || null,
        icon: data.icon || null,
        color: data.color || null,
      };
      await categoriesApi.update(categoryModal.editingItem.id, cleanedData);
      toast.success(t('toasts.categoryUpdated'));
      categoryModal.close();
      // Refetch rather than patch: effectiveColor is computed server-side
      // and a parent change can affect other rows' inherited colors.
      const refreshed = await categoriesApi.getAll().catch(() => null);
      if (refreshed) setCategories(refreshed);
    } catch (error) {
      showErrorToast(error, t('toasts.categoryUpdateFailed'));
      throw error;
    }
  };

  const handleTransactionUpdate = useCallback((updatedTransaction: Transaction) => {
    setTransactions(prev =>
      prev.map(tx => tx.id === updatedTransaction.id
        ? {
            ...updatedTransaction,
            // Enrichment fields the single-transaction endpoints do not return.
            linkedInvestmentTransactionId: updatedTransaction.linkedInvestmentTransactionId ?? tx.linkedInvestmentTransactionId,
            attachmentCount: updatedTransaction.attachmentCount ?? tx.attachmentCount,
          }
        : tx
      )
    );
  }, []);

  // Build current filters for bulk update selection
  const bulkUpdateFilters = useMemo((): BulkUpdateFilters => {
    const f: BulkUpdateFilters = {};
    if (filters.filterAccountIds.length > 0) {
      f.accountIds = filters.filterAccountIds;
    } else if (filters.filteredAccounts.length > 0) {
      f.accountIds = filters.filteredAccounts.map(a => a.id);
    }
    if (filters.filterCategoryIds.length > 0) f.categoryIds = filters.filterCategoryIds;
    if (filters.filterPayeeIds.length > 0) f.payeeIds = filters.filterPayeeIds;
    if (filters.filterTagIds.length > 0) f.tagIds = filters.filterTagIds;
    if (filters.filterStartDate) f.startDate = filters.filterStartDate;
    if (filters.filterEndDate) f.endDate = filters.filterEndDate;
    if (filters.filterSearch) f.search = filters.filterSearch;
    if (filters.filterAmountFrom) f.amountFrom = parseFloat(filters.filterAmountFrom);
    if (filters.filterAmountTo) f.amountTo = parseFloat(filters.filterAmountTo);
    return f;
  }, [filters.filterAccountIds, filters.filteredAccounts, filters.filterCategoryIds, filters.filterPayeeIds, filters.filterTagIds, filters.filterStartDate, filters.filterEndDate, filters.filterSearch, filters.filterAmountFrom, filters.filterAmountTo]);

  // Derive chart currency, aggregated per-date balances, and latest per-account balances
  const { chartBalances, chartCurrency, accountBalances, accountCount } = useMemo(() => {
    if (dailyBalances.length === 0) {
      return {
        chartBalances: [] as Array<{ date: string; balance: number }>,
        chartCurrency: defaultCurrency,
        accountBalances: [] as Array<{ accountId: string; accountName: string; balance: number }>,
        accountCount: 0,
      };
    }

    const currencies = new Set(dailyBalances.map((r) => r.currencyCode));
    const isSingleCurrency = currencies.size === 1;
    const displayCurrency = isSingleCurrency ? [...currencies][0] : defaultCurrency;

    // A day whose total needs a rate we do not have has an unknown balance, not a
    // smaller one. `null` marks the gap so the line breaks there rather than
    // drawing a straight segment through it (`connectNulls={false}`).
    const byDate = new Map<string, number | null>();
    const latestByAccount = new Map<string, { date: string; balance: number; currencyCode: string }>();
    for (const row of dailyBalances) {
      const amount = isSingleCurrency
        ? row.balance
        : convertToDefault(row.balance, row.currencyCode);
      const running = byDate.get(row.date);
      byDate.set(
        row.date,
        amount === null || running === null ? null : (running ?? 0) + amount,
      );

      const existing = latestByAccount.get(row.accountId);
      if (!existing || existing.date < row.date) {
        latestByAccount.set(row.accountId, { date: row.date, balance: row.balance, currencyCode: row.currencyCode });
      }
    }

    const aggregated = [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, balance]) => ({ date, balance }));

    const accountNameById = new Map(accounts.map((a) => [a.id, a.name]));
    const perAccount = [...latestByAccount.entries()]
      .map(([accountId, info]) => ({
        accountId,
        accountName: accountNameById.get(accountId) ?? 'Unknown',
        balance: isSingleCurrency
          ? info.balance
          : convertToDefault(info.balance, info.currencyCode),
      }))
      // An unconvertible balance cannot be drawn as a bar, so it is left out
      // rather than shown at an arbitrary length.
      .filter((a): a is typeof a & { balance: number } => a.balance !== null)
      // Hide zero-balance accounts -- they add no information to the chart.
      // Compare at 4-decimal precision to match decimal(20,4) storage.
      .filter((a) => Math.round(a.balance * 10000) !== 0)
      .sort((a, b) => b.balance - a.balance);

    return { chartBalances: aggregated, chartCurrency: displayCurrency, accountBalances: perAccount, accountCount: latestByAccount.size };
  }, [dailyBalances, accounts, defaultCurrency, convertToDefault]);

  // Label appended to the Monthly Totals download filename so it reflects
  // which category/payee/tag/search the chart is scoped to. When a full list
  // of names would push the filename past MAX_FILENAME_LENGTH we collapse
  // any multi-selection into a "multiple X" descriptor while keeping single
  // selections as-is, so a user with one specific category plus many payees
  // still sees the category name in the filename.
  const monthlyTotalsFilterLabel = useMemo(() => {
    const MAX_FILENAME_LENGTH = 100;
    const FILENAME_PREFIX = 'Monthly Totals - ';

    const cats = filters.selectedCategories.map((c) => c.name);
    const pays = filters.selectedPayees.map((p) => p.name);
    const tgs = filters.selectedTags.map((t) => t.name);
    const search = filters.filterSearch ? [`"${filters.filterSearch}"`] : [];

    if (cats.length + pays.length + tgs.length + search.length === 0) return undefined;

    const preferred = [...cats, ...pays, ...tgs, ...search].join(', ');
    if ((FILENAME_PREFIX + preferred).length <= MAX_FILENAME_LENGTH) return preferred;

    const compactParts: string[] = [];
    if (cats.length === 1) compactParts.push(cats[0]);
    else if (cats.length > 1) compactParts.push('multiple categories');
    if (pays.length === 1) compactParts.push(pays[0]);
    else if (pays.length > 1) compactParts.push('multiple payees');
    if (tgs.length === 1) compactParts.push(tgs[0]);
    else if (tgs.length > 1) compactParts.push('multiple tags');
    if (search.length) compactParts.push(search[0]);
    return compactParts.join(', ');
  }, [filters.selectedCategories, filters.selectedPayees, filters.selectedTags, filters.filterSearch]);

  // Name of the single account behind the Balance History chart, used as the
  // download filename suffix. Falls back to the accounts list when there are
  // no chart rows yet but the user has narrowed down to one account.
  const balanceHistoryAccountName = useMemo(() => {
    if (accountBalances.length === 1) return accountBalances[0].accountName;
    if (filters.filterAccountIds.length === 1) {
      const id = filters.filterAccountIds[0];
      return accounts.find((a) => a.id === id)?.name;
    }
    return undefined;
  }, [accountBalances, filters.filterAccountIds, accounts]);

  // When the list is narrowed to exactly one account, surface that account so
  // its info widget can render beside the Account Balance chart.
  const singleFilteredAccount = useMemo(() => {
    if (filters.filterAccountIds.length !== 1) return undefined;
    const id = filters.filterAccountIds[0];
    return (
      filters.selectedAccounts.find((a) => a.id === id) ??
      accounts.find((a) => a.id === id)
    );
  }, [filters.filterAccountIds, filters.selectedAccounts, accounts]);

  // Selecting from the widget's caret is the same command as picking one
  // account in the Accounts filter, never `handleAccountFilterClick`, which
  // resets the Show Accounts toggle to All.
  const { handleArrayFilterChange, setFilterAccountIds } = filters;
  const handleWidgetAccountSwitch = useCallback(
    (accountId: string) => {
      handleArrayFilterChange(setFilterAccountIds, [accountId]);
    },
    [handleArrayFilterChange, setFilterAccountIds],
  );

  // The accounts list is fetched once per page load, so account.currentBalance
  // goes stale as transactions are added or edited. The daily-balance series is
  // refetched alongside the transactions, so the widget's balance is derived
  // from it — the exact figure the Balance History chart shows as "Current".
  const singleAccountCurrentBalance = useMemo(
    () => computeBalanceSummary(chartBalances)?.currentBalance,
    [chartBalances],
  );

  // When the list is narrowed to exactly one payee/category, surface it so
  // its info widget can render beside the chart. Deriving from the loaded
  // lists means the widget refreshes after an edit (the submit handlers
  // patch those lists). The category pseudo-filters aren't real entities,
  // so they render no widget.
  const singleFilteredPayee = useMemo(() => {
    if (filters.filterPayeeIds.length !== 1) return undefined;
    const id = filters.filterPayeeIds[0];
    return payees.find((p) => p.id === id);
  }, [filters.filterPayeeIds, payees]);

  const singleFilteredCategory = useMemo(() => {
    if (filters.filterCategoryIds.length !== 1) return undefined;
    const id = filters.filterCategoryIds[0];
    if (isSpecialCategoryFilterId(id)) return undefined;
    return categories.find((c) => c.id === id);
  }, [filters.filterCategoryIds, categories]);

  // The active page filters each widget forwards to its queries, minus the
  // widget's own entity id (each widget injects that itself).
  const widgetFilterParams = useMemo<WidgetFilterParams>(() => ({
    accountIds: accountIdsForQuery,
    startDate: filters.filterStartDate || undefined,
    endDate: filters.filterEndDate || undefined,
    tagIds: filters.filterTagIds.length > 0 ? filters.filterTagIds : undefined,
    search: filters.filterSearch || undefined,
    amountFrom: filters.filterAmountFrom ? parseFloat(filters.filterAmountFrom) : undefined,
    amountTo: filters.filterAmountTo ? parseFloat(filters.filterAmountTo) : undefined,
  }), [accountIdsForQuery, filters.filterStartDate, filters.filterEndDate, filters.filterTagIds, filters.filterSearch, filters.filterAmountFrom, filters.filterAmountTo]);

  // Retain the last single-filtered entity across the moment the filter
  // widens, so the widget can stay mounted and play the same slide-out
  // animation as the manual collapse instead of vanishing abruptly. Synced
  // with the "info from previous render" pattern (no setState in an effect).
  const [retainedWidget, setRetainedWidget] = useState<RetainedWidget | undefined>();
  if (singleFilteredPayee) {
    if (retainedWidget?.kind !== 'payee' || retainedWidget.payee !== singleFilteredPayee) {
      setRetainedWidget({ kind: 'payee', payee: singleFilteredPayee });
    }
  } else if (singleFilteredCategory) {
    if (retainedWidget?.kind !== 'category' || retainedWidget.category !== singleFilteredCategory) {
      setRetainedWidget({ kind: 'category', category: singleFilteredCategory });
    }
  } else if (singleFilteredAccount) {
    if (
      retainedWidget?.kind !== 'account' ||
      retainedWidget.account !== singleFilteredAccount ||
      retainedWidget.currentBalance !== singleAccountCurrentBalance
    ) {
      setRetainedWidget({
        kind: 'account',
        account: singleFilteredAccount,
        currentBalance: singleAccountCurrentBalance,
      });
    }
  }
  const widgetAccount = retainedWidget?.kind === 'account' ? retainedWidget.account : undefined;

  const widgetInstitution = useMemo(() => {
    if (!widgetAccount?.institutionId) return undefined;
    return institutions.find((i) => i.id === widgetAccount.institutionId);
  }, [widgetAccount, institutions]);

  // The selection resets on the criteria the *user* chose, not on
  // `bulkUpdateFilters`: that object falls back to every visible account when
  // no account filter is set, so it changes the moment the accounts request
  // lands, and clearing there dropped a selection the user had already made.
  // Derived from `bulkUpdateFilters` -- with only the derived account scope
  // swapped for the user's own choice -- so the two lists cannot drift apart.
  const selectionUserFilterKey = useMemo(
    () =>
      JSON.stringify({
        ...bulkUpdateFilters,
        accountIds: filters.filterAccountIds,
        accountStatus: filters.filterAccountStatus,
      }),
    [bulkUpdateFilters, filters.filterAccountIds, filters.filterAccountStatus],
  );

  const selection = useTransactionSelection(
    transactions,
    pagination?.total ?? 0,
    bulkUpdateFilters,
    selectionUserFilterKey,
  );

  const handleBulkUpdate = useCallback(async (updateFields: Partial<Pick<BulkUpdateData, 'payeeId' | 'payeeName' | 'categoryId' | 'description' | 'status' | 'tagIds'>>) => {
    const payload = selection.buildSelectionPayload();
    // The active category filter rides along in BOTH selection modes: split
    // lines are only recategorized when they match it, and a hand-picked
    // selection (mode "ids") must honor the filter the user was looking
    // through just like select-all-matching does.
    const categoryFilterIds =
      bulkUpdateFilters.categoryIds && bulkUpdateFilters.categoryIds.length > 0
        ? { categoryFilterIds: bulkUpdateFilters.categoryIds }
        : {};
    const result = await transactionsApi.bulkUpdate({ ...payload, ...categoryFilterIds, ...updateFields } as BulkUpdateData);

    const parts = [t('bulk.toasts.updated', { count: result.updated })];
    if (result.skipped > 0) parts.push(t('bulk.toasts.skipped', { count: result.skipped }));
    const splitLinesUpdated = result.splitLinesUpdated ?? 0;
    if (splitLinesUpdated > 0) {
      parts.push(t('bulk.toasts.splitLines', { count: splitLinesUpdated }));
    }
    if (result.updated > 0) {
      toast.success(parts.join(', '));
    } else if (result.skipped > 0) {
      toast.error(parts.join(', '));
    }
    if (result.skippedReasons.length > 0) {
      // Server-localized strings; rendered verbatim.
      result.skippedReasons.forEach(reason => toast(reason, { icon: 'ℹ️', duration: 6000 }));
    }

    setShowBulkUpdate(false);
    setBulkSelectMode(false);
    selection.clearSelection();
    loadAllData();
    return result;
  }, [selection, loadAllData, t, bulkUpdateFilters.categoryIds]);

  const handleBulkDelete = useCallback(async () => {
    const payload = selection.buildSelectionPayload();
    const result = await transactionsApi.bulkDelete(payload as BulkDeleteData);

    if (result.deleted > 0) {
      toast.success(t('toasts.deleted', { count: result.deleted }));
    }

    setShowBulkDeleteConfirm(false);
    setBulkSelectMode(false);
    selection.clearSelection();
    loadAllData();
  }, [selection, loadAllData, t]);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    try {
      const parsedAmountFrom = filters.filterAmountFrom ? parseFloat(filters.filterAmountFrom) : undefined;
      const parsedAmountTo = filters.filterAmountTo ? parseFloat(filters.filterAmountTo) : undefined;

      const queryParams = {
        accountIds: accountIdsForQuery,
        startDate: filters.filterStartDate || undefined,
        endDate: filters.filterEndDate || undefined,
        categoryIds: filters.filterCategoryIds.length > 0 ? filters.filterCategoryIds : undefined,
        payeeIds: filters.filterPayeeIds.length > 0 ? filters.filterPayeeIds : undefined,
        tagIds: filters.filterTagIds.length > 0 ? filters.filterTagIds : undefined,
        search: filters.filterSearch || undefined,
        amountFrom: parsedAmountFrom,
        amountTo: parsedAmountTo,
        statuses: filters.filterStatuses.length > 0 ? filters.filterStatuses : undefined,
        originalCurrencyCodes: filters.filterOriginalCurrencyCodes.length > 0 ? filters.filterOriginalCurrencyCodes : undefined,
        hasAttachments:
          filters.filterHasAttachments === ''
            ? undefined
            : filters.filterHasAttachments === 'yes',
      };

      // Fetch all pages of filtered transactions
      const allTransactions: Transaction[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await transactionsApi.getAll({
          ...queryParams,
          page,
          limit: PAGE_SIZE,
        });
        allTransactions.push(...response.data);
        hasMore = page < response.pagination.totalPages;
        page++;
      }

      if (allTransactions.length === 0) {
        toast.error(t('toasts.noneToExport'));
        return;
      }

      const headers = ['Date', 'Account', 'Payee', 'Category', 'Description', 'Tags', 'Amount', 'Currency', 'Status'];
      const rows = allTransactions.map(tx => {
        // `tx.amount` is typed number but arrives as the decimal string the
        // API serialized ("-67.9900"), so coerce it: the Amount column holds a
        // number, the way the split branch below already produces one.
        let amount = Number(tx.amount);
        // Use the filtered split amount when only some splits match the
        // active filter, matching what the UI displays.
        if (tx.isSplit && tx.splits && tx.splits.length > 0) {
          const splitsSumCents = tx.splits.reduce(
            (sum, s) => sum + Math.round(Number(s.amount) * 10000),
            0,
          );
          const txAmountCents = Math.round(amount * 10000);
          if (splitsSumCents !== txAmountCents) {
            amount = splitsSumCents / 10000;
          }
        }

        // A transfer's counterpart account is what the Category column has to
        // say -- the register shows it as an arrow chip, and the export used to
        // leave the cell empty (or, on a split line, call it "Uncategorized",
        // which it is not). Each line is labelled from its own amount, so the
        // two legs of one transfer read "To" and "From" respectively.
        const transferName = tx.linkedTransaction?.account?.name;
        const categoryCell = tx.isSplit && tx.splits
          ? tx.splits
              .map(s =>
                s.transferAccount
                  ? transferCsvLabel(s.transferAccount.name, s.amount)
                  : s.category?.name || 'Uncategorized',
              )
              .join('; ')
          : tx.isTransfer && transferName
            // A transfer can also carry a spending category, which the register
            // shows beside the arrow; keep both rather than dropping one.
            ? [tx.category?.name, transferCsvLabel(transferName, tx.amount)]
                .filter(Boolean)
                .join('; ')
            : (tx.category?.name ?? '');

        return [
          tx.transactionDate,
          tx.account?.name ?? '',
          // Blank-payee transfer legs export the same "Transfer to <account>"
          // text the register resolves at render time (issue #1214).
          tx.payee?.name ?? tx.payeeName ?? transferPayeeCsvLabel(tx) ?? '',
          categoryCell,
          tx.description ?? '',
          tx.tags?.map(t => t.name).join('; ') ?? '',
          amount,
          tx.currencyCode ?? '',
          tx.status,
        ];
      });

      const now = new Date();
      const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
      const filename = `Monize_Transactions_${datePart}_${timePart}.csv`;

      exportToCsv(filename, headers, rows);
      toast.success(t('toasts.exported', { count: allTransactions.length }));
    } catch (error) {
      showErrorToast(error, t('toasts.exportFailed'));
      logger.error(error);
    } finally {
      setIsExporting(false);
    }
  }, [accountIdsForQuery, filters.filterCategoryIds, filters.filterPayeeIds, filters.filterTagIds, filters.filterStartDate, filters.filterEndDate, filters.filterSearch, filters.filterAmountFrom, filters.filterAmountTo, filters.filterStatuses, filters.filterOriginalCurrencyCodes, filters.filterHasAttachments, t]);

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('page.title')}
          subtitle={t('page.subtitle')}
          helpUrl={docsUrl('transactions')}
          actions={
            <Button
              {...tourAnchor(TOUR_ANCHORS.transactionsNewButton)}
              onClick={handleCreateNew}
            >
              {t('page.newButton')}
            </Button>
          }
        />
        {(() => {
          if (chartCollapsed) return <CollapsedChartStrip onExpand={expandChart} />;
          const chartKind =
            filters.filterCategoryIds.length > 0 || filters.filterPayeeIds.length > 0 || filters.filterTagIds.length > 0 || filters.filterSearch.length > 0
              ? 'monthlyTotals'
              : accountBalances.length > 1
                ? 'accountBalances'
                // Multiple accounts in scope but every one has a zero balance
                // (e.g. only closed accounts, which are zeroed at closure): the
                // bar chart hides zero balances and a summed line reads as a
                // meaningless flat line, so show a banner instead.
                : accountCount > 1 && accountBalances.length === 0
                  ? 'zeroBalances'
                  : 'balanceHistory';
          // Keyed by kind so swapping chart types remounts the card and plays
          // the fade-in, instead of one chart popping into the other.
          const chart = (
            <div key={chartKind} className="animate-chart-in motion-reduce:animate-none">
              {chartKind === 'monthlyTotals' ? (
                <CategoryPayeeBarChart
                  data={monthlyTotals}
                  isLoading={isLoading}
                  filterLabel={monthlyTotalsFilterLabel}
                  onCollapse={collapseChart}
                  onMonthClick={(startDate, endDate) => {
                    isFilterChangeRef.current = true;
                    filters.setFilterStartDate(startDate);
                    filters.setFilterEndDate(endDate);
                    filters.setFilterTimePeriod('custom');
                  }}
                />
              ) : chartKind === 'accountBalances' ? (
                <AccountBalancesBarChart
                  data={accountBalances}
                  isLoading={isLoading}
                  currencyCode={chartCurrency}
                  onAccountClick={filters.handleAccountFilterClick}
                  onCollapse={collapseChart}
                />
              ) : chartKind === 'zeroBalances' ? (
                isLoading ? (
                  <ChartLoadingPlaceholder />
                ) : (
                  <div
                    data-testid="chart-zero-balances"
                    className={`${CARD_CLASS} relative p-3 sm:p-6 mb-6 min-h-[420px] flex items-center justify-center`}
                  >
                    <div className="absolute top-3 right-3 sm:top-6 sm:right-6">
                      <ChartCollapseButton onCollapse={collapseChart} />
                    </div>
                    <p className="text-gray-500 dark:text-gray-400 text-center max-w-md">
                      {t('charts.zeroBalances.message')}
                    </p>
                  </div>
                )
              ) : (
                <BalanceHistoryChart
                  data={chartBalances}
                  isLoading={isLoading}
                  currencyCode={chartCurrency}
                  accountName={balanceHistoryAccountName}
                  // Only when narrowed to a single liability account is a
                  // negative balance expected; an aggregate of accounts is not.
                  isLiability={isLiabilityAccountType(singleFilteredAccount?.accountType)}
                  onCollapse={collapseChart}
                />
              )}
            </div>
          );

          // Filtered to a single payee/category/account: show its info
          // widget (25%) to the left of the chart (75%). Stacks vertically
          // on narrow screens. The widget can be collapsed (persisted per
          // kind) so the chart uses full width.
          if (retainedWidget) {
            const kind = retainedWidget.kind;
            const activeMatches =
              kind === 'payee'
                ? retainedWidget.payee === singleFilteredPayee
                : kind === 'category'
                  ? retainedWidget.category === singleFilteredCategory
                  : retainedWidget.account === singleFilteredAccount;
            const collapsed =
              kind === 'payee'
                ? payeeWidgetCollapsed
                : kind === 'category'
                  ? categoryWidgetCollapsed
                  : accountWidgetCollapsed;
            const setCollapsed =
              kind === 'payee'
                ? setPayeeWidgetCollapsed
                : kind === 'category'
                  ? setCategoryWidgetCollapsed
                  : setAccountWidgetCollapsed;
            const showLabel =
              kind === 'payee'
                ? t('payeeWidget.show')
                : kind === 'category'
                  ? t('categoryWidget.show')
                  : t('accountWidget.show');
            // The widget animates between expanded and collapsed rather than
            // mounting/unmounting, so both the chevron toggle and widening the
            // filter past one entity slide it out of view: its column
            // collapses width (desktop) or height (mobile) and fades, while
            // the chart flexes to fill the reclaimed space.
            const widgetVisible = activeMatches && !collapsed;
            return (
              <div className="flex flex-col lg:flex-row lg:items-stretch">
                <div
                  aria-hidden={!widgetVisible}
                  inert={!widgetVisible}
                  className={`flex-shrink-0 lg:relative overflow-hidden transition-all duration-300 ease-in-out motion-reduce:transition-none ${
                    widgetVisible
                      ? 'max-h-[1000px] lg:max-h-none lg:w-1/4 lg:mr-6 opacity-100 lg:translate-x-0'
                      : 'max-h-0 lg:max-h-none lg:w-0 lg:mr-0 opacity-0 lg:-translate-x-6 pointer-events-none'
                  }`}
                >
                  {retainedWidget.kind === 'payee' ? (
                    <PayeeInfoWidget
                      payee={retainedWidget.payee}
                      categories={categories}
                      scheduledTransactions={scheduledTransactions}
                      filterParams={widgetFilterParams}
                      refreshKey={reloadKey}
                      onEdit={() => handlePayeeClick(retainedWidget.payee.id)}
                      onCollapse={() => setPayeeWidgetCollapsed(true)}
                      onCategoryClick={filters.handleCategoryClick}
                    />
                  ) : retainedWidget.kind === 'category' ? (
                    <CategoryInfoWidget
                      category={retainedWidget.category}
                      categories={categories}
                      scheduledTransactions={scheduledTransactions}
                      monthlyTotals={monthlyTotals}
                      filterParams={widgetFilterParams}
                      refreshKey={reloadKey}
                      onEdit={() => categoryModal.openEdit(retainedWidget.category)}
                      onCollapse={() => setCategoryWidgetCollapsed(true)}
                      onSubcategoryClick={filters.handleCategoryClick}
                      onPayeeClick={filters.handlePayeeFilterClick}
                    />
                  ) : (
                    <AccountInfoWidget
                      account={retainedWidget.account}
                      currentBalance={retainedWidget.currentBalance}
                      institution={widgetInstitution}
                      scheduledTransactions={scheduledTransactions}
                      refreshKey={reloadKey}
                      // The caret offers exactly what the Accounts filter
                      // offers (its status-narrowed list) and changes the
                      // filter the way the filter's own control does, so the
                      // Show Accounts toggle and every other filter survive
                      // the switch.
                      switchableAccounts={filters.filteredAccounts}
                      onSwitchAccount={handleWidgetAccountSwitch}
                      onEdit={() => accountModal.openEdit(retainedWidget.account)}
                      onCollapse={() => setAccountWidgetCollapsed(true)}
                    />
                  )}
                </div>
                <div className="lg:flex-1 min-w-0">
                  {collapsed && activeMatches && (
                    <button
                      type="button"
                      onClick={() => setCollapsed(false)}
                      className="mb-2 inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      <ChevronDoubleRightIcon className="h-4 w-4" />
                      {showLabel}
                    </button>
                  )}
                  {chart}
                </div>
              </div>
            );
          }
          return chart;
        })()}

        {/* Account Edit Modal (shared with the Accounts page) */}
        <AccountFormModal formModal={accountModal} onSaved={loadAllData} />

        {/* Category Edit Modal (same form as the Categories page) */}
        <Modal isOpen={categoryModal.showForm} onClose={categoryModal.close} {...categoryModal.modalProps} maxWidth="lg" className="p-6" title={t('page.editModal.editCategoryTitle')}>
          <CategoryForm
            category={categoryModal.editingItem}
            categories={categories}
            onSubmit={handleCategoryFormSubmit}
            onCancel={categoryModal.close}
            onDirtyChange={categoryModal.setFormDirty}
            submitRef={categoryModal.formSubmitRef}
          />
        </Modal>
        <UnsavedChangesDialog {...categoryModal.unsavedChangesDialog} />

        {/* Form Modal */}
        <Modal isOpen={showForm} onClose={handleClose} {...modalProps} maxWidth="6xl" className="p-6 !max-w-[69rem]" title={editingTransaction ? t('page.editModal.editTitle') : duplicatingFrom ? t('page.editModal.duplicateTitle') : t('page.editModal.newTitle')}>
          <TransactionForm
            key={`${editingTransaction?.id || 'new'}-${duplicatingFrom?.id || ''}-${filters.filterAccountIds.join(',')}-${createOnDate || ''}-${formKey}`}
            transaction={editingTransaction}
            duplicateFrom={duplicatingFrom}
            defaultDate={createOnDate}
            defaultAccountId={filters.filterAccountIds.length === 1 ? filters.filterAccountIds[0] : undefined}
            defaultCategoryId={(() => {
              if (filters.filterAccountIds.length !== 1) return undefined;
              const account = accounts.find(a => a.id === filters.filterAccountIds[0]);
              return account?.accountType === 'ASSET' ? (account.assetCategoryId || undefined) : undefined;
            })()}
            onSuccess={handleFormSuccess}
            onCreateAndNew={handleCreateAndNew}
            onCancel={handleClose}
            onDirtyChange={setFormDirty}
            submitRef={formSubmitRef}
            onAddWarranty={actingAsDelegate ? undefined : handleAddWarrantyFromForm}
            onAddWarrantyAfterCreate={actingAsDelegate ? undefined : handleAddWarrantyAfterCreate}
            onOpenWarranty={handleOpenWarrantyFromForm}
          />
        </Modal>
        <UnsavedChangesDialog
          {...unsavedChangesDialog}
          onDiscard={() => { setDuplicatingFrom(undefined); unsavedChangesDialog.onDiscard(); releaseFormNavigation(); }}
          onCancel={() => { pendingFormNavigation.current = null; unsavedChangesDialog.onCancel(); }}
        />

        {/* Schedule as Recurring Modal */}
        {showScheduleForm && (
          <Modal isOpen={showScheduleForm} onClose={handleScheduleFormClose} maxWidth="6xl" className="p-6 !max-w-[69rem]" pushHistory title={t('page.editModal.scheduleTitle')}>
            <ScheduledTransactionForm
              key={`schedule-${schedulingFrom?.id || 'new'}`}
              templateTransaction={schedulingFrom}
              onSuccess={handleScheduleFormSuccess}
              onCancel={handleScheduleFormClose}
            />
          </Modal>
        )}

        {/* Payee Edit Modal */}
        {editingPayee && (
          <Modal isOpen={showPayeeForm} onClose={handlePayeeFormCancel} maxWidth="lg" className="p-6" pushHistory title={t('page.editModal.editPayeeTitle')}>
            <PayeeForm
              payee={editingPayee}
              categories={categories}
              onSubmit={handlePayeeFormSubmit}
              onCancel={handlePayeeFormCancel}
            />
          </Modal>
        )}

        <TransactionFilterPanel
          filterAccountIds={filters.filterAccountIds}
          filterCategoryIds={filters.filterCategoryIds}
          filterPayeeIds={filters.filterPayeeIds}
          filterStartDate={filters.filterStartDate}
          filterEndDate={filters.filterEndDate}
          filterSearch={filters.filterSearch}
          searchInput={filters.searchInput}
          searchInterpretation={
            searchEcho && searchEcho.search === filters.filterSearch
              ? searchEcho.interpretation
              : undefined
          }
          filterAccountStatus={filters.filterAccountStatus}
          filterTimePeriod={filters.filterTimePeriod}
          filterAmountFrom={filters.filterAmountFrom}
          filterAmountTo={filters.filterAmountTo}
          filterTagIds={filters.filterTagIds}
          filterStatuses={filters.filterStatuses}
          filterOriginalCurrencyCodes={filters.filterOriginalCurrencyCodes}
          filterTagKey={filters.filterTagKey}
          filterTagKeyOp={filters.filterTagKeyOp}
          filterTagKeyValue={filters.filterTagKeyValue}
          filterHasAttachments={filters.filterHasAttachments}
          weekStartsOn={weekStartsOn}
          handleArrayFilterChange={filters.handleArrayFilterChange}
          handleFilterChange={filters.handleFilterChange}
          handleSearchChange={filters.handleSearchChange}
          setFilterAccountStatus={filters.setFilterAccountStatus}
          setFilterAccountIds={filters.setFilterAccountIds}
          setFilterCategoryIds={filters.setFilterCategoryIds}
          setFilterPayeeIds={filters.setFilterPayeeIds}
          setFilterStartDate={filters.setFilterStartDate}
          setFilterEndDate={filters.setFilterEndDate}
          setFilterSearch={filters.setFilterSearch}
          setFilterTimePeriod={filters.setFilterTimePeriod}
          setFilterAmountFrom={filters.setFilterAmountFrom}
          setFilterAmountTo={filters.setFilterAmountTo}
          setFilterTagIds={filters.setFilterTagIds}
          setFilterStatuses={filters.setFilterStatuses}
          setFilterOriginalCurrencyCodes={filters.setFilterOriginalCurrencyCodes}
          setFilterTagKey={filters.setFilterTagKey}
          setFilterTagKeyOp={filters.setFilterTagKeyOp}
          setFilterTagKeyValue={filters.setFilterTagKeyValue}
          setFilterHasAttachments={filters.setFilterHasAttachments}
          filtersExpanded={filters.filtersExpanded}
          setFiltersExpanded={filters.setFiltersExpanded}
          activeFilterCount={filters.activeFilterCount}
          filteredAccounts={filters.filteredAccounts}
          accountStatusCounts={filters.accountStatusCounts}
          selectedAccounts={filters.selectedAccounts}
          selectedCategories={filters.selectedCategories}
          selectedPayees={filters.selectedPayees}
          selectedTags={filters.selectedTags}
          accountFilterOptions={filters.accountFilterOptions}
          categoryFilterOptions={filters.categoryFilterOptions}
          payeeFilterOptions={filters.payeeFilterOptions}
          tagFilterOptions={filters.tagFilterOptions}
          formatDate={formatDate}
          bulkSelectMode={bulkSelectMode}
          onToggleBulkSelectMode={() => {
            if (bulkSelectMode) selection.clearSelection();
            setBulkSelectMode(!bulkSelectMode);
          }}
          onClearFilters={filters.clearFilters}
          hideDateRange={view === 'calendar'}
        />

        {/* Spending broken down by the selected KEY:VALUE tag key. */}
        {filters.filterTagKey && (
          <div className="mb-6">
            <TagKeyBreakdownChart
              tagKey={filters.filterTagKey}
              params={{
                accountIds: accountIdsForQuery,
                startDate: filters.filterStartDate || undefined,
                endDate: filters.filterEndDate || undefined,
                tagIds:
                  filters.filterTagIds.length > 0
                    ? filters.filterTagIds
                    : undefined,
                search: filters.filterSearch || undefined,
                amountFrom: filters.filterAmountFrom
                  ? parseFloat(filters.filterAmountFrom)
                  : undefined,
                amountTo: filters.filterAmountTo
                  ? parseFloat(filters.filterAmountTo)
                  : undefined,
              }}
            />
          </div>
        )}

        {/* Bulk Selection Banner */}
        {selection.hasSelection && (
          <BulkSelectionBanner
            selectionCount={selection.selectionCount}
            isAllOnPageSelected={selection.isAllOnPageSelected}
            selectAllMatching={selection.selectAllMatching}
            totalMatching={pagination?.total ?? 0}
            onSelectAllMatching={selection.selectAllMatchingTransactions}
            onClearSelection={() => { selection.clearSelection(); setBulkSelectMode(false); }}
            onBulkUpdate={() => setShowBulkUpdate(true)}
            onBulkDelete={() => setShowBulkDeleteConfirm(true)}
          />
        )}

        {/* Bulk Update Modal */}
        <BulkUpdateModal
          isOpen={showBulkUpdate}
          onClose={() => setShowBulkUpdate(false)}
          onSubmit={handleBulkUpdate}
          selectionCount={selection.selectionCount}
        />

        {/* Bulk Delete Confirmation */}
        <ConfirmDialog
          isOpen={showBulkDeleteConfirm}
          onCancel={() => setShowBulkDeleteConfirm(false)}
          onConfirm={handleBulkDelete}
          title={t('page.bulkDelete.title')}
          message={t('page.bulkDelete.message', { count: selection.selectionCount })}
          confirmLabel={tc('delete')}
          variant="danger"
        />

        {/* The register, or the month calendar standing in for it. Everything
            above this point is the same either way. */}
        {view === 'calendar' ? (
          <TransactionsCalendarView
            accounts={accounts}
            scheduledTransactions={scheduledTransactions}
            filters={calendarFilters}
            scopeAccountIds={accountIdsForQuery ?? []}
            weekStartsOn={weekStartsOn}
            today={financialToday}
            categoryColorMap={filters.categoryColorMap}
            categoryIconMap={filters.categoryIconMap}
            categoryLabelMap={filters.categoryLabelMap}
            onEditTransaction={handleEdit}
            onCreateOnDay={handleCreateOnDay}
            refreshKey={reloadKey}
            viewToggle={<ViewModeToggle value={view} onChange={setView} />}
          />
        ) : (
          <>
        {/* Transactions List */}
        <div className={`${CARD_CLASS} overflow-hidden`}>
          <div ref={swipeRef} {...(paginates ? { [SWIPE_PAGINATE_ATTR]: 'true' } : {})}>
          {isLoading && transactions.length === 0 ? (
            <LoadingSpinner text={t('page.loading')} />
          ) : (
            <TransactionList
              transactions={transactions}
              jointPermissionsByAccount={jointPermissionsByAccount}
              onEdit={handleEdit}
              onDuplicate={handleDuplicate}
              onScheduleRecurring={handleScheduleRecurring}
              onRefresh={loadAllData}
              onTransactionUpdate={handleTransactionUpdate}
              onPayeeClick={handlePayeeView}
              onTransferClick={filters.handleTransferClick}
              onCategoryClick={filters.handleCategoryClick}
              onTagClick={filters.handleTagFilterClick}
              onDateFilterClick={filters.handleDateFilterClick}
              onAccountFilterClick={filters.handleAccountFilterClick}
              onPayeeFilterClick={filters.handlePayeeFilterClick}
              onExport={handleExport}
              isExporting={isExporting}
              viewToggle={<ViewModeToggle value={view} onChange={setView} />}
              isSingleAccountView={filters.filterAccountIds.length === 1}
              selectionMode={bulkSelectMode}
              selectedIds={selection.selectedIds}
              selectAllMatching={selection.selectAllMatching}
              excludedIds={selection.excludedIds}
              onToggleSelection={selection.toggleTransaction}
              onToggleAllOnPage={selection.toggleAllOnPage}
              isAllOnPageSelected={selection.isAllOnPageSelected}
              startingBalance={startingBalance}
              startingBalanceWithheld={startingBalanceWithheld}
              sort={registerSort}
              rowsSort={rowsSort}
              onSortChange={handleSortChange}
              currentPage={filters.currentPage}
              totalPages={pagination?.totalPages ?? 1}
              totalItems={pagination?.total ?? 0}
              pageSize={PAGE_SIZE}
              onPageChange={filters.goToPage}
              categoryColorMap={filters.categoryColorMap}
              categoryIconMap={filters.categoryIconMap}
              categoryLabelMap={filters.categoryLabelMap}
              budgetStatusMap={budgetStatusMap}
              highlightTransactionId={filters.highlightTransactionId}
            />
          )}
          </div>
        </div>

        {/* Pagination, repeated below the rows */}
        <ListBottomPager
          currentPage={filters.currentPage}
          totalPages={pagination?.totalPages}
          totalItems={pagination?.total}
          pageSize={PAGE_SIZE}
          onPageChange={filters.goToPage}
          itemName={t('list.itemNamePlural')}
          totalLabel={t('page.totalCount', { count: pagination?.total ?? 0 })}
        />
          </>
        )}
      </main>
    </PageLayout>
  );
}
