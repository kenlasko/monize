import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import InvestmentsPage from './page';
import { PortfolioSummary, PaginatedInvestmentTransactions, InvestmentTransaction } from '@/types/investment';
import { Account } from '@/types/account';

// Mock next/navigation
const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
  usePathname: () => '/investments',
}));

// Mock next/image
vi.mock('next/image', () => ({
  default: (props: any) => <img {...props} />,
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
      preferences: { twoFactorEnabled: true, theme: 'system', defaultCurrency: 'USD' },
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

// --- Test data factories ---

function makeMockAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acct-cash-1',
    userId: 'test-user-id',
    accountType: 'INVESTMENT',
    accountSubType: 'INVESTMENT_CASH',
    linkedAccountId: 'acct-brokerage-1',
    name: 'Brokerage Account - Cash',
    description: null,
    currencyCode: 'USD',
    accountNumber: null,
    institution: null,
    openingBalance: 0,
    currentBalance: 5000,
    creditLimit: null,
    interestRate: null,
    isClosed: false,
    closedDate: null,
    isFavourite: false,
    paymentAmount: null,
    paymentFrequency: null,
    paymentStartDate: null,
    sourceAccountId: null,
    principalCategoryId: null,
    interestCategoryId: null,
    scheduledTransactionId: null,
    assetCategoryId: null,
    dateAcquired: null,
    isCanadianMortgage: false,
    isVariableRate: false,
    termMonths: null,
    termEndDate: null,
    amortizationMonths: null,
    originalPrincipal: null,
    canDelete: true,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeMockBrokerageAccount(): Account {
  return makeMockAccount({
    id: 'acct-brokerage-1',
    accountSubType: 'INVESTMENT_BROKERAGE',
    linkedAccountId: 'acct-cash-1',
    name: 'Brokerage Account',
    currentBalance: 50000,
  });
}

function makeMockPortfolioSummary(overrides: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    totalCashValue: 5000,
    totalHoldingsValue: 45000,
    totalCostBasis: 40000,
    totalPortfolioValue: 50000,
    totalGainLoss: 5000,
    totalGainLossPercent: 12.5,
    holdings: [
      {
        id: 'holding-1',
        accountId: 'acct-brokerage-1',
        securityId: 'sec-1',
        symbol: 'AAPL',
        name: 'Apple Inc.',
        securityType: 'STOCK',
        currencyCode: 'USD',
        quantity: 100,
        averageCost: 150,
        costBasis: 15000,
        currentPrice: 175,
        marketValue: 17500,
        gainLoss: 2500,
        gainLossPercent: 16.67,
      },
      {
        id: 'holding-2',
        accountId: 'acct-brokerage-1',
        securityId: 'sec-2',
        symbol: 'MSFT',
        name: 'Microsoft Corp.',
        securityType: 'STOCK',
        currencyCode: 'USD',
        quantity: 50,
        averageCost: 300,
        costBasis: 15000,
        currentPrice: 350,
        marketValue: 17500,
        gainLoss: 2500,
        gainLossPercent: 16.67,
      },
    ],
    holdingsByAccount: [
      {
        accountId: 'acct-brokerage-1',
        accountName: 'Brokerage Account',
        currencyCode: 'USD',
        cashAccountId: 'acct-cash-1',
        cashBalance: 5000,
        holdings: [
          {
            id: 'holding-1',
            accountId: 'acct-brokerage-1',
            securityId: 'sec-1',
            symbol: 'AAPL',
            name: 'Apple Inc.',
            securityType: 'STOCK',
            currencyCode: 'USD',
            quantity: 100,
            averageCost: 150,
            costBasis: 15000,
            currentPrice: 175,
            marketValue: 17500,
            gainLoss: 2500,
            gainLossPercent: 16.67,
          },
        ],
        totalCostBasis: 15000,
        totalMarketValue: 17500,
        totalGainLoss: 2500,
        totalGainLossPercent: 16.67,
      },
    ],
    allocation: [
      { name: 'Apple Inc.', symbol: 'AAPL', type: 'security', value: 17500, percentage: 35 },
      { name: 'Microsoft Corp.', symbol: 'MSFT', type: 'security', value: 17500, percentage: 35 },
      { name: 'Cash', symbol: null, type: 'cash', value: 5000, percentage: 10 },
    ],
    ...overrides,
  };
}

function makeMockTransaction(overrides: Partial<InvestmentTransaction> = {}): InvestmentTransaction {
  return {
    id: 'tx-1',
    accountId: 'acct-brokerage-1',
    securityId: 'sec-1',
    fundingAccountId: 'acct-cash-1',
    action: 'BUY',
    transactionDate: '2024-06-15',
    quantity: 10,
    price: 150,
    commission: 9.99,
    totalAmount: 1509.99,
    description: 'Buy AAPL shares',
    security: {
      id: 'sec-1',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      securityType: 'STOCK',
      exchange: 'NASDAQ',
      currencyCode: 'USD',
      isActive: true,
      skipPriceUpdates: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
    fundingAccount: { id: 'acct-cash-1', name: 'Brokerage Account - Cash' },
    createdAt: '2024-06-15T10:00:00Z',
    updatedAt: '2024-06-15T10:00:00Z',
    ...overrides,
  };
}

function makeMockPaginatedTransactions(
  transactions: InvestmentTransaction[] = [makeMockTransaction()],
  paginationOverrides: Partial<PaginatedInvestmentTransactions['pagination']> = {},
): PaginatedInvestmentTransactions {
  return {
    data: transactions,
    pagination: {
      page: 1,
      limit: 50,
      total: transactions.length,
      totalPages: 1,
      hasMore: false,
      ...paginationOverrides,
    },
  };
}

// --- Mock API modules ---

const mockGetPortfolioSummary = vi.fn();
const mockGetTransactions = vi.fn();
const mockGetInvestmentAccounts = vi.fn();
const mockGetPriceStatus = vi.fn();
const mockRefreshSelectedPrices = vi.fn();
const mockDeleteTransaction = vi.fn();
const mockGetTransaction = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
    getTransactions: (...args: any[]) => mockGetTransactions(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
    getPriceStatus: (...args: any[]) => mockGetPriceStatus(...args),
    refreshSelectedPrices: (...args: any[]) => mockRefreshSelectedPrices(...args),
    refreshPrices: vi.fn(),
    deleteTransaction: (...args: any[]) => mockDeleteTransaction(...args),
    getTransaction: (...args: any[]) => mockGetTransaction(...args),
    getHoldings: vi.fn().mockResolvedValue([]),
    getSecurities: vi.fn().mockResolvedValue([]),
    createTransaction: vi.fn(),
    updateTransaction: vi.fn(),
    getAssetAllocation: vi.fn(),
  },
}));

