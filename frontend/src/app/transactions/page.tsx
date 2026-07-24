'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { TransactionFilterPanel } from '@/components/transactions/TransactionFilterPanel';
import { TagKeyBreakdownChart } from '@/components/transactions/TagKeyBreakdownChart';
import { Pagination } from '@/components/ui/Pagination';
import { TransactionList } from '@/components/transactions/TransactionList';
import { type DensityLevel } from '@/hooks/useTableDensity';
import dynamic from 'next/dynamic';

const TransactionForm = dynamic(() => import('@/components/transactions/TransactionForm').then(m => m.TransactionForm), { ssr: false });
const ScheduledTransactionForm = dynamic(() => import('@/components/scheduled-transactions/ScheduledTransactionForm').then(m => m.ScheduledTransactionForm), { ssr: false });
const PayeeForm = dynamic(() => import('@/components/payees/PayeeForm').then(m => m.PayeeForm), { ssr: false });
const CategoryForm = dynamic(() => import('@/components/categories/CategoryForm').then(m => m.CategoryForm), { ssr: false });
const BulkUpdateModal = dynamic(() => import('@/components/transactions/BulkUpdateModal').then(m => m.BulkUpdateModal), { ssr: false });
// Reserve the chart card's height while the chunk loads so the rest of the
// page (filter row, table) doesn't jump down when the chart hydrates.
const ChartLoadingPlaceholder = () => (
  <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6 min-h-[420px]" />
);
const BalanceHistoryChart = dynamic(() => import('@/components/transactions/BalanceHistoryChart').then(m => m.BalanceHistoryChart), { ssr: false, loading: ChartLoadingPlaceholder });
const CategoryPayeeBarChart = dynamic(() => import('@/components/transactions/CategoryPayeeBarChart').then(m => m.CategoryPayeeBarChart), { ssr: false, loading: ChartLoadingPlaceholder });
const AccountBalancesBarChart = dynamic(() => import('@/components/transactions/AccountBalancesBarChart').then(m => m.AccountBalancesBarChart), { ssr: false, loading: ChartLoadingPlaceholder });
import { transactionsApi } from '@/lib/transactions';
import { accountsApi } from '@/lib/accounts';
import { institutionsApi } from '@/lib/institutions';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { categoriesApi } from '@/lib/categories';
import { payeesApi } from '@/lib/payees';
import { tagsApi } from '@/lib/tags';
import { Transaction, PaginationInfo, BulkUpdateData, BulkUpdateFilters, MonthlyTotal, BulkDeleteData } from '@/types/transaction';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useTransactionSelection } from '@/hooks/useTransactionSelection';
import { useTransactionFilters } from '@/hooks/useTransactionFilters';
import { BulkSelectionBanner } from '@/components/transactions/BulkSelectionBanner';
import { Account, isLiabilityAccountType } from '@/types/account';
import { Institution } from '@/types/institution';
import { Category } from '@/types/category';
import { Payee } from '@/types/payee';
import { Tag } from '@/types/tag';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useDateFormat } from '@/hooks/useDateFormat';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useFormModal } from '@/hooks/useFormModal';
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
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { createLogger } from '@/lib/logger';
import { showErrorToast } from '@/lib/errors';
import { exportToCsv } from '@/lib/csv-export';
import { PAGE_SIZE } from '@/lib/constants';
import { budgetsApi } from '@/lib/budgets';
import { CategoryBudgetStatus } from '@/types/budget';

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
  const defaultCurrency = usePreferencesStore((s) => s.preferences?.defaultCurrency) || 'CAD';
  const { convertToDefault } = useExchangeRates();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [scheduledTransactions, setScheduledTransactions] = useState<ScheduledTransaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [dailyBalances, setDailyBalances] = useState<Array<{ date: string; balance: number; accountId: string; currencyCode: string }>>([]);
  const [monthlyTotals, setMonthlyTotals] = useState<MonthlyTotal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { showForm, editingItem: editingTransaction, openCreate, openEdit, close, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef } = useFormModal<Transaction>();
  // Separate modal instances for editing the account/category behind a
  // single-entity filter, reusing the same forms as their own pages.
  const accountModal = useFormModal<Account>();
  const categoryModal = useFormModal<Category>();
  const [duplicatingFrom, setDuplicatingFrom] = useState<Transaction | undefined>();
  const [schedulingFrom, setSchedulingFrom] = useState<Transaction | undefined>();
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [showPayeeForm, setShowPayeeForm] = useState(false);
  const [editingPayee, setEditingPayee] = useState<Payee | undefined>();
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('monize-transactions-density', 'normal');
  const [accountWidgetCollapsed, setAccountWidgetCollapsed] = useLocalStorage<boolean>('monize-transactions-account-widget-collapsed', false);
  const [payeeWidgetCollapsed, setPayeeWidgetCollapsed] = useLocalStorage<boolean>('monize-transactions-payee-widget-collapsed', false);
  const [categoryWidgetCollapsed, setCategoryWidgetCollapsed] = useLocalStorage<boolean>('monize-transactions-category-widget-collapsed', false);
  const [showBulkUpdate, setShowBulkUpdate] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [bulkSelectMode, setBulkSelectMode] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  // Ref to track whether any modal is open (used by popstate handler to avoid conflicts)
  const modalOpenRef = useRef(false);
  modalOpenRef.current = showForm || showScheduleForm || showPayeeForm || showBulkUpdate || showBulkDeleteConfirm;

  const filters = useTransactionFilters({ accounts, categories, payees, tags, weekStartsOn });

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

  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [startingBalance, setStartingBalance] = useState<number | undefined>();

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
  const loadStaticData = useCallback(async () => {
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
  }, [t]);

  // Load transaction data and chart data in parallel
  const loadTransactions = useCallback(async (page: number) => {
    const safePage = (!page || page < 1) ? 1 : page;
    try {
      const targetTransactionId = filters.targetTransactionIdRef.current;
      filters.targetTransactionIdRef.current = null;

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
          amountFrom: parsedAmountFrom,
          amountTo: parsedAmountTo,
          statuses: filters.filterStatuses.length > 0 ? filters.filterStatuses : undefined,
          originalCurrencyCodes: filters.filterOriginalCurrencyCodes.length > 0 ? filters.filterOriginalCurrencyCodes : undefined,
          tagKey: filters.filterTagKey || undefined,
          tagKeyOp: filters.filterTagKeyOp,
          tagKeyValue: filters.filterTagKeyValue || undefined,
        }),
        chartPromise,
      ]);

      setTransactions(transactionsResponse.data);
      setPagination(transactionsResponse.pagination);
      setStartingBalance(transactionsResponse.startingBalance);

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
      showErrorToast(error, t('toasts.loadFailed'));
      logger.error(error);
    } finally {
      setIsLoading(false);
      // Signal the entity info widgets to refetch their summaries in lockstep
      // with the freshly loaded chart/list data.
      setReloadKey((k) => k + 1);
    }
  }, [accountIdsForQuery, filters.filterAccountStatus, filters.filterCategoryIds, filters.filterPayeeIds, filters.filterTagIds, filters.filterStartDate, filters.filterEndDate, filters.filterSearch, filters.filterAmountFrom, filters.filterAmountTo, filters.filterStatuses, filters.filterOriginalCurrencyCodes, filters.filterTagKey, filters.filterTagKeyOp, filters.filterTagKeyValue, t]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (!filters.filtersInitialized) return;

    // Reload static data if invalidated (e.g. after undo/redo)
    loadStaticData();

    const page = filters.isFilterChange.current ? 1 : filters.currentPage;
    const wasFilterChange = filters.isFilterChange.current;
    if (filters.isFilterChange.current) {
      filters.setCurrentPage(1);
      filters.isFilterChange.current = false;
    }

    if (filters.syncingFromPopstateRef.current) {
      filters.syncingFromPopstateRef.current = false;
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
      }, wasFilterChange);
    }

    if (filters.filterDebounceRef.current) clearTimeout(filters.filterDebounceRef.current);
    if (wasFilterChange) {
      filters.filterDebounceRef.current = setTimeout(() => {
        loadTransactions(page);
      }, 150);
    } else {
      loadTransactions(page);
    }
  }, [filters.currentPage, filters.filterAccountIds, filters.filterCategoryIds, filters.filterPayeeIds, filters.filterTagIds, filters.filterStartDate, filters.filterEndDate, filters.filterSearch, filters.filterAmountFrom, filters.filterAmountTo, filters.filterStatuses, filters.filterOriginalCurrencyCodes, filters.filterTagKey, filters.filterTagKeyOp, filters.filterTagKeyValue, filters.updateUrl, loadTransactions, filters.filtersInitialized, undoRedoTick]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleCreateNew = () => openCreate();

  const handleEdit = async (transaction: Transaction) => {
    if (transaction.linkedInvestmentTransactionId) {
      toast(t('page.toasts.investmentLinked'));
      router.push(`/investments?edit=${transaction.linkedInvestmentTransactionId}`);
      return;
    }
    if (transaction.isTransfer || transaction.isSplit) {
      try {
        const fullTransaction = await transactionsApi.getById(transaction.id);
        openEdit(fullTransaction);
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
    setDuplicatingFrom(undefined);
    close();
  };

  const [formKey, setFormKey] = useState(0);

  const handleFormSuccess = () => {
    setDuplicatingFrom(undefined);
    close();
    setFormKey(prev => prev + 1);
    loadData();
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
        ? { ...updatedTransaction, linkedInvestmentTransactionId: tx.linkedInvestmentTransactionId }
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

    const byDate = new Map<string, number>();
    const latestByAccount = new Map<string, { date: string; balance: number; currencyCode: string }>();
    for (const row of dailyBalances) {
      const amount = isSingleCurrency ? row.balance : convertToDefault(row.balance, row.currencyCode);
      byDate.set(row.date, (byDate.get(row.date) ?? 0) + amount);

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
        balance: isSingleCurrency ? info.balance : convertToDefault(info.balance, info.currencyCode),
      }))
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
    if (id === 'uncategorized' || id === 'transfer') return undefined;
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

  const selection = useTransactionSelection(
    transactions,
    pagination?.total ?? 0,
    bulkUpdateFilters,
  );

  const handleBulkUpdate = useCallback(async (updateFields: Partial<Pick<BulkUpdateData, 'payeeId' | 'payeeName' | 'categoryId' | 'description' | 'status' | 'tagIds'>>) => {
    const payload = selection.buildSelectionPayload();
    const result = await transactionsApi.bulkUpdate({ ...payload, ...updateFields } as BulkUpdateData);

    const parts = [`${result.updated} transaction${result.updated !== 1 ? 's' : ''} updated`];
    if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
    if (result.updated > 0) {
      toast.success(parts.join(', '));
    } else if (result.skipped > 0) {
      toast.error(parts.join(', '));
    }
    if (result.skippedReasons.length > 0) {
      result.skippedReasons.forEach(reason => toast(reason, { icon: 'ℹ️', duration: 6000 }));
    }

    setShowBulkUpdate(false);
    setBulkSelectMode(false);
    selection.clearSelection();
    loadAllData();
    return result;
  }, [selection, loadAllData]);

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
        // Use the filtered split amount when only some splits match the
        // active filter, matching what the UI displays.
        let amount = tx.amount;
        if (tx.isSplit && tx.splits && tx.splits.length > 0) {
          const splitsSumCents = tx.splits.reduce(
            (sum, s) => sum + Math.round(Number(s.amount) * 10000),
            0,
          );
          const txAmountCents = Math.round(Number(tx.amount) * 10000);
          if (splitsSumCents !== txAmountCents) {
            amount = splitsSumCents / 10000;
          }
        }

        return [
          tx.transactionDate,
          tx.account?.name ?? '',
          tx.payee?.name ?? tx.payeeName ?? '',
          tx.isSplit && tx.splits
            ? tx.splits.map(s => s.category?.name || 'Uncategorized').join('; ')
            : (tx.category?.name ?? ''),
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
  }, [accountIdsForQuery, filters.filterCategoryIds, filters.filterPayeeIds, filters.filterTagIds, filters.filterStartDate, filters.filterEndDate, filters.filterSearch, filters.filterAmountFrom, filters.filterAmountTo, filters.filterStatuses, filters.filterOriginalCurrencyCodes, t]);

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('page.title')}
          subtitle={t('page.subtitle')}
          helpUrl="https://github.com/kenlasko/monize/wiki/Transactions"
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
                  onMonthClick={(startDate, endDate) => {
                    filters.isFilterChange.current = true;
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
                />
              ) : chartKind === 'zeroBalances' ? (
                isLoading ? (
                  <ChartLoadingPlaceholder />
                ) : (
                  <div
                    data-testid="chart-zero-balances"
                    className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6 min-h-[420px] flex items-center justify-center"
                  >
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
        <Modal isOpen={categoryModal.showForm} onClose={categoryModal.close} {...categoryModal.modalProps} maxWidth="lg" className="p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {t('page.editModal.editCategoryTitle')}
          </h2>
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
        <Modal isOpen={showForm} onClose={handleClose} {...modalProps} maxWidth="6xl" className="p-6 !max-w-[69rem]">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {editingTransaction ? t('page.editModal.editTitle') : duplicatingFrom ? t('page.editModal.duplicateTitle') : t('page.editModal.newTitle')}
          </h2>
          <TransactionForm
            key={`${editingTransaction?.id || 'new'}-${duplicatingFrom?.id || ''}-${filters.filterAccountIds.join(',')}-${formKey}`}
            transaction={editingTransaction}
            duplicateFrom={duplicatingFrom}
            defaultAccountId={filters.filterAccountIds.length === 1 ? filters.filterAccountIds[0] : undefined}
            defaultCategoryId={(() => {
              if (filters.filterAccountIds.length !== 1) return undefined;
              const account = accounts.find(a => a.id === filters.filterAccountIds[0]);
              return account?.accountType === 'ASSET' ? (account.assetCategoryId || undefined) : undefined;
            })()}
            onSuccess={handleFormSuccess}
            onCancel={handleClose}
            onDirtyChange={setFormDirty}
            submitRef={formSubmitRef}
          />
        </Modal>
        <UnsavedChangesDialog
          {...unsavedChangesDialog}
          onDiscard={() => { setDuplicatingFrom(undefined); unsavedChangesDialog.onDiscard(); }}
        />

        {/* Schedule as Recurring Modal */}
        {showScheduleForm && (
          <Modal isOpen={showScheduleForm} onClose={handleScheduleFormClose} maxWidth="6xl" className="p-6 !max-w-[69rem]" pushHistory>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
              {t('page.editModal.scheduleTitle')}
            </h2>
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
          <Modal isOpen={showPayeeForm} onClose={handlePayeeFormCancel} maxWidth="lg" className="p-6" pushHistory>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">{t('page.editModal.editPayeeTitle')}</h2>
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
          filtersExpanded={filters.filtersExpanded}
          setFiltersExpanded={filters.setFiltersExpanded}
          activeFilterCount={filters.activeFilterCount}
          filteredAccounts={filters.filteredAccounts}
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

        {/* Transactions List */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {isLoading && transactions.length === 0 ? (
            <LoadingSpinner text={t('page.loading')} />
          ) : (
            <TransactionList
              transactions={transactions}
              onEdit={handleEdit}
              onDuplicate={handleDuplicate}
              onScheduleRecurring={handleScheduleRecurring}
              onRefresh={loadAllData}
              onTransactionUpdate={handleTransactionUpdate}
              onPayeeClick={handlePayeeClick}
              onTransferClick={filters.handleTransferClick}
              onCategoryClick={filters.handleCategoryClick}
              onTagClick={filters.handleTagFilterClick}
              onDateFilterClick={filters.handleDateFilterClick}
              onAccountFilterClick={filters.handleAccountFilterClick}
              onPayeeFilterClick={filters.handlePayeeFilterClick}
              density={listDensity}
              onDensityChange={setListDensity}
              onExport={handleExport}
              isExporting={isExporting}
              isSingleAccountView={filters.filterAccountIds.length === 1}
              selectionMode={bulkSelectMode}
              selectedIds={selection.selectedIds}
              selectAllMatching={selection.selectAllMatching}
              excludedIds={selection.excludedIds}
              onToggleSelection={selection.toggleTransaction}
              onToggleAllOnPage={selection.toggleAllOnPage}
              isAllOnPageSelected={selection.isAllOnPageSelected}
              startingBalance={startingBalance}
              currentPage={filters.currentPage}
              totalPages={pagination?.totalPages ?? 1}
              totalItems={pagination?.total ?? 0}
              pageSize={PAGE_SIZE}
              onPageChange={filters.goToPage}
              categoryColorMap={filters.categoryColorMap}
              categoryLabelMap={filters.categoryLabelMap}
              budgetStatusMap={budgetStatusMap}
              highlightTransactionId={filters.highlightTransactionId}
            />
          )}
        </div>

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 && (
          <div className="mt-4">
            <Pagination
              currentPage={filters.currentPage}
              totalPages={pagination.totalPages}
              totalItems={pagination.total}
              pageSize={PAGE_SIZE}
              onPageChange={filters.goToPage}
              itemName={t('list.itemNamePlural')}
            />
          </div>
        )}

        {/* Show total count when only one page */}
        {pagination && pagination.totalPages <= 1 && pagination.total > 0 && (
          <div className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
            {t('page.totalCount', { count: pagination.total })}
          </div>
        )}
      </main>
    </PageLayout>
  );
}
