import { describe, it, expect, vi, beforeEach } from 'vitest';
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
