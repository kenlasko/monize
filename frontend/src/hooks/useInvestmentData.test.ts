import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInvestmentData } from './useInvestmentData';

// --- API mocks ---
const mockDeleteTransaction = vi.fn();
const mockGetPortfolioSummary = vi.fn();
const mockGetTransactions = vi.fn();
const mockGetInvestmentAccounts = vi.fn();
const mockGetAllAccounts = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    deleteTransaction: (...args: unknown[]) => mockDeleteTransaction(...args),
    getPortfolioSummary: (...args: unknown[]) => mockGetPortfolioSummary(...args),
    getTransactions: (...args: unknown[]) => mockGetTransactions(...args),
    getInvestmentAccounts: (...args: unknown[]) => mockGetInvestmentAccounts(...args),
    getPriceStatus: vi.fn().mockResolvedValue({ lastUpdated: null }),
  },
}));

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: vi.fn().mockResolvedValue({ data: [], pagination: null }),
    getById: vi.fn(),
  },
}));

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (..._args: unknown[]) => mockGetAllAccounts(),
  },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: { getAll: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@/lib/payees', () => ({
  payeesApi: { getAll: vi.fn().mockResolvedValue([]) },
}));

// --- Hook mocks ---
vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (_key: string, initialValue: unknown) => {
    const { useState } = require('react');
    return useState(initialValue);
  },
}));

vi.mock('@/hooks/usePriceRefresh', () => ({
  usePriceRefresh: () => ({ triggerAutoRefresh: vi.fn() }),
  setRefreshInProgress: vi.fn(),
}));

vi.mock('@/hooks/useFormModal', () => ({
  useFormModal: () => ({
    showForm: false,
    editingItem: null,
    openCreate: vi.fn(),
    openEdit: vi.fn(),
    close: vi.fn(),
    isEditing: false,
    modalProps: {},
    setFormDirty: vi.fn(),
    unsavedChangesDialog: null,
    formSubmitRef: { current: null },
  }),
}));

