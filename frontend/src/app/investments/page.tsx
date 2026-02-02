'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { Pagination } from '@/components/ui/Pagination';
import { PortfolioSummaryCard } from '@/components/investments/PortfolioSummaryCard';
import { GroupedHoldingsList } from '@/components/investments/GroupedHoldingsList';
import { AssetAllocationChart } from '@/components/investments/AssetAllocationChart';
import { InvestmentTransactionList, DensityLevel, TransactionFilters } from '@/components/investments/InvestmentTransactionList';
import { InvestmentTransactionForm } from '@/components/investments/InvestmentTransactionForm';
import { investmentsApi } from '@/lib/investments';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { Account } from '@/types/account';
import {
  PortfolioSummary,
  InvestmentTransaction,
  InvestmentTransactionPaginationInfo,
} from '@/types/investment';

const PAGE_SIZE = 50;

// Helper to format relative time
function formatRelativeTime(dateString: string | null): string {
  if (!dateString) return 'Never';
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export default function InvestmentsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [portfolioSummary, setPortfolioSummary] = useState<PortfolioSummary | null>(
    null,
  );
  const [transactions, setTransactions] = useState<InvestmentTransaction[]>([]);
  const [pagination, setPagination] = useState<InvestmentTransactionPaginationInfo | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [showTransactionForm, setShowTransactionForm] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<InvestmentTransaction | undefined>();
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('moneymate-investments-density', 'normal');
  const [isRefreshingPrices, setIsRefreshingPrices] = useState(false);
  const [lastPriceUpdate, setLastPriceUpdate] = useState<string | null>(null);
  const [refreshResult, setRefreshResult] = useState<{
    updated: number;
    failed: number;
    results?: Array<{ symbol: string; success: boolean; price?: number; error?: string }>;
  } | null>(null);
  const [showRefreshDetails, setShowRefreshDetails] = useState(false);
  const [transactionFilters, setTransactionFilters] = useState<TransactionFilters>({});

  const loadInvestmentAccounts = useCallback(async () => {
    try {
      const accountsData = await investmentsApi.getInvestmentAccounts();
      setAccounts(accountsData);
    } catch (error) {
      console.error('Failed to load investment accounts:', error);
    }
  }, []);

  const loadPriceStatus = useCallback(async () => {
    try {
      const status = await investmentsApi.getPriceStatus();
      setLastPriceUpdate(status.lastUpdated);
    } catch (error) {
      console.error('Failed to load price status:', error);
    }
  }, []);

  const handleRefreshPrices = async () => {
    setIsRefreshingPrices(true);
    setRefreshResult(null);
    setShowRefreshDetails(false);
    try {
      const result = await investmentsApi.refreshPrices();
      setRefreshResult({
        updated: result.updated,
        failed: result.failed,
        results: result.results,
      });
      setLastPriceUpdate(result.lastUpdated);
      // Reload portfolio data to show updated prices
      loadPortfolioData(selectedAccountId || undefined, currentPage, transactionFilters);
      // Auto-show details if there are failures
      if (result.failed > 0) {
        setShowRefreshDetails(true);
      }
      // Clear result after 10 seconds (longer if there are failures)
      setTimeout(() => {
        setRefreshResult(null);
        setShowRefreshDetails(false);
      }, result.failed > 0 ? 15000 : 5000);
    } catch (error) {
      console.error('Failed to refresh prices:', error);
      setRefreshResult({ updated: 0, failed: -1 }); // -1 indicates API error
      setTimeout(() => setRefreshResult(null), 5000);
    } finally {
      setIsRefreshingPrices(false);
    }
  };

  const loadPortfolioData = useCallback(async (
    accountId?: string,
    page: number = 1,
    filters: TransactionFilters = {},
  ) => {
    setIsLoading(true);
    try {
      // Portfolio summary now includes allocation data to avoid duplicate API call
      const [summaryData, txResponse] = await Promise.all([
        investmentsApi.getPortfolioSummary(accountId || undefined),
        investmentsApi.getTransactions({
          accountId: accountId || undefined,
          page,
          limit: PAGE_SIZE,
          symbol: filters.symbol,
          action: filters.action,
          startDate: filters.startDate,
          endDate: filters.endDate,
        }),
      ]);

      setPortfolioSummary(summaryData);
      setTransactions(txResponse.data || []);
      setPagination(txResponse.pagination);
    } catch (error) {
      console.error('Failed to load portfolio data:', error);
      // Set empty arrays on error to prevent undefined errors
      setPortfolioSummary(null);
      setTransactions([]);
      setPagination(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInvestmentAccounts();
    loadPriceStatus();
  }, [loadInvestmentAccounts, loadPriceStatus]);

  useEffect(() => {
    loadPortfolioData(selectedAccountId || undefined, currentPage, transactionFilters);
  }, [loadPortfolioData, selectedAccountId, currentPage, transactionFilters]);

  // Handle edit URL parameter (when redirected from transactions page)
  useEffect(() => {
    const editId = searchParams.get('edit');
    if (editId) {
      // Load the transaction and open the edit form
      investmentsApi.getTransaction(editId)
        .then((transaction) => {
          setEditingTransaction(transaction);
          setShowTransactionForm(true);
          // Clear the URL parameter
          router.replace('/investments', { scroll: false });
        })
        .catch((error) => {
          console.error('Failed to load investment transaction:', error);
          router.replace('/investments', { scroll: false });
        });
    }
  }, [searchParams, router]);

  const handleAccountChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedAccountId(e.target.value);
    setCurrentPage(1); // Reset to page 1 when account changes
  };

  const handleDeleteTransaction = async (id: string) => {
    if (!confirm('Are you sure you want to delete this transaction?')) return;
    try {
      await investmentsApi.deleteTransaction(id);
      // Reload data
      loadPortfolioData(selectedAccountId || undefined, currentPage, transactionFilters);
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
    loadPortfolioData(selectedAccountId || undefined, currentPage, transactionFilters);
  };

  const handleFiltersChange = (newFilters: TransactionFilters) => {
    setTransactionFilters(newFilters);
    setCurrentPage(1); // Reset to page 1 when filters change
  };

  const handleSymbolClick = (symbol: string) => {
    setTransactionFilters({ ...transactionFilters, symbol });
    setCurrentPage(1);
  };

  const handleCashClick = (cashAccountId: string) => {
    router.push(`/transactions?accountId=${cashAccountId}`);
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
            <div className="flex items-center gap-3">
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
              <div className="relative">
                <Button
                  variant="outline"
                  onClick={handleRefreshPrices}
                  disabled={isRefreshingPrices}
                  className="whitespace-nowrap"
                  title={lastPriceUpdate ? `Last updated: ${formatRelativeTime(lastPriceUpdate)}` : 'Never updated'}
                >
                  {isRefreshingPrices ? (
                    <>
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Updating...
                    </>
                  ) : (
                    <>
                      <svg className="mr-1.5 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      Refresh
                      {!refreshResult && lastPriceUpdate && (
                        <span className="ml-1.5 text-xs text-gray-500 dark:text-gray-400">
                          ({formatRelativeTime(lastPriceUpdate)})
                        </span>
                      )}
                    </>
                  )}
                </Button>
                {refreshResult && (
                  <div className="absolute top-full right-0 mt-1 z-50">
                    <button
                      onClick={() => refreshResult.failed > 0 && setShowRefreshDetails(!showRefreshDetails)}
                      className={`text-xs whitespace-nowrap ${refreshResult.failed === -1 ? 'text-red-600 dark:text-red-400' : refreshResult.failed > 0 ? 'text-yellow-600 dark:text-yellow-400 hover:underline cursor-pointer' : 'text-green-600 dark:text-green-400'}`}
                    >
                      {refreshResult.failed === -1 ? 'Error refreshing' : `${refreshResult.updated} updated${refreshResult.failed > 0 ? `, ${refreshResult.failed} failed` : ''}`}
                      {refreshResult.failed > 0 && (
                        <svg className="inline-block ml-1 h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={showRefreshDetails ? "M5 15l7-7 7 7" : "M19 9l-7 7-7-7"} />
                        </svg>
                      )}
                    </button>
                    {showRefreshDetails && refreshResult.results && (
                      <div className="absolute top-full right-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 min-w-64 max-w-md">
                        <div className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">Price Update Results</div>
                        <div className="max-h-48 overflow-y-auto space-y-1">
                          {refreshResult.results
                            .filter(r => !r.success)
                            .map((r, i) => (
                              <div key={i} className="flex items-start gap-2 text-xs">
                                <span className="text-red-500 dark:text-red-400 flex-shrink-0">✗</span>
                                <span className="font-medium text-gray-800 dark:text-gray-200">{r.symbol}</span>
                                <span className="text-gray-500 dark:text-gray-400 truncate">{r.error}</span>
                              </div>
                            ))}
                          {refreshResult.results
                            .filter(r => r.success)
                            .map((r, i) => (
                              <div key={i} className="flex items-start gap-2 text-xs">
                                <span className="text-green-500 dark:text-green-400 flex-shrink-0">✓</span>
                                <span className="font-medium text-gray-800 dark:text-gray-200">{r.symbol}</span>
                                <span className="text-gray-500 dark:text-gray-400">${r.price?.toFixed(2)}</span>
                              </div>
                            ))}
                        </div>
                        <button
                          onClick={() => setShowRefreshDetails(false)}
                          className="mt-2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                        >
                          Close
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <Button onClick={handleNewTransaction} className="whitespace-nowrap">+ New Transaction</Button>
            </div>
          </div>

          {/* Summary and Allocation Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <PortfolioSummaryCard summary={portfolioSummary} isLoading={isLoading} />
            <AssetAllocationChart
              allocation={portfolioSummary ? { allocation: portfolioSummary.allocation, totalValue: portfolioSummary.totalPortfolioValue } : null}
              isLoading={isLoading}
            />
          </div>

          {/* Holdings List */}
          <div className="mb-6">
            <GroupedHoldingsList
              holdingsByAccount={portfolioSummary?.holdingsByAccount || []}
              isLoading={isLoading}
              totalPortfolioValue={portfolioSummary?.totalPortfolioValue || 0}
              onSymbolClick={handleSymbolClick}
              onCashClick={handleCashClick}
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
              filters={transactionFilters}
              onFiltersChange={handleFiltersChange}
              availableSymbols={[...new Set(portfolioSummary?.holdings.map(h => h.symbol) || [])].sort()}
            />
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
      </main>

      {/* Transaction Form Modal */}
      <Modal isOpen={showTransactionForm} onClose={handleFormCancel} maxWidth="xl" className="p-6">
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
      </Modal>
    </div>
  );
}
