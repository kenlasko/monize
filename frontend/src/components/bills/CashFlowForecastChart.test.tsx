import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { CashFlowForecastChart } from './CashFlowForecastChart';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Line: () => <div data-testid="line" />,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />,
  CartesianGrid: () => <div data-testid="cartesian-grid" />,
  Tooltip: () => <div data-testid="tooltip" />,
  ReferenceLine: () => <div data-testid="reference-line" />,
}));

const mockFormatCurrency = vi.fn((n: number, _code?: string) => `$${n.toFixed(2)}`);
const mockFormatCurrencyAxis = vi.fn((n: number, _code?: string) => `$${n}`);

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: mockFormatCurrency,
    formatCurrencyAxis: mockFormatCurrencyAxis,
  }),
}));

const mockConvertToDefault = vi.fn((amount: number, _currency: string) => amount * 1.35);

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: mockConvertToDefault,
    defaultCurrency: 'CAD',
  }),
}));

const mockBuildForecast = vi.fn().mockReturnValue([]);
const mockGetForecastSummary = vi.fn().mockReturnValue({
  startingBalance: 1000,
  endingBalance: 800,
  minBalance: 500,
  goesNegative: false,
});

vi.mock('@/lib/forecast', () => ({
  buildForecast: (...args: any[]) => mockBuildForecast(...args),
  getForecastSummary: (...args: any[]) => mockGetForecastSummary(...args),
  FORECAST_PERIOD_LABELS: {
    week: '1W',
    month: '1M',
    '90days': '90D',
    '6months': '6M',
    year: '1Y',
  },
}));

const makeAccount = (overrides: Record<string, any> = {}) => ({
  id: 'a1',
  name: 'Checking',
  isClosed: false,
  accountType: 'CHEQUING',
  accountSubType: null,
  currencyCode: 'CAD',
  ...overrides,
}) as any;

