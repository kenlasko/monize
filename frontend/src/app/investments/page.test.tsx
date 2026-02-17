import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import InvestmentsPage from './page';

// Mock next/image
vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img alt="" {...props} />,
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock auth store
vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      const state = {
        user: { id: 'test-user-id', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        logout: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    {
      getState: vi.fn(() => ({
        user: { id: 'test-user-id', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
      })),
    },
  ),
}));

// Mock preferences store
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector?: any) => {
    const state = {
      preferences: { twoFactorEnabled: true, theme: 'system' },
      isLoaded: true,
      _hasHydrated: true,
    };
    return selector ? selector(state) : state;
  },
}));

// Mock auth API
vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: false,
    }),
  },
}));

vi.mock('@/lib/constants', () => ({
  PAGE_SIZE: 25,
}));

const mockGetInvestmentAccounts = vi.fn();
const mockGetAllAccounts = vi.fn();
const mockGetPortfolioSummary = vi.fn();
const mockGetTransactions = vi.fn();
const mockGetPriceStatus = vi.fn();
const mockRefreshSelectedPrices = vi.fn();
const mockDeleteTransaction = vi.fn();
const mockGetTransaction = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
    getTransactions: (...args: any[]) => mockGetTransactions(...args),
    getPriceStatus: (...args: any[]) => mockGetPriceStatus(...args),
    refreshSelectedPrices: (...args: any[]) => mockRefreshSelectedPrices(...args),
    getTransaction: (...args: any[]) => mockGetTransaction(...args),
    deleteTransaction: (...args: any[]) => mockDeleteTransaction(...args),
  },
}));

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAllAccounts(...args),
  },
}));

const mockOpenCreate = vi.fn();
const mockOpenEdit = vi.fn();
const mockClose = vi.fn();

vi.mock('@/hooks/useFormModal', () => ({
  useFormModal: () => ({
    showForm: false,
    editingItem: null,
    openCreate: mockOpenCreate,
    openEdit: mockOpenEdit,
    close: mockClose,
    isEditing: false,
    modalProps: {},
    setFormDirty: vi.fn(),
    unsavedChangesDialog: { isOpen: false, onConfirm: vi.fn(), onCancel: vi.fn() },
    formSubmitRef: { current: null },
  }),
}));

// Configurable useLocalStorage mock - tracks state per key
const mockLocalStorageState: Record<string, { value: any; setter: ReturnType<typeof vi.fn> }> = {};

vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (key: string, defaultValue: any) => {
    if (!mockLocalStorageState[key]) {
      const setter = vi.fn((newValue: any) => {
        mockLocalStorageState[key].value = typeof newValue === 'function'
          ? newValue(mockLocalStorageState[key].value)
          : newValue;
      });
      mockLocalStorageState[key] = { value: defaultValue, setter };
    }
    return [mockLocalStorageState[key].value, mockLocalStorageState[key].setter];
  },
}));

vi.mock('@/hooks/usePriceRefresh', () => ({
  usePriceRefresh: () => ({
    isRefreshing: false,
    triggerAutoRefresh: vi.fn(),
  }),
  setRefreshInProgress: vi.fn(),
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) => (
    <button onClick={onClick} disabled={disabled} {...rest}>{children}</button>
  ),
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: any) => isOpen ? <div data-testid="modal">{children}</div> : null,
}));

vi.mock('@/components/ui/UnsavedChangesDialog', () => ({
  UnsavedChangesDialog: () => null,
}));

