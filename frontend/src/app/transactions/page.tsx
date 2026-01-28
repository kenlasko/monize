'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
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

  // Filters - initialize from URL params
  const [filterAccountId, setFilterAccountId] = useState<string>(searchParams.get('accountId') || '');
  const [filterCategoryId, setFilterCategoryId] = useState<string>(searchParams.get('categoryId') || '');
  const [filterPayeeId, setFilterPayeeId] = useState<string>(searchParams.get('payeeId') || '');
  const [filterStartDate, setFilterStartDate] = useState<string>(searchParams.get('startDate') || '');
  const [filterEndDate, setFilterEndDate] = useState<string>(searchParams.get('endDate') || '');

  // Update URL when filters or page change
  const updateUrl = useCallback((page: number, filters: {
    accountId: string;
    categoryId: string;
    payeeId: string;
    startDate: string;
    endDate: string;
  }) => {
    const params = new URLSearchParams();
    if (page > 1) params.set('page', page.toString());
    if (filters.accountId) params.set('accountId', filters.accountId);
    if (filters.categoryId) params.set('categoryId', filters.categoryId);
    if (filters.payeeId) params.set('payeeId', filters.payeeId);
    if (filters.startDate) params.set('startDate', filters.startDate);
    if (filters.endDate) params.set('endDate', filters.endDate);

    const queryString = params.toString();
    const newUrl = queryString ? `/transactions?${queryString}` : '/transactions';
    router.replace(newUrl, { scroll: false });
  }, [router]);

  // Get names for display when filtered
  const filteredCategory = filterCategoryId === 'uncategorized'
    ? { id: 'uncategorized', name: 'Uncategorized', color: null } as Category
    : filterCategoryId === 'transfer'
    ? { id: 'transfer', name: 'Transfers', color: null } as Category
    : categories.find(c => c.id === filterCategoryId);
  const filteredPayee = payees.find(p => p.id === filterPayeeId);

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
          accountId: filterAccountId || undefined,
          startDate: filterStartDate || undefined,
          endDate: filterEndDate || undefined,
          categoryId: filterCategoryId || undefined,
          payeeId: filterPayeeId || undefined,
          page,
          limit: PAGE_SIZE,
        }),
        transactionsApi.getSummary({
          accountId: filterAccountId || undefined,
          startDate: filterStartDate || undefined,
          endDate: filterEndDate || undefined,
          categoryId: filterCategoryId || undefined,
          payeeId: filterPayeeId || undefined,
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
  }, [filterAccountId, filterCategoryId, filterPayeeId, filterStartDate, filterEndDate]);

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

  // Track if this is a filter-triggered change (to reset page to 1)
  const isFilterChange = useRef(false);

  // Update URL and load transactions when page or filters change
  useEffect(() => {
    const page = isFilterChange.current ? 1 : currentPage;
    if (isFilterChange.current) {
      setCurrentPage(1);
      isFilterChange.current = false;
    }
    updateUrl(page, {
      accountId: filterAccountId,
      categoryId: filterCategoryId,
      payeeId: filterPayeeId,
      startDate: filterStartDate,
      endDate: filterEndDate,
    });
    loadTransactions(page);
  }, [currentPage, filterAccountId, filterCategoryId, filterPayeeId, filterStartDate, filterEndDate, updateUrl, loadTransactions]);

  // Helper to update filter and mark as filter change
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
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl dark:shadow-gray-700/50 max-w-4xl w-full max-h-[90vh] overflow-y-auto p-6">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
                {editingTransaction ? 'Edit Transaction' : 'New Transaction'}
              </h2>
              <TransactionForm
                key={`${editingTransaction?.id || 'new'}-${filterAccountId}-${formKey}`}
                transaction={editingTransaction}
                defaultAccountId={filterAccountId}
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
            <div className="flex gap-2">
              {filteredCategory && (
                <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200">
                  {filteredCategory.color && (
                    <span
                      className="w-2 h-2 rounded-full mr-2"
                      style={{ backgroundColor: filteredCategory.color }}
                    />
                  )}
                  {filteredCategory.name}
                </span>
              )}
              {filteredPayee && (
                <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200">
                  {filteredPayee.name}
                </span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Select
              label="Account"
              options={[
                { value: '', label: 'All accounts' },
                ...accounts
                  .filter(account => !isInvestmentBrokerageAccount(account))
                  .map(account => ({
                    value: account.id,
                    label: account.name,
                  })),
              ]}
              value={filterAccountId}
              onChange={(e) => handleFilterChange(setFilterAccountId, e.target.value)}
            />

            <Select
              label="Category"
              options={getCategorySelectOptions(categories, {
                includeEmpty: true,
                emptyLabel: 'All categories',
                includeUncategorized: true,
                includeTransfers: true,
              })}
              value={filterCategoryId}
              onChange={(e) => handleFilterChange(setFilterCategoryId, e.target.value)}
            />

            <Select
              label="Payee"
              options={[
                { value: '', label: 'All payees' },
                ...payees
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map(payee => ({
                    value: payee.id,
                    label: payee.name,
                  })),
              ]}
              value={filterPayeeId}
              onChange={(e) => handleFilterChange(setFilterPayeeId, e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
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
              {(filterAccountId || filterCategoryId || filterPayeeId || filterStartDate || filterEndDate) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    // Clear all filters at once - reset page to 1 and update URL
                    setCurrentPage(1);
                    setFilterAccountId('');
                    setFilterCategoryId('');
                    setFilterPayeeId('');
                    setFilterStartDate('');
                    setFilterEndDate('');
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
              isSingleAccountView={!!filterAccountId}
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
