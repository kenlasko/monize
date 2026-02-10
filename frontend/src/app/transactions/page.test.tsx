import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import TransactionsPage from './page';

// Mock next/image
vi.mock('next/image', () => ({
  default: (props: any) => <img {...props} />,
}));

// Mock next/dynamic
vi.mock('next/dynamic', () => ({
  default: () => () => <div data-testid="dynamic-component">DynamicComponent</div>,
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

// Mock API libs
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: vi.fn().mockResolvedValue({ data: [], pagination: { page: 1, totalPages: 1, total: 0 } }),
    getSummary: vi.fn().mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 }),
    getById: vi.fn(),
  },
}));

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getAll: vi.fn().mockResolvedValue([]),
    getById: vi.fn(),
    update: vi.fn(),
  },
}));

// Mock child components
vi.mock('@/components/transactions/TransactionList', () => ({
  TransactionList: () => <div data-testid="transaction-list">TransactionList</div>,
  DensityLevel: {},
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: any) => isOpen ? <div data-testid="modal">{children}</div> : null,
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: ({ text }: { text?: string }) => <div data-testid="loading-spinner">{text}</div>,
}));

vi.mock('@/components/ui/SummaryCard', () => ({
  SummaryCard: ({ label, value }: any) => <div data-testid={`summary-${label}`}>{value}</div>,
  SummaryIcons: { plus: null, minus: null, money: null },
}));

vi.mock('@/components/ui/Pagination', () => ({
  Pagination: () => <div data-testid="pagination">Pagination</div>,
}));

vi.mock('@/components/ui/MultiSelect', () => ({
  MultiSelect: () => <div data-testid="multi-select">MultiSelect</div>,
  MultiSelectOption: {},
}));

vi.mock('@/components/ui/Input', () => ({
  Input: (props: any) => <input data-testid={`input-${props.label}`} {...props} />,
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

vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (key: string, defaultValue: any) => [defaultValue, vi.fn()],
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

describe('TransactionsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the page header with title', async () => {
    render(<TransactionsPage />);
    await waitFor(() => {
      expect(screen.getByText('Transactions')).toBeInTheDocument();
    });
  });

  it('renders the subtitle', async () => {
    render(<TransactionsPage />);
    await waitFor(() => {
      expect(screen.getByText(/Manage your income and expenses/i)).toBeInTheDocument();
    });
  });

  it('renders within page layout', async () => {
    render(<TransactionsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('page-layout')).toBeInTheDocument();
    });
  });

  it('renders summary cards', async () => {
    render(<TransactionsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Income')).toBeInTheDocument();
      expect(screen.getByTestId('summary-Total Expenses')).toBeInTheDocument();
      expect(screen.getByTestId('summary-Net Cash Flow')).toBeInTheDocument();
    });
  });
});
