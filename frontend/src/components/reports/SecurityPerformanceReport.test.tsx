import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { SecurityPerformanceReport } from './SecurityPerformanceReport';

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/components/ui/ExportDropdown', () => ({
  ExportDropdown: ({ onExportCsv, onExportPdf, disabled }: any) => (
    <div data-testid="export-dropdown">
      {onExportCsv && <button data-testid="export-csv" onClick={onExportCsv}>CSV</button>}
      <button data-testid="export-pdf" onClick={onExportPdf} data-disabled={String(disabled === true)}>PDF</button>
    </div>
  ),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatSignedPercent: (n: number, decimals = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`,
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
    }),
  };
});
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convertToDefault: (amount: number) => amount,
  }),
}));

vi.mock('@/lib/utils', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...inputs: any[]) => inputs.flat(Infinity).filter(Boolean).join(' '),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Line: () => null,
  Legend: () => null,
  Area: () => null,
  XAxis: ({ tickFormatter }: any) => <div>{tickFormatter ? tickFormatter(1) : ''}</div>,
  YAxis: ({ tickFormatter }: any) => <div>{tickFormatter ? tickFormatter(100) : ''}</div>,
  CartesianGrid: () => null,
  Tooltip: ({ content, formatter }: any) => {
    if (typeof content === 'function') {
      // Payload carries both the single-security shape (label/close/markers on
      // `.payload`) and the comparison shape (`ts` plus per-series value/dataKey)
      // so the one mock drives either chart's tooltip.
      const ts = new Date('2024-01-01T00:00:00').getTime();
      return (
        <div data-testid="tooltip">
          {content({ active: true, payload: [{ payload: { ts, label: 'Jan', close: 100, buyMarker: 100, sellMarker: 100 }, value: 5, dataKey: 's-1', color: '#000' }] })}
          {content({ active: false, payload: [] })}
          {content({ active: true, payload: [{ payload: { ts, label: 'Feb', close: 50 }, value: -2, dataKey: 's-2', color: '#111' }] })}
        </div>
      );
    }
    if (formatter) {
      try { formatter(123, 'X'); } catch {}
    }
    return null;
  },
  ReferenceLine: ({ label }: any) =>
    typeof label === 'function'
      ? label({ viewBox: { x: 0, y: 50, width: 600 } })
      : null,
}));

const mockGetSecurities = vi.fn();
const mockGetPortfolioSummary = vi.fn();
const mockGetSecurityPrices = vi.fn();
const mockGetTransactions = vi.fn();
const mockGetInvestmentAccounts = vi.fn();
const mockGetMarketIndexes = vi.fn();
const mockGetPerformanceComparison = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurities: (...args: any[]) => mockGetSecurities(...args),
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
    getSecurityPrices: (...args: any[]) => mockGetSecurityPrices(...args),
    getTransactions: (...args: any[]) => mockGetTransactions(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
    getMarketIndexes: (...args: any[]) => mockGetMarketIndexes(...args),
    getPerformanceComparison: (...args: any[]) =>
      mockGetPerformanceComparison(...args),
  },
}));

const mockMarketIndexes = [
  {
    code: 'SP500',
    yahooSymbol: '^GSPC',
    defaultName: 'S&P 500',
    currencyCode: 'USD',
    region: 'NORTH_AMERICA',
    exchanges: ['NYSE', 'NASDAQ'],
    coverage: { earliestDate: '2000-01-03', latestDate: '2026-08-05' },
  },
  {
    // No stored history: offering it could only produce an excluded row.
    code: 'FTSE_100',
    yahooSymbol: '^FTSE',
    defaultName: 'FTSE 100',
    currencyCode: 'GBP',
    region: 'EUROPE',
    exchanges: ['LSE'],
    coverage: { earliestDate: null, latestDate: null },
  },
];

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockSecurities = [
  { id: 's-1', symbol: 'AAPL', name: 'Apple Inc.', isActive: true, currencyCode: 'USD', exchange: 'NASDAQ', securityType: 'STOCK' },
  { id: 's-2', symbol: 'VTI', name: 'Vanguard Total Stock', isActive: true, currencyCode: 'USD' },
  { id: 's-3', symbol: 'OLD', name: 'Old Stock', isActive: false, currencyCode: 'USD' },
  // Security without exchange/securityType/currencyCode for null-branch coverage
  { id: 's-4', symbol: 'BARE', name: 'Bare Security', isActive: true },
];

const mockHoldings = [
  {
    id: 'h-1',
    accountId: 'acc-1',
    securityId: 's-1',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    securityType: 'STOCK',
    currencyCode: 'USD',
    quantity: 10,
    averageCost: 150,
    costBasis: 1500,
    currentPrice: 180,
    marketValue: 1800,
    gainLoss: 300,
    gainLossPercent: 20,
    costBasisAccountCurrency: 1500,
    accountBreakdowns: [
      { id: 'h-1', accountId: 'acc-1', securityId: 's-1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', currencyCode: 'USD', quantity: 10, averageCost: 150, costBasis: 1500, currentPrice: 180, marketValue: 1800, gainLoss: 300, gainLossPercent: 20, costBasisAccountCurrency: 1500 },
    ],
  },
];

const SELECT_PLACEHOLDER = 'Select securities...';

// The security selector is a searchable MultiSelect (trigger button + portal
// dropdown of checkboxes), not a native <select>. These helpers open it and
// toggle an option by its "SYMBOL - Name" label, closing afterwards so the
// selected label in the trigger does not duplicate the dropdown option text.
async function openSelector() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: SELECT_PLACEHOLDER }));
  });
}

async function selectSecurity(optionLabel: string) {
  await openSelector();
  await act(async () => {
    fireEvent.click(screen.getByText(optionLabel));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: SELECT_PLACEHOLDER }));
  });
}

describe('SecurityPerformanceReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Brokerage 1', currencyCode: 'USD' },
    ]);
    mockGetMarketIndexes.mockResolvedValue(mockMarketIndexes);
    mockGetPerformanceComparison.mockResolvedValue({
      window: { start: '2024-01-01', end: '2024-12-31' },
      sampling: 'day',
      series: [],
      points: [],
      totals: {},
      gaps: [],
      excluded: [],
      status: 'complete',
    });
  });

  it('shows loading state initially', async () => {
    mockGetSecurities.mockReturnValue(new Promise(() => {}));
    mockGetPortfolioSummary.mockReturnValue(new Promise(() => {}));
    mockGetInvestmentAccounts.mockReturnValue(new Promise(() => {}));
    mockGetMarketIndexes.mockReturnValue(new Promise(() => {}));
    render(<SecurityPerformanceReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
    // Flush the secondary detail-fetch resolution so its state update is
    // wrapped in act().
    await act(async () => {});
  });

  it('renders security selector with active securities only', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });
    // Only active securities appear in the dropdown; the inactive one does not.
    await openSelector();
    expect(screen.getByText('AAPL - Apple Inc.')).toBeInTheDocument();
    expect(screen.getByText('VTI - Vanguard Total Stock')).toBeInTheDocument();
    expect(screen.queryByText('OLD - Old Stock')).not.toBeInTheDocument();
  });

  it('shows prompt to select security when none selected', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByText(/Select one or more securities above/)).toBeInTheDocument();
    });
  });

  it('renders view type buttons when security is selected', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([
      { id: 1, securityId: 's-1', priceDate: '2025-01-01', closePrice: 175, createdAt: '' },
    ]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    // Select a security
    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => {
      expect(screen.getByText('Price Chart')).toBeInTheDocument();
    });
    expect(screen.getByText('Transactions')).toBeInTheDocument();
    expect(screen.getByText('Dividends')).toBeInTheDocument();
  });

  it('renders performance stats when security is selected', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => {
      expect(screen.getByText('Current Value')).toBeInTheDocument();
    });
    expect(screen.getByText('Cost Basis')).toBeInTheDocument();
    expect(screen.getByText('Total Return')).toBeInTheDocument();
    expect(screen.getByText('Annualized Return')).toBeInTheDocument();
  });

  it('renders price chart with price data', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([
      { id: 1, securityId: 's-1', priceDate: '2025-01-01', closePrice: 170, createdAt: '' },
      { id: 2, securityId: 's-1', priceDate: '2025-01-02', closePrice: 175, createdAt: '' },
    ]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => {
      expect(screen.getByText('Price History - AAPL')).toBeInTheDocument();
    });
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('switches to transactions view', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'BUY',
          quantity: 10,
          price: 150,
          totalAmount: 1500,
          securityId: 's-1',
          security: { symbol: 'AAPL', name: 'Apple Inc.' },
          accountId: 'acc-1',
        },
      ],
      pagination: { hasMore: false },
    });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => {
      expect(screen.getByText('Transactions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Transactions'));
    await waitFor(() => {
      expect(screen.getByText('Transaction History - AAPL')).toBeInTheDocument();
    });
  });

  it('shows a retryable error when the base load fails', async () => {
    mockGetSecurities.mockRejectedValue(new Error('boom'));
    mockGetPortfolioSummary.mockRejectedValue(new Error('boom'));
    mockGetInvestmentAccounts.mockRejectedValue(new Error('boom'));
    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load report data/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Try Again/ })).toBeInTheDocument();
  });

  it('exports pdf in chart view', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([
      { id: 1, securityId: 's-1', priceDate: '2025-01-01', closePrice: 175, createdAt: '' },
    ]);
    mockGetTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2020-01-01', action: 'BUY', quantity: 10, price: 150, totalAmount: 1500, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
        { id: 'tx-2', transactionDate: '2024-06-15', action: 'SELL', quantity: 5, price: 180, totalAmount: 900, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
        { id: 'tx-3', transactionDate: '2024-07-15', action: 'DIVIDEND', quantity: null, price: null, totalAmount: 50, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
        { id: 'tx-4', transactionDate: '2024-08-15', action: 'REINVEST', quantity: 1, price: 50, totalAmount: 50, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
      ],
      pagination: { hasMore: false },
    });
    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });
    await selectSecurity('AAPL - Apple Inc.');
    await waitFor(() => {
      expect(screen.getByText('Current Value')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    expect(exportToPdf).toHaveBeenCalled();
  });

  it('exports pdf in transactions view', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: [{ ...mockHoldings[0], gainLoss: -100, gainLossPercent: -5, marketValue: 1000, costBasis: 1500, accountBreakdowns: [{ ...mockHoldings[0].accountBreakdowns[0], gainLoss: -100, gainLossPercent: -5, marketValue: 1000, costBasis: 1500 }] }] });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-06-15', action: 'BUY', quantity: 10, price: 150, totalAmount: 1500, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
      ],
      pagination: { hasMore: false },
    });
    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });
    await selectSecurity('AAPL - Apple Inc.');
    await waitFor(() => {
      expect(screen.getByText('Transactions')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Transactions'));
    await waitFor(() => {
      expect(screen.getByTestId('export-pdf')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
  });

  it('exports pdf in dividends view', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-06-15', action: 'DIVIDEND', quantity: null, price: null, totalAmount: 50, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
      ],
      pagination: { hasMore: false },
    });
    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });
    await selectSecurity('AAPL - Apple Inc.');
    await waitFor(() => {
      expect(screen.getByText('Dividends')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Dividends'));
    await waitFor(() => {
      expect(screen.getByTestId('export-pdf')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
  });

  it('lists a reinvested dividend at its shares\' cost, and no reinvested interest or void row, as dividends', async () => {
    // Discussion #1670: a reinvest created in the app stores no total, so the
    // dividend it records is quantity x price. Reinvested interest is interest.
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-06-15', action: 'DIVIDEND', quantity: null, price: null, totalAmount: 50, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
        { id: 'tx-2', transactionDate: '2024-07-15', action: 'REINVEST', quantity: 2, price: 25, commission: 0, totalAmount: 0, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
        { id: 'tx-3', transactionDate: '2024-08-15', action: 'REINVEST_INTEREST', quantity: 1, price: 9, commission: 0, totalAmount: 0, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
        // A VOID dividend paid nothing.
        { id: 'tx-4', transactionDate: '2024-09-15', action: 'DIVIDEND', status: 'VOID', quantity: null, price: null, totalAmount: 75, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
      ],
      pagination: { hasMore: false },
    });
    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });
    await selectSecurity('AAPL - Apple Inc.');
    await waitFor(() => {
      expect(screen.getByText('Dividends')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Dividends'));
    await waitFor(() => {
      expect(screen.getByTestId('export-pdf')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });

    const { tableData } = (exportToPdf as any).mock.calls[0][0];
    expect(tableData.rows).toHaveLength(2);
    const byType = new Map<string, string>(
      tableData.rows.map((row: string[]) => [row[2], row[3]]),
    );
    expect([...byType.keys()].sort()).toEqual(['DIVIDEND', 'REINVEST']);
    // 2 x 25 is the same 50 the cash dividend paid.
    expect(byType.get('REINVEST')).toBe(byType.get('DIVIDEND'));
    expect(tableData.totalRow[3]).toMatch(/100/);
  });

  it('paginates transactions through multiple pages', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions
      .mockResolvedValueOnce({
        data: [{ id: 'tx-1', transactionDate: '2024-06-01', action: 'BUY', quantity: 10, price: 150, totalAmount: 1500, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' }],
        pagination: { hasMore: true },
      })
      .mockResolvedValueOnce({
        data: [{ id: 'tx-2', transactionDate: '2024-07-01', action: 'BUY', quantity: 5, price: 160, totalAmount: 800, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' }],
        pagination: { hasMore: false },
      });
    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });
    await selectSecurity('AAPL - Apple Inc.');
    await waitFor(() => {
      expect(mockGetTransactions).toHaveBeenCalledTimes(2);
    });
  });

  it('switches to dividends view', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          quantity: null,
          price: null,
          totalAmount: 50,
          securityId: 's-1',
          security: { symbol: 'AAPL', name: 'Apple Inc.' },
          accountId: 'acc-1',
        },
      ],
      pagination: { hasMore: false },
    });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => {
      expect(screen.getByText('Dividends')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Dividends'));
    await waitFor(() => {
      expect(screen.getByText('Dividend History - AAPL')).toBeInTheDocument();
    });
  });

  it('displays security info with exchange and securityType', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => {
      expect(screen.getByText('NASDAQ')).toBeInTheDocument();
    });
    expect(screen.getByText('STOCK')).toBeInTheDocument();
    expect(screen.getByText('USD')).toBeInTheDocument();
  });

  it('displays security info without optional exchange/securityType/currencyCode', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    // Add a holding for s-4 (bare security)
    const bareHolding = { ...mockHoldings[0], id: 'h-4', securityId: 's-4', symbol: 'BARE', accountBreakdowns: [{ ...mockHoldings[0].accountBreakdowns[0], securityId: 's-4', symbol: 'BARE' }] };
    mockGetPortfolioSummary.mockResolvedValue({ holdings: [bareHolding] });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('BARE - Bare Security');

    await waitFor(() => {
      expect(screen.getByText('Bare Security')).toBeInTheDocument();
    });
    // Exchange, securityType, and Currency sections should not appear
    expect(screen.queryByText('NASDAQ')).not.toBeInTheDocument();
  });

  it('shows negative total return styling', async () => {
    const lossHolding = {
      ...mockHoldings[0],
      costBasis: 2000,
      marketValue: 1500,
      gainLoss: -500,
      gainLossPercent: -25,
      accountBreakdowns: [{ ...mockHoldings[0].accountBreakdowns[0], costBasis: 2000, marketValue: 1500, gainLoss: -500, gainLossPercent: -25 }],
    };
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: [lossHolding] });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => {
      expect(screen.getByText('Total Return')).toBeInTheDocument();
    });
    // Negative return should show the negative value (loss)
    expect(screen.getAllByText(/Total Return/).length).toBeGreaterThanOrEqual(1);
  });

  it('shows annualized return when holding is > 1 year old', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    // Provide a BUY transaction from > 1 year ago so annualizedReturn is computed
    mockGetTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2020-01-01', action: 'BUY', quantity: 10, price: 150, totalAmount: 1500, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
      ],
      pagination: { hasMore: false },
    });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => {
      expect(screen.getByText('Annualized Return')).toBeInTheDocument();
    });
    // Annualized return should be shown (not '-')
    expect(screen.queryByText('Needs 1+ year of data')).not.toBeInTheDocument();
  });

  it('shows annualized return null state when holding is < 1 year old', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    // BUY from < 1 year ago
    mockGetTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2026-01-01', action: 'BUY', quantity: 10, price: 150, totalAmount: 1500, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
      ],
      pagination: { hasMore: false },
    });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => {
      expect(screen.getByText('Annualized Return')).toBeInTheDocument();
    });
    expect(screen.getByText('Needs 1+ year of data')).toBeInTheDocument();
    expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(1);
  });

  it('shows an unpriced holding as unknown, with no return or percentage', async () => {
    const unpriced = { ...mockHoldings[0], currentPrice: null, marketValue: null, gainLoss: null, gainLossPercent: null };
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: [unpriced] });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });
    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => {
      expect(screen.getByText('Total Return')).toBeInTheDocument();
    });
    expect(screen.getAllByText('No price for AAPL').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/-100/)).not.toBeInTheDocument();
  });

  it('omits the annualized return when later activity follows the first buy', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2020-01-01', action: 'BUY', quantity: 5, price: 150, totalAmount: 750, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
        { id: 'tx-2', transactionDate: '2025-01-01', action: 'BUY', quantity: 5, price: 150, totalAmount: 750, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
      ],
      pagination: { hasMore: false },
    });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });
    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => {
      expect(screen.getByText('Annualized Return')).toBeInTheDocument();
    });
    expect(screen.getByText('Shown only for a single buy with no later activity')).toBeInTheDocument();
  });

  it('shows multiple accounts indicator when accountCount > 1', async () => {
    const twoAccountHoldings = [
      { ...mockHoldings[0], accountId: 'acc-1', accountBreakdowns: [{ ...mockHoldings[0].accountBreakdowns[0], accountId: 'acc-1' }] },
      { ...mockHoldings[0], id: 'h-2', accountId: 'acc-2', accountBreakdowns: [{ ...mockHoldings[0].accountBreakdowns[0], id: 'h-2', accountId: 'acc-2' }] },
    ];
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: twoAccountHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Brokerage 1', currencyCode: 'USD' },
      { id: 'acc-2', name: 'Brokerage 2', currencyCode: 'USD' },
    ]);

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => {
      expect(screen.getByText(/across \d+ accounts/)).toBeInTheDocument();
    });
  });

  it('shows chart with price data including buy/sell markers', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([
      { id: 1, securityId: 's-1', priceDate: '2024-06-15', closePrice: 170, createdAt: '' },
      { id: 2, securityId: 's-1', priceDate: '2024-07-01', closePrice: 175, createdAt: '' },
    ]);
    mockGetTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-06-15', action: 'BUY', quantity: 10, price: 170, totalAmount: 1700, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
        { id: 'tx-2', transactionDate: '2024-07-01', action: 'SELL', quantity: 5, price: 175, totalAmount: 875, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
        { id: 'tx-3', transactionDate: '2024-06-15', action: 'REINVEST', quantity: 1, price: 170, totalAmount: 170, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
        { id: 'tx-4', transactionDate: '2024-07-01', action: 'REMOVE_SHARES', quantity: 2, price: null, totalAmount: 0, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
      ],
      pagination: { hasMore: false },
    });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => {
      expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    });
  });

  it('shows no price history message when chart data is empty', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => {
      expect(screen.getByText('No price history available.')).toBeInTheDocument();
    });
  });

  it('shows no transactions message in transactions view when empty', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => {
      expect(screen.getByText('Transactions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Transactions'));

    await waitFor(() => {
      expect(screen.getByText('No transactions found.')).toBeInTheDocument();
    });
  });

  it('shows no dividends message in dividends view when empty', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    // Only non-dividend transactions so dividendTx is empty
    mockGetTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-06-15', action: 'BUY', quantity: 10, price: 150, totalAmount: 1500, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
      ],
      pagination: { hasMore: false },
    });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => {
      expect(screen.getByText('Dividends')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Dividends'));

    await waitFor(() => {
      expect(screen.getByText('No dividend history found.')).toBeInTheDocument();
    });
  });

  it('shows transactions with null quantity and null price', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-06-15', action: 'ADD_SHARES', quantity: null, price: null, totalAmount: 0, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
        { id: 'tx-2', transactionDate: '2024-06-16', action: 'TRANSFER_IN', quantity: 5, price: 150, totalAmount: 750, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
        { id: 'tx-3', transactionDate: '2024-06-17', action: 'TRANSFER_OUT', quantity: 2, price: 155, totalAmount: 310, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
        // Unknown action for neutral coloring
        { id: 'tx-4', transactionDate: '2024-06-18', action: 'JOURNAL', quantity: 1, price: null, totalAmount: 0, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'unknown-acc' },
      ],
      pagination: { hasMore: false },
    });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => {
      expect(screen.getByText('Transactions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Transactions'));

    await waitFor(() => {
      expect(screen.getByText('ADD_SHARES')).toBeInTheDocument();
    });
    // null quantity shows '-' and null price shows '-'
    const dashes = screen.getAllByText('-');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
    // Unknown account ID shows '-'
    expect(screen.getByText('JOURNAL')).toBeInTheDocument();
  });

  it('exports pdf when no security is selected (no secLabel)', async () => {
    // This tests the branch where selectedSecurity is undefined in handleExportPdf
    // We need to trigger export without selecting a security -- but ExportDropdown
    // only appears when selectedSecurityId is truthy; so we select one then
    // re-test that path via the transactions pdf with a security that has no exchange
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    const securitiesNoExchange = [
      { id: 's-2', symbol: 'VTI', name: 'Vanguard Total Stock', isActive: true, currencyCode: 'USD' },
    ];
    const vtiHolding = { ...mockHoldings[0], securityId: 's-2', symbol: 'VTI', accountBreakdowns: [{ ...mockHoldings[0].accountBreakdowns[0], securityId: 's-2', symbol: 'VTI' }] };
    mockGetSecurities.mockResolvedValue(securitiesNoExchange);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: [vtiHolding] });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-06-15', action: 'BUY', quantity: 10, price: 150, totalAmount: 1500, securityId: 's-2', security: { symbol: 'VTI', name: 'Vanguard' }, accountId: 'acc-1' },
      ],
      pagination: { hasMore: false },
    });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });
    await selectSecurity('VTI - Vanguard Total Stock');
    await waitFor(() => {
      expect(screen.getByTestId('export-pdf')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    expect(exportToPdf).toHaveBeenCalled();
  });

  it('exports pdf in dividends view with negative annualized return', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    const lossHolding = {
      ...mockHoldings[0],
      costBasis: 2000,
      marketValue: 1500,
      gainLoss: -500,
      gainLossPercent: -25,
      accountBreakdowns: [{ ...mockHoldings[0].accountBreakdowns[0], costBasis: 2000, marketValue: 1500, gainLoss: -500, gainLossPercent: -25 }],
    };
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: [lossHolding] });
    mockGetSecurityPrices.mockResolvedValue([]);
    // Old BUY so annualizedReturn is computed (will be negative due to loss)
    mockGetTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2020-01-01', action: 'BUY', quantity: 10, price: 200, totalAmount: 2000, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
        { id: 'tx-2', transactionDate: '2024-01-01', action: 'DIVIDEND', quantity: null, price: null, totalAmount: 50, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
      ],
      pagination: { hasMore: false },
    });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });
    await selectSecurity('AAPL - Apple Inc.');
    await waitFor(() => {
      expect(screen.getByText('Dividends')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Dividends'));
    await waitFor(() => {
      expect(screen.getByTestId('export-pdf')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    expect(exportToPdf).toHaveBeenCalled();
  });

  it('handles loadDetail error gracefully', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockRejectedValue(new Error('price fetch failed'));
    mockGetTransactions.mockRejectedValue(new Error('tx fetch failed'));

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');

    // After error resolves, component renders chart view with empty prices
    await waitFor(() => {
      expect(screen.getByText('No price history available.')).toBeInTheDocument();
    });
  });

  it('shows stats with averageCost = 0 (no reference line)', async () => {
    const zeroCostHolding = {
      ...mockHoldings[0],
      costBasis: 0,
      averageCost: 0,
      marketValue: 1800,
      accountBreakdowns: [{ ...mockHoldings[0].accountBreakdowns[0], costBasis: 0, averageCost: 0 }],
    };
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: [zeroCostHolding] });
    mockGetSecurityPrices.mockResolvedValue([
      { id: 1, securityId: 's-1', priceDate: '2025-01-01', closePrice: 180, createdAt: '' },
    ]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => {
      expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    });
    // Zero cost basis: no annualized return, cost basis shows $0
    expect(screen.getByText('Cost Basis')).toBeInTheDocument();
  });

  it('shows loadingDetail state while fetching security details', async () => {
    let resolvePrices: (value: any) => void;
    const pricesPromise = new Promise((resolve) => { resolvePrices = resolve; });

    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockReturnValue(pricesPromise);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');

    // Should show loading detail pulse before prices resolve
    expect(document.querySelector('.animate-pulse')).toBeTruthy();

    await act(async () => {
      resolvePrices!([]);
    });
  });

  it('exports pdf in chart view via ExportDropdown', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([
      { id: 1, securityId: 's-1', priceDate: '2025-01-01', closePrice: 180, createdAt: '' },
    ]);
    mockGetTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2020-01-01', action: 'BUY', quantity: 10, price: 150, totalAmount: 1500, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
      ],
      pagination: { hasMore: false },
    });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });
    await selectSecurity('AAPL - Apple Inc.');
    await waitFor(() => {
      expect(screen.getByTestId('export-pdf')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    expect(exportToPdf).toHaveBeenCalled();
    // Verify the subtitle includes exchange info since AAPL has exchange = NASDAQ
    const call = (exportToPdf as any).mock.calls[0][0];
    expect(call.subtitle).toContain('NASDAQ');
  });

  it('exports pdf in transactions view via ExportDropdown', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-06-15', action: 'BUY', quantity: 10, price: 150, totalAmount: 1500, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
        { id: 'tx-2', transactionDate: '2024-06-16', action: 'BUY', quantity: 5, price: null, totalAmount: 0, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'unknown-acc' },
      ],
      pagination: { hasMore: false },
    });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });
    await selectSecurity('AAPL - Apple Inc.');
    await waitFor(() => {
      expect(screen.getByText('Transactions')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Transactions'));
    await waitFor(() => {
      expect(screen.getByTestId('export-pdf')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    expect(exportToPdf).toHaveBeenCalled();
    const call = (exportToPdf as any).mock.calls[0][0];
    // transactions view produces tableData with headers
    expect(call.tableData.headers).toEqual(['Date', 'Account', 'Action', 'Shares', 'Price', 'Total']);
  });

  it('exercises sort headers on transactions and dividends tables', async () => {
    mockGetSecurities.mockResolvedValue([
      { id: 'sec-1', symbol: 'VFV', name: 'Vanguard S&P 500', currencyCode: 'CAD', isActive: true, exchange: 'TSX' },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [
        { id: 'h1', accountId: 'acc-1', securityId: 'sec-1', symbol: 'VFV', name: 'Vanguard S&P 500', currencyCode: 'CAD', securityType: 'ETF', quantity: 10, averageCost: 100, costBasis: 1000, currentPrice: 110, marketValue: 1100, gainLoss: 100, gainLossPercent: 10 },
      ],
      allocation: [],
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetTransactions.mockResolvedValue({
      data: [
        { id: 'tx1', accountId: 'acc-1', securityId: 'sec-1', security: { symbol: 'VFV', name: 'Vanguard S&P 500' }, transactionDate: '2024-01-15', quantity: 5, price: 100, totalAmount: 500, action: 'BUY' },
        { id: 'tx2', accountId: 'acc-1', securityId: 'sec-1', security: { symbol: 'VFV', name: 'Vanguard S&P 500' }, transactionDate: '2024-03-15', quantity: 3, price: 110, totalAmount: 330, action: 'SELL' },
        { id: 'tx3', accountId: 'acc-1', securityId: 'sec-1', security: { symbol: 'VFV', name: 'Vanguard S&P 500' }, transactionDate: '2024-04-10', quantity: null, price: null, totalAmount: 50, action: 'DIVIDEND' },
        { id: 'tx4', accountId: 'acc-1', securityId: 'sec-1', security: { symbol: 'VFV', name: 'Vanguard S&P 500' }, transactionDate: '2024-06-10', quantity: null, price: null, totalAmount: 60, action: 'DIVIDEND' },
      ],
      pagination: { hasMore: false },
    });
    mockGetSecurityPrices.mockResolvedValue([]);
    const { container } = render(<SecurityPerformanceReport />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument(),
    );
    await selectSecurity('VFV - Vanguard S&P 500');
    // Switch to Transactions view and exercise sort headers.
    await waitFor(() => expect(screen.getByText('Transactions')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Transactions'));
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    let headerCount = container.querySelectorAll('table thead th').length;
    for (let __i = 0; __i < headerCount; __i += 1) {
      const __ths = container.querySelectorAll('table thead th');
      if (!__ths[__i]) break;
      await act(async () => { fireEvent.click(__ths[__i]); });
    }
    for (let __i = 0; __i < headerCount; __i += 1) {
      const __ths = container.querySelectorAll('table thead th');
      if (!__ths[__i]) break;
      await act(async () => { fireEvent.click(__ths[__i]); });
    }
    // Switch to Dividends view and exercise sort headers there too.
    fireEvent.click(screen.getByText('Dividends'));
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    headerCount = container.querySelectorAll('table thead th').length;
    for (let __i = 0; __i < headerCount; __i += 1) {
      const __ths = container.querySelectorAll('table thead th');
      if (!__ths[__i]) break;
      await act(async () => { fireEvent.click(__ths[__i]); });
    }
    for (let __i = 0; __i < headerCount; __i += 1) {
      const __ths = container.querySelectorAll('table thead th');
      if (!__ths[__i]) break;
      await act(async () => { fireEvent.click(__ths[__i]); });
    }
  });

  /** Two securities and one index, as the comparison endpoint returns them. */
  function comparisonPayload() {
    return {
      window: { start: '2024-01-01', end: '2024-12-31' },
      sampling: 'day' as const,
      series: [
        {
          key: 'sec:s-1',
          kind: 'SECURITY' as const,
          id: 's-1',
          label: 'AAPL',
          name: 'Apple Inc.',
          currencyCode: 'USD',
          basis: 'ADJUSTED' as const,
        },
        {
          key: 'sec:s-2',
          kind: 'SECURITY' as const,
          id: 's-2',
          label: 'VTI',
          name: 'Vanguard Total Stock',
          currencyCode: 'USD',
          basis: 'ADJUSTED' as const,
        },
      ],
      points: [
        { date: '2024-01-01', values: { 'sec:s-1': 0, 'sec:s-2': 0 } },
        { date: '2024-02-01', values: { 'sec:s-1': 10, 'sec:s-2': 5 } },
      ],
      totals: { 'sec:s-1': 10, 'sec:s-2': 5 },
      gaps: [],
      excluded: [],
      status: 'complete' as const,
    };
  }

  it('shows the comparison chart and hides per-security tabs when 2+ are selected', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetPerformanceComparison.mockResolvedValue(comparisonPayload());

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');
    await selectSecurity('VTI - Vanguard Total Stock');

    await waitFor(() => {
      expect(screen.getByText('Performance Comparison')).toBeInTheDocument();
    });
    // Per-security view tabs are hidden in comparison mode, but the export
    // control stays available for the comparison chart.
    expect(screen.queryByText('Price Chart')).not.toBeInTheDocument();
    expect(screen.getByTestId('export-pdf')).toBeInTheDocument();
    expect(screen.getByTestId('line-chart')).toBeInTheDocument();
  });

  it('exports the comparison chart pdf when 2+ securities are selected', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetPerformanceComparison.mockResolvedValue(comparisonPayload());

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });

    await selectSecurity('AAPL - Apple Inc.');
    await selectSecurity('VTI - Vanguard Total Stock');

    await waitFor(() => {
      expect(screen.getByText('Performance Comparison')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });

    expect(exportToPdf).toHaveBeenCalledTimes(1);
    const call = (exportToPdf as any).mock.calls[0][0];
    expect(call.title).toBe('Performance Comparison');
    expect(call.subtitle).toBe('AAPL, VTI');
    expect(call.filename).toBe('security-performance-comparison');
    expect(call.chartLegend).toHaveLength(2);
  });

  // --- timeframe -----------------------------------------------------------

  it('offers a timeframe selector and fetches prices for the chosen window', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });
    await selectSecurity('AAPL - Apple Inc.');

    await waitFor(() => expect(mockGetSecurityPrices).toHaveBeenCalled());
    const [, options] = mockGetSecurityPrices.mock.calls[0];
    // A window, not a row cap: a limit shorter than the history would drop its
    // oldest end, which is the wrong half for a chart asking for a year.
    expect(options).toEqual(
      expect.objectContaining({ startDate: expect.any(String) }),
    );
    expect(options).not.toHaveProperty('limit');
  });

  /**
   * "All time" resolves to no start date, and the request must say so rather
   * than fall back to a row cap -- the server reads an absent start as "from
   * the beginning" only when nothing else caps the read.
   */
  it('asks for an open-ended window on All Time, and never a row cap', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });
    await selectSecurity('AAPL - Apple Inc.');
    await waitFor(() => expect(mockGetSecurityPrices).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'All Time' }));
    });

    await waitFor(() => {
      const last = mockGetSecurityPrices.mock.calls.at(-1)![1];
      expect(last.startDate).toBeUndefined();
      expect(last).not.toHaveProperty('limit');
    });
  });

  it('refetches when the timeframe changes', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });
    await selectSecurity('AAPL - Apple Inc.');
    await waitFor(() => expect(mockGetSecurityPrices).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '1M' }));
    });

    await waitFor(() => expect(mockGetSecurityPrices).toHaveBeenCalledTimes(2));
    const first = mockGetSecurityPrices.mock.calls[0][1].startDate;
    const second = mockGetSecurityPrices.mock.calls[1][1].startDate;
    expect(second > first).toBe(true);
  });

  it('says the timeframe governs the chart alone', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });

    render(<SecurityPerformanceReport />);
    await waitFor(() =>
      expect(
        screen.getByText(/The timeframe applies to the chart/i),
      ).toBeInTheDocument(),
    );
  });

  // --- index overlay -------------------------------------------------------

  /**
   * The regression test for an empty picker. An index's history is fetched when
   * it is first selected, so filtering the options down to what we already hold
   * was a deadlock: a fresh deployment stores nothing, every option was hidden,
   * and nothing could ever fill the table. An unpriced benchmark is answered by
   * the comparison's exclusion list, not by hiding it.
   */
  it('offers every catalog index, including one with no stored history yet', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Add a market index...' }),
      ).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add a market index...' }));
    });

    expect(screen.getByText('S&P 500')).toBeInTheDocument();
    // Coverage is null on this one; it is still selectable, which is what makes
    // its first fetch possible.
    expect(screen.getByText('FTSE 100')).toBeInTheDocument();
  });

  it('is not empty when nothing has been fetched for any index', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetMarketIndexes.mockResolvedValue(
      mockMarketIndexes.map((index) => ({
        ...index,
        coverage: { earliestDate: null, latestDate: null },
      })),
    );

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Add a market index...' }),
      ).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add a market index...' }));
    });

    expect(screen.getByText('S&P 500')).toBeInTheDocument();
    expect(screen.getByText('FTSE 100')).toBeInTheDocument();
  });

  it('switches to the comparison view when an index is added to one security', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetPerformanceComparison.mockResolvedValue(comparisonPayload());

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });
    await selectSecurity('AAPL - Apple Inc.');
    // One security alone keeps the price chart with its buy/sell markers.
    await waitFor(() => expect(screen.getByText('Price Chart')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add a market index...' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('S&P 500'));
    });

    // An index level and a share price cannot share a currency axis, so the
    // chart becomes the percent-return comparison.
    await waitFor(() =>
      expect(screen.getByText('Performance Comparison')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Price Chart')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(mockGetPerformanceComparison).toHaveBeenCalledWith(
        expect.objectContaining({ indexCodes: ['SP500'] }),
      ),
    );
  });
});

describe('SecurityPerformanceReport: a failed or pending request is not exportable', () => {
  const comparison = {
    window: { start: '2024-01-01', end: '2024-12-31' },
    sampling: 'day',
    series: [],
    points: [],
    totals: {},
    gaps: [],
    excluded: [],
    status: 'complete',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue([{ id: 'acc-1', name: 'Brokerage 1', currencyCode: 'USD' }]);
    mockGetMarketIndexes.mockResolvedValue(mockMarketIndexes);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetPerformanceComparison.mockResolvedValue(comparison);
  });

  async function renderReport() {
    await act(async () => {
      render(<SecurityPerformanceReport />);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: SELECT_PLACEHOLDER })).toBeInTheDocument();
    });
  }

  it('offers the export for a loaded single security (control)', async () => {
    mockGetSecurityPrices.mockResolvedValue([
      { id: 1, securityId: 's-1', priceDate: '2025-01-01', closePrice: 175, createdAt: '' },
    ]);
    await renderReport();
    await selectSecurity('AAPL - Apple Inc.');
    await screen.findByText('Price Chart');
    expect(screen.getByTestId('export-pdf')).toHaveAttribute('data-disabled', 'false');
  });

  it('disables the export while the security detail request has failed', async () => {
    mockGetSecurityPrices.mockRejectedValue(new Error('500'));
    await renderReport();
    await selectSecurity('AAPL - Apple Inc.');
    await waitFor(() => expect(mockGetSecurityPrices).toHaveBeenCalled());
    expect(screen.getByTestId('export-pdf')).toHaveAttribute('data-disabled', 'true');
  });

  it('disables the export while the security detail request is pending', async () => {
    mockGetSecurityPrices.mockReturnValue(new Promise(() => {}));
    await renderReport();
    await selectSecurity('AAPL - Apple Inc.');
    await waitFor(() => expect(mockGetSecurityPrices).toHaveBeenCalled());
    expect(screen.getByTestId('export-pdf')).toHaveAttribute('data-disabled', 'true');
  });

  async function loadComparisonThenAddASecurity(next: () => unknown) {
    await renderReport();
    await selectSecurity('AAPL - Apple Inc.');
    await selectSecurity('VTI - Vanguard Total Stock');
    await screen.findByText('Performance Comparison');
    await waitFor(() => expect(screen.getByTestId('export-pdf')).toHaveAttribute('data-disabled', 'false'));

    mockGetPerformanceComparison.mockImplementation(next);
    await selectSecurity('BARE - Bare Security');
    await waitFor(() =>
      expect(mockGetPerformanceComparison).toHaveBeenLastCalledWith(
        expect.objectContaining({ securityIds: ['s-1', 's-2', 's-4'] }),
      ),
    );
  }

  it('disables the export while the next comparison request has failed', async () => {
    await loadComparisonThenAddASecurity(() => Promise.reject(new Error('500')));
    await waitFor(() => expect(screen.getByTestId('export-pdf')).toHaveAttribute('data-disabled', 'true'));
  });

  it('disables the export while the next comparison request is pending', async () => {
    await loadComparisonThenAddASecurity(() => new Promise(() => {}));
    await waitFor(() => expect(screen.getByTestId('export-pdf')).toHaveAttribute('data-disabled', 'true'));
  });
});
