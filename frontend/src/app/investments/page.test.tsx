import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import toast from 'react-hot-toast';
import { render, screen, waitFor, fireEvent, act, within } from '@/test/render';
import { stubCollapsingTitle } from '@/test/collapsing-title';
import InvestmentsPage from './page';
import { useMobileAddActionStore } from '@/store/mobileAddActionStore';

// --- next/navigation (must be before other mocks that may import it) ---
const mockRouterPush = vi.fn();
const mockRouterReplace = vi.fn();
const mockRouterBack = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: mockRouterReplace,
    back: mockRouterBack,
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/investments',
  useSearchParams: () => mockSearchParams,
}));

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
const mockGetInvestmentFilterOptions = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
    getTransactions: (...args: any[]) => mockGetTransactions(...args),
    getPriceStatus: (...args: any[]) => mockGetPriceStatus(...args),
    refreshSelectedPrices: (...args: any[]) => mockRefreshSelectedPrices(...args),
    getTransaction: (...args: any[]) => mockGetTransaction(...args),
    deleteTransaction: (...args: any[]) => mockDeleteTransaction(...args),
    getRegisterFilterOptions: (...args: any[]) => mockGetInvestmentFilterOptions(...args),
  },
}));

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAllAccounts(...args),
  },
}));

const mockGetAllTransactions = vi.fn();
const mockGetTransactionById = vi.fn();
const mockGetFilterOptions = vi.fn();

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...args: any[]) => mockGetAllTransactions(...args),
    getById: (...args: any[]) => mockGetTransactionById(...args),
    getRegisterFilterOptions: (...args: any[]) => mockGetFilterOptions(...args),
    delete: vi.fn(),
    deleteTransfer: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

const mockGetAllCategories = vi.fn();
vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: (...args: any[]) => mockGetAllCategories(...args),
  },
}));

const mockGetAllPayees = vi.fn();
vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getAll: (...args: any[]) => mockGetAllPayees(...args),
  },
}));

const mockOpenCreate = vi.fn();
const mockOpenEdit = vi.fn();
const mockClose = vi.fn();
let mockShowForm = false;

vi.mock('@/hooks/useFormModal', () => ({
  useFormModal: () => ({
    showForm: mockShowForm,
    editingItem: null,
    openCreate: mockOpenCreate,
    openEdit: mockOpenEdit,
    close: mockClose,
    isEditing: false,
    modalProps: { pushHistory: true, onBeforeClose: vi.fn() },
    setFormDirty: vi.fn(),
    unsavedChangesDialog: { isOpen: false, onSave: vi.fn(), onDiscard: vi.fn(), onCancel: vi.fn() },
    formSubmitRef: { current: null },
  }),
}));

// Configurable useLocalStorage mock - uses real React state so setters trigger re-renders.
// Tests can pre-seed initial values via mockLocalStorageState before rendering.
const mockLocalStorageState: Record<string, { value: any; setter: ReturnType<typeof vi.fn> }> = {};

vi.mock('@/hooks/useLocalStorage', () => {
  const { useState } = require('react');
  return {
    useLocalStorage: (key: string, defaultValue: any) => {
      const initialValue = mockLocalStorageState[key]?.value ?? defaultValue;
      const [value, setValue] = useState(initialValue);
      // Wrap the real setter so tests can spy on calls
      if (!mockLocalStorageState[key]) {
        mockLocalStorageState[key] = { value: initialValue, setter: vi.fn() };
      }
      const setter = (newValue: any) => {
        const resolved = typeof newValue === 'function' ? newValue(value) : newValue;
        mockLocalStorageState[key].value = resolved;
        (mockLocalStorageState[key].setter as any)(newValue);
        setValue(resolved);
      };
      return [value, setter];
    },
  };
});

vi.mock('@/hooks/usePriceRefresh', () => ({
  usePriceRefresh: ({ onRefreshComplete }: { onRefreshComplete?: () => void | Promise<void> } = {}) => ({
    isRefreshing: false,
    triggerAutoRefresh: vi.fn(),
    triggerManualRefresh: async () => {
      try {
        const summary = await mockGetPortfolioSummary();
        const securityIds = [
          ...new Set(
            summary.holdings
              .filter((h: { quantity: number }) => h.quantity !== 0)
              .map((h: { securityId: string }) => h.securityId),
          ),
        ];
        if (securityIds.length === 0) {
          toast.success('No securities to update');
          return;
        }
        const result = await mockRefreshSelectedPrices(securityIds);
        if (result.failed > 0) {
          toast.error(`Prices updated: ${result.updated} succeeded, ${result.failed} failed`);
        } else {
          toast.success(`${result.updated} security price${result.updated !== 1 ? 's' : ''} updated`);
        }
        if (onRefreshComplete) await onRefreshComplete();
      } catch {
        toast.error('Failed to refresh prices');
      }
    },
  }),
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('@/components/ui/Button', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/Button')>()),
  Button: ({ children, onClick, disabled, ...rest }: any) => (
    <button onClick={onClick} disabled={disabled} {...rest}>{children}</button>
  ),
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen, title }: any) => isOpen ? <div data-testid="modal" aria-label={title}>{children}</div> : null,
}));

vi.mock('@/components/ui/UnsavedChangesDialog', () => ({
  UnsavedChangesDialog: () => null,
}));

