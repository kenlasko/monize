'use client';

import { useState, useEffect, useCallback } from 'react';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { PortfolioSummaryCard } from '@/components/investments/PortfolioSummaryCard';
import { HoldingsList } from '@/components/investments/HoldingsList';
import { AssetAllocationChart } from '@/components/investments/AssetAllocationChart';
import { InvestmentTransactionList, DensityLevel } from '@/components/investments/InvestmentTransactionList';
import { InvestmentTransactionForm } from '@/components/investments/InvestmentTransactionForm';
import { investmentsApi } from '@/lib/investments';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { Account } from '@/types/account';
import {
  PortfolioSummary,
  AssetAllocation,
  InvestmentTransaction,
  InvestmentTransactionPaginationInfo,
} from '@/types/investment';

const PAGE_SIZE = 50;

export default function InvestmentsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [portfolioSummary, setPortfolioSummary] = useState<PortfolioSummary | null>(
    null,
  );
  const [assetAllocation, setAssetAllocation] = useState<AssetAllocation | null>(
    null,
  );
  const [transactions, setTransactions] = useState<InvestmentTransaction[]>([]);
  const [pagination, setPagination] = useState<InvestmentTransactionPaginationInfo | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [showTransactionForm, setShowTransactionForm] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<InvestmentTransaction | undefined>();
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('moneymate-investments-density', 'normal');

  const loadInvestmentAccounts = useCallback(async () => {
    try {
      const accountsData = await investmentsApi.getInvestmentAccounts();
      setAccounts(accountsData);
    } catch (error) {
      console.error('Failed to load investment accounts:', error);
    }
  }, []);

  const loadPortfolioData = useCallback(async (accountId?: string, page: number = 1) => {
    setIsLoading(true);
    try {
      const [summaryData, allocationData, txResponse] = await Promise.all([
        investmentsApi.getPortfolioSummary(accountId || undefined),
        investmentsApi.getAssetAllocation(accountId || undefined),
        investmentsApi.getTransactions({
          accountId: accountId || undefined,
          page,
          limit: PAGE_SIZE,
        }),
      ]);

      setPortfolioSummary(summaryData);
      setAssetAllocation(allocationData);
      setTransactions(txResponse.data || []);
      setPagination(txResponse.pagination);
    } catch (error) {
      console.error('Failed to load portfolio data:', error);
      // Set empty arrays on error to prevent undefined errors
      setPortfolioSummary(null);
      setAssetAllocation(null);
      setTransactions([]);
      setPagination(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInvestmentAccounts();
  }, [loadInvestmentAccounts]);

  useEffect(() => {
    loadPortfolioData(selectedAccountId || undefined, currentPage);
  }, [loadPortfolioData, selectedAccountId, currentPage]);

  const handleAccountChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedAccountId(e.target.value);
    setCurrentPage(1); // Reset to page 1 when account changes
  };

  const handleDeleteTransaction = async (id: string) => {
    if (!confirm('Are you sure you want to delete this transaction?')) return;
    try {
      await investmentsApi.deleteTransaction(id);
      // Reload data
      loadPortfolioData(selectedAccountId || undefined, currentPage);
    } catch (error) {
      console.error('Failed to delete transaction:', error);
      alert('Failed to delete transaction');
    }
  };

  const handleNewTransaction = () => {
    setEditingTransaction(undefined);
    setShowTransactionForm(true);
  };

  const handleEditTransaction = (transaction: InvestmentTransaction) => {
    setEditingTransaction(transaction);
    setShowTransactionForm(true);
  };

  const handleFormSuccess = () => {
    setShowTransactionForm(false);
    setEditingTransaction(undefined);
    loadPortfolioData(selectedAccountId || undefined, currentPage);
  };

  const handleFormCancel = () => {
    setShowTransactionForm(false);
    setEditingTransaction(undefined);
  };

  const goToPage = (page: number) => {
    if (page >= 1 && (!pagination || page <= pagination.totalPages)) {
      setCurrentPage(page);
    }
  };

  // Get brokerage account for the selected cash account
  const getSelectedBrokerageAccountId = () => {
    if (!selectedAccountId) return undefined;
    const cashAccount = accounts.find((a) => a.id === selectedAccountId);
    if (cashAccount?.linkedAccountId) {
      return cashAccount.linkedAccountId;
    }
    return undefined;
  };

  // Group accounts by pair for display
  const getAccountDisplayName = (account: Account) => {
    if (account.accountSubType === 'INVESTMENT_CASH') {
      return account.name.replace(' - Cash', '');
    }
    return account.name;
  };

  // Get unique investment pairs (only show cash accounts in selector)
  const cashAccounts = accounts.filter(
    (a) => a.accountSubType === 'INVESTMENT_CASH',
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <AppHeader />

      <main className="px-4 sm:px-6 lg:px-12 py-6">
        <div className="px-4 sm:px-0">
          {/* Header */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                Investments
              </h1>
              <p className="text-gray-500 dark:text-gray-400">
                Track your investment portfolio
              </p>
            </div>

            {/* Account Filter and Actions */}
            <div className="flex items-center gap-4">
              <Select
                value={selectedAccountId}
                onChange={handleAccountChange}
                className="w-64"
                options={[
                  { value: '', label: 'All Investment Accounts' },
                  ...cashAccounts.map((account) => ({
                    value: account.id,
                    label: getAccountDisplayName(account),
                  })),
                ]}
              />
              <Button onClick={handleNewTransaction} className="whitespace-nowrap">+ New Transaction</Button>
            </div>
          </div>

          {/* Summary and Allocation Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <PortfolioSummaryCard summary={portfolioSummary} isLoading={isLoading} />
            <AssetAllocationChart allocation={assetAllocation} isLoading={isLoading} />
          </div>

          {/* Holdings List */}
          <div className="mb-6">
            <HoldingsList
              holdings={portfolioSummary?.holdings || []}
              isLoading={isLoading}
            />
          </div>

          {/* Recent Transactions */}
          <div>
            <InvestmentTransactionList
              transactions={transactions}
              isLoading={isLoading}
              onDelete={handleDeleteTransaction}
              onEdit={handleEditTransaction}
              density={listDensity}
              onDensityChange={setListDensity}
            />
          </div>

          {/* Pagination */}
          {pagination && pagination.totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between bg-white dark:bg-gray-800 px-4 py-3 shadow dark:shadow-gray-700/50 rounded-lg">
              <div className="flex items-center text-sm text-gray-700 dark:text-gray-300">
                <span>
                  Showing{' '}
                  <span className="font-medium">
                    {((currentPage - 1) * PAGE_SIZE) + 1}
                  </span>
                  {' '}-{' '}
                  <span className="font-medium">
                    {Math.min(currentPage * PAGE_SIZE, pagination.total)}
                  </span>
                  {' '}of{' '}
                  <span className="font-medium">{pagination.total}</span>
                  {' '}transactions
                </span>
              </div>

              <div className="flex items-center space-x-2">
                <button
                  onClick={() => goToPage(1)}
                  disabled={currentPage === 1}
                  className="px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="First page"
                >
                  First
                </button>
                <button
                  onClick={() => goToPage(currentPage - 1)}
                  disabled={currentPage === 1}
                  className="px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Previous
                </button>

                <div className="flex items-center space-x-1">
                  {/* Show page numbers */}
                  {Array.from({ length: pagination.totalPages }, (_, i) => i + 1)
                    .filter(page => {
                      // Show first, last, current, and pages around current
                      return (
                        page === 1 ||
                        page === pagination.totalPages ||
                        Math.abs(page - currentPage) <= 1
                      );
                    })
                    .map((page, index, arr) => {
                      // Add ellipsis if there's a gap
                      const prevPage = arr[index - 1];
                      const showEllipsis = prevPage && page - prevPage > 1;

                      return (
                        <span key={page} className="flex items-center">
                          {showEllipsis && (
                            <span className="px-2 text-gray-500 dark:text-gray-400">...</span>
                          )}
                          <button
                            onClick={() => goToPage(page)}
                            className={`px-3 py-1 text-sm font-medium rounded-md ${
                              page === currentPage
                                ? 'bg-blue-600 dark:bg-blue-500 text-white'
                                : 'text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                            }`}
                          >
                            {page}
                          </button>
                        </span>
                      );
                    })}
                </div>

                <button
                  onClick={() => goToPage(currentPage + 1)}
                  disabled={!pagination.hasMore}
                  className="px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
                <button
                  onClick={() => goToPage(pagination.totalPages)}
                  disabled={currentPage === pagination.totalPages}
                  className="px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Last page"
                >
                  Last
                </button>
              </div>
            </div>
          )}

          {/* Show total count when only one page */}
          {pagination && pagination.totalPages <= 1 && pagination.total > 0 && (
            <div className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
              {pagination.total} transaction{pagination.total !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      </main>

      {/* Transaction Form Modal */}
      {showTransactionForm && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div
            className="fixed inset-0 bg-black bg-opacity-50"
            onClick={handleFormCancel}
          />
          <div className="flex min-h-full items-center justify-center p-4">
            <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-xl w-full p-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
                {editingTransaction ? 'Edit Transaction' : 'New Investment Transaction'}
              </h2>
              <InvestmentTransactionForm
                accounts={accounts}
                transaction={editingTransaction}
                defaultAccountId={getSelectedBrokerageAccountId()}
                onSuccess={handleFormSuccess}
                onCancel={handleFormCancel}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
