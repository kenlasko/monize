import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import AccountsPage from './page';
import toast from 'react-hot-toast';

// Mock next/image
vi.mock('next/image', () => ({
  default: (props: any) => <img alt="" {...props} />,
}));

// Mock next/dynamic
vi.mock('next/dynamic', () => ({
  default: () => () => <div data-testid="account-form">AccountForm</div>,
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

// Mock errors
vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_e: any, fallback: string) => fallback),
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

// Mock accounts API
const mockGetAll = vi.fn().mockResolvedValue([]);
const mockCreate = vi.fn();
const mockUpdate = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    create: (...args: any[]) => mockCreate(...args),
    update: (...args: any[]) => mockUpdate(...args),
  },
}));

// Mock investments API
const mockGetPortfolioSummary = vi.fn().mockResolvedValue(null);

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
  },
}));

// Mock child components
vi.mock('@/components/accounts/AccountList', () => ({
  AccountList: ({ accounts, onEdit }: any) => (
    <div data-testid="account-list">
      {accounts.map((a: any) => (
        <div key={a.id} data-testid={`account-${a.id}`}>
          {a.name}
          <button data-testid={`edit-${a.id}`} onClick={() => onEdit(a)}>Edit</button>
        </div>
      ))}
    </div>
  ),
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: any) => isOpen ? <div data-testid="modal">{children}</div> : null,
}));

vi.mock('@/components/ui/UnsavedChangesDialog', () => ({
  UnsavedChangesDialog: () => null,
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: ({ text }: { text?: string }) => <div data-testid="loading-spinner">{text}</div>,
}));

vi.mock('@/components/ui/SummaryCard', () => ({
  SummaryCard: ({ label, value }: any) => <div data-testid={`summary-${label}`}>{value}</div>,
  SummaryIcons: { accounts: null, money: null, checkmark: null, cross: null },
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

vi.mock('@/hooks/useFormModal', () => ({
  useFormModal: () => ({
    showForm: false,
    editingItem: null,
    openCreate: vi.fn(),
    openEdit: vi.fn(),
    close: vi.fn(),
    isEditing: false,
    modalProps: { pushHistory: true, onBeforeClose: vi.fn() },
    setFormDirty: vi.fn(),
    unsavedChangesDialog: { isOpen: false, onSave: vi.fn(), onDiscard: vi.fn(), onCancel: vi.fn() },
    formSubmitRef: { current: null },
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (val: number) => val,
    defaultCurrency: 'USD',
  }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (val: number) => `$${val.toFixed(2)}`,
    formatNumber: (val: number) => val.toString(),
  }),
}));

const mockAccounts = [
  { id: 'acc-1', name: 'Checking', accountType: 'CHECKING', accountSubType: null, currencyCode: 'USD', currentBalance: 5000, isClosed: false, canDelete: true },
  { id: 'acc-2', name: 'Savings', accountType: 'SAVINGS', accountSubType: null, currencyCode: 'USD', currentBalance: 10000, isClosed: false, canDelete: true },
  { id: 'acc-3', name: 'Credit Card', accountType: 'CREDIT_CARD', accountSubType: null, currencyCode: 'USD', currentBalance: -2000, isClosed: false, canDelete: false },
  { id: 'acc-4', name: 'Old Account', accountType: 'CHECKING', accountSubType: null, currencyCode: 'USD', currentBalance: 0, isClosed: true, canDelete: true },
  { id: 'acc-5', name: 'Brokerage', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', currencyCode: 'USD', currentBalance: 0, isClosed: false, canDelete: false },
];

describe('AccountsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAll.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(null);
  });

  it('renders the page header with title', async () => {
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByText('Accounts')).toBeInTheDocument();
    });
  });

  it('renders the page subtitle', async () => {
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByText(/Manage your bank accounts/i)).toBeInTheDocument();
    });
  });

  it('renders within page layout', async () => {
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('page-layout')).toBeInTheDocument();
    });
  });

  it('renders summary cards', async () => {
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Accounts')).toBeInTheDocument();
    });
  });

  it('shows loading spinner while data is loading', async () => {
    mockGetAll.mockReturnValue(new Promise(() => {}));
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    });
  });

  it('renders + New Account button', async () => {
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Account')).toBeInTheDocument();
    });
  });

  it('renders account list after data loads', async () => {
    mockGetAll.mockResolvedValue(mockAccounts);
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('account-list')).toBeInTheDocument();
    });
  });

  it('displays all accounts in the account list', async () => {
    mockGetAll.mockResolvedValue(mockAccounts);
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByText('Checking')).toBeInTheDocument();
      expect(screen.getByText('Savings')).toBeInTheDocument();
      expect(screen.getByText('Credit Card')).toBeInTheDocument();
    });
  });

  it('calls getAll with true to include closed accounts', async () => {
    render(<AccountsPage />);
    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(true);
    });
  });

  it('fetches portfolio summary on mount', async () => {
    render(<AccountsPage />);
    await waitFor(() => {
      expect(mockGetPortfolioSummary).toHaveBeenCalled();
    });
  });

  it('shows correct account count for active accounts', async () => {
    mockGetAll.mockResolvedValue(mockAccounts);
    render(<AccountsPage />);
    await waitFor(() => {
      // 4 active accounts (excluding the closed one)
      expect(screen.getByTestId('summary-Total Accounts')).toHaveTextContent('4');
    });
  });

  it('calculates net worth correctly (assets minus liabilities)', async () => {
    mockGetAll.mockResolvedValue(mockAccounts);
    render(<AccountsPage />);
    await waitFor(() => {
      // Assets: 5000 + 10000 + 0 (brokerage) = 15000
      // Liabilities: 2000 (credit card abs)
      // Net worth: 15000 - 2000 = 13000
      expect(screen.getByTestId('summary-Net Worth')).toHaveTextContent('$13000.00');
    });
  });

  it('calculates total assets correctly', async () => {
    mockGetAll.mockResolvedValue(mockAccounts);
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Assets')).toHaveTextContent('$15000.00');
    });
  });

  it('calculates total liabilities correctly', async () => {
    mockGetAll.mockResolvedValue(mockAccounts);
    render(<AccountsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Liabilities')).toHaveTextContent('$2000.00');
    });
  });

  it('handles API error gracefully', async () => {
    mockGetAll.mockRejectedValueOnce(new Error('Network error'));
    render(<AccountsPage />);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load accounts');
    });
  });

  it('uses brokerage market values from portfolio summary', async () => {
    mockGetAll.mockResolvedValue([
      { id: 'acc-5', name: 'Brokerage', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', currencyCode: 'USD', currentBalance: 0, isClosed: false, canDelete: false },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdingsByAccount: [
        { accountId: 'acc-5', totalMarketValue: 50000, cashBalance: 5000 },
      ],
    });
    render(<AccountsPage />);
    await waitFor(() => {
      // Brokerage value: 50000 + 5000 = 55000
      expect(screen.getByTestId('summary-Total Assets')).toHaveTextContent('$55000.00');
    });
  });

  it('handles portfolio summary fetch failure gracefully', async () => {
    mockGetAll.mockResolvedValue(mockAccounts);
    mockGetPortfolioSummary.mockRejectedValue(new Error('API error'));
    render(<AccountsPage />);
    // Page should still render without crashing
    await waitFor(() => {
      expect(screen.getByTestId('account-list')).toBeInTheDocument();
    });
  });
});
