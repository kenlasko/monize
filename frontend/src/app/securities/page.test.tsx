import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, fireEvent, act, within } from '@/test/render';
import SecuritiesPage from './page';
import { notifyAutoPriceRefresh } from '@/lib/autoPriceRefreshSignal';
import { SEGMENTED_TOOLBAR_GROUP_CLASS, toolbarSegmentClass } from '@/components/ui/segmented-control';
import toast from 'react-hot-toast';

// Per-test query string, so the `?price=<id>` deep link can be exercised.
const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
// What the stubbed SecurityForm submits; a test sets it to submit another payload.
const form = vi.hoisted(() => ({
  payload: { symbol: 'NEW', name: 'New Security', currencyCode: 'USD' } as Record<string, unknown>,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/securities',
  useSearchParams: () => nav.params,
}));

const mockPush = vi.fn();
const mockReplace = vi.fn();

// Mock next/image
vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img alt="" {...props} />,
}));

// Mock next/dynamic to return a stub that exposes the loaded component name.
// SecurityForm is the only component this page loads dynamically; the price and
// transaction history panes live on the detail page.
vi.mock('next/dynamic', () => ({
  default: (_loader: any) => {
    const Stub = (props: any) => {
      return (
        <div data-testid="security-form">
          SecurityForm
          {props.security && <span data-testid="editing-security">{props.security.symbol}</span>}
          <button data-testid="submit-form" onClick={() => Promise.resolve(props.onSubmit(form.payload)).catch(() => {})}>Submit</button>
          <button data-testid="cancel-form" onClick={props.onCancel}>Cancel</button>
        </div>
      );
    };
    return Stub;
  },
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
vi.mock('@/lib/errors', async (importOriginal) => ({
  getRecordInUseEntries: (await importOriginal<typeof import('@/lib/errors')>()).getRecordInUseEntries,
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
      local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: false,
    }),
  },
}));

// Mock investments API
const mockGetSecurities = vi.fn().mockResolvedValue([
  { id: 's1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', exchange: 'NASDAQ', currencyCode: 'USD', isActive: true, isFavourite: false, skipPriceUpdates: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
  { id: 's2', symbol: 'XEQT', name: 'iShares Core Equity', securityType: 'ETF', exchange: 'TSX', currencyCode: 'CAD', isActive: true, isFavourite: false, skipPriceUpdates: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
  { id: 's3', symbol: 'BTC', name: 'Bitcoin', securityType: 'CRYPTO', exchange: null, currencyCode: 'USD', isActive: false, isFavourite: false, skipPriceUpdates: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
]);
const mockGetHoldings = vi.fn().mockResolvedValue([
  { id: 'h1', accountId: 'a1', securityId: 's1', quantity: 10, averageCost: 150, security: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
]);
const mockCreateSecurity = vi.fn();
const mockUpdateSecurity = vi.fn();
const mockDeactivateSecurity = vi.fn();
const mockActivateSecurity = vi.fn();
const mockSetSecurityFavourite = vi.fn().mockResolvedValue(undefined);
const mockRefreshSelectedPrices = vi.fn().mockResolvedValue({
  updated: 2,
  failed: 0,
  results: [],
  lastUpdated: '2026-08-31T12:00:00.000Z',
});
const mockGetPriceStatus = vi.fn().mockResolvedValue({ lastUpdated: '2026-08-30T12:00:00.000Z' });

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurities: (...args: any[]) => mockGetSecurities(...args),
    getHoldings: (...args: any[]) => mockGetHoldings(...args),
    getUsedSecurityIds: vi.fn().mockResolvedValue([]),
    deleteSecurity: vi.fn().mockResolvedValue(undefined),
    createSecurity: (...args: any[]) => mockCreateSecurity(...args),
    updateSecurity: (...args: any[]) => mockUpdateSecurity(...args),
    deactivateSecurity: (...args: any[]) => mockDeactivateSecurity(...args),
    activateSecurity: (...args: any[]) => mockActivateSecurity(...args),
    setSecurityFavourite: (...args: any[]) => mockSetSecurityFavourite(...args),
    refreshSelectedPrices: (...args: any[]) => mockRefreshSelectedPrices(...args),
    getPriceStatus: (...args: any[]) => mockGetPriceStatus(...args),
  },
}));

