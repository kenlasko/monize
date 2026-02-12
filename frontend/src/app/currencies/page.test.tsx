import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import CurrenciesPage from './page';

// Mock next/image
vi.mock('next/image', () => ({
  default: (props: any) => <img alt="" {...props} />,
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
  getErrorMessage: vi.fn((e: any, fallback: string) => fallback),
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
      preferences: { twoFactorEnabled: true, theme: 'system', defaultCurrency: 'CAD' },
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

// Mock exchange rates API
const mockGetCurrencies = vi.fn().mockResolvedValue([
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', decimalPlaces: 2, isActive: true, createdAt: '2026-01-01' },
  { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, isActive: true, createdAt: '2026-01-01' },
  { code: 'EUR', name: 'Euro', symbol: '€', decimalPlaces: 2, isActive: false, createdAt: '2026-01-01' },
]);
const mockGetCurrencyUsage = vi.fn().mockResolvedValue({
  CAD: { accounts: 2, securities: 1 },
  USD: { accounts: 1, securities: 3 },
  EUR: { accounts: 0, securities: 0 },
});

const mockRefreshRates = vi.fn().mockResolvedValue({ updated: 5, failed: 0 });

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getCurrencies: (...args: any[]) => mockGetCurrencies(...args),
    getCurrencyUsage: (...args: any[]) => mockGetCurrencyUsage(...args),
    refreshRates: (...args: any[]) => mockRefreshRates(...args),
    getLatestRates: vi.fn().mockResolvedValue([]),
    createCurrency: vi.fn(),
    updateCurrency: vi.fn(),
    deactivateCurrency: vi.fn(),
    activateCurrency: vi.fn(),
    deleteCurrency: vi.fn(),
    lookupCurrency: vi.fn(),
  },
}));

// Mock useExchangeRates
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    rates: [],
    rateMap: new Map(),
    isLoading: false,
    convert: vi.fn(),
    convertToDefault: vi.fn(),
    getRate: vi.fn().mockReturnValue(null),
    refresh: vi.fn().mockResolvedValue(undefined),
    defaultCurrency: 'CAD',
  }),
}));

// Mock child components
vi.mock('@/components/currencies/CurrencyForm', () => ({
  CurrencyForm: () => <div data-testid="currency-form">CurrencyForm</div>,
}));

vi.mock('@/components/currencies/CurrencyList', () => ({
  CurrencyList: ({ currencies }: any) => (
    <div data-testid="currency-list">
      {currencies.map((c: any) => (
        <div key={c.code} data-testid={`currency-row-${c.code}`}>{c.name}</div>
      ))}
    </div>
  ),
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
  SummaryIcons: { barChart: null, checkCircle: null, ban: null },
}));

vi.mock('@/components/ui/Pagination', () => ({
  Pagination: () => <div data-testid="pagination">Pagination</div>,
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

vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (key: string, defaultValue: any) => [defaultValue, vi.fn()],
}));

describe('CurrenciesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrencies.mockResolvedValue([
      { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', decimalPlaces: 2, isActive: true, createdAt: '2026-01-01' },
      { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, isActive: true, createdAt: '2026-01-01' },
      { code: 'EUR', name: 'Euro', symbol: '€', decimalPlaces: 2, isActive: false, createdAt: '2026-01-01' },
    ]);
    mockGetCurrencyUsage.mockResolvedValue({
      CAD: { accounts: 2, securities: 1 },
      USD: { accounts: 1, securities: 3 },
      EUR: { accounts: 0, securities: 0 },
    });
  });

  it('renders the page header with title', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByText('Currencies')).toBeInTheDocument();
    });
  });

  it('renders the subtitle', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByText(/Manage currencies used across your accounts and securities/i)).toBeInTheDocument();
    });
  });

  it('renders within page layout', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('page-layout')).toBeInTheDocument();
    });
  });

  it('renders summary cards', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Currencies')).toBeInTheDocument();
      expect(screen.getByTestId('summary-Active')).toBeInTheDocument();
      expect(screen.getByTestId('summary-Inactive')).toBeInTheDocument();
    });
  });

  it('shows correct summary counts', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Currencies')).toHaveTextContent('3');
      expect(screen.getByTestId('summary-Active')).toHaveTextContent('2');
      expect(screen.getByTestId('summary-Inactive')).toHaveTextContent('1');
    });
  });

  it('loads and renders currency list after fetching', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('currency-list')).toBeInTheDocument();
    });
    expect(screen.getByTestId('currency-row-CAD')).toBeInTheDocument();
    expect(screen.getByTestId('currency-row-USD')).toBeInTheDocument();
  });

  it('calls getCurrencies and getCurrencyUsage on mount', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(mockGetCurrencies).toHaveBeenCalled();
      expect(mockGetCurrencyUsage).toHaveBeenCalled();
    });
  });

  it('renders + New Currency button', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Currency')).toBeInTheDocument();
    });
  });

  it('opens form modal when + New Currency is clicked', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Currency')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('+ New Currency'));
    await waitFor(() => {
      expect(screen.getByTestId('modal')).toBeInTheDocument();
      expect(screen.getByText('New Currency')).toBeInTheDocument();
      expect(screen.getByTestId('currency-form')).toBeInTheDocument();
    });
  });

  it('renders search input', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search by code or name...')).toBeInTheDocument();
    });
  });

  it('renders show inactive checkbox', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByText('Show inactive currencies')).toBeInTheDocument();
    });
  });

  it('displays total count text', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      // Only active currencies are shown by default (2 out of 3)
      expect(screen.getByText(/2 currencies/i)).toBeInTheDocument();
    });
  });

  it('renders Refresh Rates button', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByText('Refresh Rates')).toBeInTheDocument();
    });
  });

  it('calls refreshRates when Refresh Rates button is clicked', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByText('Refresh Rates')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Refresh Rates'));
    await waitFor(() => {
      expect(mockRefreshRates).toHaveBeenCalled();
    });
  });

  it('handles API error gracefully', async () => {
    mockGetCurrencies.mockRejectedValueOnce(new Error('Network error'));
    render(<CurrenciesPage />);
    // Should still render the page without crashing
    await waitFor(() => {
      expect(screen.getByTestId('page-header')).toBeInTheDocument();
    });
  });
});
