'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { MultiSelect, MultiSelectOption } from '@/components/ui/MultiSelect';
import { Input } from '@/components/ui/Input';
import { Pagination } from '@/components/ui/Pagination';
import { TransactionForm } from '@/components/transactions/TransactionForm';
import { TransactionList, DensityLevel } from '@/components/transactions/TransactionList';
import { PayeeForm } from '@/components/payees/PayeeForm';
import { transactionsApi } from '@/lib/transactions';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { payeesApi } from '@/lib/payees';
import { Transaction, PaginationInfo, TransactionSummary } from '@/types/transaction';
import { Account } from '@/types/account';
import { Category } from '@/types/category';
import { Payee } from '@/types/payee';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { Modal } from '@/components/ui/Modal';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { createLogger } from '@/lib/logger';

const logger = createLogger('Transactions');

const PAGE_SIZE = 50;

// LocalStorage keys for filter persistence
const STORAGE_KEYS = {
  accountIds: 'transactions.filter.accountIds',
  accountStatus: 'transactions.filter.accountStatus',
  categoryIds: 'transactions.filter.categoryIds',
  payeeIds: 'transactions.filter.payeeIds',
  startDate: 'transactions.filter.startDate',
  endDate: 'transactions.filter.endDate',
  search: 'transactions.filter.search',
};

// Helper to get filter values as array
// If ANY URL params are present (navigation from reports), ignore localStorage entirely
// This ensures clicking from a report gives a clean view with just that filter
function getFilterValues(key: string, urlParam: string | null, hasAnyUrlParams: boolean): string[] {
  if (hasAnyUrlParams) {
    // Navigation from external link - only use URL param, ignore localStorage
    return urlParam ? urlParam.split(',').map(s => s.trim()).filter(s => s) : [];
  }
  // No URL params - use localStorage (user's last filter state)
  if (typeof window === 'undefined') return [];
  const stored = localStorage.getItem(key);
  if (!stored) return [];
  try {
    return JSON.parse(stored);
  } catch {
    return [];
  }
}

// Helper to get single string filter value
function getFilterValue(key: string, urlParam: string | null, hasAnyUrlParams: boolean): string {
  if (hasAnyUrlParams) {
    return urlParam || '';
  }
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(key) || '';
}

// Helper to get stored value (for non-URL params like account status)
function getStoredValue<T>(key: string, defaultValue: T): T {
  if (typeof window === 'undefined') return defaultValue;
  const stored = localStorage.getItem(key);
  if (!stored) return defaultValue;
  try {
    return JSON.parse(stored) as T;
  } catch {
    return defaultValue;
  }
}

// Check if an account is specifically an investment brokerage account
const isInvestmentBrokerageAccount = (account: Account): boolean => {
  return account.accountSubType === 'INVESTMENT_BROKERAGE';
};

