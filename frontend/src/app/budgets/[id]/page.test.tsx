import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import BudgetDetailPage from './page';

// Mock next/navigation
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/budgets/budget-1',
  useParams: () => ({ id: 'budget-1' }),
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
      preferences: { twoFactorEnabled: true, theme: 'system', defaultCurrency: 'USD', numberFormat: 'en-US' },
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

// Mock errors
vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_e: any, fallback: string) => fallback),
}));

// Mock number format
vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
    formatNumber: (amount: number) => amount.toFixed(2),
    formatPercent: (amount: number) => `${amount}%`,
    defaultCurrency: 'USD',
  }),
}));

// Mock budgets API
const mockGetSummary = vi.fn();
const mockGetVelocity = vi.fn();
const mockGetPeriods = vi.fn();
const mockGetDailySpending = vi.fn();
const mockGetTrend = vi.fn();
const mockDeleteBudget = vi.fn();

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getSummary: (...args: any[]) => mockGetSummary(...args),
    getVelocity: (...args: any[]) => mockGetVelocity(...args),
    getPeriods: (...args: any[]) => mockGetPeriods(...args),
    getDailySpending: (...args: any[]) => mockGetDailySpending(...args),
    getTrend: (...args: any[]) => mockGetTrend(...args),
    delete: (...args: any[]) => mockDeleteBudget(...args),
  },
}));

// Mock scheduled transactions API
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, onConfirm, onCancel, confirmLabel }: any) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <button data-testid="confirm-btn" onClick={onConfirm}>{confirmLabel || 'Confirm'}</button>
        <button data-testid="cancel-btn" onClick={onCancel}>Cancel</button>
      </div>
    ) : null,
}));

vi.mock('@/components/budgets/utils/budget-labels', () => ({
  STRATEGY_LABELS: {
    FIXED: 'Fixed',
    ROLLOVER: 'Rollover',
    ZERO_BASED: 'Zero-Based',
    FIFTY_THIRTY_TWENTY: '50/30/20',
  },
}));

// Mock components
let capturedOnCategoryClick: ((budgetCategoryId: string) => void) | undefined;
vi.mock('@/components/budgets/BudgetDashboard', () => ({
  BudgetDashboard: (props: any) => {
    capturedOnCategoryClick = props.onCategoryClick;
    return <div data-testid="budget-dashboard">Dashboard</div>;
  },
}));

vi.mock('@/components/budgets/BudgetPeriodSelector', () => ({
  BudgetPeriodSelector: () => <div data-testid="period-selector" />,
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      {actions}
    </div>
  ),
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="loading-spinner">Loading...</div>,
}));

const mockSummary = {
  budget: {
    id: 'budget-1',
    userId: 'user-1',
    name: 'February 2026',
    description: null,
    budgetType: 'MONTHLY',
    periodStart: '2026-02-01',
    periodEnd: '2026-02-28',
    baseIncome: 6000,
    incomeLinked: false,
    strategy: 'FIXED',
    isActive: true,
    currencyCode: 'USD',
    config: {},
    categories: [],
    createdAt: '2026-02-01',
    updatedAt: '2026-02-01',
  },
  totalBudgeted: 5200,
  totalSpent: 3100,
  totalIncome: 6000,
  remaining: 2100,
  percentUsed: 59.62,
  categoryBreakdown: [
    {
      budgetCategoryId: 'bc-1',
      categoryId: 'cat-groceries',
      categoryName: 'Groceries',
      budgeted: 600,
      spent: 420,
      remaining: 180,
      percentUsed: 70,
      isIncome: false,
    },
  ],
};

const mockVelocity = {
  dailyBurnRate: 155,
  projectedTotal: 4650,
  budgetTotal: 5200,
  projectedVariance: -550,
  safeDailySpend: 124,
  daysElapsed: 13,
  daysRemaining: 15,
  totalDays: 28,
  currentSpent: 2015,
  paceStatus: 'under',
};

describe('BudgetDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    capturedOnCategoryClick = undefined;
    mockGetSummary.mockResolvedValue(mockSummary);
    mockGetVelocity.mockResolvedValue(mockVelocity);
    mockGetPeriods.mockResolvedValue([]);
    mockGetDailySpending.mockResolvedValue([]);
    mockGetTrend.mockResolvedValue([]);
    mockDeleteBudget.mockResolvedValue(undefined);
  });

  it('shows loading spinner initially', async () => {
    render(<BudgetDetailPage />);

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();

    // Wait for async operations to complete to prevent act() warnings
    await waitFor(() => {
      expect(screen.queryByTestId('loading-spinner')).not.toBeInTheDocument();
    });
  });

  it('renders budget dashboard after loading', async () => {
    render(<BudgetDetailPage />);

    await waitFor(() => {
      expect(screen.getByTestId('budget-dashboard')).toBeInTheDocument();
    });
  });

  it('displays budget name in header', async () => {
    render(<BudgetDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('February 2026')).toBeInTheDocument();
    });
  });

  it('shows error state on API failure', async () => {
    mockGetSummary.mockRejectedValue(new Error('Network error'));

    render(<BudgetDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load budget')).toBeInTheDocument();
    });
  });

  it('renders edit and back buttons', async () => {
    render(<BudgetDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('Edit')).toBeInTheDocument();
      expect(screen.getByText('Back')).toBeInTheDocument();
    });
  });

  it('calls API with correct budget ID', async () => {
    render(<BudgetDetailPage />);

    await waitFor(() => {
      expect(mockGetSummary).toHaveBeenCalledWith('budget-1');
      expect(mockGetVelocity).toHaveBeenCalledWith('budget-1');
      expect(mockGetPeriods).toHaveBeenCalledWith('budget-1');
    });
  });

  it('navigates to transactions with category filter on category click', async () => {
    render(<BudgetDetailPage />);

    await waitFor(() => {
      expect(screen.getByTestId('budget-dashboard')).toBeInTheDocument();
    });

    // The BudgetDashboard mock captures onCategoryClick
    expect(capturedOnCategoryClick).toBeDefined();
    capturedOnCategoryClick!('bc-1');

    expect(localStorage.getItem('transactions.filter.accountStatus')).toBe(
      JSON.stringify('active'),
    );
    expect(mockPush).toHaveBeenCalledWith(
      '/transactions?startDate=2026-02-01&endDate=2026-02-28&categoryIds=cat-groceries',
    );
  });

  it('does not navigate when category is not found', async () => {
    render(<BudgetDetailPage />);

    await waitFor(() => {
      expect(screen.getByTestId('budget-dashboard')).toBeInTheDocument();
    });

    capturedOnCategoryClick!('non-existent-bc');

    expect(mockPush).not.toHaveBeenCalled();
  });
});
