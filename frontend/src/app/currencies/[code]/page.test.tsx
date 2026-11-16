import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@/test/render';
import CurrencyDetailPage from './page';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { UserPreferences } from '@/types/auth';
import type {
  CurrencyInfo,
  CurrencyUsageSummary,
  StoredRateList,
  TransactionRateList,
} from '@/lib/exchange-rates';

const mockPush = vi.fn();
/** Mutable so a test can open the page on another currency. */
const routeParams = { current: { code: 'eur' } as { code: string } };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  usePathname: () => `/currencies/${routeParams.current.code}`,
  useParams: () => routeParams.current,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      const state = {
        user: { id: 'user-1', email: 'test@example.com', role: 'user', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        logout: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    {
      getState: vi.fn(() => ({
        user: { id: 'user-1', email: 'test@example.com', role: 'user' },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
      })),
    },
  ),
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_e: unknown, fallback: string) => fallback),
}));

const mockGetCurrencies = vi.fn();
const mockGetUsage = vi.fn();
const mockGetStoredRates = vi.fn();
const mockGetTransactionRates = vi.fn();
const mockGetRateCoverage = vi.fn();
const mockFillRateGaps = vi.fn();

vi.mock('@/lib/exchange-rates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/exchange-rates')>()),
  exchangeRatesApi: {
    getCurrencies: (...args: unknown[]) => mockGetCurrencies(...args),
    getCurrencyUsageSummary: (...args: unknown[]) => mockGetUsage(...args),
    getStoredRates: (...args: unknown[]) => mockGetStoredRates(...args),
    getTransactionRates: (...args: unknown[]) => mockGetTransactionRates(...args),
    getRateCoverage: (...args: unknown[]) => mockGetRateCoverage(...args),
    fillRateGaps: (...args: unknown[]) => mockFillRateGaps(...args),
    getLatestRates: () => Promise.resolve([]),
  },
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const currency = (code: string, name: string): CurrencyInfo => ({
  code,
  name,
  symbol: code === 'EUR' ? '€' : '$',
  decimalPlaces: 2,
  isActive: true,
  isSystem: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  kind: 'FIAT',
  quoteSymbol: null,
});

const usage = (code: string): CurrencyUsageSummary => ({
  code,
  reportingCurrency: 'CAD',
  transactionCount: 4,
  firstTransactionDate: '2024-05-01',
  lastTransactionDate: '2026-03-20',
  totalInCurrency: 440,
  totalInReportingCurrency: 664,
  knownReportingSubtotal: 664,
  unconvertedCount: 0,
  missingPairs: [],
});

const stored: StoredRateList = {
  from: 'EUR',
  to: 'CAD',
  rates: [
    { rateDate: '2026-03-20', rate: 1.6, source: 'frankfurter', inverted: false },
    { rateDate: '2026-03-19', rate: 1.55, source: 'yahoo_finance', inverted: false },
  ],
  truncated: false,
  limit: 2000,
};

const transactionRates: TransactionRateList = {
  code: 'EUR',
  reportingCurrency: 'CAD',
  rates: [
    {
      transactionId: 'tx-1',
      rateDate: '2026-03-19',
      rate: 1.5,
      kind: 'foreignEntry',
      accountName: 'CAD Chequing',
      payeeName: 'Hotel',
      // 1.5 against 1.55 is a spread of 3.23%.
      marketRate: 1.55,
    },
  ],
  truncated: true,
  limit: 2000,
};

async function renderPage() {
  await act(async () => {
    render(<CurrencyDetailPage />);
  });
}