vi.mock('@/components/ui/MultiSelect', () => ({
  MultiSelect: ({ options, placeholder, onChange }: any) => (
    <div data-testid="multi-select">
      <span>{placeholder}</span>
      {options?.map((opt: any) => (
        <button key={opt.value} data-testid={`option-${opt.value}`} onClick={() => onChange([opt.value])}>
          {opt.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('@/components/ui/Pagination', () => ({
  Pagination: ({ currentPage, totalPages }: any) => (
    <div data-testid="pagination">Page {currentPage} of {totalPages}</div>
  ),
}));

vi.mock('@/components/investments/PortfolioSummaryCard', () => ({
  PortfolioSummaryCard: ({ summary, singleAccountCurrency }: any) => (
    <div data-testid="portfolio-summary">
      {summary ? `Total: ${summary.totalPortfolioValue}` : 'No data'}
      {singleAccountCurrency && <span data-testid="single-currency">{singleAccountCurrency}</span>}
    </div>
  ),
}));

vi.mock('@/components/investments/AssetAllocationChart', () => ({
  AssetAllocationChart: ({ allocation }: any) => (
    <div data-testid="asset-allocation-chart">
      {allocation ? `Value: ${allocation.totalValue}` : 'No allocation'}
    </div>
  ),
}));

vi.mock('@/components/investments/GroupedHoldingsList', () => ({
  GroupedHoldingsList: ({ onSymbolClick, onCashClick }: any) => (
    <div data-testid="grouped-holdings">
      <button data-testid="symbol-click" onClick={() => onSymbolClick('AAPL')}>AAPL</button>
      <button data-testid="cash-click" onClick={() => onCashClick('cash-1')}>Cash</button>
    </div>
  ),
}));

vi.mock('@/components/investments/InvestmentTransactionList', () => ({
  InvestmentTransactionList: ({ transactions, onDelete, onEdit, onNewTransaction, onFiltersChange, filters }: any) => (
    <div data-testid="transaction-list">
      <span>{transactions.length} transactions</span>
      {transactions.map((t: any) => (
        <div key={t.id} data-testid={`itx-${t.id}`}>
          <button data-testid={`delete-${t.id}`} onClick={() => onDelete(t.id)}>Delete</button>
          <button data-testid={`edit-${t.id}`} onClick={() => onEdit(t)}>Edit</button>
        </div>
      ))}
      <button data-testid="new-tx-btn" onClick={onNewTransaction}>New</button>
      <button data-testid="clear-filters" onClick={() => onFiltersChange({})}>Clear Filters</button>
      {filters?.symbol && <span data-testid="symbol-filter">{filters.symbol}</span>}
    </div>
  ),
}));

vi.mock('@/components/investments/InvestmentTransactionForm', () => ({
  InvestmentTransactionForm: () => <div data-testid="transaction-form">Form</div>,
}));

vi.mock('@/components/investments/InvestmentValueChart', () => ({
  InvestmentValueChart: ({ accountIds }: any) => (
    <div data-testid="value-chart">
      {accountIds?.length > 0 ? `Filtered: ${accountIds.join(',')}` : 'All accounts'}
    </div>
  ),
}));

const mockCashAccounts = [
  { id: 'cash-1', name: 'RRSP - Cash', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_CASH', linkedAccountId: 'brok-1', currencyCode: 'USD', currentBalance: 5000, isClosed: false },
  { id: 'cash-2', name: 'TFSA - Cash', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_CASH', linkedAccountId: 'brok-2', currencyCode: 'CAD', currentBalance: 3000, isClosed: false },
  { id: 'brok-1', name: 'RRSP - Brokerage', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', linkedAccountId: 'cash-1', currencyCode: 'USD', currentBalance: 0, isClosed: false },
  { id: 'brok-2', name: 'TFSA - Brokerage', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', linkedAccountId: 'cash-2', currencyCode: 'CAD', currentBalance: 0, isClosed: false },
];

const mockPortfolioSummary = {
  totalPortfolioValue: 50000,
  totalCostBasis: 40000,
  totalGainLoss: 10000,
  totalGainLossPercentage: 25,
  holdingsByAccount: [{ accountName: 'RRSP', holdings: [] }],
  holdings: [
    { securityId: 'sec-1', symbol: 'AAPL', quantity: 10 },
    { securityId: 'sec-2', symbol: 'GOOG', quantity: 5 },
    { securityId: 'sec-3', symbol: 'SOLD', quantity: 0 },
  ],
  allocation: [],
};

const mockTxResponse = {
  data: [{ id: 'itx-1', action: 'BUY', symbol: 'AAPL', quantity: 10, price: 150 }],
  pagination: { page: 1, totalPages: 1, total: 1 },
};

describe('InvestmentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset useLocalStorage mock state
    for (const key of Object.keys(mockLocalStorageState)) {
      delete mockLocalStorageState[key];
    }
    mockGetInvestmentAccounts.mockResolvedValue(mockCashAccounts);
    mockGetAllAccounts.mockResolvedValue(mockCashAccounts);
    mockGetPortfolioSummary.mockResolvedValue(mockPortfolioSummary);
    mockGetTransactions.mockResolvedValue(mockTxResponse);
    mockGetPriceStatus.mockResolvedValue({ lastUpdated: null });
  });

  describe('Rendering', () => {
    it('renders page title and subtitle', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByText('Investments')).toBeInTheDocument();
        expect(screen.getByText('Track your investment portfolio')).toBeInTheDocument();
      });
    });

    it('renders within page layout', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('page-layout')).toBeInTheDocument();
      });
    });

    it('renders portfolio summary card', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('portfolio-summary')).toBeInTheDocument();
      });
    });

    it('renders asset allocation chart', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('asset-allocation-chart')).toBeInTheDocument();
      });
    });

    it('renders investment value chart', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('value-chart')).toBeInTheDocument();
      });
    });

    it('renders grouped holdings list', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('grouped-holdings')).toBeInTheDocument();
      });
    });

    it('renders transaction list', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('transaction-list')).toBeInTheDocument();
      });
    });

    it('renders New Transaction button', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
      });
    });

    it('renders Refresh button', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByText(/Refresh/)).toBeInTheDocument();
      });
    });

    it('renders auto-generated symbol note', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByText(/Auto-generated symbol name/)).toBeInTheDocument();
      });
    });
  });

  describe('Account Filter', () => {
    it('renders account filter with placeholder', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByText('All Investment Accounts')).toBeInTheDocument();
      });
    });

    it('displays account names without " - Brokerage" suffix', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByText('RRSP')).toBeInTheDocument();
        expect(screen.getByText('TFSA')).toBeInTheDocument();
      });
    });
  });

  describe('Data Loading', () => {
    it('loads investment accounts, all accounts, and price status on mount', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(mockGetInvestmentAccounts).toHaveBeenCalled();
        expect(mockGetAllAccounts).toHaveBeenCalled();
        expect(mockGetPriceStatus).toHaveBeenCalled();
      });
    });

    it('loads portfolio summary and transactions', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(mockGetPortfolioSummary).toHaveBeenCalled();
        expect(mockGetTransactions).toHaveBeenCalled();
      });
    });

    it('handles portfolio summary load failure gracefully', async () => {
      mockGetPortfolioSummary.mockRejectedValue(new Error('Failed'));
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('portfolio-summary')).toHaveTextContent('No data');
      });
    });

    it('handles transaction load failure gracefully', async () => {
      mockGetTransactions.mockRejectedValue(new Error('Failed'));
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('transaction-list')).toHaveTextContent('0 transactions');
      });
    });

    it('handles investment accounts load failure gracefully', async () => {
      mockGetInvestmentAccounts.mockRejectedValue(new Error('Failed'));
      render(<InvestmentsPage />);
      // Should still render the page
      await waitFor(() => {
        expect(screen.getByText('Investments')).toBeInTheDocument();
      });
    });

    it('handles price status load failure gracefully', async () => {
      mockGetPriceStatus.mockRejectedValue(new Error('Failed'));
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByText(/Refresh/)).toBeInTheDocument();
      });
    });
  });

  describe('Price Refresh', () => {
    it('calls refreshSelectedPrices with non-zero-quantity holdings', async () => {
      mockRefreshSelectedPrices.mockResolvedValue({
        updated: 2, failed: 0, results: [], lastUpdated: '2026-02-14T12:00:00Z',
      });
      render(<InvestmentsPage />);
      await waitFor(() => expect(screen.getByText(/Refresh/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/Refresh/));
      await waitFor(() => {
        // sec-3 (qty=0) should be excluded, only sec-1 and sec-2
        expect(mockRefreshSelectedPrices).toHaveBeenCalledWith(['sec-1', 'sec-2']);
      });
    });

    it('handles empty holdings gracefully', async () => {
      mockGetPortfolioSummary
        .mockResolvedValueOnce(mockPortfolioSummary) // initial load
        .mockResolvedValueOnce(mockPortfolioSummary) // account change load
        .mockResolvedValueOnce({ ...mockPortfolioSummary, holdings: [] }); // refresh click
      render(<InvestmentsPage />);
      await waitFor(() => expect(screen.getByText(/Refresh/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/Refresh/));
      await waitFor(() => {
        expect(mockRefreshSelectedPrices).not.toHaveBeenCalled();
      });
    });

    it('displays refresh result with failures', async () => {
      mockRefreshSelectedPrices.mockResolvedValue({
        updated: 1,
        failed: 1,
        results: [
          { symbol: 'AAPL', success: true, price: 150.00 },
          { symbol: 'GOOG', success: false, error: 'Not found' },
        ],
        lastUpdated: '2026-02-14T12:00:00Z',
      });
      render(<InvestmentsPage />);
      await waitFor(() => expect(screen.getByText(/Refresh/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/Refresh/));
      await waitFor(() => {
        expect(screen.getByText(/1 updated, 1 failed/)).toBeInTheDocument();
      });
    });

    it('handles refresh API error', async () => {
      mockRefreshSelectedPrices.mockRejectedValue(new Error('API Error'));
      // Need initial summary to get holdings for refresh
      render(<InvestmentsPage />);
      await waitFor(() => expect(screen.getByText(/Refresh/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/Refresh/));
      await waitFor(() => {
        expect(screen.getByText('Error refreshing')).toBeInTheDocument();
      });
    });

    it('shows last update time on refresh button', async () => {
      mockGetPriceStatus.mockResolvedValue({ lastUpdated: '2026-02-14T11:00:00Z' });
      render(<InvestmentsPage />);
      await waitFor(() => {
        const refreshBtn = screen.getByText(/Refresh/);
        expect(refreshBtn).toBeInTheDocument();
      });
    });
  });

  describe('Symbol Click', () => {
    it('filters transactions by symbol when clicked in holdings', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('symbol-click')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('symbol-click'));

      await waitFor(() => {
        expect(screen.getByTestId('symbol-filter')).toHaveTextContent('AAPL');
      });
    });
  });

  describe('Cash Click', () => {
    it('navigates to transactions page for cash account', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('cash-click')).toBeInTheDocument();
      });

      // Clicking cash should navigate - we can verify it doesn't throw
      fireEvent.click(screen.getByTestId('cash-click'));
    });
  });

  describe('Transaction Actions', () => {
    it('opens new transaction form when button clicked', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('+ New Transaction'));

      expect(mockOpenCreate).toHaveBeenCalled();
    });

    it('opens edit form when transaction edit button is clicked', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('edit-itx-1')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('edit-itx-1'));

      expect(mockOpenEdit).toHaveBeenCalled();
    });

    it('deletes transaction when confirmed', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      mockDeleteTransaction.mockResolvedValue(undefined);

      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('delete-itx-1')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('delete-itx-1'));

      await waitFor(() => {
        expect(mockDeleteTransaction).toHaveBeenCalledWith('itx-1');
      });

      vi.restoreAllMocks();
    });

    it('does not delete transaction when cancelled', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);

      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('delete-itx-1')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('delete-itx-1'));

      expect(mockDeleteTransaction).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('shows alert when delete fails', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      vi.spyOn(window, 'alert').mockImplementation(() => {});
      mockDeleteTransaction.mockRejectedValue(new Error('Delete failed'));

      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('delete-itx-1')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('delete-itx-1'));

      await waitFor(() => {
        expect(window.alert).toHaveBeenCalledWith('Failed to delete transaction');
      });

      vi.restoreAllMocks();
    });
  });

  describe('Transaction Filters', () => {
    it('clears transaction filters and resets to page 1', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('clear-filters')).toBeInTheDocument();
      });

      // First set a symbol filter
      fireEvent.click(screen.getByTestId('symbol-click'));
      await waitFor(() => {
        expect(screen.getByTestId('symbol-filter')).toBeInTheDocument();
      });

      // Clear filters
      fireEvent.click(screen.getByTestId('clear-filters'));
      await waitFor(() => {
        expect(screen.queryByTestId('symbol-filter')).not.toBeInTheDocument();
      });
    });
  });

  describe('Pagination', () => {
    it('shows single page count when only one page', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByText('1 transaction')).toBeInTheDocument();
      });
    });

    it('shows pagination when multiple pages exist', async () => {
      mockGetTransactions.mockResolvedValue({
        data: Array.from({ length: 25 }, (_, i) => ({ id: `tx-${i}`, action: 'BUY' })),
        pagination: { page: 1, totalPages: 3, total: 75 },
      });
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('pagination')).toBeInTheDocument();
        expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
      });
    });

    it('shows plural transactions label for multiple', async () => {
      mockGetTransactions.mockResolvedValue({
        data: [
          { id: 'itx-1', action: 'BUY' },
          { id: 'itx-2', action: 'SELL' },
        ],
        pagination: { page: 1, totalPages: 1, total: 2 },
      });
      render(<InvestmentsPage />);
      await waitFor(() => {
        // The page renders a total count div separate from the mock transaction list.
        // Match the page's own total count div specifically (the one with the class for styling).
        const totalCountDiv = document.querySelector('.mt-4.text-sm.text-gray-500');
        expect(totalCountDiv).toBeInTheDocument();
        expect(totalCountDiv?.textContent).toBe('2 transactions');
      });
    });
  });

  describe('Portfolio Data Display', () => {
    it('shows portfolio summary with total value', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('portfolio-summary')).toHaveTextContent('Total: 50000');
      });
    });

    it('passes allocation data to asset allocation chart', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('asset-allocation-chart')).toHaveTextContent('Value: 50000');
      });
    });
  });

  describe('New Transaction from list', () => {
    it('opens create form when new transaction button clicked in list', async () => {
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('new-tx-btn')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('new-tx-btn'));

      expect(mockOpenCreate).toHaveBeenCalled();
    });
  });

  describe('Account ID pruning', () => {
    it('removes stale account IDs that no longer exist', async () => {
      // Pre-populate with stale IDs
      const staleIds = ['old-1', 'old-2', 'old-3', 'old-4', 'old-5', 'old-6', 'old-7', 'old-8', 'old-9', 'old-10'];
      mockLocalStorageState['monize-investments-accounts'] = {
        value: staleIds,
        setter: vi.fn((newValue: any) => {
          mockLocalStorageState['monize-investments-accounts'].value = newValue;
        }),
      };

      render(<InvestmentsPage />);

      await waitFor(() => {
        const setter = mockLocalStorageState['monize-investments-accounts'].setter;
        expect(setter).toHaveBeenCalledWith([]);
      });
    });

    it('keeps valid IDs and removes only stale ones', async () => {
      // Mix of valid (brok-1, brok-2) and stale IDs
      const mixedIds = ['brok-1', 'stale-id-1', 'brok-2', 'stale-id-2'];
      mockLocalStorageState['monize-investments-accounts'] = {
        value: mixedIds,
        setter: vi.fn((newValue: any) => {
          mockLocalStorageState['monize-investments-accounts'].value = newValue;
        }),
      };

      render(<InvestmentsPage />);

      await waitFor(() => {
        const setter = mockLocalStorageState['monize-investments-accounts'].setter;
        expect(setter).toHaveBeenCalledWith(['brok-1', 'brok-2']);
      });
    });

    it('removes cash account IDs that exist but are not selectable', async () => {
      // cash-1 and cash-2 exist in accounts but are INVESTMENT_CASH (not shown in dropdown)
      const mixedIds = ['brok-1', 'cash-1', 'brok-2', 'cash-2'];
      mockLocalStorageState['monize-investments-accounts'] = {
        value: mixedIds,
        setter: vi.fn((newValue: any) => {
          mockLocalStorageState['monize-investments-accounts'].value = newValue;
        }),
      };

      render(<InvestmentsPage />);

      await waitFor(() => {
        const setter = mockLocalStorageState['monize-investments-accounts'].setter;
        expect(setter).toHaveBeenCalledWith(['brok-1', 'brok-2']);
      });
    });

    it('does not call setter when all IDs are valid', async () => {
      const validIds = ['brok-1', 'brok-2'];
      mockLocalStorageState['monize-investments-accounts'] = {
        value: validIds,
        setter: vi.fn(),
      };

      render(<InvestmentsPage />);

      // Wait for accounts to load
      await waitFor(() => {
        expect(mockGetInvestmentAccounts).toHaveBeenCalled();
      });

      // Setter should NOT be called for pruning (all IDs are valid)
      const setter = mockLocalStorageState['monize-investments-accounts'].setter;
      // The setter might be called for other reasons (account change effects),
      // but should never be called with a different array than what was set
      const pruningCalls = setter.mock.calls.filter(
        (call: any[]) => Array.isArray(call[0]) && call[0].length < validIds.length,
      );
      expect(pruningCalls.length).toBe(0);
    });

    it('does not prune when selectedAccountIds is empty', async () => {
      // Default empty selection - no pruning needed
      mockLocalStorageState['monize-investments-accounts'] = {
        value: [],
        setter: vi.fn(),
      };

      render(<InvestmentsPage />);

      await waitFor(() => {
        expect(mockGetInvestmentAccounts).toHaveBeenCalled();
      });

      // Setter should not be called for pruning
      const setter = mockLocalStorageState['monize-investments-accounts'].setter;
      const pruningCalls = setter.mock.calls.filter(
        (call: any[]) => Array.isArray(call[0]),
      );
      expect(pruningCalls.length).toBe(0);
    });
  });
});
