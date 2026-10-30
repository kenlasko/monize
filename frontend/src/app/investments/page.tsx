'use client';

import { useEffect, useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { PortfolioSummaryCard } from '@/components/investments/PortfolioSummaryCard';
import { PortfolioPerformanceCard } from '@/components/investments/PortfolioPerformanceCard';
import { UnlinkedTransfersCard } from '@/components/investments/UnlinkedTransfersCard';
import { GroupedHoldingsList } from '@/components/investments/GroupedHoldingsList';
import { AssetAllocationChart } from '@/components/investments/AssetAllocationChart';
import { InvestmentTransactionList } from '@/components/investments/InvestmentTransactionList';
import { ListBottomPager } from '@/components/ui/ListBottomPager';
import { NewTransactionButton } from '@/components/investments/NewTransactionButton';
import { RefreshPricesButton } from '@/components/investments/RefreshPricesButton';
import { InvestmentTransactionForm } from '@/components/investments/InvestmentTransactionForm';
import {
  CashFilterBar,
  CashFilterToggleButton,
  useCashFilterOptions,
} from '@/components/investments/CashRegisterFilters';
import {
  InvestmentValueChart,
  INVESTMENT_CHART_REFRESH_EVENT,
} from '@/components/investments/InvestmentValueChart';
import { TransactionList } from '@/components/transactions/TransactionList';
import { ViewModeToggle } from '@/components/ui/ViewModeToggle';
import { useViewMode } from '@/store/viewModeStore';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useInvestmentData } from '@/hooks/useInvestmentData';
import { usePortfolioPeriodResults } from '@/hooks/usePortfolioPeriodResults';
import { PORTFOLIO_PERIOD_PRESETS } from '@/types/net-worth';
import { useBrokerageFilterOptions } from '@/hooks/useBrokerageFilterOptions';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import { Account } from '@/types/account';
import { buildAccountFilterLabel } from '@/lib/account-utils';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import {
  InvestmentViewToggle,
  type InvestmentTransactionView,
} from '@/components/investments/InvestmentViewToggle';
import { PAGE_SIZE } from '@/lib/constants';
import { docsUrl } from '@/lib/docs-links';

const TransactionForm = dynamic(() => import('@/components/transactions/TransactionForm').then(m => m.TransactionForm), { ssr: false });

// Calendar mode's whole tree, loaded only once a reader switches to it, so the
// register's first paint carries none of it.
const InvestmentCalendarView = dynamic(() => import('@/components/calendar/InvestmentCalendarView').then(m => m.InvestmentCalendarView), { ssr: false });


export default function InvestmentsPage() {
  return (
    <ProtectedRoute>
      <InvestmentsContent />
    </ProtectedRoute>
  );
}

