import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import DashboardPage from './page';

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
      force2fa: false,
    }),
    logout: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock all API libs
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: vi.fn().mockResolvedValue([]),
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

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getTopMovers: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getMonthly: vi.fn().mockResolvedValue([]),
  },
}));

// Mock all dashboard child components
vi.mock('@/components/dashboard/FavouriteAccounts', () => ({
  FavouriteAccounts: () => <div data-testid="favourite-accounts">FavouriteAccounts</div>,
}));

vi.mock('@/components/dashboard/UpcomingBills', () => ({
  UpcomingBills: () => <div data-testid="upcoming-bills">UpcomingBills</div>,
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
  TopMovers: () => <div data-testid="top-movers">TopMovers</div>,
}));

vi.mock('@/components/dashboard/NetWorthChart', () => ({
  NetWorthChart: () => <div data-testid="net-worth-chart">NetWorthChart</div>,
}));

vi.mock('@/hooks/usePriceRefresh', () => ({
  usePriceRefresh: () => ({
    isRefreshing: false,
    triggerManualRefresh: vi.fn(),
    triggerAutoRefresh: vi.fn(),
  }),
}));

// Mock PageLayout to simplify
vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
