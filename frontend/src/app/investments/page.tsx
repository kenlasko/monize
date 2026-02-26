'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/MultiSelect';
import { Pagination } from '@/components/ui/Pagination';
import { PortfolioSummaryCard } from '@/components/investments/PortfolioSummaryCard';
import { GroupedHoldingsList } from '@/components/investments/GroupedHoldingsList';
import { AssetAllocationChart } from '@/components/investments/AssetAllocationChart';
import { InvestmentTransactionList } from '@/components/investments/InvestmentTransactionList';
import { DensityLevel, nextDensity } from '@/hooks/useTableDensity';
import { InvestmentTransactionForm } from '@/components/investments/InvestmentTransactionForm';
import { InvestmentValueChart } from '@/components/investments/InvestmentValueChart';
import { TransactionList } from '@/components/transactions/TransactionList';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useInvestmentData } from '@/hooks/useInvestmentData';
import { Account } from '@/types/account';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PAGE_SIZE } from '@/lib/constants';
import { formatRelativeTime } from '@/lib/format';

const TransactionForm = dynamic(() => import('@/components/transactions/TransactionForm').then(m => m.TransactionForm), { ssr: false });

type TransactionViewType = 'brokerage' | 'cash';

export default function InvestmentsPage() {
  return (
    <ProtectedRoute>
      <InvestmentsContent />
    </ProtectedRoute>
  );
}

