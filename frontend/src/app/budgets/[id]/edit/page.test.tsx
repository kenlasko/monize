import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import BudgetEditPage from './page';

// Mock next/navigation
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/budgets/budget-1/edit',
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
const mockGetById = vi.fn();
const mockGetSummary = vi.fn();

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getById: (...args: any[]) => mockGetById(...args),
    getSummary: (...args: any[]) => mockGetSummary(...args),
    update: vi.fn(),
    updateCategory: vi.fn(),
  },
}));

// Mock components
vi.mock('@/components/budgets/BudgetForm', () => ({
  BudgetForm: ({ onCancel }: any) => (
    <div data-testid="budget-form">
      <button data-testid="form-cancel" onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

vi.mock('@/components/budgets/BudgetCategoryForm', () => ({
  BudgetCategoryForm: () => <div data-testid="category-form" />,
}));

vi.mock('@/components/budgets/BudgetProgressBar', () => ({
  BudgetProgressBar: () => <div data-testid="progress-bar" />,
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

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) =>
    isOpen ? <div data-testid="modal">{children}</div> : null,
}));

const mockBudget = {
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
  categories: [
    {
      id: 'bc-1',
      budgetId: 'budget-1',
      categoryId: 'cat-1',
      category: { id: 'cat-1', name: 'Groceries', isIncome: false },
      amount: 600,
      isIncome: false,
      rolloverType: 'NONE',
      rolloverCap: null,
      flexGroup: null,
      alertWarnPercent: 80,
      alertCriticalPercent: 95,
      notes: null,
      sortOrder: 0,
    },
  ],
  createdAt: '2026-02-01',
  updatedAt: '2026-02-01',
};

const mockSummary = {
  budget: mockBudget,
  totalBudgeted: 5200,
  totalSpent: 3100,
  totalIncome: 6000,
  remaining: 2100,
  percentUsed: 59.62,
  categoryBreakdown: [
    {
      budgetCategoryId: 'bc-1',
      categoryId: 'cat-1',
      categoryName: 'Groceries',
      budgeted: 600,
      spent: 420,
      remaining: 180,
      percentUsed: 70,
      isIncome: false,
    },
  ],
};

describe('BudgetEditPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue(mockBudget);
    mockGetSummary.mockResolvedValue(mockSummary);
  });

  it('shows loading spinner initially', () => {
    render(<BudgetEditPage />);

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('renders budget form after loading', async () => {
    render(<BudgetEditPage />);

    await waitFor(() => {
      expect(screen.getByTestId('budget-form')).toBeInTheDocument();
    });
  });

  it('displays budget name in header', async () => {
    render(<BudgetEditPage />);

    await waitFor(() => {
      expect(screen.getByText('Edit: February 2026')).toBeInTheDocument();
    });
  });

  it('shows category list with expense categories', async () => {
    render(<BudgetEditPage />);

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });
  });

  it('shows expenses heading with count', async () => {
    render(<BudgetEditPage />);

    await waitFor(() => {
      expect(screen.getByText('Expenses (1)')).toBeInTheDocument();
    });
  });

  it('renders back to dashboard button', async () => {
    render(<BudgetEditPage />);

    await waitFor(() => {
      expect(screen.getByText('Back to Dashboard')).toBeInTheDocument();
    });
  });

  it('redirects to budgets list on error', async () => {
    mockGetById.mockRejectedValue(new Error('Not found'));

    render(<BudgetEditPage />);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/budgets');
    });
  });
});