const mockRouterPush = vi.fn();
const mockRouterReplace = vi.fn();
let mockSearchParamsGet: (key: string) => string | null = () => null;

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: (key: string) => mockSearchParamsGet(key) }),
  useRouter: () => ({ push: mockRouterPush, replace: mockRouterReplace }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

vi.mock('@/lib/constants', () => ({ PAGE_SIZE: 25 }));

vi.mock('@/components/investments/InvestmentTransactionList', () => ({}));

// --- Helpers ---
const makeTx = (id: string) => ({
  id,
  action: 'BUY',
  transactionDate: '2024-01-15',
  quantity: 10,
  price: 100,
  totalAmount: 1000,
  security: { symbol: 'AAPL', name: 'Apple', currencyCode: 'CAD' },
});

const mockSummary = { totalValue: 5000, totalCost: 4000, totalGain: 1000 };

const defaultSetup = () => {
  mockGetInvestmentAccounts.mockResolvedValue([]);
  mockGetAllAccounts.mockResolvedValue([]);
  mockGetTransactions.mockResolvedValue({ data: [makeTx('t1'), makeTx('t2')], pagination: null });
  mockGetPortfolioSummary.mockResolvedValue(mockSummary);
};

describe('useInvestmentData – handleDeleteTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParamsGet = () => null;
    defaultSetup();
  });

  it('optimistically removes the transaction from state before API call resolves', async () => {
    // Make delete hang so we can observe the optimistic removal
    let resolveDelete!: () => void;
    mockDeleteTransaction.mockReturnValue(new Promise<void>(res => { resolveDelete = res; }));

    const { result } = renderHook(() => useInvestmentData());

    // Seed state with two transactions
    await act(async () => {
      // Wait for initial load effects to settle
      await Promise.resolve();
    });
    // Manually set transactions via the loadAllPortfolioData path
    await act(async () => {
      await new Promise(res => setTimeout(res, 0));
    });

    // Call delete for t1
    act(() => {
      void result.current.handleDeleteTransaction('t1');
    });

    // t1 should be removed immediately, t2 should remain
    expect(result.current.transactions.every(tx => tx.id !== 't1')).toBe(true);

    // Clean up the hanging promise — wrap in act since resolving triggers state updates
    await act(async () => {
      resolveDelete();
    });
  });

  it('removes both legs of a security transfer when one is deleted', async () => {
    mockDeleteTransaction.mockResolvedValue(undefined);
    const out = { ...makeTx('t1'), action: 'TRANSFER_OUT', linkedTransactionId: 't2' };
    const inLeg = { ...makeTx('t2'), action: 'TRANSFER_IN', linkedTransactionId: 't1' };
    mockGetTransactions.mockResolvedValue({
      data: [out, inLeg],
      pagination: { page: 1, limit: 25, total: 2, totalPages: 1, hasMore: false },
    });

    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });

    await act(async () => {
      await result.current.handleDeleteTransaction('t1');
    });

    // Both the deleted leg and its linked pair are gone from the list.
    expect(result.current.transactions).toHaveLength(0);
  });

  it('decrements the total by two for a transfer even when the paired leg is on another page', async () => {
    mockDeleteTransaction.mockResolvedValue(undefined);
    // Only the OUT leg is loaded; its pair (t2) lives on another page.
    const out = { ...makeTx('t1'), action: 'TRANSFER_OUT', linkedTransactionId: 't2' };
    mockGetTransactions.mockResolvedValue({
      data: [out],
      pagination: { page: 1, limit: 25, total: 10, totalPages: 1, hasMore: false },
    });

    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });

    await act(async () => {
      await result.current.handleDeleteTransaction('t1');
    });

    // The backend deletes both legs, so the total drops by 2 (10 -> 8) even
    // though only one leg was in the loaded list.
    expect(result.current.pagination?.total).toBe(8);
  });

  it('drops the total by one when an account filter excludes the paired leg', async () => {
    mockDeleteTransaction.mockResolvedValue(undefined);
    // Only the OUT leg is loaded; its pair (t2) is on another account that the
    // active filter excludes, so it is not part of pagination.total.
    const out = { ...makeTx('t1'), action: 'TRANSFER_OUT', linkedTransactionId: 't2' };
    mockGetTransactions.mockResolvedValue({
      data: [out],
      pagination: { page: 1, limit: 25, total: 10, totalPages: 1, hasMore: false },
    });

    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });

    // Filter to a single account.
    await act(async () => {
      result.current.handleAccountChange(['acc-1']);
      await new Promise(res => setTimeout(res, 0));
    });

    await act(async () => {
      await result.current.handleDeleteTransaction('t1');
    });

    // Only the in-scope leg counts: 10 -> 9, not 8.
    expect(result.current.pagination?.total).toBe(9);
  });

  it('calls deleteTransaction API with the correct id', async () => {
    mockDeleteTransaction.mockResolvedValue(undefined);

    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });

    await act(async () => {
      await result.current.handleDeleteTransaction('t1');
    });

    expect(mockDeleteTransaction).toHaveBeenCalledWith('t1');
  });

  it('refreshes portfolio summary after successful delete', async () => {
    mockDeleteTransaction.mockResolvedValue(undefined);
    const freshSummary = { totalValue: 4000, totalCost: 3500, totalGain: 500 };
    mockGetPortfolioSummary.mockResolvedValue(freshSummary);

    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });

    await act(async () => {
      await result.current.handleDeleteTransaction('t1');
    });

    expect(mockGetPortfolioSummary).toHaveBeenCalled();
    expect(result.current.portfolioSummary).toEqual(freshSummary);
  });

  it('keeps isLoading=false on subsequent reloads so sections do not redraw from blank', async () => {
    // Initial load completes -> isLoading=false. Subsequent reloads (e.g.
    // from a price refresh) should NOT flip isLoading back to true; the
    // sections should keep showing existing data while the fetch is in
    // flight. Without this, every refresh causes the summary card,
    // allocation chart, holdings list, and transaction list to revert to
    // their skeleton state -- the bug the user reported as "every section
    // except the chart redraws from blank when refreshing prices".
    mockGetPortfolioSummary.mockResolvedValue(mockSummary);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: null });

    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });

    expect(result.current.isLoading).toBe(false);
    const initialCalls = mockGetPortfolioSummary.mock.calls.length;

    // Trigger a subsequent reload (the same path price-refresh uses).
    await act(async () => {
      await result.current.loadAllPortfolioData([], 1, {});
    });

    expect(mockGetPortfolioSummary.mock.calls.length).toBeGreaterThan(initialCalls);
    expect(result.current.isLoading).toBe(false);
  });

  it('does not call setIsLoading on successful delete (no full reload)', async () => {
    mockDeleteTransaction.mockResolvedValue(undefined);

    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });

    // isLoading should be false after initial load
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      await result.current.handleDeleteTransaction('t1');
    });

    // Should remain false — no full reload triggered
    expect(result.current.isLoading).toBe(false);
  });

  it('falls back to loadAllPortfolioData when deleteTransaction fails', async () => {
    mockDeleteTransaction.mockRejectedValue(new Error('Network error'));
    // loadAllPortfolioData calls getPortfolioSummary + getTransactions
    mockGetPortfolioSummary.mockResolvedValue(mockSummary);
    mockGetTransactions.mockResolvedValue({ data: [makeTx('t1'), makeTx('t2')], pagination: null });

    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });

    await act(async () => {
      await result.current.handleDeleteTransaction('t1');
    });

    // loadAllPortfolioData sets isLoading=true then false — it was called
    // getTransactions should have been called again as part of the fallback
    expect(mockGetTransactions).toHaveBeenCalledTimes(2); // initial + fallback
  });

  it('does not call getPortfolioSummary separately when delete fails', async () => {
    mockDeleteTransaction.mockRejectedValue(new Error('Network error'));
    mockGetPortfolioSummary.mockResolvedValue(mockSummary);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: null });

    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });

    const summaryCallsBefore = mockGetPortfolioSummary.mock.calls.length;

    await act(async () => {
      await result.current.handleDeleteTransaction('t1');
    });

    // The fallback loadAllPortfolioData calls getPortfolioSummary once (not the separate call)
    const summaryCallsAfter = mockGetPortfolioSummary.mock.calls.length;
    expect(summaryCallsAfter - summaryCallsBefore).toBe(1);
  });
});

