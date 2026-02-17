import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import DashboardPage from './page';

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
        user: {
          id: 'test-user-id',
          email: 'test@example.com',
          firstName: 'Test',
          lastName: 'User',
          role: 'user',
          hasPassword: true,
        },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        logout: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    {
      getState: vi.fn(() => ({
        user: {
          id: 'test-user-id',
          email: 'test@example.com',
          firstName: 'Test',
          lastName: 'User',
          role: 'user',
          hasPassword: true,
        },
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

// Mock auth API for ProtectedRoute
vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true,
      oidc: false,
      registration: true,
      smtp: false,
      force2fa: false, demo: false,
    }),
    logout: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock all API libs
const mockGetAccounts = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAccounts(...args),
  },
}));

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: vi.fn().mockResolvedValue({ data: [], pagination: { page: 1, totalPages: 1, total: 0 } }),
  },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

const mockGetTopMovers = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getTopMovers: (...args: any[]) => mockGetTopMovers(...args),
  },
}));

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getMonthly: vi.fn().mockResolvedValue([]),
  },
}));

// Mock all dashboard child components
vi.mock('@/components/dashboard/FavouriteAccounts', () => ({
  FavouriteAccounts: ({ isLoading }: any) => <div data-testid="favourite-accounts">{isLoading ? 'loading' : 'loaded'}</div>,
}));

vi.mock('@/components/dashboard/UpcomingBills', () => ({
  UpcomingBills: ({ isLoading }: any) => <div data-testid="upcoming-bills">{isLoading ? 'loading' : 'loaded'}</div>,
}));

vi.mock('@/components/dashboard/ExpensesPieChart', () => ({
  ExpensesPieChart: () => <div data-testid="expenses-chart">ExpensesPieChart</div>,
}));

vi.mock('@/components/dashboard/IncomeExpensesBarChart', () => ({
  IncomeExpensesBarChart: () => <div data-testid="income-expenses-chart">IncomeExpensesBarChart</div>,
}));

vi.mock('@/components/dashboard/GettingStarted', () => ({
  GettingStarted: () => <div data-testid="getting-started">GettingStarted</div>,
}));

vi.mock('@/components/dashboard/TopMovers', () => ({
  TopMovers: ({ hasInvestmentAccounts }: any) => (
    <div data-testid="top-movers">{hasInvestmentAccounts ? 'has-investments' : 'no-investments'}</div>
  ),
}));

vi.mock('@/components/dashboard/NetWorthChart', () => ({
  NetWorthChart: () => <div data-testid="net-worth-chart">NetWorthChart</div>,
}));

const mockTriggerAutoRefresh = vi.fn();
vi.mock('@/hooks/usePriceRefresh', () => ({
  usePriceRefresh: () => ({
    isRefreshing: false,
    triggerManualRefresh: vi.fn(),
    triggerAutoRefresh: mockTriggerAutoRefresh,
  }),
}));

// Mock PageLayout to simplify
vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccounts.mockResolvedValue([]);
  });

  it('renders the welcome message with user name', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText(/Welcome, Test!/)).toBeInTheDocument();
    });
  });

  it('renders the financial overview subtitle', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText(/financial overview/i)).toBeInTheDocument();
    });
  });

  it('renders dashboard child components', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('favourite-accounts')).toBeInTheDocument();
      expect(screen.getByTestId('upcoming-bills')).toBeInTheDocument();
      expect(screen.getByTestId('expenses-chart')).toBeInTheDocument();
      expect(screen.getByTestId('income-expenses-chart')).toBeInTheDocument();
    });
  });

  it('renders within the page layout', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('page-layout')).toBeInTheDocument();
    });
  });

  it('renders GettingStarted component', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('getting-started')).toBeInTheDocument();
    });
  });

  it('renders NetWorthChart component', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('net-worth-chart')).toBeInTheDocument();
    });
  });

  it('renders TopMovers component', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('top-movers')).toBeInTheDocument();
    });
  });

  it('detects investment accounts and sets hasInvestments', async () => {
    mockGetAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Brokerage', accountType: 'INVESTMENT', isClosed: false },
    ]);
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('top-movers')).toHaveTextContent('has-investments');
    });
  });

  it('does not set hasInvestments when no investment accounts exist', async () => {
    mockGetAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Checking', accountType: 'CHECKING', isClosed: false },
    ]);
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('top-movers')).toHaveTextContent('no-investments');
    });
  });

  it('ignores closed investment accounts for hasInvestments', async () => {
    mockGetAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Old Brokerage', accountType: 'INVESTMENT', isClosed: true },
    ]);
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('top-movers')).toHaveTextContent('no-investments');
    });
  });

  it('loads top movers when investment accounts exist', async () => {
    mockGetAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Brokerage', accountType: 'INVESTMENT', isClosed: false },
    ]);
    render(<DashboardPage />);
    await waitFor(() => {
      expect(mockGetTopMovers).toHaveBeenCalled();
    });
  });

  it('triggers auto price refresh when investments exist', async () => {
    mockGetAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Brokerage', accountType: 'INVESTMENT', isClosed: false },
    ]);
    render(<DashboardPage />);
    await waitFor(() => {
      expect(mockTriggerAutoRefresh).toHaveBeenCalled();
    });
  });

  it('shows loading state in child components while data loads', async () => {
    mockGetAccounts.mockReturnValue(new Promise(() => {}));
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('favourite-accounts')).toHaveTextContent('loading');
    });
  });
});