function InvestmentsContent() {
  const t = useTranslations('investments');
  const tc = useTranslations('common');
  // The cash register below is the shared transactions list, so its pager
  // counts "transactions" out of that list's own catalog rather than a second
  // copy of the noun under `investments`.
  const tTx = useTranslations('transactions');
  const mainAccountName = useMainAccountName();
  const data = useInvestmentData();
  // An undo or a redo is a write that happened elsewhere, so it refreshes the
  // page the same way a write made here does -- both registers, the summary,
  // the allocation and the chart.
  const { refreshAfterWrite } = data;
  useOnUndoRedo(refreshAfterWrite);
  // An AI write (e.g. an investment transaction from the chat bubble) mutates
  // the same data as an undo/redo, so refresh the same way.
  useOnAiAction(refreshAfterWrite);
  const [transactionView, setTransactionView] = useLocalStorage<InvestmentTransactionView>('monize-investments-transaction-view', 'brokerage');
  const { view, setView } = useViewMode('investments');
  const financialToday = useFinancialToday();
  const weekStartsOn = (usePreferencesStore((s) => s.preferences?.weekStartsOn) ?? 1) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  // The day a trade started from the calendar is filed under. Cleared by every
  // other way of opening the form, so the remembered date keeps its usual job.
  const [createOnDate, setCreateOnDate] = useState<string | undefined>(undefined);
  // Tracks whether the investment transaction form currently shows a currency
  // conversion section so the modal can be widened to fit it without scrolling.
  const [investmentFormNeedsConversion, setInvestmentFormNeedsConversion] = useState(false);

  // Load cash transactions when view changes
  useEffect(() => {
    data.loadCashTransactionsIfNeeded(transactionView);
  }, [transactionView, data.loadCashTransactionsIfNeeded]); // eslint-disable-line react-hooks/exhaustive-deps

  // What the cash filter pickers offer: the payees and categories these cash
  // ledgers actually use. Keyed off the view being on screen rather than the
  // click that reaches it -- the view is remembered, so it is reachable
  // without one.
  // The brokerage filter offers what these accounts have actually traded, the
  // same way the cash filter's pickers do.
  const brokerageOptions = useBrokerageFilterOptions(data.selectedAccountIds);

  const cashFilterOptions = useCashFilterOptions(
    transactionView === 'cash',
    data.cashAccountIds,
  );

  // Reset the modal-width tracking whenever the investment transaction modal
  // closes (via cancel, success, escape, backdrop, or back button) so reopening
  // it starts at the default width without a flicker.
  const { close: closeTransactionForm, handleFormSuccess } = data;

  const closeInvestmentTransactionModal = useCallback(() => {
    setInvestmentFormNeedsConversion(false);
    closeTransactionForm();
  }, [closeTransactionForm]);

  const handleInvestmentTransactionSuccess = useCallback(() => {
    setInvestmentFormNeedsConversion(false);
    handleFormSuccess();
  }, [handleFormSuccess]);

  // The Refresh button has two effects: (a) refresh security prices in the DB
  // (existing flow that drives daily snapshots and Portfolio Summary) and
  // (b) tell the InvestmentValueChart to drop its sessionStorage entry and
  // re-fetch when it's currently rendering an intraday range. The chart
  // itself decides whether the event applies based on its active range.
  //
  // Scope the price refresh to the holdings currently visible on screen:
  // when an account filter is active we only refresh the IDs that show up
  // in portfolioSummary.holdings instead of every active security in the
  // user's catalog. With no filter we leave scope undefined so the hook
  // refreshes all eligible securities.
  const handleRefreshClick = useCallback(async () => {
    window.dispatchEvent(new Event(INVESTMENT_CHART_REFRESH_EVENT));
    const scope =
      data.selectedAccountIds.length > 0
        ? [
            ...new Set(
              (data.portfolioSummary?.holdings ?? []).map((h) => h.securityId),
            ),
          ]
        : undefined;
    await data.handleRefreshPrices(scope);
  }, [data]);

  const handleNewInvestmentTransaction = useCallback(() => {
    setCreateOnDate(undefined);
    data.handleNewTransaction();
  }, [data]);

  const handleNewCashTransaction = useCallback(() => {
    setCreateOnDate(undefined);
    data.openCashCreate();
  }, [data]);

  // A day on the calendar starts a trade on that day: the brokerage register is
  // the one the calendar's own "New" belongs to.
  const handleCreateOnDay = useCallback((date: string) => {
    setCreateOnDate(date);
    data.handleNewTransaction();
  }, [data]);

  // Symbols for what the scope holds now, so the calendar can name a security a
  // withheld value blames. The month's own rows name only what it traded, and an
  // unpriced holding is usually one it did not.
  const heldSecurityLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const holding of data.portfolioSummary?.holdings ?? []) {
      labels.set(holding.securityId, holding.symbol);
    }
    return labels;
  }, [data.portfolioSummary]);

  const handleTransactionViewChange = (view: InvestmentTransactionView) => {
    setTransactionView(view);
    if (view === 'cash') {
      data.setCashCurrentPage(1);
    }
  };

  const { handleDeleteTransaction: deleteTransaction } = data;
  const handleDeleteTransaction = useCallback((id: string) => {
    void deleteTransaction(id);
  }, [deleteTransaction]);

  // Display name for account selector (strip the localized " - Brokerage" suffix)
  const getAccountDisplayName = useCallback(
    (account: Account) =>
      account.accountSubType === 'INVESTMENT_BROKERAGE'
        ? mainAccountName(account.name)
        : account.name,
    [mainAccountName],
  );

  // Summary/allocation/chart titles show which accounts the filter covers.
  const accountFilterLabel = useMemo(() => {
    return buildAccountFilterLabel(
      data.selectedAccountIds,
      data.selectableAccounts,
      (a) => getAccountDisplayName(a as Account),
      tc,
    );
  }, [data.selectedAccountIds, data.selectableAccounts, tc, getAccountDisplayName]);

  // One account in view reports in its own currency, everywhere on the page.
  const singleAccountCurrency =
    data.selectedAccountIds.length === 1
      ? data.accounts.find(a => a.id === data.selectedAccountIds[0])?.currencyCode ?? null
      : null;

  // Asked once for the page: "Portfolio performance" lists every window, and
  // the value chart's figures for any range the batch covers are the same
  // answer. Two requests valued the same history twice, on the same event
  // loop, at the same moment (#1888).
  const periodResults = usePortfolioPeriodResults({
    periods: PORTFOLIO_PERIOD_PRESETS.join(','),
    accountIds:
      data.selectedAccountIds.length > 0 ? data.selectedAccountIds.join(',') : undefined,
    displayCurrency: singleAccountCurrency ?? undefined,
    reloadKey: data.writeRefreshKey,
  });

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <div className="sm:px-0">
          <PageHeader
            title={t('page.title')}
            subtitle={t('page.subtitle')}
            helpUrl={docsUrl('investments')}
            actions={
              <>
                <div className="flex items-stretch gap-3 w-full sm:w-auto">
                  <div className="flex-1 sm:flex-none sm:w-64 min-w-0">
                    <MultiSelect
                      value={data.selectedAccountIds}
                      onChange={data.handleAccountChange}
                      placeholder={t('page.allInvestmentAccounts')}
                      showSearch={false}
                      options={data.selectableAccounts.map((account: Account) => ({
                        value: account.id,
                        label: getAccountDisplayName(account),
                      }))}
                    />
                  </div>
                  <RefreshPricesButton
                    onClick={handleRefreshClick}
                    isRefreshing={data.isRefreshingPrices}
                    lastPriceUpdate={data.lastPriceUpdate}
                  />
                </div>
                <NewTransactionButton
                  onNewInvestment={handleNewInvestmentTransaction}
                  onNewCash={handleNewCashTransaction}
                />
              </>
            }
          />

          {/* Summary and allocation, in one row: what the portfolio is worth
              beside how it is spread. Below `lg` the two stack in that order. */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <PortfolioSummaryCard
              summary={data.portfolioSummary}
              isLoading={data.isSummaryLoading}
              singleAccountCurrency={
                data.selectedAccountIds.length === 1
                  ? data.accounts.find(a => a.id === data.selectedAccountIds[0])?.currencyCode ?? null
                  : null
              }
              titleSuffix={accountFilterLabel}
              // The picker in the header above feeds this summary, so a
              // withheld return may offer leaving an account out as a repair.
              hasAccountFilter
            />
            <AssetAllocationChart
              allocation={data.portfolioSummary ? { allocation: data.portfolioSummary.allocation, totalValue: data.portfolioSummary.totalPortfolioValue } : null}
              isLoading={data.isSummaryLoading}
              singleAccountCurrency={
                data.selectedAccountIds.length === 1
                  ? data.accounts.find(a => a.id === data.selectedAccountIds[0])?.currencyCode ?? null
                  : null
              }
              holdingsByAccount={data.portfolioSummary?.holdingsByAccount}
              titleSuffix={accountFilterLabel}
              accountIds={data.selectedAccountIds}
              valuationComplete={data.portfolioSummary?.valuationComplete}
            />
          </div>

          {/* The value series and what the investments earned from it, in one
              row: the reader sees the shape of the portfolio's value beside
              the trailing returns that shape produced. The right column is the
              narrow one -- six label/figure rows need far less width than a
              chart -- and below `lg` the two stack in that same order. */}
          <div className="grid grid-cols-1 lg:grid-cols-[3fr_1fr] gap-6 mb-6">
            <InvestmentValueChart
              accountIds={data.selectedAccountIds}
              refreshKey={data.writeRefreshKey}
              displayCurrency={singleAccountCurrency}
              titleSuffix={accountFilterLabel}
              periodResults={periodResults}
            />
            {/* What the INVESTMENTS earned over each trailing period, with
                deposits, withdrawals and idle cash taken out. */}
            <PortfolioPerformanceCard
              accountIds={data.selectedAccountIds}
              reloadKey={data.writeRefreshKey}
              displayCurrency={singleAccountCurrency}
              periodResults={periodResults}
            />
          </div>

          {/* A transfer entered twice, once per account, and never paired: the
              receiving position cannot take the cost the sending one gave up,
              so its basis reads unknown. Above the holdings because that is
              the list the unknown shows up in. Renders nothing when there is
              nothing to suggest. */}
          <div className="mb-6 empty:mb-0">
            <UnlinkedTransfersCard
              accountIds={data.selectedAccountIds}
              reloadKey={data.writeRefreshKey}
              onLinked={data.refreshAfterWrite}
            />
          </div>

          {/* Holdings List */}
          <div className="mb-6">
            <GroupedHoldingsList
              holdingsByAccount={data.portfolioSummary?.holdingsByAccount || []}
              isLoading={data.isSummaryLoading}
              totalPortfolioValue={data.portfolioSummary?.totalPortfolioValue ?? null}
              valuationComplete={data.portfolioSummary?.valuationComplete}
              onSecurityClick={data.handleSecurityClick}
              onCashClick={data.handleCashClick}
            />
          </div>

          {/* The two registers, or the month calendar standing in for both.
              Everything above this point is the same either way. */}
          {view === 'calendar' && (
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {t('page.recentTransactions')}
                </h3>
              </div>
              <InvestmentCalendarView
                accounts={data.allAccounts.length > 0 ? data.allAccounts : data.accounts}
                brokerageAccountIds={data.selectedAccountIds}
                cashAccountIds={data.cashAccountIds}
                heldSecurityLabels={heldSecurityLabels}
                weekStartsOn={weekStartsOn}
                today={financialToday}
                displayCurrency={
                  data.selectedAccountIds.length === 1
                    ? data.accounts.find(a => a.id === data.selectedAccountIds[0])?.currencyCode ?? null
                    : null
                }
                onEditInvestment={data.handleEditTransaction}
                onEditCashTransaction={data.handleEditCashTransaction}
                onCreateOnDay={handleCreateOnDay}
                refreshKey={data.writeRefreshKey}
                viewToggle={<ViewModeToggle value={view} onChange={setView} />}
              />
            </div>
          )}

          {/* Brokerage Transactions */}
          {view === 'table' && transactionView === 'brokerage' && (
            <>
              <div>
                <InvestmentTransactionList
                  transactions={data.transactions}
                  accounts={data.accounts}
                  isLoading={data.isLoading}
                  onDelete={handleDeleteTransaction}
                  onEdit={data.handleEditTransaction}
                  onStatusChanged={data.handleFormCreateAndNew}
                  filters={data.transactionFilters}
                  onFiltersChange={data.handleFiltersChange}
                  availableSymbols={brokerageOptions.symbols}
                  availableActions={brokerageOptions.actions}
                  viewToggle={
                    <InvestmentViewToggle
                      value={transactionView}
                      onChange={handleTransactionViewChange}
                    />
                  }
                  viewModeToggle={<ViewModeToggle value={view} onChange={setView} />}
                  currentPage={data.currentPage}
                  totalPages={data.pagination?.totalPages ?? 1}
                  totalItems={data.pagination?.total ?? 0}
                  pageSize={PAGE_SIZE}
                  onPageChange={data.goToPage}
                />
              </div>
              <ListBottomPager
                currentPage={data.currentPage}
                totalPages={data.pagination?.totalPages}
                totalItems={data.pagination?.total}
                pageSize={PAGE_SIZE}
                onPageChange={data.goToPage}
                itemName={t('transactionList.itemNamePlural')}
                totalLabel={t('transactionList.totalCount', {
                  count: data.pagination?.total ?? 0,
                })}
              />
            </>
          )}

          {/* Cash Transactions */}
          {view === 'table' && transactionView === 'cash' && (
            <>
            <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg">
              <div className="px-3 pt-3 sm:px-4 sm:pt-4 flex flex-wrap justify-between items-center gap-2">
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    {t('page.recentTransactions')}
                    {data.hasActiveCashFilters && (
                      <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">{t('page.filtered')}</span>
                    )}
                  </h3>
                  <InvestmentViewToggle
                    value={transactionView}
                    onChange={handleTransactionViewChange}
                  />
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <CashFilterToggleButton
                    activeCount={data.activeCashFilterCount}
                    onClick={() => data.setShowCashFilters(!data.showCashFilters)}
                    expanded={data.showCashFilters}
                  />
                </div>
              </div>

              {/* Cash Filter Bar */}
              {data.showCashFilters && (
                <CashFilterBar
                  options={cashFilterOptions}
                  value={data.cashFilters}
                  onChange={data.setCashFilters}
                />
              )}

              <div className="mt-3 sm:mt-4" />
              {data.cashTransactionsLoading && data.cashTransactions.length === 0 ? (
                <LoadingSpinner text={t('page.loadingCashTransactions')} />
              ) : (
                <TransactionList
                  densityView="investments"
                  viewToggle={<ViewModeToggle value={view} onChange={setView} />}
                  transactions={data.cashTransactions}
                  onEdit={data.handleEditCashTransaction}
                  onRefresh={data.refreshAfterWrite}
                  onTransactionUpdate={data.handleCashTransactionUpdate}
                  currentPage={data.cashCurrentPage}
                  totalPages={data.cashPagination?.totalPages ?? 1}
                  totalItems={data.cashPagination?.total ?? 0}
                  pageSize={PAGE_SIZE}
                  onPageChange={data.goToCashPage}
                  startingBalance={data.cashAccountIds.length === 1 ? (data.cashStartingBalance ?? 0) : undefined}
                  isSingleAccountView={data.cashAccountIds.length === 1}
                />
              )}
            </div>
            <ListBottomPager
              currentPage={data.cashCurrentPage}
              totalPages={data.cashPagination?.totalPages}
              totalItems={data.cashPagination?.total}
              pageSize={PAGE_SIZE}
              onPageChange={data.goToCashPage}
              itemName={tTx('list.itemNamePlural')}
              totalLabel={tTx('page.totalCount', {
                count: data.cashPagination?.total ?? 0,
              })}
            />
            </>
          )}

          {/* Footer note for auto-generated symbols */}
          <div className="mt-8 pt-4 border-t border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-400 dark:text-gray-500">
              {t('page.autoGeneratedSymbolNote')}
            </p>
          </div>
        </div>
      </main>

      {/* Transaction Form Modal */}
      <Modal
        isOpen={data.showTransactionForm}
        onClose={closeInvestmentTransactionModal}
        maxWidth={investmentFormNeedsConversion ? '3xl' : 'xl'}
        className="p-6"
        {...data.modalProps} title={data.editingTransaction ? t('page.editTransaction') : t('page.newInvestmentTransaction')}>
        <InvestmentTransactionForm
          key={`${data.editingTransaction?.id ?? 'new'}-${createOnDate ?? ''}`}
          accounts={data.accounts}
          allAccounts={data.allAccounts}
          transaction={data.editingTransaction}
          defaultAccountId={data.getSelectedBrokerageAccountId()}
          defaultDate={createOnDate}
          onSuccess={handleInvestmentTransactionSuccess}
          onCreateAndNew={data.handleFormCreateAndNew}
          onCancel={closeInvestmentTransactionModal}
          onDirtyChange={data.setFormDirty}
          onConversionStateChange={setInvestmentFormNeedsConversion}
          submitRef={data.formSubmitRef}
        />
      </Modal>
      <UnsavedChangesDialog {...data.unsavedChangesDialog} />

      {/* Cash Transaction Form Modal */}
      <Modal isOpen={data.showCashForm} onClose={data.closeCash} maxWidth="6xl" className="p-6 !max-w-[69rem]" {...data.cashModalProps} title={data.editingCashTransaction ? t('page.editTransaction') : t('page.newTransaction')}>
        <TransactionForm
          key={`${data.editingCashTransaction?.id || 'new-cash'}-${createOnDate ?? ''}`}
          transaction={data.editingCashTransaction}
          defaultDate={createOnDate}
          defaultAccountId={data.cashAccountIds.length > 0 ? data.cashAccountIds[0] : undefined}
          onSuccess={data.handleCashFormSuccess}
          onCreateAndNew={data.handleCashFormCreateAndNew}
          onCancel={data.closeCash}
          onDirtyChange={data.setCashFormDirty}
          submitRef={data.cashFormSubmitRef}
        />
      </Modal>
      <UnsavedChangesDialog {...data.cashUnsavedChangesDialog} />
    </PageLayout>
  );
}