vi.mock('@/components/ui/MultiSelect', () => ({
  // An option toggles in and out of the selection, as the real one does.
  MultiSelect: ({ options, placeholder, value = [], onChange, variant, ariaLabel }: any) => (
    <div data-testid={variant === 'caret' ? 'multi-select-caret' : 'multi-select'} aria-label={ariaLabel}>
      <span>{placeholder}</span>
      {options?.map((opt: any) => (
        <button
          key={opt.value}
          data-testid={`option-${opt.value}`}
          onClick={() =>
            onChange(
              value.includes(opt.value)
                ? value.filter((v: string) => v !== opt.value)
                : [...value, opt.value],
            )
          }
        >
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
  GroupedHoldingsList: ({ onSecurityClick, onCashClick }: any) => (
    <div data-testid="grouped-holdings">
      <button data-testid="symbol-click" onClick={() => onSecurityClick('sec-1')}>AAPL</button>
      <button data-testid="cash-click" onClick={() => onCashClick('cash-1')}>Cash</button>
    </div>
  ),
}));

vi.mock('@/components/investments/InvestmentTransactionList', () => ({
  // The pager and the density toggle live in the list's own strip now, so the
  // stub reports the paging it was handed rather than the page drawing one.
  InvestmentTransactionList: ({ transactions, onDelete, onEdit, onDuplicate, onNewTransaction, onFiltersChange, filters, viewToggle, currentPage, totalPages, totalItems, availableActions, availableSymbols }: any) => (
    <div data-testid="transaction-list">
      {viewToggle}
      <span>{transactions.length} transactions</span>
      <span data-testid="brokerage-paging">{`${currentPage ?? ''}/${totalPages ?? ''} of ${totalItems ?? ''}`}</span>
      <span data-testid="brokerage-actions">{(availableActions ?? []).join(',')}</span>
      <span data-testid="brokerage-symbols">{(availableSymbols ?? []).join(',')}</span>
      {transactions.map((t: any) => (
        <div key={t.id} data-testid={`itx-${t.id}`}>
          <button data-testid={`delete-${t.id}`} onClick={() => onDelete(t.id)}>Delete</button>
          <button data-testid={`edit-${t.id}`} onClick={() => onEdit(t)}>Edit</button>
          {onDuplicate && (
            <button data-testid={`duplicate-${t.id}`} onClick={() => onDuplicate(t)}>Duplicate</button>
          )}
        </div>
      ))}
      {onNewTransaction && <button data-testid="new-tx-btn" onClick={onNewTransaction}>New</button>}
      <button data-testid="clear-filters" onClick={() => onFiltersChange({})}>Clear Filters</button>
      <button data-testid="set-symbol-filter" onClick={() => onFiltersChange({ symbol: 'AAPL' })}>Filter AAPL</button>
      {filters?.symbol && <span data-testid="symbol-filter">{filters.symbol}</span>}
    </div>
  ),
}));

vi.mock('@/components/transactions/TransactionList', () => ({
  // `onRefresh` is how the real list reports a row it has already deleted (and
  // any other write it owns), so the mock's Delete button raises exactly that
  // and nothing else -- see the delete-contract note in docs/frontend/tables-and-registers.md.
  TransactionList: ({ transactions, onEdit, onRefresh, showToolbar, startingBalance, isSingleAccountView }: any) => (
    <div data-testid="cash-transaction-list">
      <span>{transactions.length} cash transactions</span>
      <span data-testid="cash-show-toolbar">{String(showToolbar)}</span>
      <span data-testid="cash-starting-balance">{String(startingBalance ?? '')}</span>
      <span data-testid="cash-single-account-view">{String(isSingleAccountView)}</span>
      {transactions.map((t: any) => (
        <div key={t.id} data-testid={`cash-tx-${t.id}`}>
          <button data-testid={`cash-edit-${t.id}`} onClick={() => onEdit(t)}>Edit</button>
          <button data-testid={`cash-deleted-${t.id}`} onClick={() => onRefresh?.()}>Delete</button>
        </div>
      ))}
    </div>
  ),
}));

vi.mock('@/components/transactions/TransactionForm', () => ({
  TransactionForm: () => <div data-testid="cash-transaction-form">Cash Form</div>,
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: ({ text }: any) => <div data-testid="loading-spinner">{text}</div>,
}));

vi.mock('@/components/investments/InvestmentTransactionForm', () => ({
  InvestmentTransactionForm: ({ duplicateFrom }: any) => (
    <div data-testid="transaction-form">
      Form
      <span data-testid="form-duplicate-from">{duplicateFrom?.id ?? ''}</span>
    </div>
  ),
}));

// The page asks for the "Portfolio performance" batch once and hands the one
// answer to the card and to the value chart (#1888).
const mockPeriodResults = vi.hoisted(() => ({
  results: { currency: 'CAD', asOf: '2026-10-27', periods: {} },
  status: 'ready' as const,
}));
const mockUsePortfolioPeriodResults = vi.hoisted(() =>
  vi.fn((_options: unknown) => mockPeriodResults),
);
vi.mock('@/hooks/usePortfolioPeriodResults', () => ({
  usePortfolioPeriodResults: mockUsePortfolioPeriodResults,
}));

vi.mock('@/components/investments/PortfolioPerformanceCard', () => ({
  PortfolioPerformanceCard: ({ accountIds, reloadKey, periodResults }: any) => (
    <div data-testid="portfolio-performance">
      {accountIds?.length > 0 ? `Filtered: ${accountIds.join(',')}` : 'All accounts'}
      <span data-testid="performance-reload-key">{String(reloadKey ?? '')}</span>
      <span data-testid="performance-shared">{String(periodResults === mockPeriodResults)}</span>
    </div>
  ),
}));

vi.mock('@/components/investments/InvestmentValueChart', () => ({
  InvestmentValueChart: ({ accountIds, refreshKey, periodResults }: any) => (
    <div data-testid="value-chart">
      {accountIds?.length > 0 ? `Filtered: ${accountIds.join(',')}` : 'All accounts'}
      <span data-testid="value-chart-refresh-key">{String(refreshKey ?? '')}</span>
      <span data-testid="value-chart-shared">{String(periodResults === mockPeriodResults)}</span>
    </div>
  ),
  INVESTMENT_CHART_REFRESH_EVENT: 'monize:investment-chart-refresh',
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

// Render and flush all pending async state updates (e.g. useEffect API calls)
async function renderPage() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<InvestmentsPage />);
  });
  return result!;
}

/** A viewport where `query === '(max-width: 1279px)'` (the tab bar) is `tabBar`. */
function setViewport({ tabBar }: { tabBar: boolean }) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: tabBar && query === '(max-width: 1279px)',
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}
const originalMatchMedia = window.matchMedia;

describe('InvestmentsPage', () => {
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Below `xl` unless a test says otherwise: there the header's picker is
    // the only one on the page, as these tests expect. The desktop's floating
    // copy of it has its own tests below.
    setViewport({ tabBar: true });
    mockSearchParams = new URLSearchParams();
    mockShowForm = false;
    // Reset useLocalStorage mock state
    for (const key of Object.keys(mockLocalStorageState)) {
      delete mockLocalStorageState[key];
    }
    mockGetInvestmentAccounts.mockResolvedValue(mockCashAccounts);
    mockGetAllAccounts.mockResolvedValue(mockCashAccounts);
    mockGetPortfolioSummary.mockResolvedValue(mockPortfolioSummary);
    mockGetTransactions.mockResolvedValue(mockTxResponse);
    mockGetPriceStatus.mockResolvedValue({ lastUpdated: null });
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { page: 1, totalPages: 1, total: 0 } });
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    mockGetFilterOptions.mockResolvedValue({ payees: [], categories: [] });
    mockGetInvestmentFilterOptions.mockResolvedValue({ actions: [], symbols: [] });
  });

  describe('Rendering', () => {
    it('renders page title and subtitle', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByText('Investments')).toBeInTheDocument();
        expect(screen.getByText('Track your investment portfolio')).toBeInTheDocument();
      });
    });

    it('no longer links to the Treasury bonds page (it lives under Securities)', async () => {
      await renderPage();
      await screen.findByText('Investments');
      expect(screen.queryByRole('link', { name: 'Treasury bonds' })).not.toBeInTheDocument();
    });

    it('renders within page layout', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('page-layout')).toBeInTheDocument();
      });
    });

    it('renders portfolio summary card', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('portfolio-summary')).toBeInTheDocument();
      });
    });

    it('renders asset allocation chart', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('asset-allocation-chart')).toBeInTheDocument();
      });
    });

    /**
     * The hierarchy the page reads in: what the portfolio is worth beside how
     * it is spread, then the value series beside what the investments earned
     * from it. Each pair shares ONE grid row, so the reader compares them side
     * by side instead of scrolling past one to reach the other.
     */
    it('pairs summary with allocation, and the value chart with performance', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('portfolio-performance')).toBeInTheDocument();
      });

      const summary = screen.getByTestId('portfolio-summary');
      const allocation = screen.getByTestId('asset-allocation-chart');
      const chart = screen.getByTestId('value-chart');
      const performance = screen.getByTestId('portfolio-performance');
      expect(
        summary.compareDocumentPosition(allocation) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        allocation.compareDocumentPosition(chart) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        chart.compareDocumentPosition(performance) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      // Two grid containers, not four stacked rows. jsdom computes no layout,
      // so the shared parent and its track list are what can be asserted; the
      // performance card is the narrow right-hand column beside the chart.
      const topRow = summary.parentElement!;
      expect(allocation.parentElement).toBe(topRow);
      expect(topRow.className).toContain('lg:grid-cols-2');

      const chartRow = chart.parentElement!;
      expect(performance.parentElement).toBe(chartRow);
      expect(chartRow).not.toBe(topRow);
      expect(chartRow.className).toContain('lg:grid-cols-[3fr_1fr]');
    });

    it('renders investment value chart', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('value-chart')).toBeInTheDocument();
      });
    });

    it('renders grouped holdings list', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('grouped-holdings')).toBeInTheDocument();
      });
    });

    it('renders transaction list', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('transaction-list')).toBeInTheDocument();
      });
    });

    it('renders New Transaction button', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
      });
    });

    it('renders Refresh button', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByText(/Refresh/)).toBeInTheDocument();
      });
    });

    it('renders auto-generated symbol note', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByText(/Auto-generated symbol name/)).toBeInTheDocument();
      });
    });
  });

  describe('Account Filter', () => {
    it('renders account filter with placeholder', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByText('All Investment Accounts')).toBeInTheDocument();
      });
    });

    it('displays account names without " - Brokerage" suffix', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByText('RRSP')).toBeInTheDocument();
        expect(screen.getByText('TFSA')).toBeInTheDocument();
      });
    });
  });

  describe('Data Loading', () => {
    it('loads investment accounts, all accounts, and price status on mount', async () => {
      await renderPage();
      await waitFor(() => {
        expect(mockGetInvestmentAccounts).toHaveBeenCalled();
        expect(mockGetAllAccounts).toHaveBeenCalled();
        expect(mockGetPriceStatus).toHaveBeenCalled();
      });
    });

    it('loads portfolio summary and transactions', async () => {
      await renderPage();
      await waitFor(() => {
        expect(mockGetPortfolioSummary).toHaveBeenCalled();
        expect(mockGetTransactions).toHaveBeenCalled();
      });
    });

    it('asks for the performance batch once and hands it to the card and the chart', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('performance-shared')).toHaveTextContent('true');
        expect(screen.getByTestId('value-chart-shared')).toHaveTextContent('true');
      });
      expect(mockUsePortfolioPeriodResults).toHaveBeenCalledWith(
        expect.objectContaining({
          periods: '1d,1w,1m,3m,ytd,1y,2y,5y,10y,all',
          accountIds: undefined,
          displayCurrency: undefined,
        }),
      );
    });

    it('handles portfolio summary load failure gracefully', async () => {
      mockGetPortfolioSummary.mockRejectedValue(new Error('Failed'));
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('portfolio-summary')).toHaveTextContent('No data');
      });
    });

    it('handles transaction load failure gracefully', async () => {
      mockGetTransactions.mockRejectedValue(new Error('Failed'));
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('transaction-list')).toHaveTextContent('0 transactions');
      });
    });

    it('handles investment accounts load failure gracefully', async () => {
      mockGetInvestmentAccounts.mockRejectedValue(new Error('Failed'));
      await renderPage();
      // Should still render the page
      await waitFor(() => {
        expect(screen.getByText('Investments')).toBeInTheDocument();
      });
    });

    it('handles price status load failure gracefully', async () => {
      mockGetPriceStatus.mockRejectedValue(new Error('Failed'));
      await renderPage();
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
      await renderPage();
      await waitFor(() => expect(screen.getByText(/Refresh/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/Refresh/));
      await waitFor(() => {
        // sec-3 (qty=0) should be excluded, only sec-1 and sec-2
        expect(mockRefreshSelectedPrices).toHaveBeenCalledWith(['sec-1', 'sec-2']);
      });
    });

    // Issue #1617: the chart and the period-result cards fetch their own
    // figures and only re-ask when this key moves, so a refresh that left it
    // alone kept the pre-refresh Value change and Portfolio performance on
    // screen until a full page reload.
    it('bumps the chart and performance card reload keys after a price refresh', async () => {
      mockRefreshSelectedPrices.mockResolvedValue({
        updated: 2, failed: 0, results: [], lastUpdated: '2026-02-14T12:00:00Z',
      });
      await renderPage();
      await waitFor(() => expect(screen.getByText(/Refresh/)).toBeInTheDocument());
      const chartKeyBefore = screen.getByTestId('value-chart-refresh-key').textContent;
      const performanceKeyBefore = screen.getByTestId('performance-reload-key').textContent;

      await act(async () => {
        fireEvent.click(screen.getByText(/Refresh/));
      });

      await waitFor(() => {
        expect(screen.getByTestId('value-chart-refresh-key').textContent).not.toBe(chartKeyBefore);
        expect(screen.getByTestId('performance-reload-key').textContent).not.toBe(performanceKeyBefore);
      });
    });

    it('handles empty holdings gracefully', async () => {
      mockGetPortfolioSummary
        .mockResolvedValueOnce(mockPortfolioSummary) // initial load
        .mockResolvedValueOnce(mockPortfolioSummary) // account change load
        .mockResolvedValueOnce({ ...mockPortfolioSummary, holdings: [] }); // refresh click
      await renderPage();
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
      await renderPage();
      await waitFor(() => expect(screen.getByText(/Refresh/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/Refresh/));
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Prices updated: 1 succeeded, 1 failed');
      });
    });

    it('handles refresh API error', async () => {
      mockRefreshSelectedPrices.mockRejectedValue(new Error('API Error'));
      // Need initial summary to get holdings for refresh
      await renderPage();
      await waitFor(() => expect(screen.getByText(/Refresh/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/Refresh/));
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to refresh prices');
      });
    });

    it('shows last update time on refresh button', async () => {
      mockGetPriceStatus.mockResolvedValue({ lastUpdated: '2026-02-14T11:00:00Z' });
      await renderPage();
      await waitFor(() => {
        const refreshBtn = screen.getByText(/Refresh/);
        expect(refreshBtn).toBeInTheDocument();
      });
    });
  });

  describe('Symbol Click', () => {
    it('opens the security detail page when a holding is clicked', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('symbol-click')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('symbol-click'));

      // It used to filter the transaction list by symbol instead (review of
      // discussion #964); the filters above that list still do that.
      await waitFor(() => {
        expect(mockRouterPush).toHaveBeenCalledWith('/securities/sec-1');
      });
      expect(screen.queryByTestId('symbol-filter')).not.toBeInTheDocument();
    });
  });

  describe('Cash Click', () => {
    it('navigates to transactions page for cash account', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('cash-click')).toBeInTheDocument();
      });

      // Clicking cash should navigate - we can verify it doesn't throw
      fireEvent.click(screen.getByTestId('cash-click'));
    });
  });

  describe('Transaction Actions', () => {
    it('opens new transaction form when button clicked', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('+ New Transaction'));
      fireEvent.click(screen.getByText('Investment Transaction'));

      expect(mockOpenCreate).toHaveBeenCalled();
    });

    it("offers the mobile add button both kinds of transaction, as the header menu does", async () => {
      await renderPage();
      const action = useMobileAddActionStore.getState().action;
      expect(action?.label).toBe('New Transaction');
      const choices = action?.choices?.() ?? [];
      expect(choices.map((c) => c.label)).toEqual(['Investment Transaction', 'Cash Transaction']);
      act(() => choices[1].run());
      expect(mockOpenCreate).toHaveBeenCalled();
    });

    it('opens edit form when transaction edit button is clicked', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('edit-itx-1')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('edit-itx-1'));

      expect(mockOpenEdit).toHaveBeenCalled();
    });

    it('opens a new entry copied from the row when Duplicate is clicked', async () => {
      mockShowForm = true;
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('duplicate-itx-1')).toBeInTheDocument();
      });
      expect(screen.getByTestId('form-duplicate-from')).toHaveTextContent('');

      await act(async () => {
        fireEvent.click(screen.getByTestId('duplicate-itx-1'));
      });

      expect(mockOpenCreate).toHaveBeenCalled();
      expect(mockOpenEdit).not.toHaveBeenCalled();
      expect(screen.getByTestId('form-duplicate-from')).toHaveTextContent('itx-1');
      expect(screen.getByLabelText('Duplicate Investment Transaction')).toBeInTheDocument();
    });

    it('drops the copy when the form is next opened for a new entry', async () => {
      mockShowForm = true;
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('duplicate-itx-1')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('duplicate-itx-1'));
      });
      await act(async () => {
        fireEvent.click(screen.getByText('+ New Transaction'));
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Investment Transaction'));
      });

      expect(screen.getByTestId('form-duplicate-from')).toHaveTextContent('');
    });

    it('deletes transaction when confirmed', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      mockDeleteTransaction.mockResolvedValue(undefined);

      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('delete-itx-1')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('delete-itx-1'));

      await waitFor(() => {
        expect(mockDeleteTransaction).toHaveBeenCalledWith('itx-1');
      });

      vi.restoreAllMocks();
    });

    it('calls delete directly without window.confirm (ConfirmDialog handles confirmation)', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('delete-itx-1')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('delete-itx-1'));

      await waitFor(() => {
        expect(mockDeleteTransaction).toHaveBeenCalledWith('itx-1');
      });
    });

    it('shows toast error when delete fails', async () => {
      const toast = (await import('react-hot-toast')).default;
      mockDeleteTransaction.mockRejectedValue(new Error('Delete failed'));

      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('delete-itx-1')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('delete-itx-1'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled();
      });

      vi.restoreAllMocks();
    });

    // A trade's cash leg goes with the trade, so a brokerage delete moves the
    // cash register and the value chart as surely as the summary does.
    it('refetches the cash register after deleting a brokerage transaction', async () => {
      mockDeleteTransaction.mockResolvedValue(undefined);

      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('delete-itx-1')).toBeInTheDocument();
      });

      const cashCallsBefore = mockGetAllTransactions.mock.calls.length;

      await act(async () => {
        fireEvent.click(screen.getByTestId('delete-itx-1'));
      });

      await waitFor(() => {
        expect(mockGetAllTransactions.mock.calls.length).toBeGreaterThan(cashCallsBefore);
      });
    });

    it('bumps the value chart refresh key after deleting a brokerage transaction', async () => {
      mockDeleteTransaction.mockResolvedValue(undefined);

      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('delete-itx-1')).toBeInTheDocument();
      });

      const chartKeyBefore = screen.getByTestId('value-chart-refresh-key').textContent;

      await act(async () => {
        fireEvent.click(screen.getByTestId('delete-itx-1'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('value-chart-refresh-key').textContent).not.toBe(chartKeyBefore);
      });
    });
  });

  describe('Transaction Filters', () => {
    it('clears transaction filters and resets to page 1', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('clear-filters')).toBeInTheDocument();
      });

      // First set a symbol filter
      fireEvent.click(screen.getByTestId('set-symbol-filter'));
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
    it('hands the register its paging, which it draws above its rows', async () => {
      // The detail page's registers page from the strip above the table; this
      // one used to page from below it, so switching between the two pages
      // moved the control.
      mockGetTransactions.mockResolvedValue({
        data: Array.from({ length: 25 }, (_, i) => ({ id: `tx-${i}`, action: 'BUY' })),
        pagination: { page: 1, totalPages: 3, total: 75 },
      });
      await renderPage();

      await waitFor(() => {
        expect(screen.getByTestId('brokerage-paging')).toHaveTextContent('1/3 of 75');
      });
    });

    it('offers the register only the actions its accounts have used', async () => {
      // Twenty-odd actions exist; a household brokerage uses four, and the
      // picker is a way through the rows rather than a tour of the vocabulary.
      mockGetInvestmentFilterOptions.mockResolvedValue({ actions: ['BUY', 'SELL'] });

      await renderPage();

      await waitFor(() => {
        expect(screen.getByTestId('brokerage-actions')).toHaveTextContent('BUY,SELL');
      });
    });

    it('offers the symbols the rows use, not the ones still held', async () => {
      // The picker was built from `portfolioSummary.holdings`, so a position
      // sold in full was not offered -- and its trades are exactly the rows
      // somebody filtering by symbol is looking for. The summary here holds
      // AAPL and GOOG; the register's own rows are what the picker follows.
      mockGetInvestmentFilterOptions.mockResolvedValue({
        actions: ['SELL'],
        symbols: ['TSLA'],
      });

      await renderPage();

      await waitFor(() => {
        expect(screen.getByTestId('brokerage-symbols')).toHaveTextContent('TSLA');
      });
      expect(screen.getByTestId('brokerage-symbols')).not.toHaveTextContent('AAPL');
    });

    // The register pages from the strip above its rows *and* from below them,
    // the way the Transactions page does: a reader who has just scrolled a page
    // of trades meets the controls where they finished rather than scrolling
    // back up for them. The top strip lives inside the list (which this suite
    // stubs); the bottom pager is drawn by the page, outside the card.
    it('pages the register from below the rows as well as above them', async () => {
      mockGetTransactions.mockResolvedValue({
        data: Array.from({ length: 25 }, (_, i) => ({ id: `tx-${i}`, action: 'BUY' })),
        pagination: { page: 1, totalPages: 3, total: 75 },
      });
      await renderPage();

      await waitFor(() => {
        expect(screen.getByTestId('transaction-list')).toBeInTheDocument();
      });
      expect(screen.getByTestId('pagination')).toHaveTextContent('Page 1 of 3');
    });

    // An inert pager at the end of a list says nothing, so the count says it
    // instead -- the same substitution the Transactions page makes.
    it('draws the count below the rows when everything fits on one page', async () => {
      mockGetTransactions.mockResolvedValue({
        data: [{ id: 'tx-1', action: 'BUY' }],
        pagination: { page: 1, totalPages: 1, total: 1 },
      });
      await renderPage();

      await waitFor(() => {
        expect(screen.getByTestId('transaction-list')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('pagination')).not.toBeInTheDocument();
      expect(screen.getByText('1 transaction')).toBeInTheDocument();
    });
  });

  describe('Portfolio Data Display', () => {
    it('shows portfolio summary with total value', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('portfolio-summary')).toHaveTextContent('Total: 50000');
      });
    });

    it('passes allocation data to asset allocation chart', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('asset-allocation-chart')).toHaveTextContent('Value: 50000');
      });
    });
  });

  describe('New Transaction from list', () => {
    it('offers no second New button in the list: the PageHeader one is the only primary', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('transaction-list')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('new-tx-btn')).not.toBeInTheDocument();
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

      await renderPage();

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

      await renderPage();

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

      await renderPage();

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

      await renderPage();

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

      await renderPage();

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

  describe('Cash View', () => {
    const switchToCashView = async () => {
      await renderPage();
      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByTestId('transaction-list')).toBeInTheDocument();
      });
      // The view toggle is rendered inside InvestmentTransactionList via viewToggle prop
      // Find the Cash button inside the transaction-list container (not the GroupedHoldingsList one)
      const txList = screen.getByTestId('transaction-list');
      // The viewToggle renders Brokerage then Cash buttons — find Cash
      const buttons = txList.querySelectorAll('button');
      const cashBtn = Array.from(buttons).find(b => b.textContent === 'Cash')!;
      await act(async () => {
        fireEvent.click(cashBtn);
      });
    };

    it('shows Brokerage/Cash toggle in brokerage view', async () => {
      await renderPage();
      await waitFor(() => {
        const txList = screen.getByTestId('transaction-list');
        expect(txList.querySelector('button')).toBeInTheDocument();
        // Verify both toggle buttons are present inside the transaction list
        const buttons = Array.from(txList.querySelectorAll('button'));
        expect(buttons.some(b => b.textContent === 'Brokerage')).toBe(true);
        expect(buttons.some(b => b.textContent === 'Cash')).toBe(true);
      });
    });

    it('switches to cash view when Cash button is clicked', async () => {
      mockGetAllTransactions.mockResolvedValue({
        data: [{ id: 'cash-tx-1', transactionDate: '2024-01-15', payeeName: 'Deposit', amount: 1000 }],
        pagination: { page: 1, totalPages: 1, total: 1 },
      });

      await switchToCashView();

      await waitFor(() => {
        expect(screen.getByTestId('cash-transaction-list')).toBeInTheDocument();
      });
    });

    it('loads cash transactions from linked cash accounts on switch to cash', async () => {
      mockGetAllTransactions.mockResolvedValue({
        data: [],
        pagination: { page: 1, totalPages: 1, total: 0 },
      });

      await switchToCashView();

      await waitFor(() => {
        expect(mockGetAllTransactions).toHaveBeenCalledWith(
          expect.objectContaining({
            accountIds: expect.arrayContaining(['cash-1', 'cash-2']),
            page: 1,
          })
        );
      });
    });

    it('lets the cash register draw its own strip, as the detail page does', async () => {
      // It was suppressed here and the page drew a density toggle in the
      // heading instead, which put the two pages' cash registers one control
      // apart.
      mockGetAllTransactions.mockResolvedValue({
        data: [{ id: 'cash-tx-1', transactionDate: '2024-01-15', amount: 100 }],
        pagination: { page: 1, totalPages: 1, total: 1 },
      });

      await switchToCashView();

      await waitFor(() => {
        expect(screen.getByTestId('cash-show-toolbar')).not.toHaveTextContent('false');
      });
    });

    it('passes startingBalance from API response to TransactionList', async () => {
      // Filter to single account so startingBalance is passed through
      mockLocalStorageState['monize-investments-accounts'] = {
        value: ['brok-1'],
        setter: vi.fn((newValue: any) => {
          mockLocalStorageState['monize-investments-accounts'].value =
            typeof newValue === 'function'
              ? newValue(mockLocalStorageState['monize-investments-accounts'].value)
              : newValue;
        }),
      };

      mockGetAllTransactions.mockResolvedValue({
        data: [{ id: 'cash-tx-1', transactionDate: '2024-01-15', amount: 100 }],
        pagination: { page: 1, totalPages: 1, total: 1 },
        startingBalance: 1234.56,
      });

      await switchToCashView();

      await waitFor(() => {
        expect(screen.getByTestId('cash-starting-balance')).toHaveTextContent('1234.56');
      });
    });

    it('passes isSingleAccountView=false when multiple cash accounts exist', async () => {
      mockGetAllTransactions.mockResolvedValue({
        data: [],
        pagination: { page: 1, totalPages: 1, total: 0 },
      });

      await switchToCashView();

      await waitFor(() => {
        // Two cash accounts (cash-1, cash-2) so isSingleAccountView should be false
        expect(screen.getByTestId('cash-single-account-view')).toHaveTextContent('false');
      });
    });

    it('passes isSingleAccountView=true when filtering to single account', async () => {
      // Filter to a single brokerage account (brok-1), which links to cash-1
      mockLocalStorageState['monize-investments-accounts'] = {
        value: ['brok-1'],
        setter: vi.fn((newValue: any) => {
          mockLocalStorageState['monize-investments-accounts'].value =
            typeof newValue === 'function'
              ? newValue(mockLocalStorageState['monize-investments-accounts'].value)
              : newValue;
        }),
      };

      mockGetAllTransactions.mockResolvedValue({
        data: [],
        pagination: { page: 1, totalPages: 1, total: 0 },
      });

      await switchToCashView();

      await waitFor(() => {
        // Only one cash account (cash-1) so isSingleAccountView should be true
        expect(screen.getByTestId('cash-single-account-view')).toHaveTextContent('true');
      });
    });

    it('shows + New Transaction button in cash view', async () => {
      mockGetAllTransactions.mockResolvedValue({
        data: [],
        pagination: { page: 1, totalPages: 1, total: 0 },
      });

      await switchToCashView();

      await waitFor(() => {
        // Cash view renders its own + New Transaction button (plus the page header one)
        const newTxButtons = screen.getAllByText('+ New Transaction');
        expect(newTxButtons.length).toBeGreaterThanOrEqual(1);
      });
    });

    it('shows filter button in cash view', async () => {
      mockGetAllTransactions.mockResolvedValue({
        data: [],
        pagination: { page: 1, totalPages: 1, total: 0 },
      });

      await switchToCashView();

      await waitFor(() => {
        expect(screen.getByText('Filter')).toBeInTheDocument();
      });
    });

    it('leaves the density toggle to the register, not the page heading', async () => {
      mockGetAllTransactions.mockResolvedValue({
        data: [],
        pagination: { page: 1, totalPages: 1, total: 0 },
      });

      await switchToCashView();
      await waitFor(() => {
        expect(screen.getByTestId('cash-transaction-list')).toBeInTheDocument();
      });

      // The stub draws no strip, so a toggle on screen here would be a second
      // one the page had drawn itself.
      expect(screen.queryByTitle('Toggle row density')).not.toBeInTheDocument();
    });

    it('asks for the filter options of the cash ledgers on screen', async () => {
      // Not every payee and category in the ledger: a filter is a way through
      // the rows in front of you.
      mockGetAllTransactions.mockResolvedValue({
        data: [],
        pagination: { page: 1, totalPages: 1, total: 0 },
      });

      await switchToCashView();

      await waitFor(() => {
        expect(mockGetFilterOptions).toHaveBeenCalledWith(
          expect.arrayContaining(['cash-1', 'cash-2']),
        );
      });
    });

    it('loads the filter options for a remembered cash view, with no click', async () => {
      // The view is persisted, so returning to the page lands on the cash
      // register without passing through the toggle. Loading the options only
      // on that click left both pickers reading "No options found" for exactly
      // the users who use the cash view most.
      mockLocalStorageState['monize-investments-transaction-view'] = {
        value: 'cash',
        setter: vi.fn(),
      };
      mockGetAllTransactions.mockResolvedValue({
        data: [],
        pagination: { page: 1, totalPages: 1, total: 0 },
      });

      await renderPage();

      await waitFor(() => {
        expect(mockGetFilterOptions).toHaveBeenCalled();
      });
    });

    it('opens an investment-linked cash row in place, without navigating', async () => {
      // Routing to `?edit=<id>` reached the same modal by reloading the page:
      // it jumped to the top and every section refetched before the dialogue
      // appeared.
      mockGetAllTransactions.mockResolvedValue({
        data: [
          {
            id: 'cash-tx-1',
            transactionDate: '2026-01-15',
            amount: -1000,
            linkedInvestmentTransactionId: 'itx-9',
          },
        ],
        pagination: { page: 1, totalPages: 1, total: 1 },
      });
      mockGetTransaction.mockResolvedValue({ id: 'itx-9', action: 'BUY' });

      await switchToCashView();
      await waitFor(() => {
        expect(screen.getByTestId('cash-edit-cash-tx-1')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('cash-edit-cash-tx-1'));
      });

      await waitFor(() => {
        expect(mockGetTransaction).toHaveBeenCalledWith('itx-9');
        expect(mockOpenEdit).toHaveBeenCalledWith({ id: 'itx-9', action: 'BUY' });
      });
      expect(mockRouterPush).not.toHaveBeenCalledWith(
        expect.stringContaining('edit=itx-9'),
      );
      // Both modals share one `useFormModal` mock here, so the discriminating
      // claim is the argument: the cash row itself must never be handed to a
      // form. Its amount, date and payee are consequences of the trade.
      expect(mockOpenEdit).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: 'cash-tx-1' }),
      );
    });

    it('does not ask for filter options while the brokerage register is on screen', async () => {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('transaction-list')).toBeInTheDocument();
      });

      expect(mockGetFilterOptions).not.toHaveBeenCalled();
    });

    it('shows filter panel when Filter button is clicked', async () => {
      mockGetAllTransactions.mockResolvedValue({
        data: [],
        pagination: { page: 1, totalPages: 1, total: 0 },
      });
      mockGetAllCategories.mockResolvedValue([
        { id: 'cat-1', name: 'Groceries', parentId: null, children: [] },
      ]);
      mockGetAllPayees.mockResolvedValue([
        { id: 'pay-1', name: 'Store A' },
      ]);

      await switchToCashView();

      await waitFor(() => {
        expect(screen.getByText('Filter')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Filter'));

      await waitFor(() => {
        // MultiSelect components should be rendered (mocked as multi-select divs)
        expect(screen.getByText('All payees')).toBeInTheDocument();
        expect(screen.getByText('All categories')).toBeInTheDocument();
        expect(screen.getByText('From')).toBeInTheDocument();
        expect(screen.getByText('To')).toBeInTheDocument();
      });
    });

    it('switches back to brokerage view', async () => {
      mockGetAllTransactions.mockResolvedValue({
        data: [],
        pagination: { page: 1, totalPages: 1, total: 0 },
      });

      await switchToCashView();

      await waitFor(() => {
        expect(screen.getByTestId('cash-transaction-list')).toBeInTheDocument();
      });

      // Click Brokerage to switch back
      const brokerageButton = screen.getByText('Brokerage');
      fireEvent.click(brokerageButton);

      await waitFor(() => {
        expect(screen.getByTestId('transaction-list')).toBeInTheDocument();
        expect(screen.queryByTestId('cash-transaction-list')).not.toBeInTheDocument();
      });
    });

    it('hides brokerage transaction list when in cash view', async () => {
      mockGetAllTransactions.mockResolvedValue({
        data: [],
        pagination: { page: 1, totalPages: 1, total: 0 },
      });

      await switchToCashView();

      await waitFor(() => {
        expect(screen.queryByTestId('transaction-list')).not.toBeInTheDocument();
        expect(screen.getByTestId('cash-transaction-list')).toBeInTheDocument();
      });
    });

    // Issue #1190 facing the other way: the add path refreshed the figures
    // above the register and the delete path reloaded the cash rows alone, so
    // the deleted row vanished while the summary, the allocation, Holdings by
    // Account and the chart kept their pre-delete values until Refresh.
    describe('after a cash row is deleted', () => {
      const deleteCashRow = async () => {
        mockGetAllTransactions.mockResolvedValue({
          data: [{ id: 'cash-tx-1', transactionDate: '2026-01-15', amount: 1000 }],
          pagination: { page: 1, totalPages: 1, total: 1 },
        });

        await switchToCashView();
        await waitFor(() => {
          expect(screen.getByTestId('cash-deleted-cash-tx-1')).toBeInTheDocument();
        });

        const summaryCallsBefore = mockGetPortfolioSummary.mock.calls.length;
        const brokerageCallsBefore = mockGetTransactions.mock.calls.length;
        const cashCallsBefore = mockGetAllTransactions.mock.calls.length;
        const chartKeyBefore = screen.getByTestId('value-chart-refresh-key').textContent;

        await act(async () => {
          fireEvent.click(screen.getByTestId('cash-deleted-cash-tx-1'));
        });

        return { summaryCallsBefore, brokerageCallsBefore, cashCallsBefore, chartKeyBefore };
      };

      it('refetches the portfolio summary the holdings and allocation are drawn from', async () => {
        const { summaryCallsBefore } = await deleteCashRow();

        await waitFor(() => {
          expect(mockGetPortfolioSummary.mock.calls.length).toBeGreaterThan(summaryCallsBefore);
        });
      });

      it('refetches the brokerage register, which a cash row with an investment split writes to', async () => {
        const { brokerageCallsBefore } = await deleteCashRow();

        await waitFor(() => {
          expect(mockGetTransactions.mock.calls.length).toBeGreaterThan(brokerageCallsBefore);
        });
      });

      it('refetches the cash register itself', async () => {
        const { cashCallsBefore } = await deleteCashRow();

        await waitFor(() => {
          expect(mockGetAllTransactions.mock.calls.length).toBeGreaterThan(cashCallsBefore);
        });
      });

      it('bumps the value chart refresh key, which fetches its own series', async () => {
        const { chartKeyBefore } = await deleteCashRow();

        await waitFor(() => {
          expect(screen.getByTestId('value-chart-refresh-key').textContent).not.toBe(chartKeyBefore);
        });
      });
    });
  });

  describe('Edit URL parameter (?edit=xxx)', () => {
    it('loads and opens transaction for editing when ?edit param is present', async () => {
      const mockTx = { id: 'itx-1', date: '2026-02-01', action: 'BUY', amount: 100 };
      mockGetTransaction.mockResolvedValue(mockTx);
      mockSearchParams = new URLSearchParams('edit=itx-1');

      await renderPage();

      await waitFor(() => {
        expect(mockGetTransaction).toHaveBeenCalledWith('itx-1');
        expect(mockOpenEdit).toHaveBeenCalledWith(mockTx);
      });
    });

    it('cleans URL after opening the edit form', async () => {
      const mockTx = { id: 'itx-1', date: '2026-02-01', action: 'BUY', amount: 100 };
      mockGetTransaction.mockResolvedValue(mockTx);
      mockSearchParams = new URLSearchParams('edit=itx-1');

      await renderPage();

      await waitFor(() => {
        expect(mockRouterReplace).toHaveBeenCalledWith('/investments', { scroll: false });
      });
    });

    it('does not reopen form when same edit ID reappears after cancel (back-navigation guard)', async () => {
      const mockTx = { id: 'itx-1', date: '2026-02-01', action: 'BUY', amount: 100 };
      mockGetTransaction.mockResolvedValue(mockTx);
      mockSearchParams = new URLSearchParams('edit=itx-1');

      const { rerender } = await renderPage();

      // Wait for initial edit to be handled
      await waitFor(() => {
        expect(mockGetTransaction).toHaveBeenCalledWith('itx-1');
        expect(mockOpenEdit).toHaveBeenCalledWith(mockTx);
      });

      // Simulate form being open after openEdit
      mockShowForm = true;

      // Simulate router.replace clearing the ?edit param
      mockGetTransaction.mockClear();
      mockOpenEdit.mockClear();
      mockRouterReplace.mockClear();
      mockSearchParams = new URLSearchParams();
      rerender(<InvestmentsPage />);

      // ref should NOT be reset because showForm is true
      await waitFor(() => {
        expect(mockGetTransaction).not.toHaveBeenCalled();
        expect(mockOpenEdit).not.toHaveBeenCalled();
      });

      // Simulate cancel: form closes, Modal's history.back() restores ?edit=itx-1
      mockShowForm = false;
      mockSearchParams = new URLSearchParams('edit=itx-1');
      rerender(<InvestmentsPage />);

      await waitFor(() => {
        // Guard should catch this — no reopen, just clean the URL
        expect(mockGetTransaction).not.toHaveBeenCalled();
        expect(mockOpenEdit).not.toHaveBeenCalled();
        expect(mockRouterReplace).toHaveBeenCalledWith('/investments', { scroll: false });
      });
    });

    it('allows re-editing same transaction after full URL cleanup', async () => {
      const mockTx = { id: 'itx-1', date: '2026-02-01', action: 'BUY', amount: 100 };
      mockGetTransaction.mockResolvedValue(mockTx);
      mockSearchParams = new URLSearchParams('edit=itx-1');

      const { rerender } = await renderPage();

      await waitFor(() => {
        expect(mockGetTransaction).toHaveBeenCalledWith('itx-1');
      });

      // Form open → URL clears
      mockShowForm = true;
      mockSearchParams = new URLSearchParams();
      rerender(<InvestmentsPage />);

      // Cancel → back to ?edit → guard catches → replace fires
      mockShowForm = false;
      mockSearchParams = new URLSearchParams('edit=itx-1');
      rerender(<InvestmentsPage />);

      // URL fully cleaned → ref resets (showForm is false)
      mockGetTransaction.mockClear();
      mockOpenEdit.mockClear();
      mockSearchParams = new URLSearchParams();
      rerender(<InvestmentsPage />);

      // Now navigate to same edit ID again — should work
      mockSearchParams = new URLSearchParams('edit=itx-1');
      rerender(<InvestmentsPage />);

      await waitFor(() => {
        expect(mockGetTransaction).toHaveBeenCalledWith('itx-1');
        expect(mockOpenEdit).toHaveBeenCalledWith(mockTx);
      });
    });

    it('cleans URL on load error without opening form', async () => {
      mockGetTransaction.mockRejectedValue(new Error('Not found'));
      mockSearchParams = new URLSearchParams('edit=itx-missing');

      await renderPage();

      await waitFor(() => {
        expect(mockGetTransaction).toHaveBeenCalledWith('itx-missing');
        expect(mockOpenEdit).not.toHaveBeenCalled();
        expect(mockRouterReplace).toHaveBeenCalledWith('/investments', { scroll: false });
      });
    });
  });

  describe('Mobile header title', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("hands the header the summary's account label and an account switcher", async () => {
      const title = stubCollapsingTitle();
      await renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('option-brok-1')).toBeInTheDocument();
      });
      title.collapse();

      expect(title.current()).toMatchObject({ title: 'Investments', context: 'All Accounts' });
      const switcher = title.current()?.switcher;
      // "All" is the selection, so it is current; the accounts read as the
      // picker names them, without the brokerage suffix.
      expect(switcher?.currentId).toBe('__all-investment-accounts__');
      expect(switcher?.items.map((item) => item.primary)).toEqual([
        'All Investment Accounts',
        'RRSP',
        'TFSA',
      ]);

      await act(async () => {
        switcher?.onSelect('brok-2');
      });
      await waitFor(() => {
        expect(title.current()).toMatchObject({ context: 'TFSA' });
      });
      expect(title.current()?.switcher?.currentId).toBe('brok-2');

      // And back to every account from the same menu.
      await act(async () => {
        title.current()?.switcher?.onSelect('__all-investment-accounts__');
      });
      await waitFor(() => {
        expect(title.current()).toMatchObject({ context: 'All Accounts' });
      });
    });
  });

  describe('Floating accounts bar (desktop)', () => {
    let headerScrolled: ((past: boolean) => void) | undefined;
    beforeEach(() => {
      setViewport({ tabBar: false });
      headerScrolled = undefined;
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          private readonly callback: (entries: Partial<IntersectionObserverEntry>[]) => void;
          constructor(callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {
            this.callback = callback;
          }
          observe(target: Element) {
            // The header's account picker, not the title's own observer.
            if (target.querySelector('[data-testid="multi-select"]')) {
              headerScrolled = (past) =>
                act(() =>
                  this.callback([
                    {
                      isIntersecting: !past,
                      boundingClientRect: { top: past ? -300 : 80 } as DOMRectReadOnly,
                    },
                  ]),
                );
            }
          }
          unobserve() {}
          disconnect() {}
        },
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('pins "Investments - <accounts>", an account caret and refresh to the top once the picker scrolls away', async () => {
      await renderPage();
      const floating = screen.getByTestId('investments-floating-bar');
      expect(floating).toHaveAttribute('aria-hidden', 'true');

      headerScrolled?.(true);
      expect(floating).toHaveAttribute('aria-hidden', 'false');
      // The title names the selection as the Portfolio Summary does.
      expect(within(floating).getByTestId('investments-floating-title')).toHaveTextContent(
        'Investments – All Accounts',
      );
      // A multi-account caret, not the full field and not a single-pick switcher.
      expect(within(floating).queryByTestId('multi-select')).not.toBeInTheDocument();
      expect(
        within(floating).queryByRole('button', { name: 'Switch to another account' }),
      ).not.toBeInTheDocument();
      expect(within(floating).getByTestId('multi-select-caret')).toHaveAttribute(
        'aria-label',
        'Choose accounts',
      );
      expect(within(floating).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();

      headerScrolled?.(false);
      expect(floating).toHaveAttribute('aria-hidden', 'true');
    });

    it('narrows the page to more than one account from the pinned picker', async () => {
      await renderPage();
      headerScrolled?.(true);
      const floating = screen.getByTestId('investments-floating-bar');

      await act(async () => {
        fireEvent.click(within(floating).getByTestId('option-brok-1'));
      });
      // The title follows the selection.
      await waitFor(() => {
        expect(within(floating).getByTestId('investments-floating-title')).toHaveTextContent(
          'Investments – RRSP',
        );
      });
      await act(async () => {
        fireEvent.click(within(floating).getByTestId('option-brok-2'));
      });
      await waitFor(() => {
        expect(mockUsePortfolioPeriodResults).toHaveBeenLastCalledWith(
          expect.objectContaining({ accountIds: 'brok-1,brok-2' }),
        );
      });

      // And back out of one, from the same picker.
      await act(async () => {
        fireEvent.click(within(floating).getByTestId('option-brok-1'));
      });
      await waitFor(() => {
        expect(mockUsePortfolioPeriodResults).toHaveBeenLastCalledWith(
          expect.objectContaining({ accountIds: 'brok-2' }),
        );
      });
      expect(floating).toHaveAttribute('aria-hidden', 'false');
    });

    it('shows the Total Portfolio Value and a + that asks investment or cash', async () => {
      await renderPage();
      headerScrolled?.(true);
      const floating = screen.getByTestId('investments-floating-bar');
      await waitFor(() => {
        expect(within(floating).getByTestId('investments-floating-value')).toHaveTextContent('$50,000.00');
      });
      // A complete valuation carries no partial marker.
      expect(within(floating).queryByTestId('partial-total-marker')).not.toBeInTheDocument();

      fireEvent.click(within(floating).getByRole('button', { name: 'New Transaction' }));
      expect(within(floating).getByRole('button', { name: 'Investment Transaction' })).toBeInTheDocument();
      expect(within(floating).getByRole('button', { name: 'Cash Transaction' })).toBeInTheDocument();
    });

    it('marks the value a subtotal when the valuation is incomplete', async () => {
      mockGetPortfolioSummary.mockResolvedValue({
        ...mockPortfolioSummary,
        valuationComplete: false,
        pricesComplete: false,
        unpricedSecurityIds: ['sec-9'],
      });
      await renderPage();
      headerScrolled?.(true);
      const value = await within(screen.getByTestId('investments-floating-bar')).findByTestId(
        'investments-floating-value',
      );
      expect(within(value).getByTestId('partial-total-marker')).toBeInTheDocument();
      expect(value).toHaveAttribute('title', 'Portfolio Value (partial)');
    });

    it('is not drawn where the tab bar is', async () => {
      setViewport({ tabBar: true });
      await renderPage();
      expect(screen.queryByTestId('investments-floating-bar')).not.toBeInTheDocument();
    });
  });
});
