'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { MultiSelect, MultiSelectOption } from '@/components/ui/MultiSelect';
import { ChipsInput } from '@/components/ui/ChipsInput';
import { Input } from '@/components/ui/Input';
import { Pagination } from '@/components/ui/Pagination';
import { TransactionForm } from '@/components/transactions/TransactionForm';
import { TransactionList, DensityLevel } from '@/components/transactions/TransactionList';
import { transactionsApi } from '@/lib/transactions';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { payeesApi } from '@/lib/payees';
import { Transaction, PaginationInfo, TransactionSummary } from '@/types/transaction';
import { Account } from '@/types/account';
import { Category } from '@/types/category';
import { Payee } from '@/types/payee';
import { getCategorySelectOptions } from '@/lib/categoryUtils';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useDateFormat } from '@/hooks/useDateFormat';
import { AppHeader } from '@/components/layout/AppHeader';

const PAGE_SIZE = 50;

// LocalStorage keys for filter persistence
const STORAGE_KEYS = {
  accountIds: 'transactions.filter.accountIds',
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

// Check if an account is specifically an investment brokerage account
const isInvestmentBrokerageAccount = (account: Account): boolean => {
  return account.accountSubType === 'INVESTMENT_BROKERAGE';
};

export default function TransactionsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { formatDate } = useDateFormat();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | undefined>();
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
  const [filterCategoryIds, setFilterCategoryIds] = useState<string[]>([]);
  const [filterPayeeIds, setFilterPayeeIds] = useState<string[]>([]);
  const [filterStartDate, setFilterStartDate] = useState<string>('');
  const [filterEndDate, setFilterEndDate] = useState<string>('');
  const [filterSearch, setFilterSearch] = useState<string>('');
  const [filtersInitialized, setFiltersInitialized] = useState(false);

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

  // Track if static data has been loaded
  const staticDataLoaded = useRef(false);

  // Load static data (accounts, categories, payees) - only runs once
  const loadStaticData = useCallback(async () => {
    if (staticDataLoaded.current) return;

    try {
      const [accountsData, categoriesData, payeesData] = await Promise.all([
        accountsApi.getAll(),
        categoriesApi.getAll(),
        payeesApi.getAll(),
      ]);
      setAccounts(accountsData);
      setCategories(categoriesData);
      setPayees(payeesData);
      staticDataLoaded.current = true;
    } catch (error) {
      toast.error('Failed to load form data');
      console.error(error);
    }
  }, []);

  // Load transaction data based on filters - runs when filters/page change
  const loadTransactions = useCallback(async (page: number) => {
    setIsLoading(true);
    try {
      const [transactionsResponse, summaryData] = await Promise.all([
        transactionsApi.getAll({
          accountIds: filterAccountIds.length > 0 ? filterAccountIds : undefined,
          startDate: filterStartDate || undefined,
          endDate: filterEndDate || undefined,
          categoryIds: filterCategoryIds.length > 0 ? filterCategoryIds : undefined,
          payeeIds: filterPayeeIds.length > 0 ? filterPayeeIds : undefined,
          search: filterSearch || undefined,
          page,
          limit: PAGE_SIZE,
        }),
        transactionsApi.getSummary({
          accountIds: filterAccountIds.length > 0 ? filterAccountIds : undefined,
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
    } catch (error) {
      toast.error('Failed to load transactions');
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [filterAccountIds, filterCategoryIds, filterPayeeIds, filterStartDate, filterEndDate, filterSearch]);

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
        console.error('Failed to load transaction details:', error);
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
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <AppHeader />

      {/* Page Header */}
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="px-4 sm:px-6 lg:px-12 py-4">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Transactions</h1>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Manage your income and expenses
              </p>
            </div>
            <Button onClick={handleCreateNew}>
              + New Transaction
            </Button>
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-6 lg:px-12 py-8">
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <div className="bg-white dark:bg-gray-800 overflow-hidden shadow dark:shadow-gray-700/50 rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg className="h-6 w-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">Total Income</dt>
                    <dd className="text-lg font-semibold text-green-600 dark:text-green-400">
                      ${summary.totalIncome.toFixed(2)}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 overflow-hidden shadow dark:shadow-gray-700/50 rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg className="h-6 w-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                  </svg>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">Total Expenses</dt>
                    <dd className="text-lg font-semibold text-red-600 dark:text-red-400">
                      ${summary.totalExpenses.toFixed(2)}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 overflow-hidden shadow dark:shadow-gray-700/50 rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg className="h-6 w-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">Net Cash Flow</dt>
                    <dd className={`text-lg font-semibold ${summary.netCashFlow >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-red-600 dark:text-red-400'}`}>
                      ${summary.netCashFlow.toFixed(2)}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Form Modal */}
        {showForm && (
          <div className="fixed inset-0 bg-gray-500 dark:bg-gray-900 bg-opacity-75 dark:bg-opacity-80 flex items-center justify-center p-4 z-50">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl dark:shadow-gray-700/50 max-w-6xl w-full max-h-[90vh] overflow-y-auto p-6">
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
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Filters</h3>
            <div className="flex flex-wrap gap-2">
              {selectedCategories.map(cat => (
                <span key={cat.id} className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200">
                  {cat.color && (
                    <span
                      className="w-2 h-2 rounded-full mr-2"
                      style={{ backgroundColor: cat.color }}
                    />
                  )}
                  {cat.name}
                  <button
                    onClick={() => handleArrayFilterChange(setFilterCategoryIds, filterCategoryIds.filter(id => id !== cat.id))}
                    className="ml-2 hover:text-blue-600 dark:hover:text-blue-300"
                    title="Remove category filter"
                  >
                    ×
                  </button>
                </span>
              ))}
              {selectedPayees.map(payee => (
                <span key={payee.id} className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200">
                  {payee.name}
                  <button
                    onClick={() => handleArrayFilterChange(setFilterPayeeIds, filterPayeeIds.filter(id => id !== payee.id))}
                    className="ml-2 hover:text-purple-600 dark:hover:text-purple-300"
                    title="Remove payee filter"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <MultiSelect
              label="Accounts"
              options={accounts
                .filter(account => !isInvestmentBrokerageAccount(account))
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
                // Build hierarchical options for MultiSelect
                const specialOptions: MultiSelectOption[] = [
                  { value: 'uncategorized', label: 'Uncategorized' },
                  { value: 'transfer', label: 'Transfers' },
                ];

                // Build tree with parent-child relationships
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

            <ChipsInput
              label="Payees"
              options={payees
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(payee => ({
                  value: payee.id,
                  label: payee.name,
                }))}
              value={filterPayeeIds}
              onChange={(values) => handleArrayFilterChange(setFilterPayeeIds, values)}
              placeholder="Search payees..."
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
            <div>
              <Input
                label="Search"
                type="text"
                value={filterSearch}
                onChange={(e) => handleFilterChange(setFilterSearch, e.target.value)}
                placeholder="Search descriptions..."
              />
            </div>

            <div>
              <Input
                label="Start Date"
                type="date"
                value={filterStartDate}
                onChange={(e) => handleFilterChange(setFilterStartDate, e.target.value)}
              />
              {filterStartDate && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {formatDate(filterStartDate)}
                </p>
              )}
            </div>

            <div>
              <Input
                label="End Date"
                type="date"
                value={filterEndDate}
                onChange={(e) => handleFilterChange(setFilterEndDate, e.target.value)}
              />
              {filterEndDate && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {formatDate(filterEndDate)}
                </p>
              )}
            </div>

            <div className="flex items-end">
              {(filterAccountIds.length > 0 || filterCategoryIds.length > 0 || filterPayeeIds.length > 0 || filterStartDate || filterEndDate || filterSearch) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    // Clear all filters at once - reset page to 1 and update URL
                    setCurrentPage(1);
                    setFilterAccountIds([]);
                    setFilterCategoryIds([]);
                    setFilterPayeeIds([]);
                    setFilterStartDate('');
                    setFilterEndDate('');
                    setFilterSearch('');
                    // Also clear localStorage
                    localStorage.removeItem(STORAGE_KEYS.accountIds);
                    localStorage.removeItem(STORAGE_KEYS.categoryIds);
                    localStorage.removeItem(STORAGE_KEYS.payeeIds);
                    localStorage.removeItem(STORAGE_KEYS.startDate);
                    localStorage.removeItem(STORAGE_KEYS.endDate);
                    localStorage.removeItem(STORAGE_KEYS.search);
                    router.replace('/transactions', { scroll: false });
                  }}
                >
                  Clear Filters
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Transactions List */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {isLoading ? (
            <div className="p-12 text-center">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 dark:border-blue-400"></div>
              <p className="mt-2 text-gray-500 dark:text-gray-400">Loading transactions...</p>
            </div>
          ) : (
            <TransactionList
              transactions={transactions}
              onEdit={handleEdit}
              onRefresh={loadData}
              onTransactionUpdate={handleTransactionUpdate}
              density={listDensity}
              onDensityChange={setListDensity}
              isSingleAccountView={filterAccountIds.length === 1}
              startingBalance={startingBalance}
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
    </div>
  );
}