// Mock child components
vi.mock('@/components/securities/SecurityList', () => ({
  SecurityList: ({ securities, holdings, onEdit, onToggleActive, onToggleFavourite, onDelete, onOpen, sortField, sortDirection, onSort }: any) => (
    <div data-testid="security-list">
      {sortField && <span data-testid="sort-field">{sortField}</span>}
      {sortDirection && <span data-testid="sort-direction">{sortDirection}</span>}
      {onSort && <button data-testid="sort-trigger" onClick={() => onSort('name')}>Sort</button>}
      {onSort && <button data-testid="sort-symbol" onClick={() => onSort('symbol')}>SortSymbol</button>}
      {onSort && <button data-testid="sort-type" onClick={() => onSort('type')}>SortType</button>}
      {onSort && <button data-testid="sort-exchange" onClick={() => onSort('exchange')}>SortExchange</button>}
      {onSort && <button data-testid="sort-currency" onClick={() => onSort('currency')}>SortCurrency</button>}
      {onSort && <button data-testid="sort-provider" onClick={() => onSort('provider')}>SortProvider</button>}
      {onSort && <button data-testid="sort-source" onClick={() => onSort('source')}>SortSource</button>}
      {onSort && <button data-testid="sort-value" onClick={() => onSort('value')}>SortValue</button>}
      {securities.map((s: any) => (
        <div key={s.id} data-testid={`security-row-${s.symbol}`}>
          {s.name}
          <button data-testid={`edit-${s.symbol}`} onClick={() => onEdit(s)}>Edit</button>
          <button data-testid={`toggle-${s.symbol}`} onClick={() => onToggleActive(s)}>Toggle</button>
          <span data-testid={`fav-state-${s.symbol}`}>{String(s.isFavourite)}</span>
          {onToggleFavourite && <button data-testid={`fav-${s.symbol}`} onClick={() => onToggleFavourite(s)}>Fav</button>}
          <button data-testid={`delete-${s.symbol}`} onClick={() => onDelete(s)}>Delete</button>
          <button data-testid={`open-${s.symbol}`} onClick={() => onOpen(s)}>Open</button>
        </div>
      ))}
      <div data-testid="holdings-data">{JSON.stringify(holdings)}</div>
    </div>
  ),
  DensityLevel: {},
  SecurityHoldings: {},
}));

vi.mock('@/components/securities/BondRefreshProgress', () => ({
  BondRefreshProgress: ({ programId, active }: { programId: string | null; active: boolean }) =>
    active ? <div data-testid="bond-progress">{programId}</div> : null,
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen, title, footer }: any) =>
    isOpen ? (
      <div data-testid="modal">
        {title && <h2>{title}</h2>}
        {children}
        {footer}
      </div>
    ) : null,
}));

vi.mock('@/components/ui/UnsavedChangesDialog', () => ({
  UnsavedChangesDialog: () => null,
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: ({ text }: { text?: string }) => <div data-testid="loading-spinner">{text}</div>,
}));

vi.mock('@/components/ui/SummaryCard', () => ({
  SummaryCard: ({ label, value }: any) => <div data-testid={`summary-${label}`}>{value}</div>,
  SummaryIcons: { barChart: null, tag: null, list: null, money: null },
}));

vi.mock('@/components/ui/Pagination', () => ({
  Pagination: ({ currentPage, totalPages, onPageChange }: any) => (
    <div data-testid="pagination">
      Pagination {currentPage}/{totalPages}
      <button data-testid="next-page" onClick={() => onPageChange(currentPage + 1)}>Next</button>
    </div>
  ),
}));

vi.mock('@/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, onConfirm, onCancel, title, message }: any) => isOpen ? (
    <div data-testid="confirm-dialog">
      <span data-testid="dialog-title">{title}</span>
      <span data-testid="dialog-message">{message}</span>
      <button data-testid="confirm-btn" onClick={onConfirm}>Confirm</button>
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

vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (_key: string, defaultValue: any) => useState(defaultValue),
}));