const mockGetAllAccounts = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAllAccounts(...args),
  },
}));

// Mock usePriceRefresh hook
const mockTriggerAutoRefresh = vi.fn();
vi.mock('@/hooks/usePriceRefresh', () => ({
  usePriceRefresh: () => ({
    isRefreshing: false,
    triggerManualRefresh: vi.fn(),
    triggerAutoRefresh: mockTriggerAutoRefresh,
  }),
  setRefreshInProgress: vi.fn(),
  getRefreshInProgress: vi.fn(() => false),
  isMarketHours: vi.fn(() => false),
}));

// --- Mock child components ---

vi.mock('@/components/investments/PortfolioSummaryCard', () => ({
  PortfolioSummaryCard: ({ summary, isLoading }: any) => (
    <div data-testid="portfolio-summary-card">
      {isLoading ? 'Loading summary...' : summary ? `Portfolio: $${summary.totalPortfolioValue}` : 'No data'}
    </div>
  ),
}));

vi.mock('@/components/investments/AssetAllocationChart', () => ({
  AssetAllocationChart: ({ allocation, isLoading }: any) => (
    <div data-testid="asset-allocation-chart">
      {isLoading ? 'Loading allocation...' : allocation ? 'Allocation chart' : 'No allocation'}
    </div>
  ),
}));

