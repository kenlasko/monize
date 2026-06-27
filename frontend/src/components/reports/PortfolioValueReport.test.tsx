import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { PortfolioValueReport } from './PortfolioValueReport';
import { renderChartFlagDot } from '@/components/investments/portfolio-chart-utils';
import { chartColors } from '@/lib/chart-colors';

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatSignedPercent: (n: number, decimals = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`,
    formatCurrencyCompact: (n: number, _currency?: string) => `$${n.toFixed(0)}`,
    formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    formatCurrencyFlag: (n: number, _currency?: string) => `$${n}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (amount: number, _currency: string) => amount,
    defaultCurrency: 'CAD',
  }),
}));

const STABLE_RESOLVED_RANGE = { start: '2024-01-01', end: '2026-01-01' };

let mockDateRangeValue = '2y';
const mockSetDateRange = vi.fn();

vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: mockDateRangeValue,
    setDateRange: mockSetDateRange,
    startDate: '',
    setStartDate: vi.fn(),
    endDate: '',
    setEndDate: vi.fn(),
    resolvedRange: STABLE_RESOLVED_RANGE,
    isValid: true,
  }),
}));

vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (_key: string, defaultValue: string) => [defaultValue, vi.fn()],
}));

vi.mock('@/lib/utils', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...inputs: any[]) => inputs.filter(Boolean).join(' '),
}));

const mockDateRangeSelectorProps = vi.fn();
vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: (props: any) => {
    mockDateRangeSelectorProps(props);
    return <div data-testid="date-range-selector" />;
  },
}));

vi.mock('@/components/ui/ExportDropdown', () => ({
  ExportDropdown: ({ onExportCsv, onExportPdf }: any) => (
    <div data-testid="export-dropdown">
      {onExportCsv && (
        <button data-testid="export-csv" onClick={onExportCsv}>CSV</button>
      )}
      <button data-testid="export-pdf" onClick={onExportPdf}>Export PDF</button>
    </div>
  ),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  // Invoke the dot render-prop so the high/low bubble wiring (and its dismiss
  // control) is exercised. Indices 0..2 cover both extremes of the 3-point
  // series the dismiss test renders.
  Area: ({ dot }: any) =>
    typeof dot === 'function' ? (
      <>
        {dot({ cx: 10, cy: 20, index: 0 })}
        {dot({ cx: 30, cy: 40, index: 1 })}
        {dot({ cx: 50, cy: 60, index: 2 })}
      </>
    ) : null,
  XAxis: ({ tickFormatter }: any) => (
    <div>
      {tickFormatter ? tickFormatter('Jan 2024') : ''}
      {tickFormatter ? tickFormatter('Jan 1, 2024') : ''}
    </div>
  ),
  YAxis: ({ tickFormatter }: any) => <div>{tickFormatter ? tickFormatter(1000) : ''}</div>,
  CartesianGrid: () => null,
  Tooltip: ({ content }: any) => {
    if (typeof content === 'function') {
      return (
        <div>
          {content({ active: true, payload: [{ value: 100, payload: { name: 'Jan' } }] })}
          {content({ active: false, payload: [] })}
          {content({ active: true, payload: null })}
        </div>
      );
    }
    return null;
  },
}));

vi.mock('@/components/investments/portfolio-chart-utils', () => ({
  INTRADAY_RANGES: new Set(['1d', '1w', '1m']),
  buildIntradayCacheKey: vi.fn(() => 'test-cache-key'),
  readIntradayCache: vi.fn(() => null),
  writeIntradayCache: vi.fn(),
  computeTightYAxisDomain: vi.fn((values: number[]) => {
    if (!values.length) return [0, 1];
    return [Math.min(...values), Math.max(...values)];
  }),
  renderChartFlagDot: vi.fn(() => null),
  ChartFlagShadowFilter: () => null,
}));