describe('CurrencyDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // The fixtures' dates are fixed, so the period is too: the default year
    // window ends today and would leave them behind.
    localStorage.setItem('currencyDetail:range:EUR', JSON.stringify({ dateRange: 'all' }));
    usePreferencesStore.setState({
      preferences: { defaultCurrency: 'CAD' } as UserPreferences,
    });
    routeParams.current = { code: 'eur' };
    mockGetCurrencies.mockResolvedValue([currency('CAD', 'Canadian Dollar'), currency('EUR', 'Euro')]);
    mockGetUsage.mockImplementation((code: string) => Promise.resolve(usage(code)));
    mockGetStoredRates.mockResolvedValue(stored);
    mockGetTransactionRates.mockResolvedValue(transactionRates);
    mockGetRateCoverage.mockResolvedValue({
      from: 'EUR',
      to: 'CAD',
      earliestDate: '2026-03-19',
      latestDate: '2026-03-20',
      observations: 2,
    });
    mockFillRateGaps.mockResolvedValue({
      from: 'EUR',
      to: 'CAD',
      usedFrom: '2024-05-01',
      spanEnd: '2026-03-20',
      unresolvableDays: 0,
      sparseDays: 0,
      windowsPlanned: 1,
      windowsFetched: 1,
      windowsSkipped: 0,
      windowsUnanswered: 0,
      windowsRemaining: 0,
      stored: 240,
      earliestDate: '2024-05-01',
      providerHasNothingBefore: null,
    });
  });

  it('shows the currency, its figures, the chart and the rate history', async () => {
    await renderPage();

    expect(mockGetUsage).toHaveBeenCalledWith('EUR');
    expect(mockGetStoredRates).toHaveBeenCalledWith('EUR');
    expect(mockGetTransactionRates).toHaveBeenCalledWith('EUR');
    expect(screen.getByRole('heading', { level: 1, name: 'EUR · Euro' })).toBeInTheDocument();
    expect(screen.getByText('Total in EUR')).toBeInTheDocument();
    expect(screen.getByText('1 EUR = 1.600000 CAD')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Exchange Rate' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rate History' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All (3)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Transactions (1)' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Showing the rates of your 2,000 most recent transactions; older ones are not listed.',
      ),
    ).toBeInTheDocument();
  });

  it('shows how many rates are stored and over which dates, with a way to fill the gaps', async () => {
    await renderPage();

    // A section of the page, beside Rate History, not a sub-heading of it.
    expect(screen.getByRole('heading', { level: 2, name: 'Stored Rates' })).toBeInTheDocument();
    expect(mockGetRateCoverage).toHaveBeenCalledWith('EUR');
    expect(screen.getByText(/Stored history:/)).toHaveTextContent('2 observations');
    expect(screen.getByRole('button', { name: 'Fill gaps in rate history' })).toBeInTheDocument();
  });

  it('re-reads the chart and the table after a fill stored rates', async () => {
    await renderPage();
    mockGetStoredRates.mockResolvedValue({
      ...stored,
      rates: [
        ...stored.rates,
        { rateDate: '2026-03-18', rate: 1.52, source: 'frankfurter', inverted: false },
      ],
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fill gaps in rate history' }));
    });

    expect(mockFillRateGaps).toHaveBeenCalledWith('EUR');
    await waitFor(() => expect(mockGetStoredRates).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'All (4)' })).toBeInTheDocument();
  });

  it('keeps the chosen source filter across the re-read after a fill', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Transactions (1)' }));
    expect(screen.getByRole('button', { name: 'Transactions (1)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fill gaps in rate history' }));
    });

    await waitFor(() => expect(mockGetStoredRates).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Transactions (1)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('keeps a fill that finishes after a currency switch from blanking the new currency', async () => {
    let releaseFill: (value: unknown) => void = () => {};
    mockGetCurrencies.mockResolvedValue([
      currency('CAD', 'Canadian Dollar'),
      currency('EUR', 'Euro'),
      currency('USD', 'US Dollar'),
    ]);
    mockFillRateGaps.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFill = resolve;
        }),
    );
    let rerender: (ui: React.ReactElement) => void = () => {};
    await act(async () => {
      ({ rerender } = render(<CurrencyDetailPage />));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fill gaps in rate history' }));
    });

    routeParams.current = { code: 'usd' };
    await act(async () => {
      rerender(<CurrencyDetailPage />);
    });
    expect(screen.getByRole('heading', { level: 1, name: 'USD · US Dollar' })).toBeInTheDocument();
    const storedReads = mockGetStoredRates.mock.calls.length;

    // The EUR fill lands on the USD page.
    await act(async () => {
      releaseFill({
        from: 'EUR',
        to: 'CAD',
        usedFrom: '2024-05-01',
        spanEnd: '2026-03-20',
        unresolvableDays: 0,
        sparseDays: 0,
        windowsPlanned: 1,
        windowsFetched: 1,
        windowsSkipped: 0,
        windowsUnanswered: 0,
        windowsRemaining: 0,
        stored: 240,
        earliestDate: '2024-05-01',
        providerHasNothingBefore: null,
      });
    });

    expect(mockGetStoredRates.mock.calls.length).toBe(storedReads);
    expect(screen.queryByText('Loading exchange rates...')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rate History' })).toBeInTheDocument();
  });

  it('counts the rates of the selected period and averages the spread of its transactions', async () => {
    await renderPage();

    const rates = screen.getByRole('article', { name: 'Rates in Period' });
    expect(rates).toHaveTextContent('Rates in Period303/19/2026 to 03/20/2026');
    expect(screen.getByRole('article', { name: 'Average Spread' })).toHaveTextContent('3.23%');
  });

  it('narrows the chart, the table and the period figures to the selected period', async () => {
    localStorage.setItem('currencyDetail:range:EUR', JSON.stringify({ dateRange: '1m' }));
    mockGetStoredRates.mockResolvedValue({
      ...stored,
      rates: [
        ...stored.rates,
        // Years before any one-month window.
        { rateDate: '2015-06-01', rate: 1.45, source: 'frankfurter', inverted: false },
      ],
    });
    mockGetTransactionRates.mockResolvedValue({ ...transactionRates, truncated: false });
    await renderPage();

    // Every fixture date is outside a month ending today.
    expect(screen.getByRole('heading', { name: 'Rate History' })).toBeInTheDocument();
    expect(screen.getByText('No exchange rates in this period', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByText('No rates in this period')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^All$/ }));
    });
    expect(screen.getByRole('button', { name: 'All (4)' })).toBeInTheDocument();
  });

  it('goes back to the list', async () => {
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Back to Currencies' }));
    expect(mockPush).toHaveBeenCalledWith('/currencies');
  });

  it('asks for no rate history on the default currency page', async () => {
    routeParams.current = { code: 'CAD' };
    await renderPage();

    expect(
      screen.getByText(
        'CAD is your default currency. Every other currency is converted into it, so it has no exchange rate of its own.',
      ),
    ).toBeInTheDocument();
    expect(mockGetStoredRates).not.toHaveBeenCalled();
    expect(mockGetTransactionRates).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Rate History' })).not.toBeInTheDocument();
  });

  it('keeps the figures when the rate history fails, and retries it', async () => {
    mockGetTransactionRates.mockRejectedValueOnce(new Error('boom'));
    await renderPage();

    expect(screen.getByText('Total in EUR')).toBeInTheDocument();
    expect(screen.getByText('Failed to load exchange rate history')).toBeInTheDocument();
    // A failed read is not "no rates".
    expect(screen.queryByText('No exchange rates yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Latest Rate')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    });
    expect(screen.queryByText('Failed to load exchange rate history')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rate History' })).toBeInTheDocument();
  });

  it('shows a load failure with a way to try again', async () => {
    mockGetUsage.mockRejectedValueOnce(new Error('boom'));
    await renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load currency');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    });
    expect(screen.getByRole('heading', { level: 1, name: 'EUR · Euro' })).toBeInTheDocument();
  });

  it('says so for a currency the reader does not have', async () => {
    routeParams.current = { code: 'XYZ' };
    await renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent('Currency XYZ was not found');
  });
});