export default function TransactionsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | undefined>();
  const [showPayeeForm, setShowPayeeForm] = useState(false);
  const [editingPayee, setEditingPayee] = useState<Payee | undefined>();
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('moneymate-transactions-density', 'normal');

  // Pagination state - initialize from URL
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [currentPage, setCurrentPage] = useState(() => {
    const pageParam = searchParams.get('page');
    return pageParam ? parseInt(pageParam, 10) : 1;
  });
  const [startingBalance, setStartingBalance] = useState<number | undefined>();

  // Summary from API (for all matching transactions, not just current page)
  const [summary, setSummary] = useState<TransactionSummary>({
    totalIncome: 0,
    totalExpenses: 0,
    netCashFlow: 0,
    transactionCount: 0,
  });

  // Filters - initialize from URL params, falling back to localStorage
  const [filterAccountIds, setFilterAccountIds] = useState<string[]>([]);
  const [filterAccountStatus, setFilterAccountStatus] = useState<'active' | 'closed' | ''>(() =>
    getStoredValue<'active' | 'closed' | ''>(STORAGE_KEYS.accountStatus, '')
  );
  const [filterCategoryIds, setFilterCategoryIds] = useState<string[]>([]);
  const [filterPayeeIds, setFilterPayeeIds] = useState<string[]>([]);
  const [filterStartDate, setFilterStartDate] = useState<string>('');
  const [filterEndDate, setFilterEndDate] = useState<string>('');
  const [filterSearch, setFilterSearch] = useState<string>('');
  const [filtersInitialized, setFiltersInitialized] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(true);

  // Update URL when filters or page change
  const updateUrl = useCallback((page: number, filters: {
    accountIds: string[];
    categoryIds: string[];
    payeeIds: string[];
    startDate: string;
    endDate: string;
    search: string;
  }) => {
    const params = new URLSearchParams();
    if (page > 1) params.set('page', page.toString());
    if (filters.accountIds.length) params.set('accountIds', filters.accountIds.join(','));
    if (filters.categoryIds.length) params.set('categoryIds', filters.categoryIds.join(','));
    if (filters.payeeIds.length) params.set('payeeIds', filters.payeeIds.join(','));
    if (filters.startDate) params.set('startDate', filters.startDate);
    if (filters.endDate) params.set('endDate', filters.endDate);
    if (filters.search) params.set('search', filters.search);

    const queryString = params.toString();
    const newUrl = queryString ? `/transactions?${queryString}` : '/transactions';
    router.replace(newUrl, { scroll: false });
  }, [router]);

  // Get display info for selected filters
  const selectedCategories = filterCategoryIds.map(id => {
    if (id === 'uncategorized') return { id, name: 'Uncategorized', color: null } as Category;
    if (id === 'transfer') return { id, name: 'Transfers', color: null } as Category;
    return categories.find(c => c.id === id);
  }).filter((c): c is Category => c !== undefined);

  const selectedPayees = filterPayeeIds
    .map(id => payees.find(p => p.id === id))
    .filter((p): p is Payee => p !== undefined);

  // Get selected accounts for chips
  const selectedAccounts = filterAccountIds
    .map(id => accounts.find(a => a.id === id))
    .filter((a): a is Account => a !== undefined);

  // Filter accounts by status for the dropdown
  const filteredAccounts = useMemo(() => {
    return accounts.filter(account => {
      // Always exclude investment brokerage accounts from transactions
      if (isInvestmentBrokerageAccount(account)) return false;
      // Apply status filter
      if (filterAccountStatus === 'active') return !account.isClosed;
      if (filterAccountStatus === 'closed') return account.isClosed;
      return true; // 'all' - show all non-investment accounts
    });
  }, [accounts, filterAccountStatus]);

  // When account status filter changes, remove any selected accounts that no longer match
  // But only after accounts have loaded - otherwise we'd clear selections before we can validate them
  useEffect(() => {
    if (!filtersInitialized || filterAccountIds.length === 0 || accounts.length === 0) return;
    const filteredIds = new Set(filteredAccounts.map(a => a.id));
    const validSelectedIds = filterAccountIds.filter(id => filteredIds.has(id));
    if (validSelectedIds.length !== filterAccountIds.length) {
      setFilterAccountIds(validSelectedIds);
    }
  }, [filterAccountStatus, filteredAccounts, filtersInitialized, accounts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Calculate active filter count
  const activeFilterCount = useMemo(() => {
    let count = 0;
    count += filterAccountIds.length;
    count += filterCategoryIds.length;
    count += filterPayeeIds.length;
    if (filterStartDate) count++;
    if (filterEndDate) count++;
    if (filterSearch) count++;
    return count;
  }, [filterAccountIds, filterCategoryIds, filterPayeeIds, filterStartDate, filterEndDate, filterSearch]);

  // Auto-collapse filters when there are active filters, expand when none
  useEffect(() => {
    if (filtersInitialized) {
      setFiltersExpanded(activeFilterCount === 0);
    }
  }, [filtersInitialized]); // Only run when filters are first initialized

  // Track if static data has been loaded
  const staticDataLoaded = useRef(false);

  // Load static data (accounts, categories, payees) - only runs once
  const loadStaticData = useCallback(async () => {
    if (staticDataLoaded.current) return;

    try {
      const [accountsData, categoriesData, payeesData] = await Promise.all([
        accountsApi.getAll(true), // Include closed accounts for status filter
        categoriesApi.getAll(),
        payeesApi.getAll(),
      ]);
      setAccounts(accountsData);
      setCategories(categoriesData);
      setPayees(payeesData);
      staticDataLoaded.current = true;
    } catch (error) {
      toast.error('Failed to load form data');
      logger.error(error);
    }
  }, []);

  // Load transaction data based on filters - runs when filters/page change
  const loadTransactions = useCallback(async (page: number) => {
    setIsLoading(true);
    try {
      // Determine which account IDs to use for the query
      // If specific accounts are selected, use those
      // Otherwise, if a status filter is active, use all accounts matching that status
      let accountIdsForQuery: string[] | undefined;
      if (filterAccountIds.length > 0) {
        accountIdsForQuery = filterAccountIds;
      } else if (filterAccountStatus && filteredAccounts.length > 0) {
        // Status filter is active but no specific accounts selected - use all filtered accounts
        accountIdsForQuery = filteredAccounts.map(a => a.id);
      }

      // Check if we need to navigate to a specific transaction
      const targetTransactionId = targetTransactionIdRef.current;
      targetTransactionIdRef.current = null; // Clear after reading

      const [transactionsResponse, summaryData] = await Promise.all([
        transactionsApi.getAll({
          accountIds: accountIdsForQuery,
          startDate: filterStartDate || undefined,
          endDate: filterEndDate || undefined,
          categoryIds: filterCategoryIds.length > 0 ? filterCategoryIds : undefined,
          payeeIds: filterPayeeIds.length > 0 ? filterPayeeIds : undefined,
          search: filterSearch || undefined,
          page,
          limit: PAGE_SIZE,
          targetTransactionId: targetTransactionId || undefined,
        }),
        transactionsApi.getSummary({
          accountIds: accountIdsForQuery,
          startDate: filterStartDate || undefined,
          endDate: filterEndDate || undefined,
          categoryIds: filterCategoryIds.length > 0 ? filterCategoryIds : undefined,
          payeeIds: filterPayeeIds.length > 0 ? filterPayeeIds : undefined,
          search: filterSearch || undefined,
        }),
      ]);

      setTransactions(transactionsResponse.data);
      setPagination(transactionsResponse.pagination);
      setStartingBalance(transactionsResponse.startingBalance);
      setSummary(summaryData);

      // If we navigated to a specific transaction, update the page from the response
      if (targetTransactionId && transactionsResponse.pagination.page !== page) {
        setCurrentPage(transactionsResponse.pagination.page);
      }
    } catch (error) {
      toast.error('Failed to load transactions');
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [filterAccountIds, filterAccountStatus, filteredAccounts, filterCategoryIds, filterPayeeIds, filterStartDate, filterEndDate, filterSearch]);

  // Refresh all data (called after form submission)
  const loadData = useCallback(async (page: number = currentPage) => {
    // Refresh static data in case user created new payee/category in form
    staticDataLoaded.current = false;
    loadStaticData();
    await loadTransactions(page);
  }, [currentPage, loadStaticData, loadTransactions]);

  // Load static data once on mount
  useEffect(() => {
    loadStaticData();
  }, [loadStaticData]);

  // Initialize filters on mount
  // If ANY URL params are present (navigation from reports/links), ignore localStorage
  // This ensures clicking from a report gives a clean view with just that filter
  useEffect(() => {
    const hasAnyUrlParams = searchParams.has('accountId') ||
      searchParams.has('accountIds') ||
      searchParams.has('categoryId') ||
      searchParams.has('categoryIds') ||
      searchParams.has('payeeId') ||
      searchParams.has('payeeIds') ||
      searchParams.has('startDate') ||
      searchParams.has('endDate') ||
      searchParams.has('search');

    // Handle backward compatibility with single-value params
    const getAccountIds = () => {
      const ids = searchParams.get('accountIds');
      const id = searchParams.get('accountId');
      return getFilterValues(STORAGE_KEYS.accountIds, ids || id, hasAnyUrlParams);
    };

    const getCategoryIds = () => {
      const ids = searchParams.get('categoryIds');
      const id = searchParams.get('categoryId');
      return getFilterValues(STORAGE_KEYS.categoryIds, ids || id, hasAnyUrlParams);
    };

    const getPayeeIds = () => {
      const ids = searchParams.get('payeeIds');
      const id = searchParams.get('payeeId');
      return getFilterValues(STORAGE_KEYS.payeeIds, ids || id, hasAnyUrlParams);
    };

    setFilterAccountIds(getAccountIds());
    setFilterCategoryIds(getCategoryIds());
    setFilterPayeeIds(getPayeeIds());
    setFilterStartDate(getFilterValue(STORAGE_KEYS.startDate, searchParams.get('startDate'), hasAnyUrlParams));
    setFilterEndDate(getFilterValue(STORAGE_KEYS.endDate, searchParams.get('endDate'), hasAnyUrlParams));
    setFilterSearch(getFilterValue(STORAGE_KEYS.search, searchParams.get('search'), hasAnyUrlParams));
    setFiltersInitialized(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist filter changes to localStorage
  useEffect(() => {
    if (!filtersInitialized) return;
    localStorage.setItem(STORAGE_KEYS.accountIds, JSON.stringify(filterAccountIds));
  }, [filterAccountIds, filtersInitialized]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.accountStatus, JSON.stringify(filterAccountStatus));
  }, [filterAccountStatus]);

  useEffect(() => {
    if (!filtersInitialized) return;
    localStorage.setItem(STORAGE_KEYS.categoryIds, JSON.stringify(filterCategoryIds));
  }, [filterCategoryIds, filtersInitialized]);

  useEffect(() => {
    if (!filtersInitialized) return;
    localStorage.setItem(STORAGE_KEYS.payeeIds, JSON.stringify(filterPayeeIds));
  }, [filterPayeeIds, filtersInitialized]);

  useEffect(() => {
    if (!filtersInitialized) return;
    localStorage.setItem(STORAGE_KEYS.startDate, filterStartDate);
  }, [filterStartDate, filtersInitialized]);

  useEffect(() => {
    if (!filtersInitialized) return;
    localStorage.setItem(STORAGE_KEYS.endDate, filterEndDate);
  }, [filterEndDate, filtersInitialized]);

  useEffect(() => {
    if (!filtersInitialized) return;
    localStorage.setItem(STORAGE_KEYS.search, filterSearch);
  }, [filterSearch, filtersInitialized]);

  // Track if this is a filter-triggered change (to reset page to 1)
  const isFilterChange = useRef(false);
  // Target transaction ID for navigating to a specific transaction (e.g., from transfer click)
  const targetTransactionIdRef = useRef<string | null>(null);

  // Update URL and load transactions when page or filters change
  useEffect(() => {
    // Wait for filters to be initialized from localStorage
    if (!filtersInitialized) return;

    const page = isFilterChange.current ? 1 : currentPage;
    if (isFilterChange.current) {
      setCurrentPage(1);
      isFilterChange.current = false;
    }
    updateUrl(page, {
      accountIds: filterAccountIds,
      categoryIds: filterCategoryIds,
      payeeIds: filterPayeeIds,
      startDate: filterStartDate,
      endDate: filterEndDate,
      search: filterSearch,
    });
    loadTransactions(page);
  }, [currentPage, filterAccountIds, filterCategoryIds, filterPayeeIds, filterStartDate, filterEndDate, filterSearch, updateUrl, loadTransactions, filtersInitialized]);

  // Helper to update array filter and mark as filter change
  const handleArrayFilterChange = useCallback(<T,>(setter: (value: T) => void, value: T) => {
    isFilterChange.current = true;
    setter(value);
  }, []);

  // Helper to update string filter and mark as filter change
  const handleFilterChange = useCallback((setter: (value: string) => void, value: string) => {
    isFilterChange.current = true;
    setter(value);
  }, []);

  const handleCreateNew = () => {
    setEditingTransaction(undefined);
    setShowForm(true);
  };

  const handleEdit = async (transaction: Transaction) => {
    // For investment-linked transactions, redirect to the investments page with the transaction ID
    if (transaction.linkedInvestmentTransactionId) {
      toast('This transaction is linked to an investment. Opening in Investments page.', {
        icon: '📈',
      });
      router.push(`/investments?edit=${transaction.linkedInvestmentTransactionId}`);
      return;
    }

    // For transfers, fetch the full transaction with linkedTransaction relation
    if (transaction.isTransfer) {
      try {
        const fullTransaction = await transactionsApi.getById(transaction.id);
        setEditingTransaction(fullTransaction);
      } catch (error) {
        logger.error('Failed to load transaction details:', error);
        // Fall back to using the list transaction
        setEditingTransaction(transaction);
      }
    } else {
      setEditingTransaction(transaction);
    }
    setShowForm(true);
  };

  const [formKey, setFormKey] = useState(0);

  const handleFormSuccess = () => {
    setShowForm(false);
    setEditingTransaction(undefined);
    setFormKey(prev => prev + 1); // Force form re-creation on next open
    loadData();
  };

  const handleFormCancel = () => {
    setShowForm(false);
    setEditingTransaction(undefined);
  };

  const handlePayeeClick = async (payeeId: string) => {
    try {
      const payee = await payeesApi.getById(payeeId);
      setEditingPayee(payee);
      setShowPayeeForm(true);
    } catch (error) {
      toast.error('Failed to load payee details');
      logger.error(error);
    }
  };

  const handleTransferClick = useCallback((linkedAccountId: string, linkedTransactionId: string) => {
    // Navigate to the linked account and jump to the page containing the linked transaction
    // Store the target transaction ID so loadTransactions can request the correct page
    targetTransactionIdRef.current = linkedTransactionId;
    // Reset account status filter to show all accounts (in case the linked account doesn't match current status filter)
    setFilterAccountStatus('');
    // Set the account filter to the linked account
    isFilterChange.current = true;
    setFilterAccountIds([linkedAccountId]);
  }, []);

  const handlePayeeFormSubmit = async (data: any) => {
    if (!editingPayee) return;
    try {
      const cleanedData = {
        ...data,
        defaultCategoryId: data.defaultCategoryId || undefined,
        notes: data.notes || undefined,
      };
      await payeesApi.update(editingPayee.id, cleanedData);
      toast.success('Payee updated successfully');
      setShowPayeeForm(false);
      setEditingPayee(undefined);
      // Reload payees list and transactions to reflect any changes
      const payeesData = await payeesApi.getAll();
      setPayees(payeesData);
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to update payee';
      toast.error(message);
    }
  };

  const handlePayeeFormCancel = () => {
    setShowPayeeForm(false);
    setEditingPayee(undefined);
  };

  const goToPage = (page: number) => {
    if (page >= 1 && (!pagination || page <= pagination.totalPages)) {
      setCurrentPage(page);
    }
  };

  // Handle in-place transaction update (e.g., clearing status) without full refresh
  // Preserve linkedInvestmentTransactionId since it's only computed in findAll
  const handleTransactionUpdate = useCallback((updatedTransaction: Transaction) => {
    setTransactions(prev =>
      prev.map(tx => tx.id === updatedTransaction.id
        ? { ...updatedTransaction, linkedInvestmentTransactionId: tx.linkedInvestmentTransactionId }
        : tx
      )
    );
  }, []);

  return (
    <PageLayout>
      <PageHeader
        title="Transactions"
        subtitle="Manage your income and expenses"
        actions={<Button onClick={handleCreateNew}>+ New Transaction</Button>}
        borderStyle="border"
        paddingClass="px-4 sm:px-6 lg:px-12 py-4"
      />

      <div className="px-4 sm:px-6 lg:px-12 py-8">
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <SummaryCard
            label="Total Income"
            value={formatCurrency(summary.totalIncome)}
            icon={SummaryIcons.plus}
            valueColor="green"
          />
          <SummaryCard
            label="Total Expenses"
            value={formatCurrency(summary.totalExpenses)}
            icon={SummaryIcons.minus}
            valueColor="red"
          />
          <SummaryCard
            label="Net Cash Flow"
            value={formatCurrency(summary.netCashFlow)}
            icon={SummaryIcons.money}
            valueColor={summary.netCashFlow >= 0 ? 'blue' : 'red'}
          />
        </div>

        {/* Form Modal */}
        <Modal isOpen={showForm} onClose={handleFormCancel} maxWidth="6xl" className="p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {editingTransaction ? 'Edit Transaction' : 'New Transaction'}
          </h2>
          <TransactionForm
            key={`${editingTransaction?.id || 'new'}-${filterAccountIds.join(',')}-${formKey}`}
            transaction={editingTransaction}
            defaultAccountId={filterAccountIds.length === 1 ? filterAccountIds[0] : undefined}
            onSuccess={handleFormSuccess}
            onCancel={handleFormCancel}
          />
        </Modal>

        {/* Payee Edit Modal */}
        {editingPayee && (
          <Modal isOpen={showPayeeForm} onClose={handlePayeeFormCancel} maxWidth="lg" className="p-6">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
              Edit Payee
            </h2>
            <PayeeForm
              payee={editingPayee}
              categories={categories}
              onSubmit={handlePayeeFormSubmit}
              onCancel={handlePayeeFormCancel}
            />
          </Modal>
        )}

        {/* Quick Account Select - Favourites */}
        {filteredAccounts.filter(a => a.isFavourite).length > 0 && (
          <div className="flex items-center gap-2 mb-4 overflow-x-auto pb-1">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap flex-shrink-0">
              Favourites:
            </span>
            {filteredAccounts
              .filter(a => a.isFavourite)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map(account => {
                const isSelected = filterAccountIds.includes(account.id);
                return (
                  <button
                    key={account.id}
                    onClick={() => {
                      if (isSelected && filterAccountIds.length === 1) {
                        // Already the only selected account - deselect to show all
                        handleArrayFilterChange(setFilterAccountIds, []);
                      } else {
                        // Select only this account
                        handleArrayFilterChange(setFilterAccountIds, [account.id]);
                      }
                    }}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
                      isSelected
                        ? 'bg-emerald-700 text-white dark:bg-emerald-600'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                    }`}
                  >
                    <svg className="w-3.5 h-3.5 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                    {account.name}
                  </button>
                );
              })}
          </div>
        )}

        {/* Filters - Collapsible Panel */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg mb-6">
          {/* Filter Header - Always Visible, Clickable to toggle */}
          <div
            className="px-4 py-3 sm:px-6 cursor-pointer select-none"
            onClick={() => setFiltersExpanded(!filtersExpanded)}
          >
            <div className="flex items-center justify-between gap-4">
              {/* Left side: Filter icon, title, and count */}
              <div className="flex items-center gap-2 min-w-0">
                <svg className="w-5 h-5 text-gray-500 dark:text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                </svg>
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Filters</span>
                {activeFilterCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-xs font-medium rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200">
                    {activeFilterCount}
                  </span>
                )}
              </div>

              {/* Right side: Clear and Toggle buttons */}
              <div className="flex items-center gap-2 flex-shrink-0">
                {activeFilterCount > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setCurrentPage(1);
                      setFilterAccountIds([]);
                      setFilterAccountStatus('');
                      setFilterCategoryIds([]);
                      setFilterPayeeIds([]);
                      setFilterStartDate('');
                      setFilterEndDate('');
                      setFilterSearch('');
                      localStorage.removeItem(STORAGE_KEYS.accountIds);
                      localStorage.removeItem(STORAGE_KEYS.accountStatus);
                      localStorage.removeItem(STORAGE_KEYS.categoryIds);
                      localStorage.removeItem(STORAGE_KEYS.payeeIds);
                      localStorage.removeItem(STORAGE_KEYS.startDate);
                      localStorage.removeItem(STORAGE_KEYS.endDate);
                      localStorage.removeItem(STORAGE_KEYS.search);
                      router.replace('/transactions', { scroll: false });
                      // Don't change filtersExpanded state - keep current collapse state
                    }}
                    className="text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  >
                    Clear
                  </button>
                )}
                <span className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 dark:text-blue-400">
                  {filtersExpanded ? 'Hide' : 'Show'}
                  <svg
                    className={`w-4 h-4 transition-transform duration-200 ${filtersExpanded ? 'rotate-180' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </span>
              </div>
            </div>

            {/* Active Filter Chips - Show when collapsed and filters are active */}
            {!filtersExpanded && activeFilterCount > 0 && (
              <div className="flex gap-2 mt-3 overflow-x-auto pb-1 -mx-4 px-4 sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible" onClick={(e) => e.stopPropagation()}>
                {/* Account chips - Emerald */}
                {selectedAccounts.map(account => (
                  <span
                    key={`account-${account.id}`}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 dark:bg-emerald-900 text-emerald-800 dark:text-emerald-200 whitespace-nowrap"
                  >
                    {account.name}
                    <button
                      onClick={() => handleArrayFilterChange(setFilterAccountIds, filterAccountIds.filter(id => id !== account.id))}
                      className="hover:text-emerald-600 dark:hover:text-emerald-100"
                    >
                      ×
                    </button>
                  </span>
                ))}
                {/* Category chips - Blue with color dot */}
                {selectedCategories.map(cat => (
                  <span
                    key={`category-${cat.id}`}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 whitespace-nowrap"
                  >
                    {cat.color && (
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: cat.color }}
                      />
                    )}
                    {cat.name}
                    <button
                      onClick={() => handleArrayFilterChange(setFilterCategoryIds, filterCategoryIds.filter(id => id !== cat.id))}
                      className="hover:text-blue-600 dark:hover:text-blue-100"
                    >
                      ×
                    </button>
                  </span>
                ))}
                {/* Payee chips - Purple */}
                {selectedPayees.map(payee => (
                  <span
                    key={`payee-${payee.id}`}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200 whitespace-nowrap"
                  >
                    {payee.name}
                    <button
                      onClick={() => handleArrayFilterChange(setFilterPayeeIds, filterPayeeIds.filter(id => id !== payee.id))}
                      className="hover:text-purple-600 dark:hover:text-purple-100"
                    >
                      ×
                    </button>
                  </span>
                ))}
                {/* Date range chip - Amber */}
                {(filterStartDate || filterEndDate) && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200 whitespace-nowrap">
                    {filterStartDate && filterEndDate
                      ? `${formatDate(filterStartDate)} - ${formatDate(filterEndDate)}`
                      : filterStartDate
                        ? `From ${formatDate(filterStartDate)}`
                        : `Until ${formatDate(filterEndDate)}`}
                    <button
                      onClick={() => {
                        handleFilterChange(setFilterStartDate, '');
                        handleFilterChange(setFilterEndDate, '');
                      }}
                      className="hover:text-amber-600 dark:hover:text-amber-100"
                    >
                      ×
                    </button>
                  </span>
                )}
                {/* Search chip - Gray */}
                {filterSearch && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200 whitespace-nowrap">
                    &quot;{filterSearch}&quot;
                    <button
                      onClick={() => handleFilterChange(setFilterSearch, '')}
                      className="hover:text-gray-600 dark:hover:text-gray-100"
                    >
                      ×
                    </button>
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Collapsible Filter Body */}
          <div
            className="grid transition-[grid-template-rows] duration-200 ease-in-out"
            style={{ gridTemplateRows: filtersExpanded ? '1fr' : '0fr' }}
          >
            <div className={filtersExpanded ? '' : 'overflow-hidden'}>
              <div className="px-4 pb-4 sm:px-6 border-t border-gray-200 dark:border-gray-700">
                {/* Account status segmented control */}
                <div className="flex items-center gap-3 pt-4 pb-2">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Show accounts:</span>
                  <div className="inline-flex rounded-md shadow-sm">
                    <button
                      onClick={() => setFilterAccountStatus('')}
                      className={`px-3 py-1.5 text-sm font-medium rounded-l-md border ${
                        filterAccountStatus === ''
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                      }`}
                    >
                      All
                    </button>
                    <button
                      onClick={() => setFilterAccountStatus('active')}
                      className={`px-3 py-1.5 text-sm font-medium border-t border-b ${
                        filterAccountStatus === 'active'
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                      }`}
                    >
                      Active
                    </button>
                    <button
                      onClick={() => setFilterAccountStatus('closed')}
                      className={`px-3 py-1.5 text-sm font-medium rounded-r-md border ${
                        filterAccountStatus === 'closed'
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                      }`}
                    >
                      Closed
                    </button>
                  </div>
                </div>

                {/* First row: Main filters */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
                  <MultiSelect
                    label="Accounts"
                    options={filteredAccounts
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map(account => ({
                        value: account.id,
                        label: account.name,
                      }))}
                    value={filterAccountIds}
                    onChange={(values) => handleArrayFilterChange(setFilterAccountIds, values)}
                    placeholder="All accounts"
                  />

                  <MultiSelect
                    label="Categories"
                    options={(() => {
                      const specialOptions: MultiSelectOption[] = [
                        { value: 'uncategorized', label: 'Uncategorized' },
                        { value: 'transfer', label: 'Transfers' },
                      ];
                      const buildOptions = (parentId: string | null = null): MultiSelectOption[] => {
                        return categories
                          .filter(c => c.parentId === parentId)
                          .sort((a, b) => a.name.localeCompare(b.name))
                          .flatMap(cat => {
                            const children = buildOptions(cat.id);
                            return [{
                              value: cat.id,
                              label: cat.name,
                              parentId: cat.parentId,
                              children: children.length > 0 ? children : undefined,
                            }];
                          });
                      };
                      return [...specialOptions, ...buildOptions()];
                    })()}
                    value={filterCategoryIds}
                    onChange={(values) => handleArrayFilterChange(setFilterCategoryIds, values)}
                    placeholder="All categories"
                  />

                  <MultiSelect
                    label="Payees"
                    options={payees
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map(payee => ({
                        value: payee.id,
                        label: payee.name,
                      }))}
                    value={filterPayeeIds}
                    onChange={(values) => handleArrayFilterChange(setFilterPayeeIds, values)}
                    placeholder="All payees"
                  />
                </div>

                {/* Second row: Dates and search */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
                  <Input
                    label="Start Date"
                    type="date"
                    value={filterStartDate}
                    onChange={(e) => handleFilterChange(setFilterStartDate, e.target.value)}
                  />

                  <Input
                    label="End Date"
                    type="date"
                    value={filterEndDate}
                    onChange={(e) => handleFilterChange(setFilterEndDate, e.target.value)}
                  />

                  <Input
                    label="Search"
                    type="text"
                    value={filterSearch}
                    onChange={(e) => handleFilterChange(setFilterSearch, e.target.value)}
                    placeholder="Search descriptions..."
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Transactions List */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {isLoading ? (
            <LoadingSpinner text="Loading transactions..." />
          ) : (
            <TransactionList
              transactions={transactions}
              onEdit={handleEdit}
              onRefresh={loadData}
              onTransactionUpdate={handleTransactionUpdate}
              onPayeeClick={handlePayeeClick}
              onTransferClick={handleTransferClick}
              density={listDensity}
              onDensityChange={setListDensity}
              isSingleAccountView={filterAccountIds.length === 1}
              startingBalance={startingBalance}
              currentPage={currentPage}
              totalPages={pagination?.totalPages ?? 1}
              totalItems={pagination?.total ?? 0}
              pageSize={PAGE_SIZE}
              onPageChange={goToPage}
            />
          )}
        </div>

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 && (
          <div className="mt-4">
            <Pagination
              currentPage={currentPage}
              totalPages={pagination.totalPages}
              totalItems={pagination.total}
              pageSize={PAGE_SIZE}
              onPageChange={goToPage}
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
      </div>
    </PageLayout>
  );
}
