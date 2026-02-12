import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import SecuritiesPage from './page';

// Mock next/image
vi.mock('next/image', () => ({
  default: (props: any) => <img alt="" {...props} />,
}));

// Mock next/dynamic
vi.mock('next/dynamic', () => ({
  default: () => () => <div data-testid="security-form">SecurityForm</div>,
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

// Mock investments API
const mockGetSecurities = vi.fn().mockResolvedValue([
  { id: 's1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', exchange: 'NASDAQ', currencyCode: 'USD', isActive: true, skipPriceUpdates: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
  { id: 's2', symbol: 'XEQT', name: 'iShares Core Equity', securityType: 'ETF', exchange: 'TSX', currencyCode: 'CAD', isActive: true, skipPriceUpdates: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
  { id: 's3', symbol: 'BTC', name: 'Bitcoin', securityType: 'CRYPTO', exchange: null, currencyCode: 'USD', isActive: false, skipPriceUpdates: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
]);
const mockGetHoldings = vi.fn().mockResolvedValue([
  { id: 'h1', accountId: 'a1', securityId: 's1', quantity: 10, averageCost: 150, security: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
]);

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurities: (...args: any[]) => mockGetSecurities(...args),
    getHoldings: (...args: any[]) => mockGetHoldings(...args),
    createSecurity: vi.fn(),
    updateSecurity: vi.fn(),
    deactivateSecurity: vi.fn(),
    activateSecurity: vi.fn(),
  },
}));

// Mock child components
vi.mock('@/components/securities/SecurityList', () => ({
  SecurityList: ({ securities, holdings }: any) => (
    <div data-testid="security-list">
      {securities.map((s: any) => (
        <div key={s.id} data-testid={`security-row-${s.symbol}`}>{s.name}</div>
      ))}
      <div data-testid="holdings-data">{JSON.stringify(holdings)}</div>
    </div>
  ),
  DensityLevel: {},
  SecurityHoldings: {},
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
  useLocalStorage: (_key: string, defaultValue: any) => [defaultValue, vi.fn()],
}));

describe('SecuritiesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSecurities.mockResolvedValue([
      { id: 's1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', exchange: 'NASDAQ', currencyCode: 'USD', isActive: true, skipPriceUpdates: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { id: 's2', symbol: 'XEQT', name: 'iShares Core Equity', securityType: 'ETF', exchange: 'TSX', currencyCode: 'CAD', isActive: true, skipPriceUpdates: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { id: 's3', symbol: 'BTC', name: 'Bitcoin', securityType: 'CRYPTO', exchange: null, currencyCode: 'USD', isActive: false, skipPriceUpdates: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ]);
    mockGetHoldings.mockResolvedValue([
      { id: 'h1', accountId: 'a1', securityId: 's1', quantity: 10, averageCost: 150, security: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ]);
  });

  it('renders the page header with title', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByText('Securities')).toBeInTheDocument();
    });
  });

  it('renders the subtitle', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByText(/Manage your stocks, ETFs, mutual funds/i)).toBeInTheDocument();
    });
  });

  it('renders within page layout', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('page-layout')).toBeInTheDocument();
    });
  });

  it('renders summary cards', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Securities')).toBeInTheDocument();
      expect(screen.getByTestId('summary-Active')).toBeInTheDocument();
      expect(screen.getByTestId('summary-Inactive')).toBeInTheDocument();
    });
  });

  it('shows correct summary counts from all securities', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Securities')).toHaveTextContent('3');
      expect(screen.getByTestId('summary-Active')).toHaveTextContent('2');
      expect(screen.getByTestId('summary-Inactive')).toHaveTextContent('1');
    });
  });

  it('loads and renders security list after fetching', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('security-list')).toBeInTheDocument();
    });
    // Only active securities shown by default (showInactive=false)
    expect(screen.getByTestId('security-row-AAPL')).toBeInTheDocument();
    expect(screen.getByTestId('security-row-XEQT')).toBeInTheDocument();
    expect(screen.queryByTestId('security-row-BTC')).not.toBeInTheDocument();
  });

  it('calls getSecurities with true to fetch all securities', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(mockGetSecurities).toHaveBeenCalledWith(true);
    });
  });

  it('calls getHoldings on mount', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(mockGetHoldings).toHaveBeenCalled();
    });
  });

  it('passes aggregated holdings to SecurityList', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      const holdingsData = screen.getByTestId('holdings-data');
      expect(holdingsData).toHaveTextContent('"s1":10');
    });
  });

  it('renders + New Security button', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Security')).toBeInTheDocument();
    });
  });

  it('opens form modal when + New Security is clicked', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Security')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('+ New Security'));
    await waitFor(() => {
      expect(screen.getByTestId('modal')).toBeInTheDocument();
      expect(screen.getByText('New Security')).toBeInTheDocument();
      expect(screen.getByTestId('security-form')).toBeInTheDocument();
    });
  });

  it('renders search input', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search by symbol or name...')).toBeInTheDocument();
    });
  });

  it('renders show inactive checkbox', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByText('Show inactive securities')).toBeInTheDocument();
    });
  });

  it('displays total count text for active securities', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByText(/2 securities/i)).toBeInTheDocument();
    });
  });

  it('summary counts always show totals including inactive', async () => {
    // Even though showInactive defaults to false, summary cards use allSecurities
    render(<SecuritiesPage />);
    await waitFor(() => {
      // Total should be 3 (all securities including inactive BTC)
      expect(screen.getByTestId('summary-Total Securities')).toHaveTextContent('3');
      // Active should be 2
      expect(screen.getByTestId('summary-Active')).toHaveTextContent('2');
      // Inactive should be 1
      expect(screen.getByTestId('summary-Inactive')).toHaveTextContent('1');
    });
  });

  it('handles API error gracefully', async () => {
    mockGetSecurities.mockRejectedValueOnce(new Error('Network error'));
    render(<SecuritiesPage />);
    // Should still render the page without crashing
    await waitFor(() => {
      expect(screen.getByTestId('page-header')).toBeInTheDocument();
    });
  });

  it('aggregates holdings from multiple entries for same security', async () => {
    mockGetHoldings.mockResolvedValue([
      { id: 'h1', accountId: 'a1', securityId: 's1', quantity: 10, averageCost: 150, security: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { id: 'h2', accountId: 'a2', securityId: 's1', quantity: 5, averageCost: 160, security: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ]);

    render(<SecuritiesPage />);
    await waitFor(() => {
      const holdingsData = screen.getByTestId('holdings-data');
      expect(holdingsData).toHaveTextContent('"s1":15');
    });
  });
});