const mockGetInvestmentsMonthly = vi.fn();
const mockGetInvestmentsDaily = vi.fn();
const mockGetPortfolioSummary = vi.fn();
const mockGetInvestmentAccounts = vi.fn();
const mockGetIntradayValue = vi.fn();

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getInvestmentsMonthly: (...args: any[]) => mockGetInvestmentsMonthly(...args),
    getInvestmentsDaily: (...args: any[]) => mockGetInvestmentsDaily(...args),
  },
}));

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
    getIntradayValue: (...args: any[]) => mockGetIntradayValue(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const emptyPortfolio = {
  holdings: [],
  holdingsByAccount: [],
  allocation: [],
  totalPortfolioValue: 0,
  totalCostBasis: 0,
  totalGainLoss: 0,
  totalGainLossPercent: 0,
};

describe('PortfolioValueReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDateRangeValue = '2y';
  });

  it('shows loading state initially', () => {
    mockGetInvestmentsMonthly.mockReturnValue(new Promise(() => {}));
    mockGetPortfolioSummary.mockReturnValue(new Promise(() => {}));
    mockGetInvestmentAccounts.mockReturnValue(new Promise(() => {}));
    render(<PortfolioValueReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no monthly data', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText(/No investment data for this period/)).toBeInTheDocument();
    });
  });

  it('renders summary cards with portfolio data', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
      { month: '2024-07-01', value: 52000 },
      { month: '2024-08-01', value: 55000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [
        {
          accountId: 'acc-1',
          accountName: 'TFSA',
          totalMarketValue: 50000,
          cashBalance: 5000,
          totalGainLoss: 3000,
          totalGainLossPercent: 6.0,
        },
      ],
      allocation: [],
      totalPortfolioValue: 55000,
      totalCostBasis: 50000,
      totalGainLoss: 5000,
      totalGainLossPercent: 10.0,
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Highest Value')).toBeInTheDocument();
    });
    expect(screen.getByText('Lowest Value')).toBeInTheDocument();
    expect(screen.getByText('Period Change')).toBeInTheDocument();
    expect(screen.getByText('Period Return')).toBeInTheDocument();
  });

  it('lets the user dismiss a high or low value bubble without persisting it', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
      { month: '2024-07-01', value: 52000 },
      { month: '2024-08-01', value: 55000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);

    const flagMock = vi.mocked(renderChartFlagDot);
    await waitFor(() => {
      expect(flagMock.mock.calls.some(([o]: any) => o.color === chartColors.income)).toBe(true);
    });

    // Both bubbles are wired with a dismiss control and the localized label.
    const highCall = flagMock.mock.calls.find(([o]: any) => o.color === chartColors.income)!;
    expect(typeof highCall[0].onDismiss).toBe('function');
    expect(highCall[0].dismissLabel).toBe('Hide this value');
    expect(flagMock.mock.calls.some(([o]: any) => o.color === chartColors.expense)).toBe(true);

    // Dismissing the high bubble hides it on the next render; the low remains.
    flagMock.mockClear();
    await act(async () => {
      highCall[0].onDismiss!();
    });
    expect(flagMock.mock.calls.some(([o]: any) => o.color === chartColors.income)).toBe(false);
    expect(flagMock.mock.calls.some(([o]: any) => o.color === chartColors.expense)).toBe(true);
  });

  it('renders the area chart', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
      { month: '2024-07-01', value: 55000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      ...emptyPortfolio,
      totalPortfolioValue: 55000,
      totalGainLoss: 5000,
      totalGainLossPercent: 10,
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio Value Over Time')).toBeInTheDocument();
    });
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('renders portfolio breakdown table when account data available', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [
        {
          accountId: 'acc-1',
          accountName: 'TFSA',
          totalMarketValue: 45000,
          cashBalance: 5000,
          totalGainLoss: 3000,
          totalGainLossPercent: 6.67,
        },
      ],
      allocation: [],
      totalPortfolioValue: 50000,
      totalCostBasis: 47000,
      totalGainLoss: 3000,
      totalGainLossPercent: 6.38,
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Portfolio Breakdown')).toBeInTheDocument();
    });
    // 'TFSA' appears in the breakdown table (the account picker shows the
    // "All Accounts" placeholder until opened).
    expect(screen.getAllByText('TFSA').length).toBeGreaterThanOrEqual(1);
  });

  it('passes date filter ranges including 1w, 1m, 3m, ytd to DateRangeSelector', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(mockDateRangeSelectorProps).toHaveBeenCalled();
    });
    const lastCall = mockDateRangeSelectorProps.mock.calls[mockDateRangeSelectorProps.mock.calls.length - 1][0];
    expect(lastCall.ranges).toEqual(['1d', '1w', '1m', '3m', 'ytd', '1y', '2y', '5y', 'all']);
  });

  it('handles loadData error gracefully', async () => {
    mockGetInvestmentsMonthly.mockRejectedValue(new Error('boom'));
    mockGetPortfolioSummary.mockRejectedValue(new Error('boom'));
    mockGetInvestmentAccounts.mockRejectedValue(new Error('boom'));
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText(/No investment data/)).toBeInTheDocument();
    });
  });

  it('exports pdf with breakdown', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
      { month: '2024-07-01', value: 55000 },
      { month: '2024-08-01', value: 52000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [
        { accountId: 'acc-1', accountName: 'TFSA', totalMarketValue: 45000, cashBalance: 5000, totalGainLoss: 3000, totalGainLossPercent: 6.67 },
        { accountId: 'acc-2', accountName: 'RRSP', totalMarketValue: 3000, cashBalance: 0, totalGainLoss: -500, totalGainLossPercent: -10 },
      ],
      allocation: [],
      totalPortfolioValue: 53000,
      totalCostBasis: 50000,
      totalGainLoss: 3000,
      totalGainLossPercent: 6,
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'USD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Portfolio Breakdown')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    expect(exportToPdf).toHaveBeenCalled();
  });

  it('exports pdf with no portfolio breakdown rows', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByTestId('export-pdf')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    expect(exportToPdf).toHaveBeenCalledWith(
      expect.objectContaining({ additionalTables: undefined }),
    );
  });

  it('changes selected account', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      ...emptyPortfolio, totalPortfolioValue: 50000,
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA - Cash', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });
    await act(async () => { fireEvent.click(trigger); });
    await act(async () => {
      fireEvent.click(screen.getByText('TFSA'));
    });
  });

  it('renders with negative period change', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 60000 },
      { month: '2024-07-01', value: 55000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      ...emptyPortfolio,
      totalPortfolioValue: 55000,
      totalCostBasis: 60000,
      totalGainLoss: -5000,
      totalGainLossPercent: -8.33,
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Period Change')).toBeInTheDocument();
    });
  });

  it('handles many monthly data points (>36) for axis ticks', async () => {
    const data = Array.from({ length: 50 }, (_, i) => ({
      month: `2020-${String((i % 12) + 1).padStart(2, '0')}-01`,
      value: 50000 + i * 100,
    }));
    mockGetInvestmentsMonthly.mockResolvedValue(data);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio Value Over Time')).toBeInTheDocument();
    });
  });

  it('renders account selector dropdown', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('All Accounts')).toBeInTheDocument();
    });
  });

  it('filters INVESTMENT_BROKERAGE accounts from the dropdown', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-cash', name: 'TFSA - Cash', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      { id: 'acc-brok', name: 'TFSA - Brokerage', currencyCode: 'CAD', accountSubType: 'INVESTMENT_BROKERAGE' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('All Accounts')).toBeInTheDocument();
    });
    // Cash account (with suffix stripped) should appear; brokerage account should not
    expect(screen.queryByText('TFSA - Brokerage')).not.toBeInTheDocument();
  });

  it('strips account name suffixes in the dropdown', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA - Cash', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });
    fireEvent.click(trigger);
    // The " - Cash" suffix should be stripped in the option label
    expect(screen.getByText('TFSA')).toBeInTheDocument();
  });

  it('shows breakdown negative gain/loss in red colour class', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [
        { accountId: 'acc-1', accountName: 'RRSP', totalMarketValue: 40000, cashBalance: 0, totalGainLoss: -5000, totalGainLossPercent: -11.1 },
      ],
      allocation: [],
      totalPortfolioValue: 40000,
      totalCostBasis: 45000,
      totalGainLoss: -5000,
      totalGainLossPercent: -11.1,
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Portfolio Breakdown')).toBeInTheDocument();
    });
    // Negative gain/loss cell should have red text class
    const gainLossCell = screen.getByText('$-5000.00');
    expect(gainLossCell).toHaveClass('text-red-600');
  });

  it('shows breakdown positive gain/loss formatted with + prefix', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [
        { accountId: 'acc-1', accountName: 'TFSA', totalMarketValue: 48000, cashBalance: 2000, totalGainLoss: 5000, totalGainLossPercent: 11.6 },
      ],
      allocation: [],
      totalPortfolioValue: 50000,
      totalCostBasis: 45000,
      totalGainLoss: 5000,
      totalGainLossPercent: 11.6,
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('+$5000.00')).toBeInTheDocument();
    });
  });

  it('shows foreign currency label in summary cards when account currency differs from default', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    // Account with USD currency while default is CAD
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-usd', name: 'USD Account - Cash', currencyCode: 'USD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });
    await act(async () => { fireEvent.click(trigger); });
    await act(async () => {
      fireEvent.click(screen.getByText('USD Account'));
    });
    await waitFor(() => {
      // When foreign currency is active, values are formatted with the currency code suffix
      expect(screen.getAllByText('$50000 USD').length).toBeGreaterThan(0);
    });
  });

  it('handles daily range (3m) using getInvestmentsDaily', async () => {
    // 3m is in DAILY_RANGES but not in INTRADAY_RANGES, so it uses the daily endpoint
    mockDateRangeValue = '3m';
    mockGetInvestmentsDaily.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
      { date: '2024-06-02', value: 51000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio Value Over Time')).toBeInTheDocument();
    });
    expect(mockGetInvestmentsDaily).toHaveBeenCalled();
  });

  it('shows intraday unavailable state for 1d range with fallbackToDaily', async () => {
    mockDateRangeValue = '1d';
    mockGetIntradayValue.mockResolvedValue({
      points: [],
      interval: '5m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: ['MSFT'],
      fallbackToDaily: true,
    });
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText(/Intraday view unavailable/i)).toBeInTheDocument();
    });
    // Should show skipped symbols
    expect(screen.getByText(/MSFT/)).toBeInTheDocument();
  });

  it('shows intraday unavailable with no skipped symbols listed', async () => {
    mockDateRangeValue = '1d';
    mockGetIntradayValue.mockResolvedValue({
      points: [],
      interval: '5m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: [],
      fallbackToDaily: true,
    });
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText(/Intraday view unavailable/i)).toBeInTheDocument();
    });
  });

  it('shows intraday fallback warning icon for 1w range with fallbackToDaily', async () => {
    mockDateRangeValue = '1w';
    mockGetIntradayValue.mockResolvedValue({
      points: [],
      interval: '1d',
      currency: 'CAD',
      range: '1w',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: ['VFV'],
      fallbackToDaily: true,
    });
    mockGetInvestmentsDaily.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByTestId('report-intraday-fallback-warning')).toBeInTheDocument();
    });
  });

  it('renders intraday chart points for 1d range without fallback', async () => {
    mockDateRangeValue = '1d';
    mockGetIntradayValue.mockResolvedValue({
      points: [
        { timestamp: '2024-06-01T10:00:00Z', value: 50000 },
        { timestamp: '2024-06-01T11:00:00Z', value: 51000 },
      ],
      interval: '5m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: [],
      fallbackToDaily: false,
    });
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    });
  });

  it('handles intraday fetch error gracefully', async () => {
    mockDateRangeValue = '1d';
    mockGetIntradayValue.mockRejectedValue(new Error('network error'));
    // Component falls back to daily on intraday error; mock it empty so chart stays empty
    mockGetInvestmentsDaily.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText(/No investment data|Intraday view unavailable/i)).toBeInTheDocument();
    });
  });

  it('shows background loading indicator when data is being refreshed', async () => {
    // First load resolves; second (triggered by account change) stays pending
    mockGetInvestmentsMonthly
      .mockResolvedValueOnce([{ month: '2024-06-01', value: 50000 }])
      .mockReturnValueOnce(new Promise(() => {}));
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio Value Over Time')).toBeInTheDocument();
    });
    // Trigger a reload by changing the account — new fetch hangs, but old points are shown
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Filter by account' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('TFSA'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('report-chart-loading-indicator')).toBeInTheDocument();
    });
  });

  it('renders many daily data points (>36) axis tick logic', async () => {
    mockDateRangeValue = '3m';
    const data = Array.from({ length: 50 }, (_, i) => ({
      date: `2024-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      value: 50000 + i * 100,
    }));
    mockGetInvestmentsDaily.mockResolvedValue(data);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio Value Over Time')).toBeInTheDocument();
    });
    expect(mockGetInvestmentsDaily).toHaveBeenCalled();
  });

  it('computes summary with single chart point (initial === current, change = 0)', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('+0.0%')).toBeInTheDocument();
    });
  });

  it('exports pdf using foreign-currency fmtFull when account has foreign currency', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 40000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [
        { accountId: 'acc-usd', accountName: 'USD Account', totalMarketValue: 40000, cashBalance: 0, totalGainLoss: 1000, totalGainLossPercent: 2.5 },
      ],
      allocation: [],
      totalPortfolioValue: 40000,
      totalCostBasis: 39000,
      totalGainLoss: 1000,
      totalGainLossPercent: 2.5,
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-usd', name: 'USD Account - Brokerage', currencyCode: 'USD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    // Select the USD account first to activate foreign currency path
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });
    await act(async () => { fireEvent.click(trigger); });
    // The account name also appears in the breakdown table, so target the
    // option's checkbox inside the dropdown rather than matching by text.
    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox'));
    });
    await waitFor(() => expect(screen.getByTestId('export-pdf')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    expect(exportToPdf).toHaveBeenCalled();
  });

  it('switches to table view, exercises sort, and exports CSV', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-01-01', value: 50000 },
      { month: '2024-02-01', value: 52000 },
      { month: '2024-03-01', value: 51000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      ...emptyPortfolio,
      holdingsByAccount: [
        {
          accountId: 'a1',
          accountName: 'Account A',
          totalMarketValue: 25000,
          cashBalance: 1000,
          totalGainLoss: 500,
        },
        {
          accountId: 'a2',
          accountName: 'Account B',
          totalMarketValue: 25000,
          cashBalance: 500,
          totalGainLoss: -200,
        },
      ],
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    const { container } = render(<PortfolioValueReport />);
    // Wait for the chart to render so the toggle is mounted.
    await waitFor(() => expect(screen.getByTitle('Table')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTitle('Table')); });
    // The chart card now renders a table; click each header to exercise sort.
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const tables = container.querySelectorAll('table');
    expect(tables.length).toBeGreaterThan(0);
    // Exercise sort headers on every rendered table (chart-table + breakdown table).
    const tableCount = tables.length;
    for (let t = 0; t < tableCount; t += 1) {
      const headerCount = container.querySelectorAll('table')[t].querySelectorAll('th').length;
      for (let __i = 0; __i < headerCount; __i += 1) {
        const __ths = container.querySelectorAll('table')[t].querySelectorAll('th');
        if (!__ths[__i]) break;
        await act(async () => { fireEvent.click(__ths[__i]); });
      }
      for (let __i = 0; __i < headerCount; __i += 1) {
        const __ths = container.querySelectorAll('table')[t].querySelectorAll('th');
        if (!__ths[__i]) break;
        await act(async () => { fireEvent.click(__ths[__i]); });
      }
    }
    // Trigger CSV export.
    await act(async () => { fireEvent.click(screen.getByTestId('export-csv')); });
  });
});
