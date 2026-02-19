import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import BudgetsPage from './page';

// Mock next/navigation
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/budgets',
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
      local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: false,
    }),
  },
}));

// Mock errors
vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_e: any, fallback: string) => fallback),
}));

// Mock exchange rates
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'USD',
    convertToDefault: vi.fn((amount: number) => amount),
  }),
}));

// Mock budgets API
const mockGetAll = vi.fn().mockResolvedValue([]);
const mockDelete = vi.fn();

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    delete: (...args: any[]) => mockDelete(...args),
    generate: vi.fn(),
    applyGenerated: vi.fn(),
  },
}));

// Mock components
vi.mock('@/components/budgets/BudgetWizard', () => ({
  BudgetWizard: ({ onComplete, onCancel }: any) => (
    <div data-testid="budget-wizard">
      <button data-testid="wizard-complete" onClick={onComplete}>Complete</button>
      <button data-testid="wizard-cancel" onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

vi.mock('@/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, title, onConfirm, onCancel, confirmLabel }: any) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <span>{title}</span>
        <button data-testid="confirm-btn" onClick={onConfirm}>{confirmLabel || 'Confirm'}</button>
        <button data-testid="cancel-btn" onClick={onCancel}>Cancel</button>
      </div>
    ) : null,
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
      {actions}
    </div>
  ),
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="loading-spinner">Loading...</div>,
}));

describe('BudgetsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAll.mockResolvedValue([]);
  });

  it('renders the page with title', async () => {
    render(<BudgetsPage />);

    await waitFor(() => {
      expect(screen.getByText('Budgets')).toBeInTheDocument();
    });
  });

  it('shows empty state when no budgets exist', async () => {
    render(<BudgetsPage />);

    await waitFor(() => {
      expect(screen.getByText('No budgets yet')).toBeInTheDocument();
    });
    expect(screen.getByText('Create Your First Budget')).toBeInTheDocument();
  });

  it('shows budget cards when budgets exist', async () => {
    mockGetAll.mockResolvedValue([
      {
        id: 'budget-1',
        name: 'February 2026',
        strategy: 'FIXED',
        budgetType: 'MONTHLY',
        isActive: true,
        periodStart: '2026-02-01',
        categories: [{ id: 'bc-1' }, { id: 'bc-2' }],
      },
    ]);

    render(<BudgetsPage />);

    await waitFor(() => {
      expect(screen.getByText('February 2026')).toBeInTheDocument();
    });
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Fixed - Monthly')).toBeInTheDocument();
    expect(screen.getByText('2 categories')).toBeInTheDocument();
  });

  it('shows the wizard when clicking New Budget', async () => {
    render(<BudgetsPage />);

    await waitFor(() => {
      expect(screen.getByText('No budgets yet')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Your First Budget'));

    await waitFor(() => {
      expect(screen.getByTestId('budget-wizard')).toBeInTheDocument();
    });
  });

  it('returns to list when wizard completes', async () => {
    render(<BudgetsPage />);

    await waitFor(() => {
      expect(screen.getByText('No budgets yet')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Your First Budget'));

    await waitFor(() => {
      expect(screen.getByTestId('budget-wizard')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('wizard-complete'));

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledTimes(2);
    });
  });

  it('returns to list when wizard is cancelled', async () => {
    render(<BudgetsPage />);

    await waitFor(() => {
      expect(screen.getByText('No budgets yet')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Your First Budget'));

    await waitFor(() => {
      expect(screen.getByTestId('budget-wizard')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('wizard-cancel'));

    await waitFor(() => {
      expect(screen.getByText('No budgets yet')).toBeInTheDocument();
    });
  });

  it('navigates to budget detail on card click', async () => {
    mockGetAll.mockResolvedValue([
      {
        id: 'budget-1',
        name: 'Budget',
        strategy: 'FIXED',
        budgetType: 'MONTHLY',
        isActive: true,
        periodStart: '2026-02-01',
        categories: [],
      },
    ]);

    render(<BudgetsPage />);

    await waitFor(() => {
      expect(screen.getByText('Budget')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Budget'));
    expect(mockPush).toHaveBeenCalledWith('/budgets/budget-1');
  });

  it('deletes a budget after confirmation', async () => {
    mockGetAll.mockResolvedValue([
      {
        id: 'budget-1',
        name: 'Budget',
        strategy: 'FIXED',
        budgetType: 'MONTHLY',
        isActive: true,
        periodStart: '2026-02-01',
        categories: [],
      },
    ]);
    mockDelete.mockResolvedValue(undefined);

    render(<BudgetsPage />);

    await waitFor(() => {
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('confirm-btn'));

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith('budget-1');
    });
  });
});
