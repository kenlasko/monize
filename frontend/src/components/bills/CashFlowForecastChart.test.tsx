import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { CashFlowForecastChart } from './CashFlowForecastChart';

// The recharts mock invokes the Area `dot` render-prop and the Tooltip
// `content` render-prop so the SVG min-balance callout and the tooltip
// transaction-overflow branch are exercised by the data-driven tests below.
// The render-prop output is exposed via test ids those tests opt into;
// existing assertions are unaffected since the chart only renders when
// forecast data is present.
//
// `charts.tooltipPoint` is the data point the mocked Tooltip feeds to the
// component's own tooltip. A multi-account test swaps it for a point carrying
// `balances` so the per-account rows are exercised with real values.
const charts = vi.hoisted(() => ({
  tooltipPoint: null as any,
}));

const DEFAULT_TOOLTIP_POINT = {
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
};

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  ComposedChart: ({ children }: any) => <div data-testid="composed-chart">{children}</div>,
  Area: ({ dot, fill, stroke, name }: any) => (
    <div data-testid="area" data-fill={fill} data-stroke={stroke} data-name={name}>
      {typeof dot === 'function' && (
        <svg data-testid="line-dots">
          {dot({ cx: 50, cy: 60, index: 0 })}
          {dot({ cx: 70, cy: 80, index: 1 })}
        </svg>
      )}
    </div>
  ),
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Line: ({ dataKey, name, stroke, fill }: any) => (
    <div
      data-testid="line"
      data-key={dataKey}
      data-name={name}
      data-stroke={stroke}
      data-fill={fill}
    />
  ),
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
      payload: [{ payload: charts.tooltipPoint }],
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

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: mockFormatCurrency,
      formatCurrencyAxis: mockFormatCurrencyAxis,
      formatCurrencyFlag: mockFormatCurrencyFlag,
    }),
  };
});
const mockConvertToDefault = vi.fn((amount: number, _currency: string) => amount * 1.35);

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: mockConvertToDefault,
    defaultCurrency: 'CAD',
  }),
}));

// `buildForecast` returns `{ points, missingCurrencies }`: a projected balance is
// cumulative, so one unconvertible leg withholds the whole series. `forecastOf`
// keeps these tests writing the series and nothing else.
const forecastOf = (points: any[], missingCurrencies: string[] = []) => ({
  points,
  missingCurrencies,
});
/** The multi-account shape: the same envelope plus the per-account series. */
const multiForecastOf = (
  points: any[],
  series: any[] = [],
  missingCurrencies: string[] = [],
) => ({ points, series, missingCurrencies });
const mockBuildForecast = vi.fn().mockReturnValue(forecastOf([]));
const mockBuildMultiAccountForecast = vi.fn().mockReturnValue(multiForecastOf([]));
const mockGetForecastSummary = vi.fn().mockReturnValue({
  startingBalance: 1000,
  endingBalance: 800,
  minBalance: 500,
  goesNegative: false,
});

