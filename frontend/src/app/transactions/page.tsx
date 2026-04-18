'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { TransactionFilterPanel } from '@/components/transactions/TransactionFilterPanel';
import { Pagination } from '@/components/ui/Pagination';
import { TransactionList } from '@/components/transactions/TransactionList';
import { type DensityLevel } from '@/hooks/useTableDensity';
import dynamic from 'next/dynamic';

const TransactionForm = dynamic(() => import('@/components/transactions/TransactionForm').then(m => m.TransactionForm), { ssr: false });
const ScheduledTransactionForm = dynamic(() => import('@/components/scheduled-transactions/ScheduledTransactionForm').then(m => m.ScheduledTransactionForm), { ssr: false });
const PayeeForm = dynamic(() => import('@/components/payees/PayeeForm').then(m => m.PayeeForm), { ssr: false });
const BulkUpdateModal = dynamic(() => import('@/components/transactions/BulkUpdateModal').then(m => m.BulkUpdateModal), { ssr: false });
const BalanceHistoryChart = dynamic(() => import('@/components/transactions/BalanceHistoryChart').then(m => m.BalanceHistoryChart), { ssr: false });
const CategoryPayeeBarChart = dynamic(() => import('@/components/transactions/CategoryPayeeBarChart').then(m => m.CategoryPayeeBarChart), { ssr: false });
const AccountBalancesBarChart = dynamic(() => import('@/components/transactions/AccountBalancesBarChart').then(m => m.AccountBalancesBarChart), { ssr: false });
import { transactionsApi } from '@/lib/transactions';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { payeesApi } from '@/lib/payees';
import { tagsApi } from '@/lib/tags';
import { Transaction, PaginationInfo, BulkUpdateData, BulkUpdateFilters, MonthlyTotal, BulkDeleteData } from '@/types/transaction';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useTransactionSelection } from '@/hooks/useTransactionSelection';
import { useTransactionFilters } from '@/hooks/useTransactionFilters';
import { BulkSelectionBanner } from '@/components/transactions/BulkSelectionBanner';
import { Account } from '@/types/account';
import { Category } from '@/types/category';
import { Payee } from '@/types/payee';
import { Tag } from '@/types/tag';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useDateFormat } from '@/hooks/useDateFormat';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useFormModal } from '@/hooks/useFormModal';
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

export default function TransactionsPage() {
  return (
    <ProtectedRoute>
      <TransactionsContent />
    </ProtectedRoute>
  );
}

