import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import InvestmentsPage from './page';

// Mock next/image
vi.mock('next/image', () => ({
  default: (props: any) => <img alt="" {...props} />,
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
      local: true, oidc: false, registration: true, smtp: false, force2fa: false,
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

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
    getTransactions: (...args: any[]) => mockGetTransactions(...args),
    getPriceStatus: (...args: any[]) => mockGetPriceStatus(...args),
    refreshSelectedPrices: (...args: any[]) => mockRefreshSelectedPrices(...args),
    getTransaction: vi.fn(),
    deleteTransaction: vi.fn(),
  },
}));

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAllAccounts(...args),
  },
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
    unsavedChangesDialog: { isOpen: false, onConfirm: vi.fn(), onCancel: vi.fn() },
    formSubmitRef: { current: null },
  }),
}));

vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (_key: string, defaultValue: any) => [defaultValue, vi.fn()],
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
  MultiSelect: ({ options, placeholder }: any) => (
    <div data-testid="multi-select">
      <span>{placeholder}</span>
      {options?.map((opt: any) => <span key={opt.value} data-testid={`option-${opt.value}`}>{opt.label}</span>)}
    </div>
  ),
}));

vi.mock('@/components/ui/Pagination', () => ({
  Pagination: ({ currentPage, totalPages }: any) => (
    <div data-testid="pagination">Page {currentPage} of {totalPages}</div>
  ),
}));

vi.mock('@/components/investments/PortfolioSummaryCard', () => ({
  PortfolioSummaryCard: ({ summary }: any) => (
    <div data-testid="portfolio-summary">{summary ? `Total: ${summary.totalPortfolioValue}` : 'No data'}</div>
  ),
}));

vi.mock('@/components/investments/AssetAllocationChart', () => ({
  AssetAllocationChart: () => <div data-testid="asset-allocation-chart">AssetAllocationChart</div>,
}));

vi.mock('@/components/investments/GroupedHoldingsList', () => ({
  GroupedHoldingsList: () => <div data-testid="grouped-holdings">GroupedHoldingsList</div>,
}));

vi.mock('@/components/investments/InvestmentTransactionList', () => ({
  InvestmentTransactionList: ({ transactions }: any) => (
    <div data-testid="transaction-list">{transactions.length} transactions</div>
  ),
}));

vi.mock('@/components/investments/InvestmentTransactionForm', () => ({
  InvestmentTransactionForm: () => <div data-testid="transaction-form">Form</div>,
}));

vi.mock('@/components/investments/InvestmentValueChart', () => ({
  InvestmentValueChart: () => <div data-testid="value-chart">InvestmentValueChart</div>,
}));

const mockCashAccounts = [
  { id: 'cash-1', name: 'RRSP - Cash', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_CASH', linkedAccountId: 'brok-1', currencyCode: 'USD', currentBalance: 5000, isClosed: false },
  { id: 'cash-2', name: 'TFSA - Cash', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_CASH', linkedAccountId: 'brok-2', currencyCode: 'CAD', currentBalance: 3000, isClosed: false },
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

    it('displays account names without " - Cash" suffix', async () => {
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
        data: Array(25).fill({ id: 'tx', action: 'BUY' }),
        pagination: { page: 1, totalPages: 3, total: 75 },
      });
      render(<InvestmentsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('pagination')).toBeInTheDocument();
        expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
      });
    });
  });
});