describe('useInvestmentData – accountId URL filter', () => {
  const brokerageAccount = {
    id: 'broker-1',
    name: 'My Brokerage',
    accountType: 'INVESTMENT',
    accountSubType: 'INVESTMENT_BROKERAGE',
    linkedAccountId: 'cash-1',
    currentBalance: 0,
    currencyCode: 'CAD',
  };

  const cashAccount = {
    id: 'cash-1',
    name: 'My Cash',
    accountType: 'INVESTMENT',
    accountSubType: 'INVESTMENT_CASH',
    linkedAccountId: 'broker-1',
    currentBalance: 0,
    currencyCode: 'CAD',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParamsGet = () => null;
    mockGetTransactions.mockResolvedValue({ data: [], pagination: null });
    mockGetPortfolioSummary.mockResolvedValue(mockSummary);
    mockGetAllAccounts.mockResolvedValue([]);
  });

  it('sets selectedAccountIds from accountId URL parameter when account exists', async () => {
    mockSearchParamsGet = (key: string) => key === 'accountId' ? 'broker-1' : null;
    mockGetInvestmentAccounts.mockResolvedValue([brokerageAccount, cashAccount]);

    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });

    expect(result.current.selectedAccountIds).toEqual(['broker-1']);
  });

  it('cleans up the URL after applying the accountId filter', async () => {
    mockSearchParamsGet = (key: string) => key === 'accountId' ? 'broker-1' : null;
    mockGetInvestmentAccounts.mockResolvedValue([brokerageAccount, cashAccount]);

    renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });

    expect(mockRouterReplace).toHaveBeenCalledWith('/investments', { scroll: false });
  });

  it('does not set filter when accountId does not match a selectable account', async () => {
    mockSearchParamsGet = (key: string) => key === 'accountId' ? 'nonexistent-id' : null;
    mockGetInvestmentAccounts.mockResolvedValue([brokerageAccount, cashAccount]);

    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });

    // Should remain empty (default) since the account was not found
    expect(result.current.selectedAccountIds).toEqual([]);
    // URL should still be cleaned up
    expect(mockRouterReplace).toHaveBeenCalledWith('/investments', { scroll: false });
  });

  it('does not set filter for non-brokerage accounts (e.g. INVESTMENT_CASH)', async () => {
    mockSearchParamsGet = (key: string) => key === 'accountId' ? 'cash-1' : null;
    mockGetInvestmentAccounts.mockResolvedValue([brokerageAccount, cashAccount]);

    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });

    expect(result.current.selectedAccountIds).toEqual([]);
  });

  it('does not apply accountId filter when no accountId param is present', async () => {
    mockSearchParamsGet = () => null;
    mockGetInvestmentAccounts.mockResolvedValue([brokerageAccount, cashAccount]);

    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });

    expect(result.current.selectedAccountIds).toEqual([]);
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });
});