vi.mock('@/components/investments/GroupedHoldingsList', () => ({
  GroupedHoldingsList: ({ holdingsByAccount, isLoading, onSymbolClick, onCashClick }: any) => (
    <div data-testid="grouped-holdings-list">
      {isLoading ? 'Loading holdings...' : `${holdingsByAccount.length} account(s)`}
      {holdingsByAccount.map((acct: any) => (
        <div key={acct.accountId} data-testid={`account-holdings-${acct.accountId}`}>
          {acct.accountName}
          {acct.holdings.map((h: any) => (
            <button key={h.id} data-testid={`symbol-${h.symbol}`} onClick={() => onSymbolClick(h.symbol)}>
              {h.symbol}
            </button>
          ))}
          {acct.cashAccountId && (
            <button data-testid={`cash-link-${acct.cashAccountId}`} onClick={() => onCashClick(acct.cashAccountId)}>
              Cash
            </button>
          )}
        </div>
      ))}
    </div>
  ),
}));

vi.mock('@/components/investments/InvestmentTransactionList', () => ({
  InvestmentTransactionList: ({ transactions, isLoading, onDelete, onEdit, onNewTransaction, filters, onFiltersChange }: any) => (
    <div data-testid="investment-transaction-list">
      {isLoading ? 'Loading transactions...' : `${transactions.length} transaction(s)`}
      {transactions.map((tx: any) => (
        <div key={tx.id} data-testid={`transaction-${tx.id}`}>
          <span>{tx.action} {tx.security?.symbol}</span>
          <button data-testid={`edit-tx-${tx.id}`} onClick={() => onEdit(tx)}>Edit</button>
          <button data-testid={`delete-tx-${tx.id}`} onClick={() => onDelete(tx.id)}>Delete</button>
        </div>
      ))}
      <button data-testid="new-transaction-from-list" onClick={onNewTransaction}>New</button>
    </div>
  ),
  DensityLevel: {},
  TransactionFilters: {},
}));

vi.mock('@/components/investments/InvestmentTransactionForm', () => ({
  InvestmentTransactionForm: ({ transaction, onSuccess, onCancel, onDirtyChange }: any) => (
    <div data-testid="investment-transaction-form">
      <span>{transaction ? 'Edit Transaction' : 'New Investment Transaction'}</span>
      <button data-testid="form-save" onClick={onSuccess}>Save</button>
      <button data-testid="form-cancel" onClick={onCancel}>Cancel</button>
      <button data-testid="form-mark-dirty" onClick={() => onDirtyChange(true)}>Mark Dirty</button>
      <button data-testid="form-mark-clean" onClick={() => onDirtyChange(false)}>Mark Clean</button>
    </div>
  ),
}));

vi.mock('@/components/investments/InvestmentValueChart', () => ({
  InvestmentValueChart: ({ accountIds }: any) => (
    <div data-testid="investment-value-chart">
      Value chart (accounts: {accountIds?.length ?? 0})
    </div>
  ),
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen, onClose, onBeforeClose }: any) => {
    if (!isOpen) return null;
    return (
      <div data-testid="modal">
        <button data-testid="modal-close" onClick={() => {
          const shouldClose = onBeforeClose ? onBeforeClose() : undefined;
          if (shouldClose !== false) {
            onClose();
          }
        }}>Close Modal</button>
        {children}
      </div>
    );
  },
}));

vi.mock('@/components/ui/UnsavedChangesDialog', () => ({
  UnsavedChangesDialog: ({ isOpen, onSave, onDiscard, onCancel }: any) => {
    if (!isOpen) return null;
    return (
      <div data-testid="unsaved-changes-dialog">
        <span>Unsaved Changes</span>
        <button data-testid="unsaved-save" onClick={onSave}>Save</button>
        <button data-testid="unsaved-discard" onClick={onDiscard}>Discard</button>
        <button data-testid="unsaved-cancel" onClick={onCancel}>Cancel</button>
      </div>
    );
  },
}));

vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, onClick, disabled, className, title, variant, ...rest }: any) => (
    <button onClick={onClick} disabled={disabled} className={className} title={title} data-variant={variant} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock('@/components/ui/Pagination', () => ({
  Pagination: ({ currentPage, totalPages, totalItems, pageSize, onPageChange, itemName }: any) => (
    <div data-testid="pagination">
      <span data-testid="pagination-info">Page {currentPage} of {totalPages} ({totalItems} {itemName})</span>
      <button data-testid="pagination-prev" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage <= 1}>Previous</button>
      <button data-testid="pagination-next" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage >= totalPages}>Next</button>
    </div>
  ),
}));

vi.mock('@/components/ui/MultiSelect', () => ({
  MultiSelect: ({ value, onChange, options, placeholder }: any) => (
    <div data-testid="multi-select">
      <select
        data-testid="account-filter-select"
        multiple
        value={value}
        onChange={(e) => {
          const selected = Array.from(e.target.selectedOptions).map((o: any) => o.value);
          onChange(selected);
        }}
      >
        <option value="">{placeholder}</option>
        {options?.map((opt: any) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  ),
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <div data-testid="protected-route">{children}</div>,
}));

vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (key: string, defaultValue: any) => {
    const [value, setValue] = vi.importActual<typeof import('react')>('react').useState(defaultValue);
    return [value, setValue];
  },
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatDate: (d: string) => d,
  }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (val: number) => `$${val.toFixed(2)}`,
    formatNumber: (val: number) => val.toString(),
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (val: number) => val,
    defaultCurrency: 'USD',
  }),
}));

// --- Test setup ---

const mockCashAccount = makeMockAccount();
const mockBrokerageAccount = makeMockBrokerageAccount();
const mockSummary = makeMockPortfolioSummary();
const mockTransaction = makeMockTransaction();

function setupDefaultMocks() {
  mockGetInvestmentAccounts.mockResolvedValue([mockCashAccount, mockBrokerageAccount]);
  mockGetAllAccounts.mockResolvedValue([mockCashAccount, mockBrokerageAccount]);
  mockGetPortfolioSummary.mockResolvedValue(mockSummary);
  mockGetTransactions.mockResolvedValue(makeMockPaginatedTransactions([mockTransaction]));
  mockGetPriceStatus.mockResolvedValue({ lastUpdated: '2024-06-15T12:00:00Z' });
  mockRefreshSelectedPrices.mockResolvedValue({
    totalSecurities: 2,
    updated: 2,
    failed: 0,
    skipped: 0,
    results: [
      { symbol: 'AAPL', success: true, price: 175 },
      { symbol: 'MSFT', success: true, price: 350 },
    ],
    lastUpdated: '2024-06-15T12:30:00Z',
  });
  mockDeleteTransaction.mockResolvedValue(undefined);
  mockGetTransaction.mockResolvedValue(mockTransaction);
}