describe('CashFlowForecastChart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildForecast.mockReturnValue([]);
    mockGetForecastSummary.mockReturnValue({
      startingBalance: 1000,
      endingBalance: 800,
      minBalance: 500,
      goesNegative: false,
    });
  });

  it('renders loading state with title and pulse skeleton', () => {
    render(
      <CashFlowForecastChart scheduledTransactions={[]} accounts={[]} isLoading={true} />
    );
    expect(screen.getByText('Cash Flow Forecast')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders title when not loading', () => {
    render(
      <CashFlowForecastChart scheduledTransactions={[]} accounts={[]} isLoading={false} />
    );
    expect(screen.getByText('Cash Flow Forecast')).toBeInTheDocument();
  });

  it('shows empty state when no data', () => {
    render(
      <CashFlowForecastChart scheduledTransactions={[]} accounts={[]} isLoading={false} />
    );
    expect(screen.getByText('No data to display')).toBeInTheDocument();
    expect(screen.getByText('No accounts found')).toBeInTheDocument();
  });

  it('shows "No scheduled transactions" when accounts exist but no scheduled transactions', () => {
    render(
      <CashFlowForecastChart scheduledTransactions={[]} accounts={[makeAccount()]} isLoading={false} />
    );
    expect(screen.getByText('No scheduled transactions')).toBeInTheDocument();
  });

  it('shows period selector buttons', () => {
    render(
      <CashFlowForecastChart scheduledTransactions={[]} accounts={[]} isLoading={false} />
    );
    expect(screen.getByText('1W')).toBeInTheDocument();
    expect(screen.getByText('1M')).toBeInTheDocument();
    expect(screen.getByText('90D')).toBeInTheDocument();
    expect(screen.getByText('6M')).toBeInTheDocument();
    expect(screen.getByText('1Y')).toBeInTheDocument();
  });

  it('shows All Accounts option in account selector', () => {
    render(
      <CashFlowForecastChart scheduledTransactions={[]} accounts={[]} isLoading={false} />
    );
    expect(screen.getByText('All Accounts')).toBeInTheDocument();
  });

  it('renders chart with forecast data and summary footer', () => {
    const forecastData = [
      { label: 'Today', balance: 1000, transactions: [] },
      { label: 'Tomorrow', balance: 750, transactions: [{ amount: -250, name: 'Bill' }] },
    ];
    mockBuildForecast.mockReturnValue(forecastData);
    mockGetForecastSummary.mockReturnValue({
      startingBalance: 1000,
      endingBalance: 750,
      minBalance: 650,
      goesNegative: false,
    });

    render(
      <CashFlowForecastChart scheduledTransactions={[{} as any]} accounts={[makeAccount()]} isLoading={false} />
    );
    expect(screen.getByText('Starting')).toBeInTheDocument();
    expect(screen.getByText('Ending')).toBeInTheDocument();
    expect(screen.getByText('Min Balance')).toBeInTheDocument();
    expect(screen.getByText('$1000.00')).toBeInTheDocument();
    expect(screen.getByText('$750.00')).toBeInTheDocument();
    expect(screen.getByText('$650.00')).toBeInTheDocument();
  });

  it('shows scheduled transaction count when forecasted transactions exist', () => {
    const forecastData = [
      { label: 'Today', balance: 1000, transactions: [{ amount: -100, name: 'Bill 1' }] },
      { label: 'Tomorrow', balance: 800, transactions: [{ amount: -200, name: 'Bill 2' }] },
    ];
    mockBuildForecast.mockReturnValue(forecastData);

    render(
      <CashFlowForecastChart scheduledTransactions={[{} as any]} accounts={[makeAccount()]} isLoading={false} />
    );
    expect(screen.getByText('2 scheduled transactions in forecast')).toBeInTheDocument();
  });

  it('shows "Lowest" label and warning when forecast goes negative', () => {
    const forecastData = [
      { label: 'Today', balance: 100, transactions: [] },
      { label: 'Tomorrow', balance: -50, transactions: [{ amount: -150, name: 'Big Bill' }] },
    ];
    mockBuildForecast.mockReturnValue(forecastData);
    mockGetForecastSummary.mockReturnValue({
      startingBalance: 100,
      endingBalance: -50,
      minBalance: -50,
      goesNegative: true,
    });

    render(
      <CashFlowForecastChart scheduledTransactions={[{} as any]} accounts={[makeAccount()]} isLoading={false} />
    );
    expect(screen.getByText('Lowest')).toBeInTheDocument();
    expect(screen.getByText('!')).toBeInTheDocument();
  });

  it('shows flat line message when no upcoming transactions in period', () => {
    const forecastData = [
      { label: 'Today', balance: 1000, transactions: [] },
      { label: 'Tomorrow', balance: 1000, transactions: [] },
    ];
    mockBuildForecast.mockReturnValue(forecastData);
    mockGetForecastSummary.mockReturnValue({
      startingBalance: 1000,
      endingBalance: 1000,
      minBalance: 1000,
      goesNegative: false,
    });

    render(
      <CashFlowForecastChart scheduledTransactions={[{} as any]} accounts={[makeAccount()]} isLoading={false} />
    );
    expect(screen.getByText('No upcoming transactions in this period - showing current balance')).toBeInTheDocument();
  });

  it('changes period when period button is clicked', () => {
    render(
      <CashFlowForecastChart scheduledTransactions={[]} accounts={[]} isLoading={false} />
    );
    fireEvent.click(screen.getByText('1W'));
    // buildForecast should be called with 'week' period after state update
    expect(mockBuildForecast).toHaveBeenCalled();
  });

  it('shows accounts in the account selector dropdown', () => {
    const accounts = [
      makeAccount({ id: 'a1', name: 'Checking' }),
      makeAccount({ id: 'a2', name: 'Savings', accountType: 'SAVINGS' }),
    ];

    render(
      <CashFlowForecastChart scheduledTransactions={[]} accounts={accounts} isLoading={false} />
    );
    expect(screen.getByText('Checking')).toBeInTheDocument();
    expect(screen.getByText('Savings')).toBeInTheDocument();
  });

  it('filters out closed and asset/investment accounts from selector', () => {
    const accounts = [
      makeAccount({ id: 'a1', name: 'Checking' }),
      makeAccount({ id: 'a2', name: 'Closed Account', isClosed: true }),
      makeAccount({ id: 'a3', name: 'House', accountType: 'ASSET' }),
      makeAccount({ id: 'a4', name: 'Brokerage', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE' }),
    ];

    render(
      <CashFlowForecastChart scheduledTransactions={[]} accounts={accounts} isLoading={false} />
    );
    expect(screen.getByText('Checking')).toBeInTheDocument();
    expect(screen.queryByText('Closed Account')).not.toBeInTheDocument();
    expect(screen.queryByText('House')).not.toBeInTheDocument();
  });

  it('passes futureTransactions to buildForecast', () => {
    const accounts = [makeAccount()];
    const futureTransactions = [
      { id: 'ft-1', accountId: 'a1', name: 'Future Bill', amount: -500, date: '2026-03-01' },
    ];

    render(
      <CashFlowForecastChart
        scheduledTransactions={[]}
        accounts={accounts}
        futureTransactions={futureTransactions}
        isLoading={false}
      />
    );
    // Verify buildForecast was called with the futureTransactions argument
    expect(mockBuildForecast).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      futureTransactions,
      undefined, // no conversion needed for single-currency
    );
  });

  it('defaults futureTransactions to empty array when not provided', () => {
    const accounts = [makeAccount()];

    render(
      <CashFlowForecastChart scheduledTransactions={[]} accounts={accounts} isLoading={false} />
    );
    // buildForecast should be called with empty array for futureTransactions
    expect(mockBuildForecast).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      [],
      undefined, // no conversion needed for single-currency
    );
  });

  describe('currency-aware formatting', () => {
    it('uses account currency for single-currency accounts', () => {
      mockFormatCurrency.mockClear();
      const accounts = [makeAccount({ currencyCode: 'USD' })];

      const forecastData = [
        { label: 'Today', balance: 1000, transactions: [] },
        { label: 'Tomorrow', balance: 800, transactions: [{ amount: -200, name: 'Bill' }] },
      ];
      mockBuildForecast.mockReturnValue(forecastData);
      mockGetForecastSummary.mockReturnValue({
        startingBalance: 1000,
        endingBalance: 800,
        minBalance: 800,
        goesNegative: false,
      });

      render(
        <CashFlowForecastChart scheduledTransactions={[{} as any]} accounts={accounts} isLoading={false} />
      );

      // Summary footer calls formatCurrencyCompact with the account's currency
      const usdCalls = mockFormatCurrency.mock.calls.filter(
        ([, code]) => code === 'USD',
      );
      expect(usdCalls.length).toBeGreaterThan(0);
    });

    it('uses default currency when accounts have mixed currencies', () => {
      mockFormatCurrency.mockClear();
      const accounts = [
        makeAccount({ id: 'a1', currencyCode: 'USD' }),
        makeAccount({ id: 'a2', name: 'Euro Account', currencyCode: 'EUR' }),
      ];

      const forecastData = [
        { label: 'Today', balance: 2700, transactions: [] },
        { label: 'Tomorrow', balance: 2500, transactions: [{ amount: -200, name: 'Bill' }] },
      ];
      mockBuildForecast.mockReturnValue(forecastData);
      mockGetForecastSummary.mockReturnValue({
        startingBalance: 2700,
        endingBalance: 2500,
        minBalance: 2500,
        goesNegative: false,
      });

      render(
        <CashFlowForecastChart scheduledTransactions={[{} as any]} accounts={accounts} isLoading={false} />
      );

      // With mixed currencies, should format in default currency (CAD)
      const cadCalls = mockFormatCurrency.mock.calls.filter(
        ([, code]) => code === 'CAD',
      );
      expect(cadCalls.length).toBeGreaterThan(0);
    });

    it('passes convertToDefault to buildForecast when currencies are mixed', () => {
      const accounts = [
        makeAccount({ id: 'a1', currencyCode: 'USD' }),
        makeAccount({ id: 'a2', name: 'Euro Account', currencyCode: 'EUR' }),
      ];

      render(
        <CashFlowForecastChart scheduledTransactions={[]} accounts={accounts} isLoading={false} />
      );

      // Should pass the conversion function as 6th argument
      expect(mockBuildForecast).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        mockConvertToDefault,
      );
    });

    it('does not pass convertToDefault when all accounts share one currency', () => {
      const accounts = [
        makeAccount({ id: 'a1', currencyCode: 'USD' }),
        makeAccount({ id: 'a2', name: 'Savings', currencyCode: 'USD' }),
      ];

      render(
        <CashFlowForecastChart scheduledTransactions={[]} accounts={accounts} isLoading={false} />
      );

      // Should pass undefined as 6th argument (no conversion needed)
      expect(mockBuildForecast).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        undefined,
      );
    });
  });
});