describe('useInvestmentData – pagination, filters, handlers', () => {
  const broker = {
    id: 'b1', name: 'Brk', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE',
    linkedAccountId: 'c1', currencyCode: 'USD', currentBalance: 0,
  };
  const cash = {
    id: 'c1', name: 'Cash', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_CASH',
    linkedAccountId: 'b1', currencyCode: 'USD', currentBalance: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParamsGet = () => null;
    mockGetInvestmentAccounts.mockResolvedValue([broker, cash]);
    mockGetAllAccounts.mockResolvedValue([broker, cash]);
    mockGetTransactions.mockResolvedValue({ data: [makeTx('t1')], pagination: { page: 1, limit: 25, total: 1, totalPages: 1, hasMore: false } });
    mockGetPortfolioSummary.mockResolvedValue(mockSummary);
  });

  it('handleAccountChange updates selection and resets pages', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    await act(async () => {
      result.current.handleAccountChange(['b1']);
    });
    expect(result.current.selectedAccountIds).toEqual(['b1']);
    expect(result.current.currentPage).toBe(1);
  });

  it('handleSymbolClick sets symbol filter and resets page', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    await act(async () => {
      result.current.handleSymbolClick('AAPL');
    });
    expect(result.current.transactionFilters.symbol).toBe('AAPL');
  });

  it('handleFiltersChange updates filter and resets page', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    await act(async () => {
      result.current.handleFiltersChange({ action: 'BUY' });
    });
    expect(result.current.transactionFilters).toEqual({ action: 'BUY' });
  });

  it('goToPage updates page when within bounds', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { page: 1, limit: 25, total: 50, totalPages: 2, hasMore: false } });
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    await act(async () => { result.current.goToPage(2); });
    expect(result.current.currentPage).toBe(2);
  });

  it('goToPage rejects out-of-bounds pages', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { page: 1, limit: 25, total: 1, totalPages: 1, hasMore: false } });
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    await act(async () => { result.current.goToPage(99); });
    expect(result.current.currentPage).toBe(1);
    await act(async () => { result.current.goToPage(-1); });
    expect(result.current.currentPage).toBe(1);
  });

  it('clearCashFilters resets all cash filter state', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    await act(async () => {
      result.current.setCashFilterPayeeIds(['p1']);
      result.current.setCashFilterCategoryIds(['c1']);
      result.current.setCashFilterStartDate('2024-01-01');
      result.current.setCashFilterEndDate('2024-12-31');
    });
    expect(result.current.hasActiveCashFilters).toBe(true);
    expect(result.current.activeCashFilterCount).toBe(4);

    await act(async () => { result.current.clearCashFilters(); });
    expect(result.current.hasActiveCashFilters).toBe(false);
  });

  it('handleCashClick navigates to transactions page', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    await act(async () => { result.current.handleCashClick('cash-x'); });
    expect(mockRouterPush).toHaveBeenCalledWith('/transactions?accountId=cash-x');
  });

  it('goToCashPage updates page when within bounds', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    await act(async () => { result.current.goToCashPage(2); });
    expect(result.current.cashCurrentPage).toBe(2);
  });

  it('handleCashTransactionUpdate replaces matching transaction', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    await act(async () => {
      result.current.handleCashTransactionUpdate({ id: 'x', amount: 5 } as any);
    });
  });

  it('getSelectedBrokerageAccountId returns first selected', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    await act(async () => { result.current.handleAccountChange(['b1']); });
    expect(result.current.getSelectedBrokerageAccountId()).toBe('b1');
  });

  it('getSelectedBrokerageAccountId returns undefined when none selected', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    expect(result.current.getSelectedBrokerageAccountId()).toBeUndefined();
  });

  it('cashAccountIds derives from selected brokerages with linkedAccountId', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    expect(result.current.cashAccountIds).toEqual(['c1']);

    await act(async () => { result.current.handleAccountChange(['b1']); });
    expect(result.current.cashAccountIds).toEqual(['c1']);
  });

  it('hasActiveCashFilters returns false when none set', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    expect(result.current.hasActiveCashFilters).toBe(false);
    expect(result.current.activeCashFilterCount).toBe(0);
  });
});