function InvestmentsContent() {
  const data = useInvestmentData();
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('monize-investments-density', 'normal');
  const [transactionView, setTransactionView] = useState<TransactionViewType>('brokerage');

  // Load cash transactions when view changes
  useEffect(() => {
    data.loadCashTransactionsIfNeeded(transactionView);
  }, [transactionView, data.loadCashTransactionsIfNeeded]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleTransactionViewChange = (view: TransactionViewType) => {
    setTransactionView(view);
    if (view === 'cash') {
      data.setCashCurrentPage(1);
      if (data.cashPayees.length === 0 && data.cashCategories.length === 0) {
        data.loadCashFilterData();
      }
    }
  };

  // Build filter dropdown options
  const cashCategoryFilterOptions = useMemo((): MultiSelectOption[] => {
    const buildOptions = (parentId: string | null = null): MultiSelectOption[] => {
      return data.cashCategories
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
    return buildOptions();
  }, [data.cashCategories]);

  const cashPayeeFilterOptions = useMemo((): MultiSelectOption[] => {
    return data.cashPayees
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(payee => ({ value: payee.id, label: payee.name }));
  }, [data.cashPayees]);

  const cycleDensity = useCallback(() => {
    setListDensity(d => nextDensity(d));
  }, [setListDensity]);

  // Display name for account selector (strip " - Brokerage" suffix)
  const getAccountDisplayName = (account: Account) => {
    if (account.accountSubType === 'INVESTMENT_BROKERAGE') {
      return account.name.replace(' - Brokerage', '');
    }
    return account.name;
  };

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <div className="sm:px-0">
          <PageHeader
            title="Investments"
            subtitle="Track your investment portfolio"
            actions={
              <>
                <div className="flex items-stretch gap-3 w-full sm:w-auto">
                  <div className="flex-1 sm:flex-none sm:w-64 min-w-0">
                    <MultiSelect
                      value={data.selectedAccountIds}
                      onChange={data.handleAccountChange}
                      placeholder="All Investment Accounts"
                      showSearch={false}
                      options={data.selectableAccounts.map((account: Account) => ({
                        value: account.id,
                        label: getAccountDisplayName(account),
                      }))}
                    />
                  </div>
                  <div className="relative">
                    <Button
                      variant="outline"
                      onClick={data.handleRefreshPrices}
                      disabled={data.isRefreshingPrices}
                      className="whitespace-nowrap h-full"
                      title={data.lastPriceUpdate ? `Last updated: ${formatRelativeTime(data.lastPriceUpdate)}` : 'Never updated'}
                    >
                      {data.isRefreshingPrices ? (
                        <>
                          <svg className="animate-spin sm:-ml-1 sm:mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          <span className="hidden sm:inline">Updating...</span>
                        </>
                      ) : (
                        <>
                          <svg className="sm:mr-1.5 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          <span className="hidden sm:inline">Refresh</span>
                          {!data.refreshResult && data.lastPriceUpdate && (
                            <span className="hidden sm:inline ml-1.5 text-xs text-gray-500 dark:text-gray-400">
                              ({formatRelativeTime(data.lastPriceUpdate)})
                            </span>
                          )}
                        </>
                      )}
                    </Button>
                    {data.refreshResult && (
                      <div className="absolute top-full right-0 mt-1 z-50">
                        <button
                          onClick={() => data.refreshResult!.failed > 0 && data.setShowRefreshDetails(!data.showRefreshDetails)}
                          className={`text-xs whitespace-nowrap ${data.refreshResult.failed === -1 ? 'text-red-600 dark:text-red-400' : data.refreshResult.failed > 0 ? 'text-yellow-600 dark:text-yellow-400 hover:underline cursor-pointer' : 'text-green-600 dark:text-green-400'}`}
                        >
                          {data.refreshResult.failed === -1 ? 'Error refreshing' : `${data.refreshResult.updated} updated${data.refreshResult.failed > 0 ? `, ${data.refreshResult.failed} failed` : ''}`}
                          {data.refreshResult.failed > 0 && (
                            <svg className="inline-block ml-1 h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={data.showRefreshDetails ? "M5 15l7-7 7 7" : "M19 9l-7 7-7-7"} />
                            </svg>
                          )}
                        </button>
                        {data.showRefreshDetails && data.refreshResult.results && (
                          <div className="absolute top-full right-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 min-w-64 max-w-md">
                            <div className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">Price Update Results</div>
                            <div className="max-h-48 overflow-y-auto space-y-1">
                              {data.refreshResult.results
                                .filter(r => !r.success)
                                .map((r, i) => (
                                  <div key={i} className="flex items-start gap-2 text-xs">
                                    <span className="text-red-500 dark:text-red-400 flex-shrink-0">&#10007;</span>
                                    <span className="font-medium text-gray-800 dark:text-gray-200">{r.symbol}</span>
                                    <span className="text-gray-500 dark:text-gray-400 truncate">{r.error}</span>
                                  </div>
                                ))}
                              {data.refreshResult.results
                                .filter(r => r.success)
                                .map((r, i) => (
                                  <div key={i} className="flex items-start gap-2 text-xs">
                                    <span className="text-green-500 dark:text-green-400 flex-shrink-0">&#10003;</span>
                                    <span className="font-medium text-gray-800 dark:text-gray-200">{r.symbol}</span>
                                    <span className="text-gray-500 dark:text-gray-400">${r.price?.toFixed(2)}</span>
                                  </div>
                                ))}
                            </div>
                            <button
                              onClick={() => data.setShowRefreshDetails(false)}
                              className="mt-2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                            >
                              Close
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <Button onClick={data.handleNewTransaction} className="whitespace-nowrap">+ New Transaction</Button>
              </>
            }
          />

          {/* Summary and Allocation Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <PortfolioSummaryCard
              summary={data.portfolioSummary}
              isLoading={data.isLoading}
              singleAccountCurrency={
                data.selectedAccountIds.length === 1
                  ? data.accounts.find(a => a.id === data.selectedAccountIds[0])?.currencyCode ?? null
                  : null
              }
            />
            <AssetAllocationChart
              allocation={data.portfolioSummary ? { allocation: data.portfolioSummary.allocation, totalValue: data.portfolioSummary.totalPortfolioValue } : null}
              isLoading={data.isLoading}
              singleAccountCurrency={
                data.selectedAccountIds.length === 1
                  ? data.accounts.find(a => a.id === data.selectedAccountIds[0])?.currencyCode ?? null
                  : null
              }
              holdingsByAccount={data.portfolioSummary?.holdingsByAccount}
            />
          </div>

          {/* Portfolio Value Over Time */}
          <div className="mb-6">
            <InvestmentValueChart
              accountIds={data.selectedAccountIds}
              displayCurrency={
                data.selectedAccountIds.length === 1
                  ? data.accounts.find(a => a.id === data.selectedAccountIds[0])?.currencyCode ?? null
                  : null
              }
            />
          </div>

          {/* Holdings List */}
          <div className="mb-6">
            <GroupedHoldingsList
              holdingsByAccount={data.portfolioSummary?.holdingsByAccount || []}
              isLoading={data.isLoading}
              totalPortfolioValue={data.portfolioSummary?.totalPortfolioValue || 0}
              onSymbolClick={data.handleSymbolClick}
              onCashClick={data.handleCashClick}
            />
          </div>

          {/* Brokerage Transactions */}
          {transactionView === 'brokerage' && (
            <>
              <div>
                <InvestmentTransactionList
                  transactions={data.transactions}
                  isLoading={data.isLoading}
                  onDelete={data.handleDeleteTransaction}
                  onEdit={data.handleEditTransaction}
                  onNewTransaction={data.handleNewTransaction}
                  density={listDensity}
                  onDensityChange={setListDensity}
                  filters={data.transactionFilters}
                  onFiltersChange={data.handleFiltersChange}
                  availableSymbols={[...new Set(data.portfolioSummary?.holdings.map(h => h.symbol) || [])].sort()}
                  viewToggle={
                    <div className="inline-flex rounded-md bg-gray-100 dark:bg-gray-700 p-0.5">
                      <button
                        onClick={() => handleTransactionViewChange('brokerage')}
                        className="px-3 py-1 text-sm font-medium rounded transition-colors bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm"
                      >
                        Brokerage
                      </button>
                      <button
                        onClick={() => handleTransactionViewChange('cash')}
                        className="px-3 py-1 text-sm font-medium rounded transition-colors text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
                      >
                        Cash
                      </button>
                    </div>
                  }
                />
              </div>

              {data.pagination && data.pagination.totalPages > 1 && (
                <div className="mt-4">
                  <Pagination
                    currentPage={data.currentPage}
                    totalPages={data.pagination.totalPages}
                    totalItems={data.pagination.total}
                    pageSize={PAGE_SIZE}
                    onPageChange={data.goToPage}
                    itemName="transactions"
                  />
                </div>
              )}
              {data.pagination && data.pagination.totalPages <= 1 && data.pagination.total > 0 && (
                <div className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
                  {data.pagination.total} transaction{data.pagination.total !== 1 ? 's' : ''}
                </div>
              )}
            </>
          )}

          {/* Cash Transactions */}
          {transactionView === 'cash' && (
            <>
            <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg">
              <div className="px-3 pt-3 sm:px-4 sm:pt-4 flex flex-wrap justify-between items-center gap-2">
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    Recent Transactions
                    {data.hasActiveCashFilters && (
                      <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">(filtered)</span>
                    )}
                  </h3>
                  <div className="inline-flex rounded-md bg-gray-100 dark:bg-gray-700 p-0.5">
                    <button onClick={() => handleTransactionViewChange('brokerage')} className="px-3 py-1 text-sm font-medium rounded transition-colors text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200">Brokerage</button>
                    <button onClick={() => handleTransactionViewChange('cash')} className="px-3 py-1 text-sm font-medium rounded transition-colors bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm">Cash</button>
                  </div>
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <button onClick={data.openCashCreate} className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600">
                    <span className="sm:hidden">+ New</span>
                    <span className="hidden sm:inline">+ New Transaction</span>
                  </button>
                  <button
                    onClick={() => data.setShowCashFilters(!data.showCashFilters)}
                    className={`inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md ${
                      data.hasActiveCashFilters
                        ? 'text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/30'
                        : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                    }`}
                  >
                    <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                    </svg>
                    Filter
                    {data.hasActiveCashFilters && (
                      <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-blue-600 rounded-full">{data.activeCashFilterCount}</span>
                    )}
                  </button>
                  <button onClick={cycleDensity} className="ml-auto inline-flex items-center px-2 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md" title="Toggle row density">
                    <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                    </svg>
                    {listDensity === 'normal' ? 'Normal' : listDensity === 'compact' ? 'Compact' : 'Dense'}
                  </button>
                </div>
              </div>

              {/* Cash Filter Bar */}
              {data.showCashFilters && (
                <div className="px-3 sm:px-4 py-3 bg-gray-50 dark:bg-gray-700/30 border-b border-gray-200 dark:border-gray-700">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <MultiSelect label="Payees" options={cashPayeeFilterOptions} value={data.cashFilterPayeeIds} onChange={(values) => { data.setCashFilterPayeeIds(values); data.setCashCurrentPage(1); }} placeholder="All payees" />
                    <MultiSelect label="Categories" options={cashCategoryFilterOptions} value={data.cashFilterCategoryIds} onChange={(values) => { data.setCashFilterCategoryIds(values); data.setCashCurrentPage(1); }} placeholder="All categories" />
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">From</label>
                      <input type="date" value={data.cashFilterStartDate} onChange={(e) => { data.setCashFilterStartDate(e.target.value); data.setCashCurrentPage(1); }} className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">To</label>
                      <input type="date" value={data.cashFilterEndDate} onChange={(e) => { data.setCashFilterEndDate(e.target.value); data.setCashCurrentPage(1); }} className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                  </div>
                  {data.hasActiveCashFilters && (
                    <div className="mt-3 flex justify-end">
                      <button onClick={data.clearCashFilters} className="text-sm text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 font-medium">Clear Filters</button>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-3 sm:mt-4" />
              {data.cashTransactionsLoading && data.cashTransactions.length === 0 ? (
                <LoadingSpinner text="Loading cash transactions..." />
              ) : (
                <TransactionList
                  transactions={data.cashTransactions}
                  onEdit={data.handleEditCashTransaction}
                  onRefresh={data.refreshCashTransactions}
                  onTransactionUpdate={data.handleCashTransactionUpdate}
                  density={listDensity}
                  onDensityChange={setListDensity}
                  currentPage={data.cashCurrentPage}
                  totalPages={data.cashPagination?.totalPages ?? 1}
                  totalItems={data.cashPagination?.total ?? 0}
                  pageSize={PAGE_SIZE}
                  onPageChange={data.goToCashPage}
                  showToolbar={false}
                />
              )}
            </div>

              {data.cashPagination && data.cashPagination.totalPages > 1 && (
                <div className="mt-4">
                  <Pagination currentPage={data.cashCurrentPage} totalPages={data.cashPagination.totalPages} totalItems={data.cashPagination.total} pageSize={PAGE_SIZE} onPageChange={data.goToCashPage} itemName="transactions" />
                </div>
              )}
              {data.cashPagination && data.cashPagination.totalPages <= 1 && data.cashPagination.total > 0 && (
                <div className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
                  {data.cashPagination.total} transaction{data.cashPagination.total !== 1 ? 's' : ''}
                </div>
              )}
            </>
          )}

          {/* Footer note for auto-generated symbols */}
          <div className="mt-8 pt-4 border-t border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-400 dark:text-gray-500">
              * Auto-generated symbol name. Could not find in Yahoo dataset.
            </p>
          </div>
        </div>
      </main>

      {/* Transaction Form Modal */}
      <Modal isOpen={data.showTransactionForm} onClose={data.close} maxWidth="xl" className="p-6" {...data.modalProps}>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {data.editingTransaction ? 'Edit Transaction' : 'New Investment Transaction'}
        </h2>
        <InvestmentTransactionForm
          accounts={data.accounts}
          allAccounts={data.allAccounts}
          transaction={data.editingTransaction}
          defaultAccountId={data.getSelectedBrokerageAccountId()}
          onSuccess={data.handleFormSuccess}
          onCancel={data.close}
          onDirtyChange={data.setFormDirty}
          submitRef={data.formSubmitRef}
        />
      </Modal>
      <UnsavedChangesDialog {...data.unsavedChangesDialog} />

      {/* Cash Transaction Form Modal */}
      <Modal isOpen={data.showCashForm} onClose={data.closeCash} maxWidth="6xl" className="p-6" {...data.cashModalProps}>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {data.editingCashTransaction ? 'Edit Transaction' : 'New Transaction'}
        </h2>
        <TransactionForm
          key={data.editingCashTransaction?.id || 'new-cash'}
          transaction={data.editingCashTransaction}
          defaultAccountId={data.cashAccountIds.length > 0 ? data.cashAccountIds[0] : undefined}
          onSuccess={data.handleCashFormSuccess}
          onCancel={data.closeCash}
          onDirtyChange={data.setCashFormDirty}
          submitRef={data.cashFormSubmitRef}
        />
      </Modal>
      <UnsavedChangesDialog {...data.cashUnsavedChangesDialog} />
    </PageLayout>
  );
}
