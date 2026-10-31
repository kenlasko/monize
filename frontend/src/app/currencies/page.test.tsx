import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, fireEvent, within } from '@/test/render';
import CurrenciesPage from './page';
import { SEGMENTED_TOOLBAR_GROUP_CLASS, toolbarSegmentClass } from '@/components/ui/segmented-control';
import toast from 'react-hot-toast';

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
      local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: false,
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
const mockGetRateStatus = vi.fn();
const mockDeactivateCurrency = vi.fn();
const mockActivateCurrency = vi.fn();

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getCurrencies: (...args: any[]) => mockGetCurrencies(...args),
    getCurrencyUsage: (...args: any[]) => mockGetCurrencyUsage(...args),
    refreshRates: (...args: any[]) => mockRefreshRates(...args),
    getRateStatus: (...args: any[]) => mockGetRateStatus(...args),
    getLatestRates: vi.fn().mockResolvedValue([]),
    createCurrency: vi.fn(),
    updateCurrency: vi.fn(),
    deactivateCurrency: (...args: any[]) => mockDeactivateCurrency(...args),
    activateCurrency: (...args: any[]) => mockActivateCurrency(...args),
    deleteCurrency: vi.fn(),
    lookupCurrency: vi.fn(),
  },
  isFxProviderName: (name: string) => ['frankfurter', 'yahoo'].includes(name),
}));

// Mock useExchangeRates
const mockRefreshHook = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    rates: [],
    rateMap: new Map(),
    isLoading: false,
    convert: vi.fn(),
    convertToDefault: vi.fn(),
    getRate: vi.fn((code: string) => {
      const rates: Record<string, number> = { USD: 1.35, EUR: 1.45 };
      return rates[code] ?? null;
    }),
    refresh: mockRefreshHook,
    defaultCurrency: 'CAD',
  }),
}));

// Mock child components. The form mock exposes a submit button so tests can
// drive handleFormSubmit (create + edit paths). The list mock adds decimals
// and code sort triggers so every sort comparator branch can be exercised.
vi.mock('@/components/currencies/CurrencyForm', () => ({
  CurrencyForm: ({ onSubmit }: any) => (
    <div data-testid="currency-form">
      CurrencyForm
      <button
        data-testid="currency-form-submit"
        onClick={() =>
          onSubmit?.({ code: 'JPY', name: 'Yen', symbol: 'JPY', decimalPlaces: 0 }).catch(
            () => {},
          )
        }
      >
        Submit
      </button>
    </div>
  ),
}));

vi.mock('@/components/currencies/CurrencyList', () => ({
  CurrencyList: ({ currencies, onToggleActive, onEdit, onRateHistory, sortField, sortDirection, onSort }: any) => (
    <div data-testid="currency-list">
      {sortField && <span data-testid="sort-field">{sortField}</span>}
      {sortDirection && <span data-testid="sort-direction">{sortDirection}</span>}
      {onSort && <button data-testid="sort-trigger" onClick={() => onSort('name')}>Sort</button>}
      {onSort && <button data-testid="sort-trigger-symbol" onClick={() => onSort('symbol')}>Sort Symbol</button>}
      {onSort && <button data-testid="sort-trigger-rate" onClick={() => onSort('rate')}>Sort Rate</button>}
      {onSort && <button data-testid="sort-trigger-decimals" onClick={() => onSort('decimals')}>Sort Decimals</button>}
      {onSort && <button data-testid="sort-trigger-code" onClick={() => onSort('code')}>Sort Code</button>}
      {currencies.map((c: any) => (
        <div key={c.code} data-testid={`currency-row-${c.code}`}>
          {c.name}
          <button data-testid={`toggle-${c.code}`} onClick={() => onToggleActive(c)}>Toggle</button>
          <button data-testid={`edit-${c.code}`} onClick={() => onEdit(c)}>Edit</button>
          <button data-testid={`rate-history-${c.code}`} onClick={() => onRateHistory(c)}>Rate history</button>
        </div>
      ))}
    </div>
  ),
  DensityLevel: {},
}));