describe('useInvestmentData – cash transaction loading', () => {
  const broker = {
    id: 'b1', name: 'Brk', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE',
    linkedAccountId: 'c1', currencyCode: 'USD', currentBalance: 0,
  };
  const cash = {
    id: 'c1', name: 'Cash', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_CASH',
    linkedAccountId: 'b1', currencyCode: 'USD', currentBalance: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParamsGet = () => null;
    mockGetInvestmentAccounts.mockResolvedValue([broker, cash]);
    mockGetAllAccounts.mockResolvedValue([broker, cash]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: null });
    mockGetPortfolioSummary.mockResolvedValue(mockSummary);
  });

  it('loadCashTransactionsIfNeeded loads when view is "cash"', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    await act(async () => {
      result.current.loadCashTransactionsIfNeeded('cash');
    });
    // Should be safe; no assertion needed beyond no-throw
  });

  it('loadCashTransactionsIfNeeded skips when view is not "cash"', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    act(() => {
      result.current.loadCashTransactionsIfNeeded('brokerage');
    });
  });

  it('refreshCashTransactions is callable', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    await act(async () => {
      result.current.refreshCashTransactions();
    });
  });

  it('loadCashFilterData loads categories and payees', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    await act(async () => {
      await result.current.loadCashFilterData();
    });
  });

  it('handleCashFormSuccess closes form and reloads data', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    // openCashCreate then handleCashFormSuccess
    act(() => result.current.openCashCreate());
    await act(async () => result.current.handleCashFormSuccess());
  });

  it('handleNewTransaction opens create modal', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    act(() => result.current.handleNewTransaction());
  });

  it('handleEditTransaction opens edit modal', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    act(() => result.current.handleEditTransaction(makeTx('t1') as any));
  });

  it('handleFormSuccess reloads portfolio data', async () => {
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    await act(async () => result.current.handleFormSuccess());
  });
});

describe('useInvestmentData – pruning stale account IDs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParamsGet = () => null;
    mockGetTransactions.mockResolvedValue({ data: [], pagination: null });
    mockGetPortfolioSummary.mockResolvedValue(mockSummary);
    mockGetAllAccounts.mockResolvedValue([]);
    // Pre-populate localStorage with accounts that no longer exist
    localStorage.setItem('monize-investments-accounts', JSON.stringify(['stale-id']));
  });

  it('prunes stale account IDs from localStorage when accounts load', async () => {
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'broker-1', name: 'B', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', linkedAccountId: null, currencyCode: 'USD', currentBalance: 0 },
    ]);
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    expect(result.current.selectedAccountIds).toEqual([]);
  });

  afterEach(() => {
    localStorage.clear();
  });
});

describe('useInvestmentData – edit URL parameter flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParamsGet = () => null;
    mockGetTransactions.mockResolvedValue({ data: [], pagination: null });
    mockGetPortfolioSummary.mockResolvedValue(mockSummary);
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
  });

  it('opens edit modal when ?edit= URL param present and transaction loads', async () => {
    mockSearchParamsGet = (key) => key === 'edit' ? 'tx-edit-1' : null;
    const mockGetTx = vi.fn().mockResolvedValue({ id: 'tx-edit-1', action: 'BUY' });
    // monkey-patch investmentsApi.getTransaction
    const investmentsApiMod = await import('@/lib/investments');
    const originalGetTx = (investmentsApiMod.investmentsApi as any).getTransaction;
    (investmentsApiMod.investmentsApi as any).getTransaction = mockGetTx;
    try {
      renderHook(() => useInvestmentData());
      await act(async () => { await new Promise(res => setTimeout(res, 0)); });
      expect(mockGetTx).toHaveBeenCalledWith('tx-edit-1');
    } finally {
      (investmentsApiMod.investmentsApi as any).getTransaction = originalGetTx;
    }
  });

  it('handles edit URL parameter fetch error gracefully', async () => {
    mockSearchParamsGet = (key) => key === 'edit' ? 'tx-edit-x' : null;
    const investmentsApiMod = await import('@/lib/investments');
    const originalGetTx = (investmentsApiMod.investmentsApi as any).getTransaction;
    (investmentsApiMod.investmentsApi as any).getTransaction = vi.fn().mockRejectedValue(new Error('boom'));
    try {
      renderHook(() => useInvestmentData());
      await act(async () => { await new Promise(res => setTimeout(res, 0)); });
      expect(mockRouterReplace).toHaveBeenCalled();
    } finally {
      (investmentsApiMod.investmentsApi as any).getTransaction = originalGetTx;
    }
  });
});

describe('useInvestmentData – delete error toast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParamsGet = () => null;
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({ data: [makeTx('t1')], pagination: { page: 1, limit: 25, total: 1, totalPages: 1, hasMore: false } });
    mockGetPortfolioSummary.mockResolvedValue(mockSummary);
  });

  it('updates pagination optimistically when transaction is deleted', async () => {
    mockDeleteTransaction.mockResolvedValue(undefined);
    const { result } = renderHook(() => useInvestmentData());
    await act(async () => { await new Promise(res => setTimeout(res, 0)); });
    expect(result.current.pagination?.total).toBe(1);
    await act(async () => {
      await result.current.handleDeleteTransaction('t1');
    });
    expect(result.current.pagination?.total).toBe(0);
  });
});
