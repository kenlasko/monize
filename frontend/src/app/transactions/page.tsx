'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { TransactionFilterPanel } from '@/components/transactions/TransactionFilterPanel';
import { Pagination } from '@/components/ui/Pagination';
import { TransactionList } from '@/components/transactions/TransactionList';
import { type DensityLevel } from '@/hooks/useTableDensity';
import dynamic from 'next/dynamic';

const TransactionForm = dynamic(() => import('@/components/transactions/TransactionForm').then(m => m.TransactionForm), { ssr: false });
const PayeeForm = dynamic(() => import('@/components/payees/PayeeForm').then(m => m.PayeeForm), { ssr: false });
const BulkUpdateModal = dynamic(() => import('@/components/transactions/BulkUpdateModal').then(m => m.BulkUpdateModal), { ssr: false });
const BalanceHistoryChart = dynamic(() => import('@/components/transactions/BalanceHistoryChart').then(m => m.BalanceHistoryChart), { ssr: false });
const CategoryPayeeBarChart = dynamic(() => import('@/components/transactions/CategoryPayeeBarChart').then(m => m.CategoryPayeeBarChart), { ssr: false });
import { transactionsApi } from '@/lib/transactions';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { payeesApi } from '@/lib/payees';
import { Transaction, PaginationInfo, BulkUpdateData, BulkUpdateFilters, MonthlyTotal } from '@/types/transaction';
import { useTransactionSelection } from '@/hooks/useTransactionSelection';
import { useTransactionFilters } from '@/hooks/useTransactionFilters';
import { BulkSelectionBanner } from '@/components/transactions/BulkSelectionBanner';
import { Account } from '@/types/account';
import { Category } from '@/types/category';
import { Payee } from '@/types/payee';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useDateFormat } from '@/hooks/useDateFormat';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useFormModal } from '@/hooks/useFormModal';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
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
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [dailyBalances, setDailyBalances] = useState<Array<{ date: string; balance: number }>>([]);
  const [monthlyTotals, setMonthlyTotals] = useState<MonthlyTotal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { showForm, editingItem: editingTransaction, openCreate, openEdit, close, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef } = useFormModal<Transaction>();
  const [showPayeeForm, setShowPayeeForm] = useState(false);
  const [editingPayee, setEditingPayee] = useState<Payee | undefined>();
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('monize-transactions-density', 'normal');
  const [showBulkUpdate, setShowBulkUpdate] = useState(false);
  const [bulkSelectMode, setBulkSelectMode] = useState(false);

  // Ref to track whether any modal is open (used by popstate handler to avoid conflicts)
  const modalOpenRef = useRef(false);
  modalOpenRef.current = showForm || showPayeeForm || showBulkUpdate;

  const filters = useTransactionFilters({ accounts, categories, payees, weekStartsOn });

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
      const [accountsData, categoriesData, payeesData] = await Promise.all([
        accountsApi.getAll(true),
        categoriesApi.getAll(),
        payeesApi.getAll(),
      ]);
      setAccounts(accountsData);
      setCategories(categoriesData);
      setPayees(payeesData);
      staticDataLoaded.current = true;
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to load form data'));
      logger.error(error);
    }
  }, []);

  // Load transaction data and chart data in parallel
  const loadTransactions = useCallback(async (page: number) => {
    try {
      let accountIdsForQuery: string[] | undefined;
      if (filters.filterAccountIds.length > 0) {
        accountIdsForQuery = filters.filterAccountIds;
      } else if (filters.filterAccountStatus && filters.filteredAccounts.length > 0) {
        accountIdsForQuery = filters.filteredAccounts.map(a => a.id);
      }

      const targetTransactionId = filters.targetTransactionIdRef.current;
      filters.targetTransactionIdRef.current = null;

      const hasCategoryOrPayeeFilter = filters.filterCategoryIds.length > 0 || filters.filterPayeeIds.length > 0 || filters.filterSearch.length > 0;

      const chartParams: { startDate?: string; endDate?: string; accountIds?: string } = {};
      if (filters.filterStartDate) chartParams.startDate = filters.filterStartDate;
      if (filters.filterEndDate) chartParams.endDate = filters.filterEndDate;
      if (filters.filterAccountIds.length > 0) chartParams.accountIds = filters.filterAccountIds.join(',');

      const chartPromise = hasCategoryOrPayeeFilter
        ? transactionsApi.getMonthlyTotals({
            accountIds: accountIdsForQuery,
            startDate: filters.filterStartDate || undefined,
            endDate: filters.filterEndDate || undefined,
            categoryIds: filters.filterCategoryIds.length > 0 ? filters.filterCategoryIds : undefined,
            payeeIds: filters.filterPayeeIds.length > 0 ? filters.filterPayeeIds : undefined,
            search: filters.filterSearch || undefined,
          }).catch(() => [] as MonthlyTotal[])
        : accountsApi.getDailyBalances(
            Object.keys(chartParams).length > 0 ? chartParams : undefined,
          ).catch(() => [] as Array<{ date: string; balance: number }>);

      const [transactionsResponse, chartResult] = await Promise.all([
        transactionsApi.getAll({
          accountIds: accountIdsForQuery,
          startDate: filters.filterStartDate || undefined,
          endDate: filters.filterEndDate || undefined,
          categoryIds: filters.filterCategoryIds.length > 0 ? filters.filterCategoryIds : undefined,
          payeeIds: filters.filterPayeeIds.length > 0 ? filters.filterPayeeIds : undefined,
          search: filters.filterSearch || undefined,
          page,
          limit: PAGE_SIZE,
          targetTransactionId: targetTransactionId || undefined,
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
        setDailyBalances(chartResult as Array<{ date: string; balance: number }>);
        setMonthlyTotals([]);
      }

      if (targetTransactionId && transactionsResponse.pagination.page !== page) {
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
      toast.error(getErrorMessage(error, 'Failed to load transactions'));
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [filters.filterAccountIds, filters.filterAccountStatus, filters.filteredAccounts, filters.filterCategoryIds, filters.filterPayeeIds, filters.filterStartDate, filters.filterEndDate, filters.filterSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadData = useCallback(async (page: number = filters.currentPage) => {
    await loadTransactions(page);
  }, [filters.currentPage, loadTransactions]);

  const loadAllData = useCallback(async (page: number = filters.currentPage) => {
    staticDataLoaded.current = false;
    loadStaticData();
    await loadTransactions(page);
  }, [filters.currentPage, loadStaticData, loadTransactions]);

  // Load static data once on mount
  useEffect(() => {
    loadStaticData();
  }, [loadStaticData]);

  // Update URL and load transactions when page or filters change
  useEffect(() => {
    if (!filters.filtersInitialized) return;

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
        startDate: filters.filterStartDate,
        endDate: filters.filterEndDate,
        search: filters.filterSearch,
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
  }, [filters.currentPage, filters.filterAccountIds, filters.filterCategoryIds, filters.filterPayeeIds, filters.filterStartDate, filters.filterEndDate, filters.filterSearch, filters.updateUrl, loadTransactions, filters.filtersInitialized]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (transaction.isTransfer) {
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

  const [formKey, setFormKey] = useState(0);

  const handleFormSuccess = () => {
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
      toast.error(getErrorMessage(error, 'Failed to load payee details'));
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
      toast.error(getErrorMessage(error, 'Failed to update payee'));
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
    if (filters.filterStartDate) f.startDate = filters.filterStartDate;
    if (filters.filterEndDate) f.endDate = filters.filterEndDate;
    if (filters.filterSearch) f.search = filters.filterSearch;
    return f;
  }, [filters.filterAccountIds, filters.filterAccountStatus, filters.filteredAccounts, filters.filterCategoryIds, filters.filterPayeeIds, filters.filterStartDate, filters.filterEndDate, filters.filterSearch]);

  const selection = useTransactionSelection(
    transactions,
    pagination?.total ?? 0,
    bulkUpdateFilters,
  );

  const handleBulkUpdate = useCallback(async (updateFields: Partial<Pick<BulkUpdateData, 'payeeId' | 'payeeName' | 'categoryId' | 'description' | 'status'>>) => {
    const payload = selection.buildSelectionPayload();
    const result = await transactionsApi.bulkUpdate({ ...payload, ...updateFields } as BulkUpdateData);

    const parts = [`${result.updated} transaction${result.updated !== 1 ? 's' : ''} updated`];
    if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
    toast.success(parts.join(', '));
    if (result.skippedReasons.length > 0) {
      result.skippedReasons.forEach(reason => toast(reason, { icon: 'ℹ️' }));
    }

    setShowBulkUpdate(false);
    setBulkSelectMode(false);
    selection.clearSelection();
    loadAllData();
    return result;
  }, [selection, loadAllData]);

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title="Transactions"
          subtitle="Manage your income and expenses"
          actions={<Button onClick={handleCreateNew}>+ New Transaction</Button>}
        />
        {filters.filterCategoryIds.length > 0 || filters.filterPayeeIds.length > 0 || filters.filterSearch.length > 0 ? (
          <CategoryPayeeBarChart data={monthlyTotals} isLoading={isLoading} onMonthClick={(startDate, endDate) => {
            filters.isFilterChange.current = true;
            filters.setFilterStartDate(startDate);
            filters.setFilterEndDate(endDate);
            filters.setFilterTimePeriod('custom');
          }} />
        ) : (
          <BalanceHistoryChart data={dailyBalances} isLoading={isLoading} />
        )}

        {/* Form Modal */}
        <Modal isOpen={showForm} onClose={close} {...modalProps} maxWidth="6xl" className="p-6 !max-w-[69rem]">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {editingTransaction ? 'Edit Transaction' : 'New Transaction'}
          </h2>
          <TransactionForm
            key={`${editingTransaction?.id || 'new'}-${filters.filterAccountIds.join(',')}-${formKey}`}
            transaction={editingTransaction}
            defaultAccountId={filters.filterAccountIds.length === 1 ? filters.filterAccountIds[0] : undefined}
            onSuccess={handleFormSuccess}
            onCancel={close}
            onDirtyChange={setFormDirty}
            submitRef={formSubmitRef}
          />
        </Modal>
        <UnsavedChangesDialog {...unsavedChangesDialog} />

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
          filtersExpanded={filters.filtersExpanded}
          setFiltersExpanded={filters.setFiltersExpanded}
          activeFilterCount={filters.activeFilterCount}
          filteredAccounts={filters.filteredAccounts}
          selectedAccounts={filters.selectedAccounts}
          selectedCategories={filters.selectedCategories}
          selectedPayees={filters.selectedPayees}
          accountFilterOptions={filters.accountFilterOptions}
          categoryFilterOptions={filters.categoryFilterOptions}
          payeeFilterOptions={filters.payeeFilterOptions}
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
          />
        )}

        {/* Bulk Update Modal */}
        <BulkUpdateModal
          isOpen={showBulkUpdate}
          onClose={() => setShowBulkUpdate(false)}
          onSubmit={handleBulkUpdate}
          selectionCount={selection.selectionCount}
        />

        {/* Transactions List */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {isLoading && transactions.length === 0 ? (
            <LoadingSpinner text="Loading transactions..." />
          ) : (
            <TransactionList
              transactions={transactions}
              onEdit={handleEdit}
              onRefresh={loadAllData}
              onTransactionUpdate={handleTransactionUpdate}
              onPayeeClick={handlePayeeClick}
              onTransferClick={filters.handleTransferClick}
              onCategoryClick={filters.handleCategoryClick}
              onDateFilterClick={filters.handleDateFilterClick}
              onAccountFilterClick={filters.handleAccountFilterClick}
              onPayeeFilterClick={filters.handlePayeeFilterClick}
              density={listDensity}
              onDensityChange={setListDensity}
              isSingleAccountView={filters.filterAccountIds.length === 1}
              selectionMode={bulkSelectMode}
              selectedIds={selection.selectedIds}
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
