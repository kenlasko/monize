import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { CashFlowForecastChart } from './CashFlowForecastChart';

// The recharts mock invokes the Area `dot` render-prop and the Tooltip
// `content` render-prop so the SVG min-balance callout and the tooltip
// transaction-overflow branch are exercised by the data-driven tests below.
// The render-prop output is exposed via test ids those tests opt into;
// existing assertions are unaffected since the chart only renders when
// forecast data is present.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  Area: ({ dot, fill, stroke }: any) => (
    <div data-testid="area" data-fill={fill} data-stroke={stroke}>
      {typeof dot === 'function' && (
        <svg data-testid="line-dots">
          {dot({ cx: 50, cy: 60, index: 0 })}
          {dot({ cx: 70, cy: 80, index: 1 })}
        </svg>
      )}
    </div>
  ),
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Line: () => <div data-testid="line" />,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: ({ tickFormatter }: any) => (
    <div data-testid="y-axis">{tickFormatter ? tickFormatter(2000) : null}</div>
  ),
  CartesianGrid: () => <div data-testid="cartesian-grid" />,
  Tooltip: ({ content }: any) => {
    // The component passes `content={<CashFlowTooltip formatCurrency={...} />}`
    // (a JSX element), so render its component type, merging the element's own
    // props (e.g. formatCurrency) with sample tooltip data props.
    const Comp = content?.type;
    const tooltipProps = {
      active: true,
      payload: [
        {
          payload: {
            date: '2025-01-15',
            balance: -150,
            transactions: [
              { name: 'Rent', amount: -1000 },
              { name: 'Pay', amount: 3000 },
              { name: 'A', amount: -1 },
              { name: 'B', amount: -2 },
              { name: 'C', amount: -3 },
              { name: 'D', amount: -4 },
            ],
          },
        },
      ],
    };
    return (
      <div data-testid="tooltip">
        {Comp ? <Comp {...content.props} {...tooltipProps} /> : null}
      </div>
    );
  },
  ReferenceLine: () => <div data-testid="reference-line" />,
}));

