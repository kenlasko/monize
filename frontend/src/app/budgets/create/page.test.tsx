import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import BudgetCreatePage from './page';

// Mock next/navigation
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/budgets/create',
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

// Mock exchange rates
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'USD',
    convertToDefault: vi.fn((amount: number) => amount),
  }),
}));

// Mock accounts API
const mockGetAllAccounts = vi.fn().mockResolvedValue([
  { id: 'acc-1', name: 'Checking', accountType: 'CHECKING' },
]);
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAllAccounts(...args),
  },
}));

// Mock BudgetWizard component
vi.mock('@/components/budgets/BudgetWizard', () => ({
  BudgetWizard: ({ onComplete, onCancel, defaultCurrency, accounts }: any) => (
    <div data-testid="budget-wizard">
      <span data-testid="wizard-currency">{defaultCurrency}</span>
      <span data-testid="wizard-accounts">{accounts?.length ?? 0}</span>
      <button data-testid="wizard-complete" onClick={onComplete}>Complete</button>
      <button data-testid="wizard-cancel" onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
  ),
}));

describe('BudgetCreatePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Checking', accountType: 'CHECKING' },
    ]);
  });

  it('renders the page with header', async () => {
    render(<BudgetCreatePage />);

    await waitFor(() => {
      expect(screen.getByText('Create Budget')).toBeInTheDocument();
    });
    expect(screen.getByText('Analyze your spending and create a personalized budget')).toBeInTheDocument();
  });

  it('renders the budget wizard', async () => {
    render(<BudgetCreatePage />);

    await waitFor(() => {
      expect(screen.getByTestId('budget-wizard')).toBeInTheDocument();
    });
  });

  it('passes default currency to wizard', async () => {
    render(<BudgetCreatePage />);

    await waitFor(() => {
      expect(screen.getByTestId('wizard-currency')).toHaveTextContent('USD');
    });
  });

  it('loads and passes accounts to wizard', async () => {
    render(<BudgetCreatePage />);

    await waitFor(() => {
      expect(screen.getByTestId('wizard-accounts')).toHaveTextContent('1');
    });
    expect(mockGetAllAccounts).toHaveBeenCalled();
  });

  it('navigates to /budgets on complete', async () => {
    render(<BudgetCreatePage />);

    await waitFor(() => {
      expect(screen.getByTestId('budget-wizard')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('wizard-complete'));
    expect(mockPush).toHaveBeenCalledWith('/budgets');
  });

  it('navigates to /budgets on cancel', async () => {
    render(<BudgetCreatePage />);

    await waitFor(() => {
      expect(screen.getByTestId('budget-wizard')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('wizard-cancel'));
    expect(mockPush).toHaveBeenCalledWith('/budgets');
  });

  it('handles accounts API failure gracefully', async () => {
    mockGetAllAccounts.mockRejectedValue(new Error('Network error'));

    render(<BudgetCreatePage />);

    await waitFor(() => {
      expect(screen.getByTestId('budget-wizard')).toBeInTheDocument();
    });
    // Accounts should be empty on error
    expect(screen.getByTestId('wizard-accounts')).toHaveTextContent('0');
  });
});
