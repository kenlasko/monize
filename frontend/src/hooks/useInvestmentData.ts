'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { investmentsApi } from '@/lib/investments';
import { transactionsApi } from '@/lib/transactions';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { payeesApi } from '@/lib/payees';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { Account } from '@/types/account';
import {
  PortfolioSummary,
  InvestmentTransaction,
  InvestmentTransactionPaginationInfo,
} from '@/types/investment';
import { Transaction } from '@/types/transaction';
import { Category } from '@/types/category';
import { Payee } from '@/types/payee';
import { usePriceRefresh, setRefreshInProgress } from '@/hooks/usePriceRefresh';
import { useFormModal } from '@/hooks/useFormModal';
import { createLogger } from '@/lib/logger';
import { PAGE_SIZE } from '@/lib/constants';
import { type TransactionFilters } from '@/components/investments/InvestmentTransactionList';

const logger = createLogger('Investments');

export function useInvestmentData() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [allAccounts, setAllAccounts] = useState<Account[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useLocalStorage<string[]>('monize-investments-accounts', []);
  const [portfolioSummary, setPortfolioSummary] = useState<PortfolioSummary | null>(null);
  const [transactions, setTransactions] = useState<InvestmentTransaction[]>([]);
  const [pagination, setPagination] = useState<InvestmentTransactionPaginationInfo | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const {
    showForm: showTransactionForm, editingItem: editingTransaction,
    openCreate, openEdit, close, isEditing: _isEditing,
    modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef,
  } = useFormModal<InvestmentTransaction>();
  const [isRefreshingPrices, setIsRefreshingPrices] = useState(false);
  const [lastPriceUpdate, setLastPriceUpdate] = useState<string | null>(null);
  const [refreshResult, setRefreshResult] = useState<{
    updated: number;
    failed: number;
    results?: Array<{ symbol: string; success: boolean; price?: number; error?: string }>;
  } | null>(null);
  const [showRefreshDetails, setShowRefreshDetails] = useState(false);
  const [transactionFilters, setTransactionFilters] = useState<TransactionFilters>({});

  // Cash transaction state
  const [cashTransactions, setCashTransactions] = useState<Transaction[]>([]);
  const [cashPagination, setCashPagination] = useState<{ page: number; totalPages: number; total: number } | null>(null);
  const [cashCurrentPage, setCashCurrentPage] = useState(1);
  const [cashTransactionsLoading, setCashTransactionsLoading] = useState(false);
  const [showCashFilters, setShowCashFilters] = useState(false);
  const [cashFilterPayeeIds, setCashFilterPayeeIds] = useState<string[]>([]);
  const [cashFilterCategoryIds, setCashFilterCategoryIds] = useState<string[]>([]);
  const [cashFilterStartDate, setCashFilterStartDate] = useState('');
  const [cashFilterEndDate, setCashFilterEndDate] = useState('');
  const [cashPayees, setCashPayees] = useState<Payee[]>([]);
  const [cashCategories, setCashCategories] = useState<Category[]>([]);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);

  // Cash transaction form modal
  const {
    showForm: showCashForm, editingItem: editingCashTransaction,
    openCreate: openCashCreate, openEdit: openCashEdit, close: closeCash,
    modalProps: cashModalProps, setFormDirty: setCashFormDirty,
    unsavedChangesDialog: cashUnsavedChangesDialog, formSubmitRef: cashFormSubmitRef,
  } = useFormModal<Transaction>();

  const loadInvestmentAccounts = useCallback(async () => {
    try {
      const accountsData = await investmentsApi.getInvestmentAccounts();
      setAccounts(accountsData);
    } catch (error) {
      logger.error('Failed to load investment accounts:', error);
    }
  }, []);

  const loadAllAccounts = useCallback(async () => {
    try {
      const accountsData = await accountsApi.getAll();
      setAllAccounts(accountsData);
    } catch (error) {
      logger.error('Failed to load all accounts:', error);
    }
  }, []);

  const loadCashFilterData = useCallback(async () => {
    try {
      const [cats, pays] = await Promise.all([
        categoriesApi.getAll(),
        payeesApi.getAll(),
      ]);
      setCashCategories(cats);
      setCashPayees(pays);
    } catch (error) {
      logger.error('Failed to load cash filter data:', error);
    }
  }, []);

  const loadPriceStatus = useCallback(async () => {
    try {
      const status = await investmentsApi.getPriceStatus();
      setLastPriceUpdate(status.lastUpdated);
    } catch (error) {
      logger.error('Failed to load price status:', error);
    }
  }, []);

  const loadAllPortfolioData = useCallback(async (
    accountIds: string[],
    page: number = 1,
    filters: TransactionFilters = {},
  ) => {
    setIsLoading(true);
    try {
      const ids = accountIds.length > 0 ? accountIds : undefined;
      const [summaryData, txResponse] = await Promise.all([
        investmentsApi.getPortfolioSummary(ids),
        investmentsApi.getTransactions({
          accountIds: ids ? ids.join(',') : undefined,
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
      logger.error('Failed to load portfolio data:', error);
      setPortfolioSummary(null);
      setTransactions([]);
      setPagination(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const { triggerAutoRefresh } = usePriceRefresh({
    onRefreshComplete: () => {
      loadAllPortfolioData(selectedAccountIds, currentPage, transactionFilters);
      loadPriceStatus();
    },
  });

  const handleRefreshPrices = async () => {
    setIsRefreshingPrices(true);
    setRefreshInProgress(true);
    setRefreshResult(null);
    setShowRefreshDetails(false);
    try {
      const summary = await investmentsApi.getPortfolioSummary();
      const securityIds = [...new Set(
        summary.holdings.filter(h => h.quantity !== 0).map(h => h.securityId)
      )];

      if (securityIds.length === 0) {
        setRefreshResult({ updated: 0, failed: 0, results: [] });
        setTimeout(() => setRefreshResult(null), 3000);
        return;
      }

      const result = await investmentsApi.refreshSelectedPrices(securityIds);
      setRefreshResult({ updated: result.updated, failed: result.failed, results: result.results });
      setLastPriceUpdate(result.lastUpdated);
      loadAllPortfolioData(selectedAccountIds, currentPage, transactionFilters);
      if (result.failed > 0) setShowRefreshDetails(true);
      setTimeout(() => {
        setRefreshResult(null);
        setShowRefreshDetails(false);
      }, result.failed > 0 ? 15000 : 5000);
    } catch (error) {
      logger.error('Failed to refresh prices:', error);
      setRefreshResult({ updated: 0, failed: -1 });
      setTimeout(() => setRefreshResult(null), 5000);
    } finally {
      setRefreshInProgress(false);
      setIsRefreshingPrices(false);
    }
  };

  const loadPortfolioSummary = useCallback(async (accountIds: string[]) => {
    try {
      const ids = accountIds.length > 0 ? accountIds : undefined;
      const summaryData = await investmentsApi.getPortfolioSummary(ids);
      setPortfolioSummary(summaryData);
    } catch (error) {
      logger.error('Failed to load portfolio summary:', error);
      setPortfolioSummary(null);
    }
  }, []);

  const loadTransactions = useCallback(async (
    accountIds: string[],
    page: number = 1,
    filters: TransactionFilters = {},
  ) => {
    try {
      const ids = accountIds.length > 0 ? accountIds : undefined;
      const txResponse = await investmentsApi.getTransactions({
        accountIds: ids ? ids.join(',') : undefined,
        page,
        limit: PAGE_SIZE,
        symbol: filters.symbol,
        action: filters.action,
        startDate: filters.startDate,
        endDate: filters.endDate,
      });
      setTransactions(txResponse.data || []);
      setPagination(txResponse.pagination);
    } catch (error) {
      logger.error('Failed to load transactions:', error);
      setTransactions([]);
      setPagination(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Derive cash account IDs from selected brokerage accounts
  const cashAccountIds = useMemo(() => {
    if (selectedAccountIds.length === 0) {
      return accounts
        .filter(a => a.accountSubType === 'INVESTMENT_BROKERAGE' && a.linkedAccountId)
        .map(a => a.linkedAccountId!);
    }
    return selectedAccountIds
      .map(id => accounts.find(a => a.id === id))
      .filter((a): a is Account => !!a && !!a.linkedAccountId)
      .map(a => a.linkedAccountId!);
  }, [selectedAccountIds, accounts]);

  const loadCashTransactions = useCallback(async (
    accountIds: string[],
    page: number = 1,
    filters: { payeeIds?: string[]; categoryIds?: string[]; startDate?: string; endDate?: string } = {},
  ) => {
    if (accountIds.length === 0) {
      setCashTransactions([]);
      setCashPagination(null);
      return;
    }
    setCashTransactionsLoading(true);
    try {
      const response = await transactionsApi.getAll({
        accountIds,
        page,
        limit: PAGE_SIZE,
        payeeIds: filters.payeeIds?.length ? filters.payeeIds : undefined,
        categoryIds: filters.categoryIds?.length ? filters.categoryIds : undefined,
        startDate: filters.startDate || undefined,
        endDate: filters.endDate || undefined,
      });
      setCashTransactions(response.data || []);
      setCashPagination(response.pagination ? {
        page: response.pagination.page,
        totalPages: response.pagination.totalPages,
        total: response.pagination.total,
      } : null);
    } catch (error) {
      logger.error('Failed to load cash transactions:', error);
      setCashTransactions([]);
      setCashPagination(null);
    } finally {
      setCashTransactionsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInvestmentAccounts();
    loadAllAccounts();
    loadPriceStatus();
  }, [loadInvestmentAccounts, loadAllAccounts, loadPriceStatus]);

  // Prune stale/non-selectable account IDs from localStorage when accounts load
  useEffect(() => {
    if (accounts.length > 0 && selectedAccountIds.length > 0) {
      const selectableIds = new Set(
        accounts
          .filter((a) => a.accountSubType === 'INVESTMENT_BROKERAGE' || !a.accountSubType)
          .map((a) => a.id),
      );
      const pruned = selectedAccountIds.filter((id) => selectableIds.has(id));
      if (pruned.length !== selectedAccountIds.length) {
        setSelectedAccountIds(pruned);
      }
    }
  }, [accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load summary when account selection changes
  useEffect(() => {
    loadPortfolioSummary(selectedAccountIds);
  }, [loadPortfolioSummary, selectedAccountIds]);

  // Load transactions when page, filters, or account selection changes
  useEffect(() => {
    loadTransactions(selectedAccountIds, currentPage, transactionFilters);
  }, [loadTransactions, selectedAccountIds, currentPage, transactionFilters]);

  // Memoize cash filters object
  const cashFiltersObj = useMemo(() => ({
    payeeIds: cashFilterPayeeIds,
    categoryIds: cashFilterCategoryIds,
    startDate: cashFilterStartDate,
    endDate: cashFilterEndDate,
  }), [cashFilterPayeeIds, cashFilterCategoryIds, cashFilterStartDate, cashFilterEndDate]);

  // Load cash transactions when view switches to 'cash' or dependencies change
  // (Caller must pass transactionView to control this)
  const loadCashTransactionsIfNeeded = useCallback((transactionView: string) => {
    if (transactionView === 'cash') {
      loadCashTransactions(cashAccountIds, cashCurrentPage, cashFiltersObj);
    }
  }, [loadCashTransactions, cashAccountIds, cashCurrentPage, cashFiltersObj]);

  useEffect(() => {
    if (!isLoading && !initialLoadComplete) {
      setInitialLoadComplete(true);
      triggerAutoRefresh();
    }
  }, [isLoading, initialLoadComplete, triggerAutoRefresh]);

  // Track which edit ID we have already handled
  const editHandledRef = useRef<string | null>(null);

  // Handle edit URL parameter (when redirected from transactions page)
  useEffect(() => {
    const editId = searchParams.get('edit');
    if (editId) {
      if (editId === editHandledRef.current) {
        router.replace('/investments', { scroll: false });
        return;
      }
      editHandledRef.current = editId;
      investmentsApi.getTransaction(editId)
        .then((transaction) => {
          openEdit(transaction);
          router.replace('/investments', { scroll: false });
        })
        .catch((error) => {
          logger.error('Failed to load investment transaction:', error);
          router.replace('/investments', { scroll: false });
        });
    } else if (!showTransactionForm) {
      editHandledRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, router, openEdit]);

  const handleAccountChange = (values: string[]) => {
    setSelectedAccountIds(values);
    setCurrentPage(1);
    setCashCurrentPage(1);
  };

  const handleDeleteTransaction = async (id: string) => {
    if (!confirm('Are you sure you want to delete this transaction?')) return;
    try {
      await investmentsApi.deleteTransaction(id);
      loadAllPortfolioData(selectedAccountIds, currentPage, transactionFilters);
    } catch (error) {
      logger.error('Failed to delete transaction:', error);
      alert('Failed to delete transaction');
    }
  };

  const handleNewTransaction = () => openCreate();
  const handleEditTransaction = (transaction: InvestmentTransaction) => openEdit(transaction);

  const handleFormSuccess = () => {
    close();
    loadAllPortfolioData(selectedAccountIds, currentPage, transactionFilters);
  };

  // Cash transaction handlers
  const handleEditCashTransaction = async (transaction: Transaction) => {
    if (transaction.linkedInvestmentTransactionId) {
      router.push(`/investments?edit=${transaction.linkedInvestmentTransactionId}`);
      return;
    }
    if (transaction.isTransfer) {
      try {
        const fullTransaction = await transactionsApi.getById(transaction.id);
        openCashEdit(fullTransaction);
      } catch (error) {
        logger.error('Failed to load transaction details:', error);
        openCashEdit(transaction);
      }
    } else {
      openCashEdit(transaction);
    }
  };

  const handleCashTransactionUpdate = useCallback((updatedTx: Transaction) => {
    setCashTransactions(prev => prev.map(tx => tx.id === updatedTx.id ? updatedTx : tx));
  }, []);

  const handleCashFormSuccess = () => {
    closeCash();
    loadCashTransactions(cashAccountIds, cashCurrentPage, cashFiltersObj);
  };

  const refreshCashTransactions = useCallback(() => {
    loadCashTransactions(cashAccountIds, cashCurrentPage, cashFiltersObj);
  }, [loadCashTransactions, cashAccountIds, cashCurrentPage, cashFiltersObj]);

  const handleFiltersChange = (newFilters: TransactionFilters) => {
    setTransactionFilters(newFilters);
    setCurrentPage(1);
  };

  const clearCashFilters = () => {
    setCashFilterPayeeIds([]);
    setCashFilterCategoryIds([]);
    setCashFilterStartDate('');
    setCashFilterEndDate('');
    setCashCurrentPage(1);
  };

  const hasActiveCashFilters = cashFilterPayeeIds.length > 0 || cashFilterCategoryIds.length > 0 || !!cashFilterStartDate || !!cashFilterEndDate;
  const activeCashFilterCount = (cashFilterPayeeIds.length > 0 ? 1 : 0) + (cashFilterCategoryIds.length > 0 ? 1 : 0) + (cashFilterStartDate ? 1 : 0) + (cashFilterEndDate ? 1 : 0);

  const handleSymbolClick = (symbol: string) => {
    setTransactionFilters({ ...transactionFilters, symbol });
    setCurrentPage(1);
  };

  const handleCashClick = (cashAccountId: string) => {
    router.push(`/transactions?accountId=${cashAccountId}`);
  };

  const goToPage = (page: number) => {
    if (page >= 1 && (!pagination || page <= pagination.totalPages)) {
      setCurrentPage(page);
    }
  };

  const goToCashPage = (page: number) => {
    if (page >= 1 && (!cashPagination || page <= cashPagination.totalPages)) {
      setCashCurrentPage(page);
    }
  };

  const getSelectedBrokerageAccountId = () => {
    if (selectedAccountIds.length === 0) return undefined;
    return selectedAccountIds[0];
  };

  // Get selectable investment accounts (brokerage and standalone)
  const selectableAccounts = accounts.filter(
    (a) => a.accountSubType === 'INVESTMENT_BROKERAGE' || !a.accountSubType,
  );

  return {
    // Accounts
    accounts, allAccounts, selectedAccountIds, selectableAccounts,
    handleAccountChange,

    // Portfolio
    portfolioSummary, isLoading,
    loadAllPortfolioData,

    // Brokerage transactions
    transactions, pagination, currentPage,
    transactionFilters, handleFiltersChange,
    handleDeleteTransaction, handleNewTransaction, handleEditTransaction, handleFormSuccess,
    handleSymbolClick, goToPage,

    // Transaction form modal
    showTransactionForm, editingTransaction,
    close, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef,
    getSelectedBrokerageAccountId,

    // Price refresh
    isRefreshingPrices, lastPriceUpdate, refreshResult, showRefreshDetails,
    setShowRefreshDetails, handleRefreshPrices,

    // Cash transactions
    cashAccountIds, cashTransactions, cashPagination, cashCurrentPage,
    cashTransactionsLoading, cashPayees, cashCategories,
    cashFilterPayeeIds, setCashFilterPayeeIds,
    cashFilterCategoryIds, setCashFilterCategoryIds,
    cashFilterStartDate, setCashFilterStartDate,
    cashFilterEndDate, setCashFilterEndDate,
    showCashFilters, setShowCashFilters,
    hasActiveCashFilters, activeCashFilterCount,
    handleEditCashTransaction, handleCashTransactionUpdate, handleCashFormSuccess,
    refreshCashTransactions, clearCashFilters,
    goToCashPage, handleCashClick,
    loadCashFilterData, loadCashTransactionsIfNeeded,
    setCashCurrentPage,
    openCashCreate,

    // Cash form modal
    showCashForm, editingCashTransaction, closeCash,
    cashModalProps, setCashFormDirty, cashUnsavedChangesDialog, cashFormSubmitRef,
  };
}