describe('InvestmentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setupDefaultMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Rendering basics ---

  it('renders with ProtectedRoute wrapper', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('protected-route')).toBeInTheDocument();
    });
  });

  it('renders within PageLayout', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('page-layout')).toBeInTheDocument();
    });
  });

  it('renders the page header with "Investments" title', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('Investments')).toBeInTheDocument();
    });
  });

  it('renders the subtitle "Track your investment portfolio"', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('Track your investment portfolio')).toBeInTheDocument();
    });
  });

  // --- Portfolio summary cards ---

  it('renders PortfolioSummaryCard component', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('portfolio-summary-card')).toBeInTheDocument();
    });
  });

  it('displays portfolio value after data loads', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio: $50000')).toBeInTheDocument();
    });
  });

  it('shows loading state in summary card while fetching', async () => {
    // Make getPortfolioSummary hang so loading remains true
    mockGetPortfolioSummary.mockReturnValue(new Promise(() => {}));
    mockGetTransactions.mockReturnValue(new Promise(() => {}));
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('Loading summary...')).toBeInTheDocument();
    });
  });

  // --- Asset allocation chart ---

  it('renders AssetAllocationChart component', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('asset-allocation-chart')).toBeInTheDocument();
    });
  });

  it('displays allocation chart after data loads', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('Allocation chart')).toBeInTheDocument();
    });
  });

  // --- Holdings section ---

  it('renders GroupedHoldingsList component', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('grouped-holdings-list')).toBeInTheDocument();
    });
  });

  it('displays grouped holdings data after loading', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('1 account(s)')).toBeInTheDocument();
    });
  });

  it('shows account name in holdings list', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
    });
  });

  // --- Investment value chart ---

  it('renders InvestmentValueChart component', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('investment-value-chart')).toBeInTheDocument();
    });
  });

  // --- Transaction list ---

  it('renders InvestmentTransactionList component', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('investment-transaction-list')).toBeInTheDocument();
    });
  });

  it('displays transaction data after loading', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('1 transaction(s)')).toBeInTheDocument();
    });
  });

  it('shows transaction details (action + symbol)', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('BUY AAPL')).toBeInTheDocument();
    });
  });

  it('renders empty transaction list when no transactions', async () => {
    mockGetTransactions.mockResolvedValue(makeMockPaginatedTransactions([]));
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('0 transaction(s)')).toBeInTheDocument();
    });
  });

  // --- Pagination ---

  it('does not render pagination when only one page', async () => {
    mockGetTransactions.mockResolvedValue(makeMockPaginatedTransactions([mockTransaction], { totalPages: 1 }));
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('1 transaction(s)')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('pagination')).not.toBeInTheDocument();
  });

  it('shows total count text when only one page with items', async () => {
    mockGetTransactions.mockResolvedValue(makeMockPaginatedTransactions([mockTransaction], { total: 5, totalPages: 1 }));
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText(/5 transactions/)).toBeInTheDocument();
    });
  });

  it('renders pagination when multiple pages exist', async () => {
    const transactions = Array.from({ length: 50 }, (_, i) =>
      makeMockTransaction({ id: `tx-${i}` }),
    );
    mockGetTransactions.mockResolvedValue(
      makeMockPaginatedTransactions(transactions, { total: 150, totalPages: 3, hasMore: true }),
    );
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('pagination')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pagination-info')).toHaveTextContent('Page 1 of 3 (150 transactions)');
  });

  it('changes page when pagination next is clicked', async () => {
    const transactions = [makeMockTransaction()];
    mockGetTransactions.mockResolvedValue(
      makeMockPaginatedTransactions(transactions, { total: 100, totalPages: 2, hasMore: true }),
    );
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('pagination')).toBeInTheDocument();
    });

    // Click next page
    fireEvent.click(screen.getByTestId('pagination-next'));

    // Should re-fetch with page 2
    await waitFor(() => {
      expect(mockGetTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2 }),
      );
    });
  });

  // --- Price refresh button ---

  it('renders the Refresh button', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });
  });

  it('calls API when Refresh button is clicked', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Refresh'));
    });

    await waitFor(() => {
      // handleRefreshPrices calls getPortfolioSummary first to get holdings, then refreshSelectedPrices
      expect(mockGetPortfolioSummary).toHaveBeenCalled();
      expect(mockRefreshSelectedPrices).toHaveBeenCalledWith(['sec-1', 'sec-2']);
    });
  });

  it('shows "Updating..." text while refreshing prices', async () => {
    // Make refreshSelectedPrices hang to keep refreshing state
    mockRefreshSelectedPrices.mockReturnValue(new Promise(() => {}));
    // Need getPortfolioSummary to resolve for the refresh flow
    mockGetPortfolioSummary.mockResolvedValue(mockSummary);

    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Refresh'));
    });

    await waitFor(() => {
      expect(screen.getByText('Updating...')).toBeInTheDocument();
    });
  });

  it('shows success result after price refresh completes', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Refresh'));
    });

    await waitFor(() => {
      expect(screen.getByText(/2 updated/)).toBeInTheDocument();
    });
  });

  it('shows error result when price refresh fails with API error', async () => {
    mockGetPortfolioSummary
      .mockResolvedValueOnce(mockSummary) // initial load
      .mockRejectedValueOnce(new Error('Network error')); // refresh call
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Refresh'));
    });

    await waitFor(() => {
      expect(screen.getByText('Error refreshing')).toBeInTheDocument();
    });
  });

  it('shows partial failure result when some prices fail to refresh', async () => {
    mockRefreshSelectedPrices.mockResolvedValue({
      totalSecurities: 2,
      updated: 1,
      failed: 1,
      skipped: 0,
      results: [
        { symbol: 'AAPL', success: true, price: 175 },
        { symbol: 'MSFT', success: false, error: 'Not found' },
      ],
      lastUpdated: '2024-06-15T12:30:00Z',
    });

    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Refresh'));
    });

    await waitFor(() => {
      expect(screen.getByText(/1 updated, 1 failed/)).toBeInTheDocument();
    });
  });

  it('skips refresh when portfolio has no holdings with non-zero quantity', async () => {
    const emptySummary = makeMockPortfolioSummary({
      holdings: [],
      holdingsByAccount: [],
    });
    mockGetPortfolioSummary
      .mockResolvedValueOnce(mockSummary) // initial load
      .mockResolvedValueOnce(emptySummary); // refresh call

    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Refresh'));
    });

    // refreshSelectedPrices should not be called if no securities
    await waitFor(() => {
      expect(mockRefreshSelectedPrices).not.toHaveBeenCalled();
    });
  });

  // --- Account filter ---

  it('renders the account filter MultiSelect', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('multi-select')).toBeInTheDocument();
    });
  });

  it('shows cash accounts in the filter dropdown options', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('account-filter-select')).toBeInTheDocument();
    });
    // The cash account name "Brokerage Account - Cash" should be displayed
    // as "Brokerage Account" (stripping " - Cash") via getAccountDisplayName
    const options = screen.getByTestId('account-filter-select').querySelectorAll('option');
    const optionTexts = Array.from(options).map((o) => o.textContent);
    expect(optionTexts).toContain('Brokerage Account');
  });

  it('reloads data when account filter changes', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('account-filter-select')).toBeInTheDocument();
    });

    // Clear initial call counts
    mockGetPortfolioSummary.mockClear();
    mockGetTransactions.mockClear();

    // Simulate account selection
    const select = screen.getByTestId('account-filter-select');
    fireEvent.change(select, { target: { selectedOptions: [{ value: 'acct-cash-1' }] } });

    await waitFor(() => {
      expect(mockGetPortfolioSummary).toHaveBeenCalled();
      expect(mockGetTransactions).toHaveBeenCalled();
    });
  });

  // --- Create transaction button ---

  it('renders the "+ New Transaction" button', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
    });
  });

  it('opens transaction form modal when "+ New Transaction" is clicked', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('+ New Transaction'));

    await waitFor(() => {
      expect(screen.getByTestId('modal')).toBeInTheDocument();
      expect(screen.getByTestId('investment-transaction-form')).toBeInTheDocument();
    });
  });

  it('shows "New Investment Transaction" heading in form modal for new transaction', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('+ New Transaction'));

    await waitFor(() => {
      expect(screen.getByText('New Investment Transaction')).toBeInTheDocument();
    });
  });

  // --- Edit transaction ---

  it('opens form in edit mode when edit button is clicked on a transaction', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('edit-tx-tx-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('edit-tx-tx-1'));

    await waitFor(() => {
      expect(screen.getByTestId('modal')).toBeInTheDocument();
      expect(screen.getByText('Edit Transaction')).toBeInTheDocument();
    });
  });

  // --- Form close and cancel ---

  it('closes form modal when cancel is clicked', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('+ New Transaction'));
    await waitFor(() => {
      expect(screen.getByTestId('modal')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('form-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('modal')).not.toBeInTheDocument();
    });
  });

  it('closes form and reloads data on successful save', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('+ New Transaction'));
    await waitFor(() => {
      expect(screen.getByTestId('modal')).toBeInTheDocument();
    });

    // Clear call counts before save
    mockGetPortfolioSummary.mockClear();
    mockGetTransactions.mockClear();

    fireEvent.click(screen.getByTestId('form-save'));

    await waitFor(() => {
      expect(screen.queryByTestId('modal')).not.toBeInTheDocument();
    });

    // Should reload portfolio data
    await waitFor(() => {
      expect(mockGetPortfolioSummary).toHaveBeenCalled();
      expect(mockGetTransactions).toHaveBeenCalled();
    });
  });

  // --- Unsaved changes dialog ---

  it('shows unsaved changes dialog when closing form with dirty state', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
    });

    // Open the form
    fireEvent.click(screen.getByText('+ New Transaction'));
    await waitFor(() => {
      expect(screen.getByTestId('modal')).toBeInTheDocument();
    });

    // Mark the form as dirty
    fireEvent.click(screen.getByTestId('form-mark-dirty'));

    // Try to close the modal
    fireEvent.click(screen.getByTestId('modal-close'));

    await waitFor(() => {
      expect(screen.getByTestId('unsaved-changes-dialog')).toBeInTheDocument();
      expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
    });
  });

  it('discards changes and closes form when Discard is clicked in unsaved dialog', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('+ New Transaction'));
    await waitFor(() => {
      expect(screen.getByTestId('modal')).toBeInTheDocument();
    });

    // Mark dirty and try to close
    fireEvent.click(screen.getByTestId('form-mark-dirty'));
    fireEvent.click(screen.getByTestId('modal-close'));

    await waitFor(() => {
      expect(screen.getByTestId('unsaved-changes-dialog')).toBeInTheDocument();
    });

    // Click Discard
    fireEvent.click(screen.getByTestId('unsaved-discard'));

    await waitFor(() => {
      expect(screen.queryByTestId('unsaved-changes-dialog')).not.toBeInTheDocument();
      expect(screen.queryByTestId('modal')).not.toBeInTheDocument();
    });
  });

  it('keeps form open when Cancel is clicked in unsaved dialog', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('+ New Transaction'));
    await waitFor(() => {
      expect(screen.getByTestId('modal')).toBeInTheDocument();
    });

    // Mark dirty and try to close
    fireEvent.click(screen.getByTestId('form-mark-dirty'));
    fireEvent.click(screen.getByTestId('modal-close'));

    await waitFor(() => {
      expect(screen.getByTestId('unsaved-changes-dialog')).toBeInTheDocument();
    });

    // Click Cancel in the unsaved dialog
    fireEvent.click(screen.getByTestId('unsaved-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('unsaved-changes-dialog')).not.toBeInTheDocument();
    });
    // Form should still be visible
    expect(screen.getByTestId('modal')).toBeInTheDocument();
  });

  it('does not show unsaved dialog when form is not dirty', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('+ New Transaction'));
    await waitFor(() => {
      expect(screen.getByTestId('modal')).toBeInTheDocument();
    });

    // Close without marking dirty
    fireEvent.click(screen.getByTestId('modal-close'));

    // Dialog should not appear; form should close
    expect(screen.queryByTestId('unsaved-changes-dialog')).not.toBeInTheDocument();
  });

  // --- Empty state ---

  it('renders page even when no investment accounts exist', async () => {
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(
      makeMockPortfolioSummary({
        totalCashValue: 0,
        totalHoldingsValue: 0,
        totalCostBasis: 0,
        totalPortfolioValue: 0,
        totalGainLoss: 0,
        totalGainLossPercent: 0,
        holdings: [],
        holdingsByAccount: [],
        allocation: [],
      }),
    );
    mockGetTransactions.mockResolvedValue(makeMockPaginatedTransactions([]));

    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('Investments')).toBeInTheDocument();
      expect(screen.getByText('0 account(s)')).toBeInTheDocument();
      expect(screen.getByText('0 transaction(s)')).toBeInTheDocument();
    });
  });

  it('does not show account options in filter when no cash accounts', async () => {
    // Return only brokerage accounts (no cash accounts)
    mockGetInvestmentAccounts.mockResolvedValue([makeMockBrokerageAccount()]);

    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('account-filter-select')).toBeInTheDocument();
    });

    const options = screen.getByTestId('account-filter-select').querySelectorAll('option');
    // Should only have the placeholder option
    expect(options.length).toBe(1);
  });

  // --- Loading states ---

  it('shows loading state for holdings while data is fetching', async () => {
    mockGetPortfolioSummary.mockReturnValue(new Promise(() => {}));
    mockGetTransactions.mockReturnValue(new Promise(() => {}));
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('Loading holdings...')).toBeInTheDocument();
    });
  });

  it('shows loading state for transactions while data is fetching', async () => {
    mockGetPortfolioSummary.mockReturnValue(new Promise(() => {}));
    mockGetTransactions.mockReturnValue(new Promise(() => {}));
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('Loading transactions...')).toBeInTheDocument();
    });
  });

  it('shows loading state for allocation chart while data is fetching', async () => {
    mockGetPortfolioSummary.mockReturnValue(new Promise(() => {}));
    mockGetTransactions.mockReturnValue(new Promise(() => {}));
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('Loading allocation...')).toBeInTheDocument();
    });
  });

  // --- Error handling for data loading ---

  it('handles portfolio data load failure gracefully', async () => {
    mockGetPortfolioSummary.mockRejectedValue(new Error('Server error'));
    mockGetTransactions.mockRejectedValue(new Error('Server error'));

    render(<InvestmentsPage />);
    await waitFor(() => {
      // Page should still render
      expect(screen.getByText('Investments')).toBeInTheDocument();
      // Summary card should show no data state
      expect(screen.getByText('No data')).toBeInTheDocument();
      // Transaction list should be empty
      expect(screen.getByText('0 transaction(s)')).toBeInTheDocument();
    });
  });

  it('handles investment accounts load failure gracefully', async () => {
    mockGetInvestmentAccounts.mockRejectedValue(new Error('Failed'));

    render(<InvestmentsPage />);
    await waitFor(() => {
      // Page should still render
      expect(screen.getByText('Investments')).toBeInTheDocument();
    });
  });

  // --- Symbol click navigation ---

  it('navigates to symbol filter when symbol is clicked in holdings', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('symbol-AAPL')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('symbol-AAPL'));

    // Should re-fetch transactions with symbol filter
    await waitFor(() => {
      expect(mockGetTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: 'AAPL' }),
      );
    });
  });

  it('navigates to transactions page when cash link is clicked', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('cash-link-acct-cash-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('cash-link-acct-cash-1'));

    expect(mockPush).toHaveBeenCalledWith('/transactions?accountId=acct-cash-1');
  });

  // --- API call verification ---

  it('calls required APIs on initial mount', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(mockGetInvestmentAccounts).toHaveBeenCalledTimes(1);
      expect(mockGetAllAccounts).toHaveBeenCalledTimes(1);
      expect(mockGetPriceStatus).toHaveBeenCalledTimes(1);
      expect(mockGetPortfolioSummary).toHaveBeenCalled();
      expect(mockGetTransactions).toHaveBeenCalled();
    });
  });

  it('triggers auto-refresh after initial load completes', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(mockTriggerAutoRefresh).toHaveBeenCalled();
    });
  });

  // --- Footer note ---

  it('renders the footer note about auto-generated symbols', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText(/Auto-generated symbol name/)).toBeInTheDocument();
    });
  });

  // --- Single transaction count ---

  it('shows singular "transaction" when count is 1', async () => {
    mockGetTransactions.mockResolvedValue(
      makeMockPaginatedTransactions([mockTransaction], { total: 1, totalPages: 1 }),
    );
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByText('1 transaction')).toBeInTheDocument();
    });
  });

  // --- New transaction from list component ---

  it('opens new transaction form when triggered from transaction list', async () => {
    render(<InvestmentsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('new-transaction-from-list')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('new-transaction-from-list'));

    await waitFor(() => {
      expect(screen.getByTestId('modal')).toBeInTheDocument();
      expect(screen.getByText('New Investment Transaction')).toBeInTheDocument();
    });
  });
});
