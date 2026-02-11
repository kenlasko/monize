'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { MultiSelectOption } from '@/components/ui/MultiSelect';
import { TransactionFilterPanel } from '@/components/transactions/TransactionFilterPanel';
import { Pagination } from '@/components/ui/Pagination';
import { TransactionList, DensityLevel } from '@/components/transactions/TransactionList';
import dynamic from 'next/dynamic';

const TransactionForm = dynamic(() => import('@/components/transactions/TransactionForm').then(m => m.TransactionForm), { ssr: false });
const PayeeForm = dynamic(() => import('@/components/payees/PayeeForm').then(m => m.PayeeForm), { ssr: false });
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
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { Modal } from '@/components/ui/Modal';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

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
  return (
    <ProtectedRoute>
      <TransactionsContent />
    </ProtectedRoute>
  );
}

function TransactionsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const { convertToDefault } = useExchangeRates();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | undefined>();
  const [showPayeeForm, setShowPayeeForm] = useState(false);
  const [editingPayee, setEditingPayee] = useState<Payee | undefined>();
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('monize-transactions-density', 'normal');

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

  // Convert per-currency totals to the user's base currency
  const convertedSummary = useMemo(() => {
    const bc = summary.byCurrency;
    if (!bc || Object.keys(bc).length <= 1) {
      // Single currency or no breakdown — use raw totals (no conversion needed)
      return { totalIncome: summary.totalIncome, totalExpenses: summary.totalExpenses, netCashFlow: summary.netCashFlow };
    }
    let totalIncome = 0;
    let totalExpenses = 0;
    for (const [currency, data] of Object.entries(bc)) {
      totalIncome += convertToDefault(data.totalIncome, currency);
      totalExpenses += convertToDefault(data.totalExpenses, currency);
    }
    return { totalIncome, totalExpenses, netCashFlow: totalIncome - totalExpenses };
  }, [summary, convertToDefault]);

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
  const [searchInput, setSearchInput] = useState<string>('');
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);
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

  // Memoize filter option arrays to avoid rebuilding on every render
  const categoryFilterOptions = useMemo(() => {
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
  }, [categories]);

  const accountFilterOptions = useMemo(() => {
    return filteredAccounts
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(account => ({
        value: account.id,
        label: account.name,
      }));
  }, [filteredAccounts]);

  const payeeFilterOptions = useMemo(() => {
    return payees
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(payee => ({
        value: payee.id,
        label: payee.name,
      }));
  }, [payees]);

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
      toast.error(getErrorMessage(error, 'Failed to load form data'));
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
      toast.error(getErrorMessage(error, 'Failed to load transactions'));
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
    const initialSearch = getFilterValue(STORAGE_KEYS.search, searchParams.get('search'), hasAnyUrlParams);
    setFilterSearch(initialSearch);
    setSearchInput(initialSearch);
    setFiltersInitialized(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist filter changes to localStorage (single effect instead of 7 separate ones)
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.accountStatus, JSON.stringify(filterAccountStatus));
  }, [filterAccountStatus]);

  useEffect(() => {
    if (!filtersInitialized) return;
    localStorage.setItem(STORAGE_KEYS.accountIds, JSON.stringify(filterAccountIds));
    localStorage.setItem(STORAGE_KEYS.categoryIds, JSON.stringify(filterCategoryIds));
    localStorage.setItem(STORAGE_KEYS.payeeIds, JSON.stringify(filterPayeeIds));
    localStorage.setItem(STORAGE_KEYS.startDate, filterStartDate);
    localStorage.setItem(STORAGE_KEYS.endDate, filterEndDate);
    localStorage.setItem(STORAGE_KEYS.search, filterSearch);
  }, [filterAccountIds, filterCategoryIds, filterPayeeIds, filterStartDate, filterEndDate, filterSearch, filtersInitialized]);

  // Track if this is a filter-triggered change (to reset page to 1)
  const isFilterChange = useRef(false);
  // Target transaction ID for navigating to a specific transaction (e.g., from transfer click)
  const targetTransactionIdRef = useRef<string | null>(null);
  // Debounce timer for filter-triggered loads (prevents rapid consecutive API calls)
  const filterDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Update URL and load transactions when page or filters change
  useEffect(() => {
    // Wait for filters to be initialized from localStorage
    if (!filtersInitialized) return;

    const page = isFilterChange.current ? 1 : currentPage;
    const wasFilterChange = isFilterChange.current;
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

    // Debounce filter changes to prevent rapid consecutive API calls
    // (e.g., quickly changing category then payee). Page changes load immediately.
    if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
    if (wasFilterChange) {
      filterDebounceRef.current = setTimeout(() => {
        loadTransactions(page);
      }, 150);
    } else {
      loadTransactions(page);
    }
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

  // Debounced search handler - updates input immediately, delays API call
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      isFilterChange.current = true;
      setFilterSearch(value);
    }, 300);
  }, []);

  // Cleanup debounce timers on unmount
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
    };
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
      toast.error(getErrorMessage(error, 'Failed to load payee details'));
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
      const updated = await payeesApi.update(editingPayee.id, cleanedData);
      toast.success('Payee updated successfully');
      setShowPayeeForm(false);
      setEditingPayee(undefined);
      // Update payee in-place instead of refetching all payees
      setPayees(prev => prev.map(p => p.id === updated.id ? updated : p));
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to update payee'));
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
      <main className="px-4 sm:px-6 lg:px-12 py-8">
        <PageHeader
          title="Transactions"
          subtitle="Manage your income and expenses"
          actions={<Button onClick={handleCreateNew}>+ New Transaction</Button>}
        />
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <SummaryCard
            label="Total Income"
            value={formatCurrency(convertedSummary.totalIncome)}
            icon={SummaryIcons.plus}
            valueColor="green"
          />
          <SummaryCard
            label="Total Expenses"
            value={formatCurrency(convertedSummary.totalExpenses)}
            icon={SummaryIcons.minus}
            valueColor="red"
          />
          <SummaryCard
            label="Net Cash Flow"
            value={formatCurrency(convertedSummary.netCashFlow)}
            icon={SummaryIcons.money}
            valueColor={convertedSummary.netCashFlow >= 0 ? 'blue' : 'red'}
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

        <TransactionFilterPanel
          filterAccountIds={filterAccountIds}
          filterCategoryIds={filterCategoryIds}
          filterPayeeIds={filterPayeeIds}
          filterStartDate={filterStartDate}
          filterEndDate={filterEndDate}
          filterSearch={filterSearch}
          searchInput={searchInput}
          filterAccountStatus={filterAccountStatus}
          handleArrayFilterChange={handleArrayFilterChange}
          handleFilterChange={handleFilterChange}
          handleSearchChange={handleSearchChange}
          setFilterAccountStatus={setFilterAccountStatus}
          setFilterAccountIds={setFilterAccountIds}
          setFilterCategoryIds={setFilterCategoryIds}
          setFilterPayeeIds={setFilterPayeeIds}
          setFilterStartDate={setFilterStartDate}
          setFilterEndDate={setFilterEndDate}
          setFilterSearch={setFilterSearch}
          filtersExpanded={filtersExpanded}
          setFiltersExpanded={setFiltersExpanded}
          activeFilterCount={activeFilterCount}
          filteredAccounts={filteredAccounts}
          selectedAccounts={selectedAccounts}
          selectedCategories={selectedCategories}
          selectedPayees={selectedPayees}
          accountFilterOptions={accountFilterOptions}
          categoryFilterOptions={categoryFilterOptions}
          payeeFilterOptions={payeeFilterOptions}
          formatDate={formatDate}
          onClearFilters={() => {
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
          }}
        />

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
      </main>
    </PageLayout>
  );
}