const mockFormatCurrency = vi.fn((n: number, _code?: string) => `$${n.toFixed(2)}`);
const mockFormatCurrencyAxis = vi.fn((n: number, _code?: string) => `$${n}`);
const mockFormatCurrencyFlag = vi.fn((n: number, _code?: string) => `$${n}`);

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: mockFormatCurrency,
    formatCurrencyAxis: mockFormatCurrencyAxis,
    formatCurrencyFlag: mockFormatCurrencyFlag,
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

  it('lists favourite accounts above non-favourites in the account selector', () => {
    const accounts = [
      makeAccount({ id: 'a1', name: 'Apple', isFavourite: false }),
      makeAccount({ id: 'a2', name: 'Zebra', isFavourite: true, favouriteSortOrder: 0 }),
    ];
    render(
      <CashFlowForecastChart scheduledTransactions={[]} accounts={accounts} isLoading={false} />
    );
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels[0]).toBe('All Accounts');
    expect(labels.indexOf('Zebra')).toBeLessThan(labels.indexOf('Apple'));
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

  describe('chart render-prop and tooltip branches', () => {
    it('marks the highest and lowest forecast points with value bubbles', () => {
      const forecastData = [
        { label: 'Day 1', balance: 1000, transactions: [{ amount: 0, name: 'Open' }] },
        { label: 'Day 2', balance: -150, transactions: [{ amount: -1150, name: 'Rent' }] },
      ];
      mockBuildForecast.mockReturnValue(forecastData);
      mockGetForecastSummary.mockReturnValue({
        startingBalance: 1000,
        endingBalance: -150,
        minBalance: -150,
        goesNegative: true,
      });
      render(
        <CashFlowForecastChart
          scheduledTransactions={[{} as any]}
          accounts={[makeAccount()]}
          isLoading={false}
        />,
      );
      // The mocked Area invokes the dot render-prop for both points: the high
      // (1000) and low (-150) each draw a callout group with the formatted
      // label text.
      const dots = screen.getByTestId('line-dots');
      const labels = Array.from(dots.querySelectorAll('text')).map((node) => node.textContent);
      expect(labels).toContain('$1000');
      expect(labels).toContain('$-150');
    });

    it('temporarily hides a value bubble when its dismiss control is clicked', () => {
      const forecastData = [
        { label: 'Day 1', balance: 1000, transactions: [{ amount: 0, name: 'Open' }] },
        { label: 'Day 2', balance: -150, transactions: [{ amount: -1150, name: 'Rent' }] },
      ];
      mockBuildForecast.mockReturnValue(forecastData);
      mockGetForecastSummary.mockReturnValue({
        startingBalance: 1000,
        endingBalance: -150,
        minBalance: -150,
        goesNegative: true,
      });
      const { container } = render(
        <CashFlowForecastChart
          scheduledTransactions={[{} as any]}
          accounts={[makeAccount()]}
          isLoading={false}
        />,
      );
      const labels = () =>
        Array.from(
          container.querySelectorAll('[data-testid="line-dots"] text'),
        ).map((node) => node.textContent);
      expect(labels()).toEqual(expect.arrayContaining(['$1000', '$-150']));

      // The dot mock renders index 0 (high, $1000) first, so the first dismiss
      // control belongs to the high bubble.
      const closeControls = container.querySelectorAll('.chart-flag-dismiss');
      expect(closeControls).toHaveLength(2);
      fireEvent.click(closeControls[0]);

      expect(labels()).toContain('$-150');
      expect(labels()).not.toContain('$1000');
    });

    it('formats the bubble labels with the compact flag formatter', () => {
      const forecastData = [
        { label: 'Day 1', balance: 60000, transactions: [{ amount: 0, name: 'Open' }] },
        { label: 'Day 2', balance: 5000, transactions: [{ amount: -55000, name: 'Bill' }] },
      ];
      mockBuildForecast.mockReturnValue(forecastData);
      mockGetForecastSummary.mockReturnValue({
        startingBalance: 60000,
        endingBalance: 5000,
        minBalance: 5000,
        goesNegative: false,
      });
      mockFormatCurrencyFlag.mockClear();
      render(
        <CashFlowForecastChart
          scheduledTransactions={[{} as any]}
          accounts={[makeAccount()]}
          isLoading={false}
        />,
      );
      expect(screen.getByTestId('line-dots')).toBeInTheDocument();
      // The high/low bubbles are labelled via the compact flag formatter.
      expect(mockFormatCurrencyFlag).toHaveBeenCalled();
    });

    it('shades the area under the line with the zero-anchored balance gradient', () => {
      const forecastData = [
        { label: 'Day 1', balance: 1000, transactions: [{ amount: 0, name: 'Open' }] },
        { label: 'Day 2', balance: -150, transactions: [{ amount: -1150, name: 'Rent' }] },
      ];
      mockBuildForecast.mockReturnValue(forecastData);
      mockGetForecastSummary.mockReturnValue({
        startingBalance: 1000,
        endingBalance: -150,
        minBalance: -150,
        goesNegative: true,
      });
      render(
        <CashFlowForecastChart
          scheduledTransactions={[{} as any]}
          accounts={[makeAccount()]}
          isLoading={false}
        />,
      );
      const area = screen.getByTestId('area');
      expect(area.getAttribute('data-fill')).toBe('url(#forecastBalance)');
      expect(area.getAttribute('data-stroke')).toBe('var(--chart-primary)');
    });

    it('renders the tooltip content with a transaction overflow indicator', () => {
      const forecastData = [
        { label: 'Day 1', balance: 1000, transactions: [{ amount: -100, name: 'Bill' }] },
        { label: 'Day 2', balance: 800, transactions: [{ amount: -200, name: 'Bill 2' }] },
      ];
      mockBuildForecast.mockReturnValue(forecastData);
      mockGetForecastSummary.mockReturnValue({
        startingBalance: 1000,
        endingBalance: 800,
        minBalance: 800,
        goesNegative: false,
      });
      render(
        <CashFlowForecastChart
          scheduledTransactions={[{} as any]}
          accounts={[makeAccount()]}
          isLoading={false}
        />,
      );
      // The mocked Tooltip renders content with 6 transactions, so the
      // "+1 more" overflow line (component lines ~78-83) renders.
      expect(screen.getByText(/\+1 more/)).toBeInTheDocument();
      // The tooltip date is localized from the data point's `date` via
      // useChartDateFormat; '2025-01-15' renders as "Jan 15" in the default locale.
      expect(screen.getByText('Jan 15')).toBeInTheDocument();
    });
  });
});