// The builders are mocked; the tooltip's overdue count is the real helper, so
// a point the mocks hand over is counted the way the chart counts it.
vi.mock('@/lib/forecast', async (importOriginal) => ({
  countOverdueOccurrences: (await importOriginal<typeof import('@/lib/forecast')>())
    .countOverdueOccurrences,
  buildForecast: (...args: any[]) => mockBuildForecast(...args),
  buildMultiAccountForecast: (...args: any[]) => mockBuildMultiAccountForecast(...args),
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

/**
 * The account picker is a checkbox list behind a trigger, so its options exist
 * only while it is open.
 */
const openAccountPicker = () => {
  fireEvent.click(screen.getByLabelText('Accounts to forecast'));
};

const accountOptionLabels = () =>
  Array.from(document.querySelectorAll('input[type="checkbox"]')).map(
    (input) => input.closest('label')?.textContent ?? '',
  );

const toggleAccount = (name: string) => {
  const option = Array.from(document.querySelectorAll('label')).find(
    (label) => label.textContent === name,
  );
  if (!option) throw new Error(`No account option labelled "${name}"`);
  fireEvent.click(option.querySelector('input') as HTMLInputElement);
};

describe('CashFlowForecastChart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    charts.tooltipPoint = DEFAULT_TOOLTIP_POINT;
    mockBuildForecast.mockReturnValue(forecastOf([]));
    mockBuildMultiAccountForecast.mockReturnValue(multiForecastOf([]));
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

  it('shows All Accounts when nothing is selected', () => {
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
    openAccountPicker();
    const labels = accountOptionLabels();
    expect(labels.indexOf('Zebra')).toBeLessThan(labels.indexOf('Apple'));
  });

  // `buildAccountDropdownOptions` puts a disabled rule between favourites and
  // the rest. A `<select>` can render that; a checkbox list would turn it into
  // a selectable account made of box-drawing characters.
  it('does not offer the favourites separator as a selectable account', () => {
    const accounts = [
      makeAccount({ id: 'a1', name: 'Apple', isFavourite: false }),
      makeAccount({ id: 'a2', name: 'Zebra', isFavourite: true, favouriteSortOrder: 0 }),
    ];
    render(
      <CashFlowForecastChart scheduledTransactions={[]} accounts={accounts} isLoading={false} />
    );
    openAccountPicker();
    expect(accountOptionLabels()).toEqual(['Zebra', 'Apple']);
  });

  it('renders chart with forecast data and summary footer', () => {
    const forecastData = [
      { label: 'Today', balance: 1000, transactions: [] },
      { label: 'Tomorrow', balance: 750, transactions: [{ amount: -250, name: 'Bill' }] },
    ];
    mockBuildForecast.mockReturnValue(forecastOf(forecastData));
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
    mockBuildForecast.mockReturnValue(forecastOf(forecastData));

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
    mockBuildForecast.mockReturnValue(forecastOf(forecastData));
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
    mockBuildForecast.mockReturnValue(forecastOf(forecastData));
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
    openAccountPicker();
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
    openAccountPicker();
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
      mockBuildForecast.mockReturnValue(forecastOf(forecastData));
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
      mockBuildForecast.mockReturnValue(forecastOf(forecastData));
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
      mockBuildForecast.mockReturnValue(forecastOf(forecastData));
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
      mockBuildForecast.mockReturnValue(forecastOf(forecastData));
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
      mockBuildForecast.mockReturnValue(forecastOf(forecastData));
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
      mockBuildForecast.mockReturnValue(forecastOf(forecastData));
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
      mockBuildForecast.mockReturnValue(forecastOf(forecastData));
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

  /**
   * The chart used to draw whatever `buildForecast` produced. With a missing
   * rate that was a line starting from only the accounts that converted -- an
   * ordinary-looking projection understated by a whole account, with nothing on
   * screen to say so.
   */
  describe('when a rate is missing', () => {
    it('says so instead of drawing a line', () => {
      mockBuildForecast.mockReturnValue(forecastOf([], ['EUR']));
      render(
        <CashFlowForecastChart
          accounts={[makeAccount()] as any}
          scheduledTransactions={[]}
          isLoading={false}
        />,
      );

      expect(screen.getByRole('alert')).toHaveTextContent(
        'no exchange rate is available for EUR',
      );
    });

    it('names every currency it could not convert', () => {
      mockBuildForecast.mockReturnValue(forecastOf([], ['EUR', 'GBP']));
      render(
        <CashFlowForecastChart
          accounts={[makeAccount()] as any}
          scheduledTransactions={[]}
          isLoading={false}
        />,
      );

      expect(screen.getByRole('alert')).toHaveTextContent('EUR, GBP');
    });

    // An empty forecast with no missing rates is the ordinary "nothing to show"
    // case and must keep its own empty state.
    it('keeps the normal empty state when nothing is missing', () => {
      mockBuildForecast.mockReturnValue(forecastOf([]));
      render(
        <CashFlowForecastChart
          accounts={[makeAccount()] as any}
          scheduledTransactions={[]}
          isLoading={false}
        />,
      );

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  /**
   * Selecting more than one account draws a line per account plus the total
   * they sum to. The total keeps the single-account filled area so the shape
   * the page has always had still means the same thing; the members are plain
   * unfilled lines, because a stack of translucent fills reads as an area chart
   * of parts rather than as several independent balances.
   */
  describe('multiple selected accounts', () => {
    const twoAccounts = [
      makeAccount({ id: 'a1', name: 'Checking' }),
      makeAccount({ id: 'a2', name: 'Savings', accountType: 'SAVINGS' }),
    ];

    const multiPoints = [
      { date: '2025-01-15', balance: 1500, balances: { a1: 1000, a2: 500 }, transactions: [] },
      {
        date: '2025-01-16',
        balance: 1300,
        balances: { a1: 800, a2: 500 },
        transactions: [{ name: 'Bill', amount: -200, accountId: 'a1' }],
      },
    ];
    const twoSeries = [
      { accountId: 'a1', name: 'Checking' },
      { accountId: 'a2', name: 'Savings' },
    ];

    const renderWithBothSelected = () => {
      mockBuildMultiAccountForecast.mockReturnValue(multiForecastOf(multiPoints, twoSeries));
      const result = render(
        <CashFlowForecastChart
          scheduledTransactions={[{} as any]}
          accounts={twoAccounts}
          isLoading={false}
        />,
      );
      openAccountPicker();
      toggleAccount('Checking');
      toggleAccount('Savings');
      return result;
    };

    it('draws one line per selected account, keyed to that account', () => {
      renderWithBothSelected();
      const lines = screen.getAllByTestId('line');
      expect(lines.map((l) => l.getAttribute('data-name'))).toEqual(['Checking', 'Savings']);
      expect(lines.map((l) => l.getAttribute('data-key'))).toEqual([
        'balances.a1',
        'balances.a2',
      ]);
      // recharts reads the key as a path into the datum, so a key that merely
      // looks plausible draws an empty line. Resolve it the way recharts does.
      const resolve = (point: any, key: string) =>
        key.split('.').reduce((value, part) => value?.[part], point);
      expect(
        lines.map((l) => resolve(multiPoints[1], l.getAttribute('data-key') as string)),
      ).toEqual([800, 500]);
    });

    it('leaves the per-account lines unfilled', () => {
      renderWithBothSelected();
      for (const line of screen.getAllByTestId('line')) {
        expect(line.getAttribute('data-fill')).toBe('none');
      }
    });

    it('gives each account its own colour, none of them the total line colour', () => {
      renderWithBothSelected();
      const strokes = screen.getAllByTestId('line').map((l) => l.getAttribute('data-stroke'));
      expect(new Set(strokes).size).toBe(strokes.length);
      // `--chart-1` is the theme accent, which is what `--chart-primary` is too,
      // so an account taking the first palette slot would be indistinguishable
      // from the total.
      expect(strokes).not.toContain('var(--chart-primary)');
    });

    it('keeps the filled area for the "Total of Accounts" line', () => {
      renderWithBothSelected();
      const area = screen.getByTestId('area');
      expect(area.getAttribute('data-fill')).toBe('url(#forecastBalance)');
      expect(area.getAttribute('data-stroke')).toBe('var(--chart-primary)');
      expect(area.getAttribute('data-name')).toBe('Total of Accounts');
    });

    it('legends the total and every selected account', () => {
      renderWithBothSelected();
      const legend = within(screen.getByRole('list', { name: 'Forecast lines' }));
      expect(legend.getByText('Total of Accounts')).toBeInTheDocument();
      expect(legend.getByText('Checking')).toBeInTheDocument();
      expect(legend.getByText('Savings')).toBeInTheDocument();
    });

    it('names each account and its balance at the hovered point', () => {
      charts.tooltipPoint = {
        date: '2025-01-16',
        balance: 1300,
        balances: { a1: 800, a2: 500 },
        transactions: [{ name: 'Bill', amount: -200, accountId: 'a1' }],
      };
      renderWithBothSelected();
      const tooltip = within(screen.getByTestId('tooltip'));
      expect(tooltip.getByText('Total of Accounts')).toBeInTheDocument();
      expect(tooltip.getByText('$1300.00')).toBeInTheDocument();
      expect(tooltip.getByText('Checking')).toBeInTheDocument();
      expect(tooltip.getByText('$800.00')).toBeInTheDocument();
      expect(tooltip.getByText('Savings')).toBeInTheDocument();
      expect(tooltip.getByText('$500.00')).toBeInTheDocument();
    });

    it('says which account a hovered transaction belongs to', () => {
      charts.tooltipPoint = {
        date: '2025-01-16',
        balance: 1300,
        balances: { a1: 800, a2: 500 },
        transactions: [{ name: 'Bill', amount: -200, accountId: 'a1' }],
      };
      renderWithBothSelected();
      expect(
        within(screen.getByTestId('tooltip')).getByText('Bill (Checking)'),
      ).toBeInTheDocument();
    });

    // Discussion #1784: overdue occurrences land on the first day, and the
    // tooltip says how many, so the drop has a visible cause.
    describe('overdue occurrences on the hovered day', () => {
      const overduePoint = (transactions: any[]) => ({
        date: '2025-01-15',
        balance: 1300,
        balances: { a1: 800, a2: 500 },
        transactions,
      });

      it('says one overdue scheduled transaction, in the singular', () => {
        charts.tooltipPoint = overduePoint([
          { name: 'Rent', amount: -200, accountId: 'a1', scheduledTransactionId: 's1', overdueOriginalDate: '2025-01-10' },
          { name: 'Pay', amount: 300, accountId: 'a1', scheduledTransactionId: 's2' },
        ]);
        renderWithBothSelected();
        expect(
          within(screen.getByTestId('tooltip')).getByText('Includes 1 overdue scheduled transaction'),
        ).toBeInTheDocument();
      });

      it('counts each overdue occurrence, in the plural', () => {
        charts.tooltipPoint = overduePoint([
          { name: 'Rent', amount: -200, accountId: 'a1', scheduledTransactionId: 's1', overdueOriginalDate: '2025-01-01' },
          { name: 'Rent', amount: -200, accountId: 'a1', scheduledTransactionId: 's1', overdueOriginalDate: '2025-01-08' },
        ]);
        renderWithBothSelected();
        expect(
          within(screen.getByTestId('tooltip')).getByText('Includes 2 overdue scheduled transactions'),
        ).toBeInTheDocument();
      });

      it('counts an overdue transfer between two selected accounts once', () => {
        charts.tooltipPoint = overduePoint([
          { name: 'Move', amount: -100, accountId: 'a1', scheduledTransactionId: 't1', overdueOriginalDate: '2025-01-10' },
          { name: 'Move', amount: 100, accountId: 'a2', scheduledTransactionId: 't1', overdueOriginalDate: '2025-01-10' },
        ]);
        renderWithBothSelected();
        expect(
          within(screen.getByTestId('tooltip')).getByText('Includes 1 overdue scheduled transaction'),
        ).toBeInTheDocument();
      });

      it('says nothing when no hovered transaction is overdue', () => {
        charts.tooltipPoint = overduePoint([
          { name: 'Bill', amount: -200, accountId: 'a1', scheduledTransactionId: 's1' },
        ]);
        renderWithBothSelected();
        expect(
          within(screen.getByTestId('tooltip')).queryByText(/overdue/),
        ).not.toBeInTheDocument();
      });
    });

    it('builds the forecast from the picker order, not the click order', () => {
      mockBuildMultiAccountForecast.mockReturnValue(multiForecastOf(multiPoints, twoSeries));
      render(
        <CashFlowForecastChart
          scheduledTransactions={[{} as any]}
          accounts={twoAccounts}
          isLoading={false}
        />,
      );
      openAccountPicker();
      toggleAccount('Savings');
      toggleAccount('Checking');

      expect(mockBuildMultiAccountForecast).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        ['a1', 'a2'],
        expect.anything(),
        undefined,
      );
    });

    it('withholds the whole chart when a rate is missing', () => {
      mockBuildMultiAccountForecast.mockReturnValue(multiForecastOf([], [], ['EUR']));
      render(
        <CashFlowForecastChart
          scheduledTransactions={[{} as any]}
          accounts={twoAccounts}
          isLoading={false}
        />,
      );
      openAccountPicker();
      toggleAccount('Checking');
      toggleAccount('Savings');

      expect(screen.getByRole('alert')).toHaveTextContent(
        'no exchange rate is available for EUR',
      );
      expect(screen.queryByTestId('composed-chart')).not.toBeInTheDocument();
    });

    it('stays on the single filled area while only one account is selected', () => {
      mockBuildForecast.mockReturnValue(
        forecastOf([
          { date: '2025-01-15', balance: 1000, transactions: [{ amount: -100, name: 'Bill' }] },
          { date: '2025-01-16', balance: 900, transactions: [] },
        ]),
      );
      render(
        <CashFlowForecastChart
          scheduledTransactions={[{} as any]}
          accounts={twoAccounts}
          isLoading={false}
        />,
      );
      openAccountPicker();
      toggleAccount('Checking');

      expect(screen.getByTestId('area-chart')).toBeInTheDocument();
      expect(screen.queryByTestId('composed-chart')).not.toBeInTheDocument();
      expect(screen.queryAllByTestId('line')).toHaveLength(0);
      expect(mockBuildForecast).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'a1',
        expect.anything(),
        undefined,
      );
    });
  });

  describe('remembering the selection', () => {
    const twoAccounts = [
      makeAccount({ id: 'a1', name: 'Checking' }),
      makeAccount({ id: 'a2', name: 'Savings', accountType: 'SAVINGS' }),
    ];

    it('restores a stored multi-account selection, in picker order', () => {
      localStorage.setItem('cashFlowForecast.accountIds', JSON.stringify(['a2', 'a1']));
      render(
        <CashFlowForecastChart
          scheduledTransactions={[]}
          accounts={twoAccounts}
          isLoading={false}
        />,
      );

      expect(mockBuildMultiAccountForecast).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        ['a1', 'a2'],
        expect.anything(),
        undefined,
      );
    });

    // The selector used to store a single id (or the string 'all'), so an
    // existing user must not be silently moved back to every account.
    it('carries a single account forward from the pre-multi-select key', () => {
      localStorage.setItem('cashFlowForecast.accountId', 'a2');
      render(
        <CashFlowForecastChart
          scheduledTransactions={[]}
          accounts={twoAccounts}
          isLoading={false}
        />,
      );

      expect(mockBuildForecast).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'a2',
        expect.anything(),
        undefined,
      );
    });

    it('reads a stored "all" from the pre-multi-select key as every account', () => {
      localStorage.setItem('cashFlowForecast.accountId', 'all');
      render(
        <CashFlowForecastChart
          scheduledTransactions={[]}
          accounts={twoAccounts}
          isLoading={false}
        />,
      );

      expect(mockBuildForecast).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'all',
        expect.anything(),
        undefined,
      );
    });

    it('falls back to the legacy key rather than throwing on unparseable storage', () => {
      localStorage.setItem('cashFlowForecast.accountIds', '{not json');
      localStorage.setItem('cashFlowForecast.accountId', 'a1');
      render(
        <CashFlowForecastChart
          scheduledTransactions={[]}
          accounts={twoAccounts}
          isLoading={false}
        />,
      );

      expect(mockBuildForecast).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'a1',
        expect.anything(),
        undefined,
      );
    });

    it('persists a new selection', () => {
      render(
        <CashFlowForecastChart
          scheduledTransactions={[]}
          accounts={twoAccounts}
          isLoading={false}
        />,
      );
      openAccountPicker();
      toggleAccount('Savings');

      expect(localStorage.getItem('cashFlowForecast.accountIds')).toBe(
        JSON.stringify(['a2']),
      );
    });

    // A stored account that has since been closed or deleted is no longer on
    // offer, so it must not quietly narrow the forecast to nothing.
    it('ignores stored ids for accounts that are no longer available', () => {
      localStorage.setItem('cashFlowForecast.accountIds', JSON.stringify(['gone']));
      render(
        <CashFlowForecastChart
          scheduledTransactions={[]}
          accounts={twoAccounts}
          isLoading={false}
        />,
      );

      expect(mockBuildForecast).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'all',
        expect.anything(),
        undefined,
      );
    });
  });

  describe('hiding the chart', () => {
    const renderChart = (isLoading = false) =>
      render(
        <CashFlowForecastChart scheduledTransactions={[]} accounts={[]} isLoading={isLoading} />
      );

    it('folds into the strip and remembers the choice in localStorage', () => {
      renderChart();
      fireEvent.click(screen.getByRole('button', { name: 'Hide chart' }));

      expect(screen.getByTestId('chart-collapsed-strip')).toBeInTheDocument();
      expect(screen.queryByText('Cash Flow Forecast')).not.toBeInTheDocument();
      expect(localStorage.getItem('cashFlowForecast.collapsed')).toBe('true');
    });

    it('starts folded when this browser saved that choice', () => {
      localStorage.setItem('cashFlowForecast.collapsed', 'true');
      renderChart();

      expect(screen.getByTestId('chart-collapsed-strip')).toBeInTheDocument();
      expect(screen.queryByText('1M')).not.toBeInTheDocument();
    });

    it('restores the chart from the strip and remembers that too', () => {
      localStorage.setItem('cashFlowForecast.collapsed', 'true');
      renderChart();
      fireEvent.click(screen.getByTestId('chart-collapsed-strip'));

      expect(screen.getByText('Cash Flow Forecast')).toBeInTheDocument();
      expect(screen.queryByTestId('chart-collapsed-strip')).not.toBeInTheDocument();
      expect(localStorage.getItem('cashFlowForecast.collapsed')).toBe('false');
    });

    it('reads a stored value that is not a boolean as open', () => {
      localStorage.setItem('cashFlowForecast.collapsed', '"yes"');
      renderChart();

      expect(screen.getByText('Cash Flow Forecast')).toBeInTheDocument();
      expect(screen.queryByTestId('chart-collapsed-strip')).not.toBeInTheDocument();
    });

    it('offers the hide button while the forecast is loading', () => {
      renderChart(true);
      fireEvent.click(screen.getByRole('button', { name: 'Hide chart' }));

      expect(screen.getByTestId('chart-collapsed-strip')).toBeInTheDocument();
    });
  });
});