describe('SecuritiesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nav.params = new URLSearchParams();
    form.payload = { symbol: 'NEW', name: 'New Security', currencyCode: 'USD' };
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
      expect(screen.getByTestId('summary-Types')).toBeInTheDocument();
      expect(screen.getByTestId('summary-Exchanges')).toBeInTheDocument();
      expect(screen.getByTestId('summary-Currencies')).toBeInTheDocument();
    });
  });

  it('shows correct summary counts from all securities', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Securities')).toHaveTextContent('3');
      expect(screen.getByTestId('summary-Types')).toHaveTextContent('3');
      expect(screen.getByTestId('summary-Exchanges')).toHaveTextContent('2');
      expect(screen.getByTestId('summary-Currencies')).toHaveTextContent('2');
    });
  });

  it('excludes null values from distinct counts', async () => {
    // BTC has exchange: null, so only 2 distinct exchanges (NASDAQ, TSX)
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Exchanges')).toHaveTextContent('2');
    });
  });

  it('shows correct distinct counts with single security', async () => {
    mockGetSecurities.mockResolvedValue([
      { id: 's1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', exchange: 'NASDAQ', currencyCode: 'USD', isActive: true, skipPriceUpdates: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ]);
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Securities')).toHaveTextContent('1');
      expect(screen.getByTestId('summary-Types')).toHaveTextContent('1');
      expect(screen.getByTestId('summary-Exchanges')).toHaveTextContent('1');
      expect(screen.getByTestId('summary-Currencies')).toHaveTextContent('1');
    });
  });

  it('shows zero distinct counts when no securities', async () => {
    mockGetSecurities.mockResolvedValue([]);
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Securities')).toHaveTextContent('0');
      expect(screen.getByTestId('summary-Types')).toHaveTextContent('0');
      expect(screen.getByTestId('summary-Exchanges')).toHaveTextContent('0');
      expect(screen.getByTestId('summary-Currencies')).toHaveTextContent('0');
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

  it('has no Treasury bonds button in the header', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Security')).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: 'Treasury bonds' })).not.toBeInTheDocument();
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

  it('renders filter buttons for All, Active, Inactive with counts', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByText(/All \(3\)/)).toBeInTheDocument();
      expect(screen.getByText(/Active \(2\)/)).toBeInTheDocument();
      expect(screen.getByText(/Inactive \(1\)/)).toBeInTheDocument();
    });
  });

  it('defaults to Active filter showing only active securities', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('security-list')).toBeInTheDocument();
    });
    expect(screen.getByTestId('security-row-AAPL')).toBeInTheDocument();
    expect(screen.getByTestId('security-row-XEQT')).toBeInTheDocument();
    expect(screen.queryByTestId('security-row-BTC')).not.toBeInTheDocument();
  });

  it('displays total count text for active securities', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByText(/2 securities/i)).toBeInTheDocument();
    });
  });

  it('shows all securities when All button is clicked', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('security-list')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/All \(3\)/));
    await waitFor(() => {
      expect(screen.getByTestId('security-row-AAPL')).toBeInTheDocument();
      expect(screen.getByTestId('security-row-XEQT')).toBeInTheDocument();
      expect(screen.getByTestId('security-row-BTC')).toBeInTheDocument();
    });
  });

  it('shows only inactive securities when Inactive button is clicked', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('security-list')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Inactive \(1\)/));
    await waitFor(() => {
      expect(screen.queryByTestId('security-row-AAPL')).not.toBeInTheDocument();
      expect(screen.getByTestId('security-row-BTC')).toBeInTheDocument();
    });
  });

  it('passes sort props to SecurityList', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('sort-field')).toHaveTextContent('symbol');
      expect(screen.getByTestId('sort-direction')).toHaveTextContent('asc');
    });
  });

  it('passes onSort callback to SecurityList', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('sort-trigger')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('sort-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('sort-field')).toHaveTextContent('name');
    });
  });

  it('filters securities by search query', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('security-list')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByPlaceholderText('Search by symbol or name...'), { target: { value: 'Apple' } });
    await waitFor(() => {
      expect(screen.getByTestId('security-row-AAPL')).toBeInTheDocument();
      expect(screen.queryByTestId('security-row-XEQT')).not.toBeInTheDocument();
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

  it('handles string quantities from API (PostgreSQL decimal)', async () => {
    mockGetHoldings.mockResolvedValue([
      { id: 'h1', accountId: 'a1', securityId: 's1', quantity: '21410.58770000', averageCost: 150, security: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ]);

    render(<SecuritiesPage />);
    await waitFor(() => {
      const holdingsData = screen.getByTestId('holdings-data');
      expect(holdingsData).toHaveTextContent('"s1":21410.5877');
    });
  });

  it('aggregates mixed string and numeric quantities', async () => {
    mockGetHoldings.mockResolvedValue([
      { id: 'h1', accountId: 'a1', securityId: 's1', quantity: '100.5', averageCost: 150, security: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { id: 'h2', accountId: 'a2', securityId: 's1', quantity: 50, averageCost: 160, security: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ]);

    render(<SecuritiesPage />);
    await waitFor(() => {
      const holdingsData = screen.getByTestId('holdings-data');
      expect(holdingsData).toHaveTextContent('"s1":150.5');
    });
  });

  it('filters out negligible quantities (rounding errors)', async () => {
    mockGetHoldings.mockResolvedValue([
      { id: 'h1', accountId: 'a1', securityId: 's1', quantity: 100, averageCost: 150, security: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { id: 'h2', accountId: 'a2', securityId: 's1', quantity: -100, averageCost: 160, security: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { id: 'h3', accountId: 'a3', securityId: 's2', quantity: 0.000000001, averageCost: 50, security: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ]);

    render(<SecuritiesPage />);
    await waitFor(() => {
      const holdingsData = screen.getByTestId('holdings-data');
      // s1 should not appear (100 - 100 = 0)
      // s2 should not appear (0.000000001 < threshold)
      expect(holdingsData.textContent).toBe('{}');
    });
  });

  it('shows loading spinner while data is loading', async () => {
    mockGetSecurities.mockReturnValue(new Promise(() => {}));
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    });
  });

  it('calls deactivateSecurity when toggling an active security', async () => {
    mockDeactivateSecurity.mockResolvedValue(undefined);
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('security-list')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('toggle-AAPL'));
    await waitFor(() => {
      expect(mockDeactivateSecurity).toHaveBeenCalledWith('s1');
    });
  });

  it('shows error toast when toggle active fails', async () => {
    mockDeactivateSecurity.mockRejectedValueOnce(new Error('Failed'));
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('security-list')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('toggle-AAPL'));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to update security status');
    });
  });

  it('optimistically flips the favourite flag and persists it without a reload', async () => {
    mockGetSecurities.mockResolvedValueOnce([
      { id: 's1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', exchange: 'NASDAQ', currencyCode: 'USD', isActive: true, isFavourite: false, skipPriceUpdates: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ]);
    mockSetSecurityFavourite.mockResolvedValueOnce(undefined);
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('security-list')).toBeInTheDocument();
    });
    const callsAfterLoad = mockGetSecurities.mock.calls.length;

    expect(screen.getByTestId('fav-state-AAPL').textContent).toBe('false');
    fireEvent.click(screen.getByTestId('fav-AAPL'));

    // Optimistic update flips the star immediately.
    await waitFor(() => {
      expect(screen.getByTestId('fav-state-AAPL').textContent).toBe('true');
    });
    expect(mockSetSecurityFavourite).toHaveBeenCalledWith('s1', true);
    // No reload (getSecurities not called again).
    expect(mockGetSecurities.mock.calls.length).toBe(callsAfterLoad);
  });

  it('reverts the favourite flag and shows an error toast when the save fails', async () => {
    mockGetSecurities.mockResolvedValueOnce([
      { id: 's1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', exchange: 'NASDAQ', currencyCode: 'USD', isActive: true, isFavourite: false, skipPriceUpdates: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ]);
    mockSetSecurityFavourite.mockRejectedValueOnce(new Error('boom'));
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('security-list')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('fav-AAPL'));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to update favourite');
    });
    // Reverted back to not-favourite.
    expect(screen.getByTestId('fav-state-AAPL').textContent).toBe('false');
  });

  it('shows singular "security" for count of 1', async () => {
    mockGetSecurities.mockResolvedValue([
      { id: 's1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', exchange: 'NASDAQ', currencyCode: 'USD', isActive: true, skipPriceUpdates: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ]);
    render(<SecuritiesPage />);
    await waitFor(() => {
      expect(screen.getByText(/1 security/i)).toBeInTheDocument();
    });
  });

  it('opens edit modal with security data', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('edit-AAPL')); });
    await waitFor(() => {
      expect(screen.getByText('Edit Security')).toBeInTheDocument();
      expect(screen.getByTestId('editing-security')).toHaveTextContent('AAPL');
    });
  });

  it('creates a security on form submit', async () => {
    mockCreateSecurity.mockResolvedValue({ id: 'new', symbol: 'NEW' });
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByText('+ New Security')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('+ New Security')); });
    await waitFor(() => expect(screen.getByTestId('submit-form')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('submit-form')); });
    await waitFor(() => {
      expect(mockCreateSecurity).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Security created successfully');
    });
  });

  describe('a linked bond security refreshes through the list Refresh', () => {
    const submitNew = async () => {
      mockGetSecurities.mockResolvedValue([
        { id: 'bond1', symbol: 'EDO', name: 'EDO', securityType: 'BOND', exchange: null, currencyCode: 'PLN', isActive: true, skipPriceUpdates: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      ]);
      render(<SecuritiesPage />);
      await waitFor(() => expect(screen.getByText('+ New Security')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByText('+ New Security')); });
      await waitFor(() => expect(screen.getByTestId('submit-form')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('submit-form')); });
    };

    it('refreshes the created security when auto-fetch is on', async () => {
      mockCreateSecurity.mockResolvedValue({ id: 'bond1', symbol: 'EDO' });
      form.payload = { symbol: 'EDO', name: 'EDO', currencyCode: 'PLN', bondProgramId: 'p1', bondAutoFetch: true };
      await submitNew();
      await waitFor(() => expect(mockRefreshSelectedPrices).toHaveBeenCalledWith(['bond1']));
    });

    it('shows the progress bar for the program while that refresh runs, and hides it after', async () => {
      mockCreateSecurity.mockResolvedValue({ id: 'bond1', symbol: 'EDO' });
      let finish!: (v: unknown) => void;
      mockRefreshSelectedPrices.mockReturnValueOnce(new Promise((r) => { finish = r; }));
      form.payload = { symbol: 'EDO', name: 'EDO', currencyCode: 'PLN', bondProgramId: 'p1', bondAutoFetch: true };
      await submitNew();
      await waitFor(() => expect(screen.getByTestId('bond-progress')).toHaveTextContent('p1'));
      await act(async () => { finish({ updated: 1, failed: 0, results: [], lastUpdated: null }); });
      await waitFor(() => expect(screen.queryByTestId('bond-progress')).not.toBeInTheDocument());
    });

    it('shows no progress bar when no bond refresh was triggered', async () => {
      mockCreateSecurity.mockResolvedValue({ id: 'bond1', symbol: 'EDO' });
      form.payload = { symbol: 'EDO', name: 'EDO', currencyCode: 'PLN', bondProgramId: 'p1', bondAutoFetch: false };
      await submitNew();
      await waitFor(() => expect(mockCreateSecurity).toHaveBeenCalled());
      expect(screen.queryByTestId('bond-progress')).not.toBeInTheDocument();
    });

    it('does not refresh when auto-fetch is off', async () => {
      mockCreateSecurity.mockResolvedValue({ id: 'bond1', symbol: 'EDO' });
      form.payload = { symbol: 'EDO', name: 'EDO', currencyCode: 'PLN', bondProgramId: 'p1', bondAutoFetch: false };
      await submitNew();
      await waitFor(() => expect(mockCreateSecurity).toHaveBeenCalled());
      expect(mockRefreshSelectedPrices).not.toHaveBeenCalled();
    });

    it('refreshes an edited security when auto-fetch turns on, not when it was already on', async () => {
      mockUpdateSecurity.mockResolvedValue({ id: 's1', symbol: 'AAPL' });
      form.payload = { symbol: 'AAPL', name: 'Apple', currencyCode: 'USD', bondProgramId: 'p1', bondAutoFetch: true };
      render(<SecuritiesPage />);
      await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('edit-AAPL')); });
      await act(async () => { fireEvent.click(screen.getByTestId('submit-form')); });
      await waitFor(() => expect(mockRefreshSelectedPrices).toHaveBeenCalledWith(['s1']));
    });

    it('does not refresh an edit that leaves a linked auto-fetch security as it was', async () => {
      mockUpdateSecurity.mockResolvedValue({ id: 's1', symbol: 'AAPL' });
      mockGetSecurities.mockResolvedValue([
        { id: 's1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'BOND', exchange: null, currencyCode: 'USD', isActive: true, skipPriceUpdates: false, bondProgramId: 'p1', bondAutoFetch: true, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      ]);
      form.payload = { symbol: 'AAPL', name: 'Apple', currencyCode: 'USD', bondProgramId: 'p1', bondAutoFetch: true };
      render(<SecuritiesPage />);
      await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('edit-AAPL')); });
      await act(async () => { fireEvent.click(screen.getByTestId('submit-form')); });
      await waitFor(() => expect(mockUpdateSecurity).toHaveBeenCalled());
      expect(mockRefreshSelectedPrices).not.toHaveBeenCalled();
    });

    const editLinked = async (stored: Record<string, unknown>, payload: Record<string, unknown>) => {
      mockUpdateSecurity.mockResolvedValue({ id: 's1', symbol: 'AAPL' });
      mockGetSecurities.mockResolvedValue([
        { id: 's1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'BOND', exchange: null, currencyCode: 'USD', isActive: true, skipPriceUpdates: false, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...stored },
      ]);
      form.payload = payload;
      render(<SecuritiesPage />);
      await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('edit-AAPL')); });
      await act(async () => { fireEvent.click(screen.getByTestId('submit-form')); });
    };

    it('refreshes when only auto-fetch is switched on for an already linked security (program omitted)', async () => {
      await editLinked({ bondProgramId: 'p1', bondAutoFetch: false }, { bondAutoFetch: true });
      await waitFor(() => expect(mockRefreshSelectedPrices).toHaveBeenCalledWith(['s1']));
    });

    it('refreshes when only the program changes on a security with auto-fetch on (auto-fetch omitted)', async () => {
      let finish!: (v: unknown) => void;
      mockRefreshSelectedPrices.mockReturnValueOnce(new Promise((r) => { finish = r; }));
      await editLinked({ bondProgramId: 'p1', bondAutoFetch: true }, { bondProgramId: 'p2' });
      await waitFor(() => expect(mockRefreshSelectedPrices).toHaveBeenCalledWith(['s1']));
      await waitFor(() => expect(screen.getByTestId('bond-progress')).toHaveTextContent('p2'));
      await act(async () => { finish({ updated: 1, failed: 0, results: [], lastUpdated: null }); });
    });

    it('does not refresh an edit that sends neither link field', async () => {
      await editLinked({ bondProgramId: 'p1', bondAutoFetch: true }, { name: 'Renamed' });
      await waitFor(() => expect(mockUpdateSecurity).toHaveBeenCalled());
      expect(mockRefreshSelectedPrices).not.toHaveBeenCalled();
    });
  });

  it('updates a security on edit form submit', async () => {
    mockUpdateSecurity.mockResolvedValue({ id: 's1', symbol: 'AAPL' });
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('edit-AAPL')); });
    await waitFor(() => expect(screen.getByTestId('submit-form')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('submit-form')); });
    await waitFor(() => {
      expect(mockUpdateSecurity).toHaveBeenCalledWith('s1', expect.objectContaining({ symbol: 'NEW' }));
      expect(toast.success).toHaveBeenCalledWith('Security updated successfully');
    });
  });

  it('shows error toast when create fails', async () => {
    mockCreateSecurity.mockRejectedValueOnce(new Error('fail'));
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByText('+ New Security')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('+ New Security')); });
    await waitFor(() => expect(screen.getByTestId('submit-form')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('submit-form')); });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to create security');
    });
  });

  it('opens delete confirmation when delete clicked', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('delete-AAPL')); });
    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
      expect(screen.getByTestId('dialog-message')).toHaveTextContent(/AAPL/);
    });
  });

  it('deletes security when confirmed', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('delete-AAPL')); });
    await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('confirm-btn')); });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Security "AAPL" deleted');
    });
  });

  it('cancels delete when cancel button is clicked', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('delete-AAPL')); });
    await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('cancel-btn')); });
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
  });

  it('shows error toast when delete fails', async () => {
    const { investmentsApi } = await import('@/lib/investments');
    (investmentsApi.deleteSecurity as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('delete-AAPL')); });
    await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('confirm-btn')); });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to delete security');
    });
  });

  it('shows what still uses the security, linked, when the delete is refused with 409', async () => {
    const { investmentsApi } = await import('@/lib/investments');
    (investmentsApi.deleteSecurity as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('Conflict'), {
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            errorCode: 'RECORD_IN_USE',
            errors: [{ kind: 'holdings', count: 2 }, { kind: 'bankSyncLinks', count: 1 }],
          },
        },
      }),
    );
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('delete-AAPL')); });
    await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('confirm-btn')); });

    expect(await screen.findByText('Cannot delete "AAPL"')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '2 holdings' })).toHaveAttribute('href', '/securities/s1');
    expect(screen.getByText('1 bank sync link')).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('opens the detail page from the list', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('open-AAPL')); });
    // The price and transaction views live on that page now, not in a modal here.
    expect(mockPush).toHaveBeenCalledWith('/securities/s1');
  });

  it('activates an inactive security when toggled', async () => {
    mockActivateSecurity.mockResolvedValue(undefined);
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Inactive \(1\)/));
    await waitFor(() => expect(screen.getByTestId('security-row-BTC')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('toggle-BTC')); });
    await waitFor(() => {
      expect(mockActivateSecurity).toHaveBeenCalledWith('s3');
      expect(toast.success).toHaveBeenCalledWith('Security activated');
    });
  });

  it('shows toast when deactivating an active security', async () => {
    mockDeactivateSecurity.mockResolvedValue(undefined);
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('toggle-AAPL')); });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Security deactivated');
    });
  });

  it('toggles sort direction when clicking same field', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
    expect(screen.getByTestId('sort-field')).toHaveTextContent('symbol');
    expect(screen.getByTestId('sort-direction')).toHaveTextContent('asc');
    await act(async () => { fireEvent.click(screen.getByTestId('sort-symbol')); });
    await waitFor(() => {
      expect(screen.getByTestId('sort-direction')).toHaveTextContent('desc');
    });
  });

  it('sorts by type', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('sort-type')); });
    await waitFor(() => {
      expect(screen.getByTestId('sort-field')).toHaveTextContent('type');
    });
  });

  it('sorts by exchange', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('sort-exchange')); });
    await waitFor(() => {
      expect(screen.getByTestId('sort-field')).toHaveTextContent('exchange');
    });
  });

  it('sorts by currency', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('sort-currency')); });
    await waitFor(() => {
      expect(screen.getByTestId('sort-field')).toHaveTextContent('currency');
    });
  });

  it('sorts by provider', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('sort-provider')); });
    await waitFor(() => {
      expect(screen.getByTestId('sort-field')).toHaveTextContent('provider');
    });
  });

  it('sorts by source', async () => {
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('sort-source')); });
    await waitFor(() => {
      expect(screen.getByTestId('sort-field')).toHaveTextContent('source');
    });
  });

  it('sorts by value, keeping a security with no price last in both directions', async () => {
    // Two priced securities plus one held position the server could not price.
    // Its value is unknown, so it belongs at neither end of an ascending sort.
    mockGetSecurities.mockResolvedValueOnce([
      { id: 's1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', exchange: 'NASDAQ', currencyCode: 'USD', isActive: true, isFavourite: false, skipPriceUpdates: false, lastPrice: 10, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { id: 's2', symbol: 'XEQT', name: 'iShares Core Equity', securityType: 'ETF', exchange: 'TSX', currencyCode: 'CAD', isActive: true, isFavourite: false, skipPriceUpdates: false, lastPrice: 100, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { id: 's4', symbol: 'ZZZ', name: 'Unpriced Co', securityType: 'STOCK', exchange: 'NYSE', currencyCode: 'USD', isActive: true, isFavourite: false, skipPriceUpdates: false, lastPrice: null, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ]);
    mockGetHoldings.mockResolvedValueOnce([
      { id: 'h1', accountId: 'a1', securityId: 's1', quantity: 10, averageCost: 5, security: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { id: 'h2', accountId: 'a1', securityId: 's2', quantity: 3, averageCost: 90, security: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { id: 'h3', accountId: 'a1', securityId: 's4', quantity: 4, averageCost: 1, security: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ]);
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());

    const rendered = () =>
      screen
        .getAllByTestId(/^security-row-/)
        .map((row) => row.getAttribute('data-testid')!.replace('security-row-', ''));

    await act(async () => { fireEvent.click(screen.getByTestId('sort-value')); });
    await waitFor(() => expect(screen.getByTestId('sort-field')).toHaveTextContent('value'));
    // AAPL is 10 x 10 = 100, XEQT is 3 x 100 = 300, ZZZ has no price at all.
    expect(rendered()).toEqual(['AAPL', 'XEQT', 'ZZZ']);

    await act(async () => { fireEvent.click(screen.getByTestId('sort-value')); });
    await waitFor(() => expect(screen.getByTestId('sort-direction')).toHaveTextContent('desc'));
    expect(rendered()).toEqual(['XEQT', 'AAPL', 'ZZZ']);
  });

  describe('refresh prices', () => {
    it('sits in the page header actions, never in the toolbar row', async () => {
      render(<SecuritiesPage />);
      await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());

      const button = screen.getByRole('button', { name: 'Refresh' });
      expect(screen.getByTestId('page-header')).toContainElement(button);
      const filterRow = screen.getByPlaceholderText('Search by symbol or name...').parentElement!;
      expect(filterRow).not.toContainElement(button);
    });

    it('draws the status filter as the shared segmented control in a wrapping toolbar', async () => {
      render(<SecuritiesPage />);
      await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());

      const group = screen.getByRole('group', { name: 'Status' });
      expect(group.className).toBe(SEGMENTED_TOOLBAR_GROUP_CLASS);
      const active = within(group).getByRole('button', { name: /^Active/ });
      expect(active).toHaveAttribute('aria-pressed', 'true');
      expect(active.className).toBe(toolbarSegmentClass(true));
      expect(group.parentElement!.className).toContain('flex-wrap');
    });

    it('refreshes every eligible security and re-reads the list', async () => {
      render(<SecuritiesPage />);
      await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
      mockGetHoldings.mockClear();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      });

      // The inactive security is not eligible; the two active ones are.
      await waitFor(() =>
        expect(mockRefreshSelectedPrices).toHaveBeenCalledWith(['s1', 's2']),
      );
      // The Value column is `shares x lastPrice`, so prices written by the
      // refresh only reach the screen if the list is read again.
      await waitFor(() => expect(mockGetHoldings).toHaveBeenCalled());
      expect(toast.success).toHaveBeenCalledWith('2 security prices updated');
    });

    it('re-reads the list in the background after an automatic refresh', async () => {
      render(<SecuritiesPage />);
      await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
      mockGetHoldings.mockClear();
      let answer: (rows: unknown) => void = () => {};
      mockGetHoldings.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));

      await act(async () => {
        notifyAutoPriceRefresh('2026-08-31T15:00:00.000Z');
      });

      // The table keeps its rows while the new values load: the refresh is
      // meant to be invisible, and a loading state every 15 minutes is not.
      expect(mockGetHoldings).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('security-list')).toBeInTheDocument();
      expect(toast.success).not.toHaveBeenCalled();
      await act(async () => { answer([]); });
    });

    it('keeps the list and says nothing when the background re-read fails', async () => {
      render(<SecuritiesPage />);
      await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
      mockGetHoldings.mockRejectedValueOnce(new Error('offline'));

      await act(async () => {
        notifyAutoPriceRefresh('2026-08-31T15:00:00.000Z');
      });

      expect(toast.error).not.toHaveBeenCalled();
      expect(screen.getByTestId('security-list')).toBeInTheDocument();
    });

    it('does not let a background re-read land over a newer load', async () => {
      render(<SecuritiesPage />);
      await waitFor(() => expect(screen.getByTestId('security-list')).toBeInTheDocument());
      let answerBackground: (rows: unknown) => void = () => {};
      mockGetSecurities.mockReturnValueOnce(
        new Promise((resolve) => { answerBackground = resolve; }),
      );
      await act(async () => {
        notifyAutoPriceRefresh('2026-08-31T15:00:00.000Z');
      });
      // A reload started after it, as a write's would be, answers first.
      mockGetSecurities.mockResolvedValueOnce([]);
      await act(async () => {
        notifyAutoPriceRefresh('2026-08-31T15:15:00.000Z');
      });
      expect(screen.queryByText('Apple Inc.')).not.toBeInTheDocument();

      await act(async () => {
        answerBackground([
          { id: 's1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', exchange: 'NASDAQ', currencyCode: 'USD', isActive: true, skipPriceUpdates: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
        ]);
      });

      expect(screen.queryByText('Apple Inc.')).not.toBeInTheDocument();
    });

    it('reads the last refresh time on load, for the button to report', async () => {
      render(<SecuritiesPage />);
      await waitFor(() => expect(mockGetPriceStatus).toHaveBeenCalled());
      // The title follows the status response, which lands after the call.
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Refresh' }).getAttribute('title'),
        ).toMatch(/^Last updated:/),
      );
    });
  });

  it('shows pagination when more than page size', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `s${i}`, symbol: `SY${i}`, name: `Sec ${i}`, securityType: 'STOCK',
      exchange: 'NYSE', currencyCode: 'USD', isActive: true, skipPriceUpdates: false,
      createdAt: '2026-01-01', updatedAt: '2026-01-01',
    }));
    mockGetSecurities.mockResolvedValue(many);
    render(<SecuritiesPage />);
    await waitFor(() => expect(screen.getByTestId('pagination')).toBeInTheDocument());
  });

  describe('legacy price deep link', () => {
    it('redirects ?price= to the detail page it now lives on', async () => {
      // Links already sent out -- the dashboard's widgets, a bookmark -- must not
      // land on a page that silently ignores them.
      nav.params = new URLSearchParams('price=s1');
      render(<SecuritiesPage />);

      await waitFor(() =>
        expect(mockReplace).toHaveBeenCalledWith('/securities/s1?tab=prices'),
      );
    });

    it('leaves the list alone without the parameter', async () => {
      nav.params = new URLSearchParams('');
      render(<SecuritiesPage />);
      await waitFor(() =>
        expect(screen.getByTestId('security-list')).toBeInTheDocument(),
      );
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });
});