vi.mock('@/components/currencies/RateHistoryCoverage', () => ({
  RateHistoryCoverage: ({ code, showStoredRates }: { code: string; showStoredRates?: boolean }) => (
    <div data-testid="rate-history-coverage" data-shows-rates={String(!!showStoredRates)}>
      {code}
    </div>
  ),
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
  useLocalStorage: (_key: string, defaultValue: any) => useState(defaultValue),
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
    mockGetRateStatus.mockResolvedValue({
      lastUpdated: '2026-10-12T00:00:00.000Z',
      providers: [{ name: 'yahoo', source: 'yahoo_finance' }],
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

  it('calls getCurrencies with true to fetch all currencies', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(mockGetCurrencies).toHaveBeenCalledWith(true);
    });
  });

  it('calls getCurrencyUsage on mount', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(mockGetCurrencyUsage).toHaveBeenCalled();
    });
  });

  it('filters out inactive currencies by default', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('currency-list')).toBeInTheDocument();
    });
    expect(screen.getByTestId('currency-row-CAD')).toBeInTheDocument();
    expect(screen.getByTestId('currency-row-USD')).toBeInTheDocument();
    expect(screen.queryByTestId('currency-row-EUR')).not.toBeInTheDocument();
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

  it('renders filter buttons for All, Active, Inactive with counts', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByText(/All \(3\)/)).toBeInTheDocument();
      expect(screen.getByText(/Active \(2\)/)).toBeInTheDocument();
      expect(screen.getByText(/Inactive \(1\)/)).toBeInTheDocument();
    });
  });

  it('displays total count text', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      // Only active currencies are shown by default (2 out of 3)
      expect(screen.getByText(/2 currencies/i)).toBeInTheDocument();
    });
  });

  it('shows all currencies when All button is clicked', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('currency-list')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/All \(3\)/));
    await waitFor(() => {
      expect(screen.getByTestId('currency-row-CAD')).toBeInTheDocument();
      expect(screen.getByTestId('currency-row-USD')).toBeInTheDocument();
      expect(screen.getByTestId('currency-row-EUR')).toBeInTheDocument();
    });
  });

  it('shows only inactive currencies when Inactive button is clicked', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('currency-list')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Inactive \(1\)/));
    await waitFor(() => {
      expect(screen.queryByTestId('currency-row-CAD')).not.toBeInTheDocument();
      expect(screen.queryByTestId('currency-row-USD')).not.toBeInTheDocument();
      expect(screen.getByTestId('currency-row-EUR')).toBeInTheDocument();
    });
  });

  it('passes sort props to CurrencyList', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('sort-field')).toHaveTextContent('code');
      expect(screen.getByTestId('sort-direction')).toHaveTextContent('asc');
    });
  });

  it('passes onSort callback to CurrencyList', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('sort-trigger')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('sort-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('sort-field')).toHaveTextContent('name');
    });
  });

  it('renders Refresh Rates button', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByText('Refresh Rates')).toBeInTheDocument();
    });
  });

  it('shows the age of the stored rates on Refresh Rates, with an icon', async () => {
    mockGetRateStatus.mockResolvedValue({
      lastUpdated: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      providers: [],
    });
    render(<CurrenciesPage />);
    const button = await screen.findByRole('button', { name: /Refresh Rates/ });
    await waitFor(() => expect(button).toHaveTextContent(/\(3 hours ago\)/));
    expect(button.querySelector('svg')).not.toBeNull();
    // The age is a line of its own under the label, so it does not widen the
    // button until the subtitle and New Currency wrap.
    const age = within(button).getByText('(3 hours ago)');
    expect(age.parentElement).toBe(within(button).getByText('Refresh Rates').parentElement);
    expect(age.parentElement!.className).toContain('flex-col');
  });

  it('draws the status filter as the shared segmented control in a wrapping toolbar', async () => {
    render(<CurrenciesPage />);
    const group = await screen.findByRole('group', { name: 'Status' });
    expect(group.className).toBe(SEGMENTED_TOOLBAR_GROUP_CLASS);
    const active = within(group).getByRole('button', { name: /^Active/ });
    expect(active).toHaveAttribute('aria-pressed', 'true');
    expect(active.className).toBe(toolbarSegmentClass(true));
    expect(group.parentElement!.className).toContain('flex-wrap');
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

  it('shows success toast after refreshing rates', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByText('Refresh Rates')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Refresh Rates'));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Exchange rates refreshed: 5 pairs updated');
    });
  });

  it('shows success toast with failed count when some rates fail', async () => {
    mockRefreshRates.mockResolvedValueOnce({ updated: 3, failed: 2 });
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByText('Refresh Rates')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Refresh Rates'));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Exchange rates refreshed: 3 updated, 2 failed');
    });
  });

  it('shows an error toast, not a success, when every pair failed', async () => {
    mockRefreshRates.mockResolvedValueOnce({ updated: 0, failed: 4 });
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByText('Refresh Rates')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Refresh Rates'));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'No exchange rates could be fetched; the provider did not answer',
      );
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  describe('the provider line', () => {
    it('names the configured providers in the order they are asked', async () => {
      mockGetRateStatus.mockResolvedValue({
        lastUpdated: null,
        providers: [
          { name: 'frankfurter', source: 'frankfurter' },
          { name: 'yahoo', source: 'yahoo_finance' },
        ],
      });
      render(<CurrenciesPage />);
      expect(await screen.findByTestId('fx-provider-line')).toHaveTextContent(
        'Rates from Frankfurter (ECB reference rates), then Yahoo Finance',
      );
    });

    it('names a Yahoo-only deployment as Yahoo Finance', async () => {
      render(<CurrenciesPage />);
      expect(await screen.findByTestId('fx-provider-line')).toHaveTextContent(
        'Rates from Yahoo Finance',
      );
    });

    it('shows a provider it has no label for by its name', async () => {
      mockGetRateStatus.mockResolvedValue({
        lastUpdated: null,
        providers: [{ name: 'newprovider', source: 'new_provider' }],
      });
      render(<CurrenciesPage />);
      expect(await screen.findByTestId('fx-provider-line')).toHaveTextContent(
        'Rates from newprovider',
      );
    });

    it('omits the line when the status cannot be read', async () => {
      mockGetRateStatus.mockRejectedValue(new Error('down'));
      render(<CurrenciesPage />);
      await waitFor(() => expect(mockGetRateStatus).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByTestId('currency-row-CAD')).toBeInTheDocument());
      expect(screen.queryByTestId('fx-provider-line')).not.toBeInTheDocument();
    });
  });

  it('shows error toast when refresh rates fails', async () => {
    mockRefreshRates.mockRejectedValueOnce(new Error('API error'));
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByText('Refresh Rates')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Refresh Rates'));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to refresh exchange rates');
    });
  });

  it('refreshes hook rates after successful API refresh', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByText('Refresh Rates')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Refresh Rates'));
    await waitFor(() => {
      expect(mockRefreshHook).toHaveBeenCalled();
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

  it('shows loading spinner while data is loading', async () => {
    mockGetCurrencies.mockReturnValue(new Promise(() => {}));
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    });
  });

  it('filters currencies by search query', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('currency-list')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByPlaceholderText('Search by code or name...'), { target: { value: 'Canadian' } });
    await waitFor(() => {
      expect(screen.getByTestId('currency-row-CAD')).toBeInTheDocument();
      expect(screen.queryByTestId('currency-row-USD')).not.toBeInTheDocument();
    });
  });

  it('deactivates a currency when toggle is clicked on active currency', async () => {
    mockDeactivateCurrency.mockResolvedValue(undefined);
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('currency-list')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('toggle-USD'));
    await waitFor(() => {
      expect(mockDeactivateCurrency).toHaveBeenCalledWith('USD');
    });
  });

  it('updates currency state inline after deactivation without reloading', async () => {
    mockDeactivateCurrency.mockResolvedValue(undefined);
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('currency-list')).toBeInTheDocument();
    });

    // Clear mock call counts from initial load
    mockGetCurrencies.mockClear();
    mockGetCurrencyUsage.mockClear();

    fireEvent.click(screen.getByTestId('toggle-USD'));
    await waitFor(() => {
      expect(mockDeactivateCurrency).toHaveBeenCalledWith('USD');
    });

    // Should NOT re-fetch data from API (inline update)
    expect(mockGetCurrencies).not.toHaveBeenCalled();
    expect(mockGetCurrencyUsage).not.toHaveBeenCalled();
  });

  it('updates summary counts after inline deactivation', async () => {
    mockDeactivateCurrency.mockResolvedValue(undefined);
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Active')).toHaveTextContent('2');
      expect(screen.getByTestId('summary-Inactive')).toHaveTextContent('1');
    });

    // Deactivate USD: active goes from 2 to 1, inactive from 1 to 2
    fireEvent.click(screen.getByTestId('toggle-USD'));
    await waitFor(() => {
      expect(screen.getByTestId('summary-Active')).toHaveTextContent('1');
      expect(screen.getByTestId('summary-Inactive')).toHaveTextContent('2');
    });
  });

  it('activates an inactive currency inline', async () => {
    mockActivateCurrency.mockResolvedValue(undefined);
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('currency-list')).toBeInTheDocument();
    });

    // Switch to All view to see inactive EUR
    fireEvent.click(screen.getByText(/All \(3\)/));
    await waitFor(() => {
      expect(screen.getByTestId('currency-row-EUR')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('toggle-EUR'));
    await waitFor(() => {
      expect(mockActivateCurrency).toHaveBeenCalledWith('EUR');
    });

    // Summary should update: active 3, inactive 0
    await waitFor(() => {
      expect(screen.getByTestId('summary-Active')).toHaveTextContent('3');
      expect(screen.getByTestId('summary-Inactive')).toHaveTextContent('0');
    });
  });

  it('does not update state when toggle fails', async () => {
    mockDeactivateCurrency.mockRejectedValue(new Error('API error'));
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('currency-list')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('toggle-USD'));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to update currency status');
    });

    // Summary counts should remain unchanged
    expect(screen.getByTestId('summary-Active')).toHaveTextContent('2');
    expect(screen.getByTestId('summary-Inactive')).toHaveTextContent('1');
  });

  it('shows singular "currency" for count of 1', async () => {
    mockGetCurrencies.mockResolvedValue([
      { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', decimalPlaces: 2, isActive: true, createdAt: '2026-01-01' },
    ]);
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByText(/1 currency/i)).toBeInTheDocument();
    });
  });

  it('shows error toast when loading currencies fails', async () => {
    mockGetCurrencies.mockRejectedValueOnce(new Error('Network error'));
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load currencies');
    });
  });

  it('toggles sort direction when sorting same field twice', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('sort-trigger')).toBeInTheDocument();
    });
    // First click changes sort field to 'name' (from default 'code')
    fireEvent.click(screen.getByTestId('sort-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('sort-field')).toHaveTextContent('name');
      expect(screen.getByTestId('sort-direction')).toHaveTextContent('asc');
    });
    // Second click on same field toggles direction to 'desc'
    fireEvent.click(screen.getByTestId('sort-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('sort-direction')).toHaveTextContent('desc');
    });
  });

  it('shows Refreshing... text while rates are being refreshed', async () => {
    let resolveRefresh!: (v: any) => void;
    mockRefreshRates.mockReturnValue(new Promise((res) => { resolveRefresh = res; }));
    render(<CurrenciesPage />);
    await waitFor(() => expect(screen.getByText('Refresh Rates')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Refresh Rates'));
    await waitFor(() => {
      expect(screen.getByText('Refreshing...')).toBeInTheDocument();
    });
    resolveRefresh({ updated: 1, failed: 0 });
    await waitFor(() => {
      expect(screen.getByText('Refresh Rates')).toBeInTheDocument();
    });
  });

  it('handles null summary from refreshRates', async () => {
    mockRefreshRates.mockResolvedValueOnce(null);
    render(<CurrenciesPage />);
    await waitFor(() => expect(screen.getByText('Refresh Rates')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Refresh Rates'));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Exchange rates refreshed: 0 pairs updated');
    });
  });

  it('sorts by symbol when sort-trigger-symbol is clicked', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => expect(screen.getByTestId('sort-trigger-symbol')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('sort-trigger-symbol'));
    await waitFor(() => {
      expect(screen.getByTestId('sort-field')).toHaveTextContent('symbol');
    });
  });

  it('sorts by rate when sort-trigger-rate is clicked', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => expect(screen.getByTestId('sort-trigger-rate')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('sort-trigger-rate'));
    await waitFor(() => {
      expect(screen.getByTestId('sort-field')).toHaveTextContent('rate');
    });
  });

  it('opens the rate history dialog for the chosen currency', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => expect(screen.getByTestId('currency-row-CAD')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rate-history-CAD'));
    await waitFor(() => {
      expect(screen.getByTestId('modal')).toBeInTheDocument();
      expect(screen.getByTestId('rate-history-coverage')).toHaveTextContent('CAD');
    });
    // The dialog a reader opened to see the rates lists them; the currency
    // form embeds the same panel without the list.
    expect(screen.getByTestId('rate-history-coverage')).toHaveAttribute(
      'data-shows-rates',
      'true',
    );
  });

  it('opens edit modal when edit button is clicked', async () => {
    render(<CurrenciesPage />);
    await waitFor(() => expect(screen.getByTestId('currency-row-CAD')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('edit-CAD'));
    await waitFor(() => {
      expect(screen.getByTestId('modal')).toBeInTheDocument();
      expect(screen.getByText('Edit Currency')).toBeInTheDocument();
    });
  });

});