function TransactionsContent() {
  const router = useRouter();
  const { formatDate } = useDateFormat();
  const weekStartsOn = (usePreferencesStore((s) => s.preferences?.weekStartsOn) ?? 1) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  const defaultCurrency = usePreferencesStore((s) => s.preferences?.defaultCurrency) || 'CAD';
  const { convertToDefault } = useExchangeRates();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [dailyBalances, setDailyBalances] = useState<Array<{ date: string; balance: number; accountId: string; currencyCode: string }>>([]);
  const [monthlyTotals, setMonthlyTotals] = useState<MonthlyTotal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { showForm, editingItem: editingTransaction, openCreate, openEdit, close, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef } = useFormModal<Transaction>();
  const [duplicatingFrom, setDuplicatingFrom] = useState<Transaction | undefined>();
  const [schedulingFrom, setSchedulingFrom] = useState<Transaction | undefined>();
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [showPayeeForm, setShowPayeeForm] = useState(false);
  const [editingPayee, setEditingPayee] = useState<Payee | undefined>();
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('monize-transactions-density', 'normal');
  const [showBulkUpdate, setShowBulkUpdate] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [bulkSelectMode, setBulkSelectMode] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  // Ref to track whether any modal is open (used by popstate handler to avoid conflicts)
  const modalOpenRef = useRef(false);
  modalOpenRef.current = showForm || showScheduleForm || showPayeeForm || showBulkUpdate || showBulkDeleteConfirm;

  const filters = useTransactionFilters({ accounts, categories, payees, tags, weekStartsOn });

  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [startingBalance, setStartingBalance] = useState<number | undefined>();

  // Budget context for category indicators
  const [budgetStatusMap, setBudgetStatusMap] = useState<Record<string, CategoryBudgetStatus>>({});

  // Track if static data has been loaded
  const staticDataLoaded = useRef(false);

  // Load static data (accounts, categories, payees) - only runs once
  const loadStaticData = useCallback(async () => {
    if (staticDataLoaded.current) return;
    try {
      const [accountsData, categoriesData, payeesData, tagsData] = await Promise.all([
        accountsApi.getAll(true),
        categoriesApi.getAll(),
        payeesApi.getAll(),
        tagsApi.getAll(),
      ]);
      setAccounts(accountsData);
      setCategories(categoriesData);
      setPayees(payeesData);
      setTags(tagsData);
      staticDataLoaded.current = true;
    } catch (error) {
      showErrorToast(error, 'Failed to load form data');
      logger.error(error);
    }
  }, []);

  // Load transaction data and chart data in parallel
  const loadTransactions = useCallback(async (page: number) => {
    const safePage = (!page || page < 1) ? 1 : page;
    try {
      let accountIdsForQuery: string[] | undefined;
      if (filters.filterAccountIds.length > 0) {
        accountIdsForQuery = filters.filterAccountIds;
      } else if (filters.filterAccountStatus && filters.filteredAccounts.length > 0) {
        accountIdsForQuery = filters.filteredAccounts.map(a => a.id);
      }

      const targetTransactionId = filters.targetTransactionIdRef.current;
      filters.targetTransactionIdRef.current = null;

      const hasCategoryOrPayeeFilter = filters.filterCategoryIds.length > 0 || filters.filterPayeeIds.length > 0 || filters.filterTagIds.length > 0 || filters.filterSearch.length > 0;

      const chartParams: { startDate?: string; endDate?: string; accountIds?: string } = {};
      if (filters.filterStartDate) chartParams.startDate = filters.filterStartDate;
      if (filters.filterEndDate) chartParams.endDate = filters.filterEndDate;
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
      showErrorToast(error, 'Failed to load transactions');
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [filters.filterAccountIds, filters.filterAccountStatus, filters.filteredAccounts, filters.filterCategoryIds, filters.filterPayeeIds, filters.filterTagIds, filters.filterStartDate, filters.filterEndDate, filters.filterSearch, filters.filterAmountFrom, filters.filterAmountTo]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [filters.currentPage, filters.filterAccountIds, filters.filterCategoryIds, filters.filterPayeeIds, filters.filterTagIds, filters.filterStartDate, filters.filterEndDate, filters.filterSearch, filters.filterAmountFrom, filters.filterAmountTo, filters.updateUrl, loadTransactions, filters.filtersInitialized, undoRedoTick]); // eslint-disable-line react-hooks/exhaustive-deps

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
      toast('This transaction is linked to an investment. Opening in Investments page.', { icon: '📈' });
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
    toast.success('Scheduled transaction created');
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
      showErrorToast(error, 'Failed to load payee details');
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
      toast.success('Payee updated successfully');
      setShowPayeeForm(false);
      setEditingPayee(undefined);
      setPayees(prev => prev.map(p => p.id === updated.id ? updated : p));
    } catch (error) {
      showErrorToast(error, 'Failed to update payee');
    }
  };

  const handlePayeeFormCancel = () => {
    setShowPayeeForm(false);
    setEditingPayee(undefined);
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
    } else if (filters.filterAccountStatus && filters.filteredAccounts.length > 0) {
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
  }, [filters.filterAccountIds, filters.filterAccountStatus, filters.filteredAccounts, filters.filterCategoryIds, filters.filterPayeeIds, filters.filterTagIds, filters.filterStartDate, filters.filterEndDate, filters.filterSearch, filters.filterAmountFrom, filters.filterAmountTo]);

  // Derive chart currency, aggregated per-date balances, and latest per-account balances
  const { chartBalances, chartCurrency, accountBalances } = useMemo(() => {
    if (dailyBalances.length === 0) {
      return {
        chartBalances: [] as Array<{ date: string; balance: number }>,
        chartCurrency: defaultCurrency,
        accountBalances: [] as Array<{ accountId: string; accountName: string; balance: number }>,
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

    return { chartBalances: aggregated, chartCurrency: displayCurrency, accountBalances: perAccount };
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
      toast.success(`${result.deleted} transaction${result.deleted !== 1 ? 's' : ''} deleted`);
    }

    setShowBulkDeleteConfirm(false);
    setBulkSelectMode(false);
    selection.clearSelection();
    loadAllData();
  }, [selection, loadAllData]);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    try {
      let accountIdsForQuery: string[] | undefined;
      if (filters.filterAccountIds.length > 0) {
        accountIdsForQuery = filters.filterAccountIds;
      } else if (filters.filterAccountStatus && filters.filteredAccounts.length > 0) {
        accountIdsForQuery = filters.filteredAccounts.map(a => a.id);
      }

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
        toast.error('No transactions to export');
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
      toast.success(`Exported ${allTransactions.length} transaction${allTransactions.length !== 1 ? 's' : ''}`);
    } catch (error) {
      showErrorToast(error, 'Failed to export transactions');
      logger.error(error);
    } finally {
      setIsExporting(false);
    }
  }, [filters.filterAccountIds, filters.filterAccountStatus, filters.filteredAccounts, filters.filterCategoryIds, filters.filterPayeeIds, filters.filterTagIds, filters.filterStartDate, filters.filterEndDate, filters.filterSearch, filters.filterAmountFrom, filters.filterAmountTo]);

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title="Transactions"
          subtitle="Manage your income and expenses"
          helpUrl="https://github.com/kenlasko/monize/wiki/Transactions"
          actions={<Button onClick={handleCreateNew}>+ New Transaction</Button>}
        />
        {filters.filterCategoryIds.length > 0 || filters.filterPayeeIds.length > 0 || filters.filterTagIds.length > 0 || filters.filterSearch.length > 0 ? (
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
        ) : accountBalances.length > 1 ? (
          <AccountBalancesBarChart
            data={accountBalances}
            isLoading={isLoading}
            currencyCode={chartCurrency}
            onAccountClick={filters.handleAccountFilterClick}
          />
        ) : (
          <BalanceHistoryChart
            data={chartBalances}
            isLoading={isLoading}
            currencyCode={chartCurrency}
            accountName={balanceHistoryAccountName}
          />
        )}

        {/* Form Modal */}
        <Modal isOpen={showForm} onClose={handleClose} {...modalProps} maxWidth="6xl" className="p-6 !max-w-[69rem]">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {editingTransaction ? 'Edit Transaction' : duplicatingFrom ? 'Duplicate Transaction' : 'New Transaction'}
          </h2>
          <TransactionForm
            key={`${editingTransaction?.id || 'new'}-${duplicatingFrom?.id || ''}-${filters.filterAccountIds.join(',')}-${formKey}`}
            transaction={editingTransaction}
            duplicateFrom={duplicatingFrom}
            defaultAccountId={filters.filterAccountIds.length === 1 ? filters.filterAccountIds[0] : undefined}
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
              Schedule as Recurring
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
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">Edit Payee</h2>
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
          title="Delete Transactions"
          message={`Are you sure you want to delete ${selection.selectionCount} transaction${selection.selectionCount !== 1 ? 's' : ''}? This will also delete any linked transfer counterparts. This action cannot be undone.`}
          confirmLabel="Delete"
          variant="danger"
        />

        {/* Transactions List */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {isLoading && transactions.length === 0 ? (
            <LoadingSpinner text="Loading transactions..." />
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
              budgetStatusMap={budgetStatusMap}
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
              itemName="transactions"
            />
          </div>
        )}

        {/* Show total count when only one page */}
        {pagination && pagination.totalPages <= 1 && pagination.total > 0 && (
          <div className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
            {pagination.total} transaction{pagination.total !== 1 ? 's' : ''}
          </div>
        )}
      </main>
    </PageLayout>
  );
}
