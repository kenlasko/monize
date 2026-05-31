import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { DividendYieldGrowthReport } from './DividendYieldGrowthReport';

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatSignedPercent: (n: number, decimals = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (amount: number) => amount,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...inputs: any[]) => inputs.flat(Infinity).filter(Boolean).join(' '),
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
  BarChart: ({ children, data }: any) => <div data-testid="bar-chart" data-points={data?.length}>{children}</div>,
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Bar: () => null,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

const mockGetTransactions = vi.fn();
const mockGetInvestmentAccounts = vi.fn();
const mockGetPortfolioSummary = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getTransactions: (...args: any[]) => mockGetTransactions(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
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

const mockHoldings = [
  {
    id: 'h-1',
    accountId: 'acc-1',
    securityId: 's-1',
    symbol: 'VFV',
    name: 'Vanguard S&P 500',
    securityType: 'ETF',
    currencyCode: 'CAD',
    quantity: 50,
    averageCost: 80,
    costBasis: 4000,
    currentPrice: 100,
    marketValue: 5000,
    gainLoss: 1000,
    gainLossPercent: 25,
  },
];

describe('DividendYieldGrowthReport', () => {
  // The report uses subYears(new Date(), 1) as a trailing-12-months cutoff.
  // Test fixtures (e.g. the "annual" test that puts a payment on 2025-05-10)
  // are dated relative to a specific "today" -- so the suite needs that
  // "today" pinned, otherwise transactions land on or past the boundary on
  // certain wall-clock days and get filtered out.
  beforeAll(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-05-06T12:00:00Z'));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetTransactions.mockReturnValue(new Promise(() => {}));
    mockGetInvestmentAccounts.mockReturnValue(new Promise(() => {}));
    mockGetPortfolioSummary.mockReturnValue(new Promise(() => {}));
    render(<DividendYieldGrowthReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no dividend transactions', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: [] });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText(/No dividend transactions found/)).toBeInTheDocument();
    });
  });

  it('renders summary cards with data', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2025-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          securityId: 's-1',
          security: { symbol: 'VFV', name: 'Vanguard S&P 500' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio Yield')).toBeInTheDocument();
    });
    expect(screen.getByText('Trailing 12M Dividends')).toBeInTheDocument();
    expect(screen.getByText('Portfolio Value')).toBeInTheDocument();
    expect(screen.getByText('Dividend Payers')).toBeInTheDocument();
  });

  it('renders view type buttons', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: [] });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Per-Security Yield')).toBeInTheDocument();
    });
    expect(screen.getByText('Year-over-Year')).toBeInTheDocument();
    expect(screen.getByText('Frequency')).toBeInTheDocument();
  });

  it('shows yield table by default with dividend data', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2025-09-15',
          action: 'DIVIDEND',
          totalAmount: 150,
          accountId: 'acc-1',
          securityId: 's-1',
          security: { symbol: 'VFV', name: 'Vanguard S&P 500' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Per-Security Dividend Yield (Trailing 12 Months)')).toBeInTheDocument();
    });
  });

  it('switches to year-over-year view', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          securityId: 's-1',
          security: { symbol: 'VFV', name: 'Vanguard S&P 500' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Year-over-Year')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Year-over-Year'));
    await waitFor(() => {
      expect(screen.getByText('Annual Dividend Income')).toBeInTheDocument();
    });
  });

  it('switches to frequency view', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2025-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          securityId: 's-1',
          security: { symbol: 'VFV', name: 'Vanguard S&P 500' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getAllByText('Frequency').length).toBeGreaterThanOrEqual(1);
    });

    // Click the Frequency button (the first one is the button)
    fireEvent.click(screen.getAllByText('Frequency')[0]);
    await waitFor(() => {
      expect(screen.getByText('Dividend Frequency Analysis')).toBeInTheDocument();
    });
  });

  it('aggregates market value across accounts holding the same security', async () => {
    // Only return transactions for DIVIDEND action so numbers are deterministic
    mockGetTransactions.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'DIVIDEND') {
        return {
          data: [
            {
              id: 'tx-1',
              transactionDate: '2025-09-15',
              action: 'DIVIDEND',
              totalAmount: 100,
              accountId: 'acc-1',
              securityId: 's-1',
              security: { symbol: 'VFV', name: 'Vanguard S&P 500' },
            },
          ],
          pagination: { hasMore: false },
        };
      }
      return { data: [], pagination: { hasMore: false } };
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [
        { ...mockHoldings[0], id: 'h-1', accountId: 'acc-1', marketValue: 5000 },
        { ...mockHoldings[0], id: 'h-2', accountId: 'acc-2', marketValue: 5000 },
      ],
    });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Per-Security Dividend Yield (Trailing 12 Months)')).toBeInTheDocument();
    });
    // Market value appears in both the Portfolio Value summary card and the table row
    expect(screen.getAllByText('$10000.00').length).toBeGreaterThanOrEqual(2);
    // Yield = 100 / 10000 * 100 = 1.00%. Without aggregation it would be 2.00%.
    expect(screen.getAllByText('1.00%').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('2.00%')).not.toBeInTheDocument();
  });

  it('excludes dividends for securities with no matching holding', async () => {
    mockGetTransactions.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'DIVIDEND') {
        return {
          data: [
            {
              id: 'tx-ghost',
              transactionDate: '2025-09-15',
              action: 'DIVIDEND',
              totalAmount: 50,
              accountId: 'acc-1',
              securityId: 's-ghost',
              security: null,
            },
            {
              id: 'tx-2',
              transactionDate: '2025-09-20',
              action: 'DIVIDEND',
              totalAmount: 100,
              accountId: 'acc-1',
              securityId: 's-1',
              security: { symbol: 'VFV', name: 'Vanguard S&P 500' },
            },
          ],
          pagination: { hasMore: false },
        };
      }
      return { data: [], pagination: { hasMore: false } };
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Per-Security Dividend Yield (Trailing 12 Months)')).toBeInTheDocument();
    });
    expect(screen.getByText('VFV')).toBeInTheDocument();
    // The unknown-security fallback name would only appear if an unknown row rendered
    expect(screen.queryByText('Unknown Security')).not.toBeInTheDocument();
    // Only the header row and a single VFV data row should be present
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });

  it('excludes dividend transactions with no securityId', async () => {
    mockGetTransactions.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'DIVIDEND') {
        return {
          data: [
            {
              id: 'tx-no-sec',
              transactionDate: '2025-09-15',
              action: 'DIVIDEND',
              totalAmount: 25,
              accountId: 'acc-1',
              securityId: null,
              security: null,
            },
            {
              id: 'tx-2',
              transactionDate: '2025-09-20',
              action: 'DIVIDEND',
              totalAmount: 100,
              accountId: 'acc-1',
              securityId: 's-1',
              security: { symbol: 'VFV', name: 'Vanguard S&P 500' },
            },
          ],
          pagination: { hasMore: false },
        };
      }
      return { data: [], pagination: { hasMore: false } };
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Per-Security Dividend Yield (Trailing 12 Months)')).toBeInTheDocument();
    });
    expect(screen.getByText('VFV')).toBeInTheDocument();
    expect(screen.queryByText('Unknown Security')).not.toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });

  it('shows growth view with annual data table', async () => {
    // Transactions across two years to exercise the growth view
    mockGetTransactions.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'DIVIDEND') {
        return {
          data: [
            { id: 'tx-1', transactionDate: '2025-03-15', action: 'DIVIDEND', totalAmount: 200, accountId: 'acc-1', securityId: 's-1' },
            { id: 'tx-2', transactionDate: '2026-01-15', action: 'DIVIDEND', totalAmount: 300, accountId: 'acc-1', securityId: 's-1' },
          ],
          pagination: { hasMore: false },
        };
      }
      return { data: [], pagination: { hasMore: false } };
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Year-over-Year')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Year-over-Year'));
    await waitFor(() => {
      expect(screen.getByText('Annual Dividend Income')).toBeInTheDocument();
    });
    // The growth table should show data rows for each year
    expect(screen.getByText('2025')).toBeInTheDocument();
    expect(screen.getByText('2026')).toBeInTheDocument();
  });

  it('shows frequency view with frequency breakdown table', async () => {
    // Transactions that generate securityYield entries (within trailing 12m)
    mockGetTransactions.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'DIVIDEND') {
        return {
          data: [
            { id: 'tx-1', transactionDate: '2025-09-15', action: 'DIVIDEND', totalAmount: 100, accountId: 'acc-1', securityId: 's-1' },
          ],
          pagination: { hasMore: false },
        };
      }
      return { data: [], pagination: { hasMore: false } };
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getAllByText('Frequency').length).toBeGreaterThanOrEqual(1);
    });
    fireEvent.click(screen.getAllByText('Frequency')[0]);
    await waitFor(() => {
      expect(screen.getByText('Dividend Frequency Analysis')).toBeInTheDocument();
    });
    // The frequency table should have a row for 'Unknown' (only one date so detectFrequency = Unknown)
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('shows year-over-year growth table with positive and negative growth rows', async () => {
    mockGetTransactions.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'DIVIDEND') {
        return {
          data: [
            { id: 'tx-1', transactionDate: '2023-06-15', action: 'DIVIDEND', totalAmount: 200, accountId: 'acc-1', securityId: 's-1' },
            { id: 'tx-2', transactionDate: '2024-06-15', action: 'DIVIDEND', totalAmount: 300, accountId: 'acc-1', securityId: 's-1' },
            { id: 'tx-3', transactionDate: '2025-06-15', action: 'DIVIDEND', totalAmount: 150, accountId: 'acc-1', securityId: 's-1' },
          ],
          pagination: { hasMore: false },
        };
      }
      return { data: [], pagination: { hasMore: false } };
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Year-over-Year')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Year-over-Year'));
    await waitFor(() => {
      expect(screen.getByText('Annual Dividend Income')).toBeInTheDocument();
    });
    // 2023 row should show '-' for growth (no prior year)
    expect(screen.getByText('-')).toBeInTheDocument();
    // 2024 shows positive growth (+50%)
    expect(screen.getByText('+50.0%')).toBeInTheDocument();
    // 2025 shows negative growth (-50%)
    expect(screen.getByText('-50.0%')).toBeInTheDocument();
  });

  it('shows frequency analysis chart and table with data', async () => {
    mockGetTransactions.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'DIVIDEND') {
        return {
          data: [
            { id: 'tx-1', transactionDate: '2025-03-15', action: 'DIVIDEND', totalAmount: 100, accountId: 'acc-1', securityId: 's-1' },
            { id: 'tx-2', transactionDate: '2025-06-15', action: 'DIVIDEND', totalAmount: 100, accountId: 'acc-1', securityId: 's-1' },
            { id: 'tx-3', transactionDate: '2025-09-15', action: 'DIVIDEND', totalAmount: 100, accountId: 'acc-1', securityId: 's-1' },
            { id: 'tx-4', transactionDate: '2025-12-15', action: 'DIVIDEND', totalAmount: 100, accountId: 'acc-1', securityId: 's-1' },
          ],
          pagination: { hasMore: false },
        };
      }
      return { data: [], pagination: { hasMore: false } };
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getAllByText('Frequency').length).toBeGreaterThanOrEqual(1);
    });
    fireEvent.click(screen.getAllByText('Frequency')[0]);
    await waitFor(() => {
      expect(screen.getByText('Dividend Frequency Analysis')).toBeInTheDocument();
    });
    // Quarterly frequency should appear (4 payments ~90 days apart)
    expect(screen.getByText('Quarterly')).toBeInTheDocument();
  });

  it('paginates through multiple pages of transactions', async () => {
    let callCount = 0;
    mockGetTransactions.mockImplementation(async ({ action, page }: { action: string; page: number }) => {
      if (action !== 'DIVIDEND') return { data: [], pagination: { hasMore: false } };
      callCount++;
      if (page === 1) {
        return {
          data: [{ id: 'tx-p1', transactionDate: '2025-06-15', action: 'DIVIDEND', totalAmount: 100, accountId: 'acc-1', securityId: 's-1' }],
          pagination: { hasMore: true },
        };
      }
      return {
        data: [{ id: 'tx-p2', transactionDate: '2025-07-15', action: 'DIVIDEND', totalAmount: 50, accountId: 'acc-1', securityId: 's-1' }],
        pagination: { hasMore: false },
      };
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Per-Security Dividend Yield (Trailing 12 Months)')).toBeInTheDocument();
    });
    // Should have fetched page 1 and page 2 for DIVIDEND
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('re-fetches data when account selection changes', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: [] });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('All Accounts')).toBeInTheDocument();
    });
    const initialCallCount = mockGetTransactions.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Filter by account' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('TFSA'));
    });
    await waitFor(() => {
      expect(mockGetTransactions.mock.calls.length).toBeGreaterThan(initialCallCount);
    });
  });

  it('handles loadData error gracefully', async () => {
    mockGetTransactions.mockRejectedValue(new Error('network error'));
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: [] });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      // Error swallowed — component should render without loading spinner
      expect(document.querySelector('.animate-pulse')).toBeFalsy();
    });
  });

  it('exports PDF in yield view', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetTransactions.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'DIVIDEND') {
        return {
          data: [{ id: 'tx-1', transactionDate: '2025-09-15', action: 'DIVIDEND', totalAmount: 100, accountId: 'acc-1', securityId: 's-1' }],
          pagination: { hasMore: false },
        };
      }
      return { data: [], pagination: { hasMore: false } };
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Per-Security Dividend Yield (Trailing 12 Months)')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    expect(exportToPdf).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Dividend Yield & Growth', subtitle: 'Per-Security Yield' }),
    );
  });

  it('exports PDF in growth view', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetTransactions.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'DIVIDEND') {
        return {
          data: [{ id: 'tx-1', transactionDate: '2025-09-15', action: 'DIVIDEND', totalAmount: 100, accountId: 'acc-1', securityId: 's-1' }],
          pagination: { hasMore: false },
        };
      }
      return { data: [], pagination: { hasMore: false } };
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Year-over-Year')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Year-over-Year'));
    await waitFor(() => {
      expect(screen.getByText('Annual Dividend Income')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    expect(exportToPdf).toHaveBeenCalledWith(
      expect.objectContaining({ subtitle: 'Year-over-Year' }),
    );
  });

  it('exports PDF in frequency view', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetTransactions.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'DIVIDEND') {
        return {
          data: [
            { id: 'tx-1', transactionDate: '2025-03-15', action: 'DIVIDEND', totalAmount: 100, accountId: 'acc-1', securityId: 's-1' },
            { id: 'tx-2', transactionDate: '2025-06-15', action: 'DIVIDEND', totalAmount: 100, accountId: 'acc-1', securityId: 's-1' },
            { id: 'tx-3', transactionDate: '2025-09-15', action: 'DIVIDEND', totalAmount: 100, accountId: 'acc-1', securityId: 's-1' },
          ],
          pagination: { hasMore: false },
        };
      }
      return { data: [], pagination: { hasMore: false } };
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getAllByText('Frequency').length).toBeGreaterThanOrEqual(1);
    });
    fireEvent.click(screen.getAllByText('Frequency')[0]);
    await waitFor(() => {
      expect(screen.getByText('Dividend Frequency Analysis')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    expect(exportToPdf).toHaveBeenCalledWith(
      expect.objectContaining({ subtitle: 'Frequency' }),
    );
  });

  it('shows portfolio yield as 0 when portfolio value is zero', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [{ id: 'tx-1', transactionDate: '2025-09-15', action: 'DIVIDEND', totalAmount: 100, accountId: 'acc-1', securityId: 's-1' }],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    // No holdings means totalPortfolioValue = 0, portfolioYield = 0
    mockGetPortfolioSummary.mockResolvedValue({ holdings: [] });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio Yield')).toBeInTheDocument();
    });
    // Portfolio Yield summary card div contains '0.00' and '%' as siblings
    const yieldCard = screen.getByText('Portfolio Yield').closest('div')?.parentElement;
    expect(yieldCard?.textContent).toContain('0.00%');
  });

  it('uses account currency when an account is selected (getTxAmount with selectedAccountId)', async () => {
    mockGetTransactions.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'DIVIDEND') {
        return {
          data: [{ id: 'tx-1', transactionDate: '2025-09-15', action: 'DIVIDEND', totalAmount: 200, accountId: 'acc-1', securityId: 's-1' }],
          pagination: { hasMore: false },
        };
      }
      return { data: [], pagination: { hasMore: false } };
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });
    await act(async () => { fireEvent.click(trigger); });
    await act(async () => {
      fireEvent.click(screen.getByText('TFSA'));
    });
    await waitFor(() => {
      // After selecting account, the yield table should still render with that account's data
      expect(screen.queryByText(/Portfolio Yield/)).toBeInTheDocument();
    });
  });

  it('detects monthly dividend frequency', async () => {
    // 12 payments, one per month = ~30 day gap => Monthly
    const now = new Date('2025-12-15');
    const txData = Array.from({ length: 12 }, (_, i) => ({
      id: `tx-${i}`,
      transactionDate: new Date(now.getFullYear(), now.getMonth() - i, 15).toISOString().slice(0, 10),
      action: 'DIVIDEND',
      totalAmount: 50,
      accountId: 'acc-1',
      securityId: 's-1',
    }));
    mockGetTransactions.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'DIVIDEND') return { data: txData, pagination: { hasMore: false } };
      return { data: [], pagination: { hasMore: false } };
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Per-Security Dividend Yield (Trailing 12 Months)')).toBeInTheDocument();
    });
    expect(screen.getByText('Monthly')).toBeInTheDocument();
  });

  it('detects annual dividend frequency', async () => {
    // 2 payments far enough apart to count as annual, both well inside trailing 12 months
    const now = new Date();
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    const recent = new Date(now);
    recent.setDate(recent.getDate() - 14);
    const older = new Date(recent);
    older.setDate(older.getDate() - 250);
    mockGetTransactions.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'DIVIDEND') {
        return {
          data: [
            { id: 'tx-1', transactionDate: ymd(older), action: 'DIVIDEND', totalAmount: 300, accountId: 'acc-1', securityId: 's-1' },
            { id: 'tx-2', transactionDate: ymd(recent), action: 'DIVIDEND', totalAmount: 300, accountId: 'acc-1', securityId: 's-1' },
          ],
          pagination: { hasMore: false },
        };
      }
      return { data: [], pagination: { hasMore: false } };
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Per-Security Dividend Yield (Trailing 12 Months)')).toBeInTheDocument();
    });
    expect(screen.getByText('Annual')).toBeInTheDocument();
  });

  it('detects semi-annual dividend frequency', async () => {
    // 2 payments ~180 days apart within trailing 12m (current date 2026-05-06, cutoff 2025-05-06)
    mockGetTransactions.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'DIVIDEND') {
        return {
          data: [
            { id: 'tx-1', transactionDate: '2025-08-15', action: 'DIVIDEND', totalAmount: 200, accountId: 'acc-1', securityId: 's-1' },
            { id: 'tx-2', transactionDate: '2026-02-15', action: 'DIVIDEND', totalAmount: 200, accountId: 'acc-1', securityId: 's-1' },
          ],
          pagination: { hasMore: false },
        };
      }
      return { data: [], pagination: { hasMore: false } };
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Per-Security Dividend Yield (Trailing 12 Months)')).toBeInTheDocument();
    });
    expect(screen.getByText('Semi-Annual')).toBeInTheDocument();
  });

  it('detects unknown frequency for a single dividend date', async () => {
    // Only 1 date in the trailing 12m — detectFrequency returns 'Unknown'
    mockGetTransactions.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'DIVIDEND') {
        return {
          data: [
            { id: 'tx-1', transactionDate: '2025-09-15', action: 'DIVIDEND', totalAmount: 100, accountId: 'acc-1', securityId: 's-1' },
          ],
          pagination: { hasMore: false },
        };
      }
      return { data: [], pagination: { hasMore: false } };
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Per-Security Dividend Yield (Trailing 12 Months)')).toBeInTheDocument();
    });
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('shows per-security yield as 0 when market value is 0', async () => {
    mockGetTransactions.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'DIVIDEND') {
        return {
          data: [{ id: 'tx-1', transactionDate: '2025-09-15', action: 'DIVIDEND', totalAmount: 100, accountId: 'acc-1', securityId: 's-1' }],
          pagination: { hasMore: false },
        };
      }
      return { data: [], pagination: { hasMore: false } };
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [{ ...mockHoldings[0], marketValue: 0 }],
    });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Per-Security Dividend Yield (Trailing 12 Months)')).toBeInTheDocument();
    });
    // Yield = 0 / 0 = 0.00% — appears in both summary card and yield table
    expect(screen.getAllByText('0.00%').length).toBeGreaterThanOrEqual(1);
  });

  it('switches back to yield view after visiting growth view', async () => {
    mockGetTransactions.mockImplementation(async ({ action }: { action: string }) => {
      if (action === 'DIVIDEND') {
        return {
          data: [{ id: 'tx-1', transactionDate: '2025-09-15', action: 'DIVIDEND', totalAmount: 100, accountId: 'acc-1', securityId: 's-1' }],
          pagination: { hasMore: false },
        };
      }
      return { data: [], pagination: { hasMore: false } };
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<DividendYieldGrowthReport />);
    await waitFor(() => {
      expect(screen.getByText('Year-over-Year')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Year-over-Year'));
    await waitFor(() => {
      expect(screen.getByText('Annual Dividend Income')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Per-Security Yield'));
    await waitFor(() => {
      expect(screen.getByText('Per-Security Dividend Yield (Trailing 12 Months)')).toBeInTheDocument();
    });
  });

  it('exercises sort headers on yield, growth, and frequency tables', async () => {
    // Use recent dates so they fall within the trailing 12-month cutoff that
    // securityYields filters on; otherwise the table renders empty and the
    // sort comparator never runs.
    const today = new Date();
    const recentDate = (monthsAgo: number) => {
      const d = new Date(today);
      d.setMonth(d.getMonth() - monthsAgo);
      return d.toISOString().slice(0, 10);
    };
    mockGetTransactions.mockResolvedValue({
      data: [
        // sec-1: Monthly cadence (multiple recent dividends)
        ...[1, 2, 3, 4].map((m, i) => ({
          id: `tx-1-${i}`,
          accountId: 'acc-1',
          securityId: 'sec-1',
          security: { symbol: 'AAA', name: 'Alpha' },
          transactionDate: recentDate(m),
          totalAmount: 100,
          action: 'DIVIDEND' as const,
        })),
        // sec-2: Quarterly cadence
        ...[1, 4].map((m, i) => ({
          id: `tx-2-${i}`,
          accountId: 'acc-1',
          securityId: 'sec-2',
          security: { symbol: 'BBB', name: 'Bravo' },
          transactionDate: recentDate(m),
          totalAmount: 50,
          action: 'DIVIDEND' as const,
        })),
      ],
      pagination: { hasMore: false },
    });
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [
        { securityId: 'sec-1', symbol: 'AAA', name: 'Alpha', currencyCode: 'CAD', marketValue: 5000 },
        { securityId: 'sec-2', symbol: 'BBB', name: 'Bravo', currencyCode: 'CAD', marketValue: 2500 },
      ],
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    const { container } = render(<DividendYieldGrowthReport />);
    await waitFor(() => expect(screen.getByText('Per-Security Dividend Yield (Trailing 12 Months)')).toBeInTheDocument());
    // Yield table sort.
    let __headerCount = container.querySelectorAll('table thead th').length;
    for (let __i = 0; __i < __headerCount; __i += 1) {
      const __ths = container.querySelectorAll('table thead th');
      if (!__ths[__i]) break;
      fireEvent.click(__ths[__i]);
    }
    for (let __i = 0; __i < __headerCount; __i += 1) {
      const __ths = container.querySelectorAll('table thead th');
      if (!__ths[__i]) break;
      fireEvent.click(__ths[__i]);
    }
    // Switch to Year-over-Year.
    fireEvent.click(screen.getByText('Year-over-Year'));
    await waitFor(() => expect(screen.getByText('Annual Dividend Income')).toBeInTheDocument());
    {
      const yHeaderCount = container.querySelectorAll('table thead th').length;
      for (let __i = 0; __i < yHeaderCount; __i += 1) {
        const __ths = container.querySelectorAll('table thead th');
        if (!__ths[__i]) break;
        fireEvent.click(__ths[__i]);
      }
      for (let __i = 0; __i < yHeaderCount; __i += 1) {
        const __ths = container.querySelectorAll('table thead th');
        if (!__ths[__i]) break;
        fireEvent.click(__ths[__i]);
      }
    }
    // Switch to Frequency view.
    fireEvent.click(screen.getByText('Frequency'));
    await waitFor(() => expect(screen.getByText('Dividend Frequency Analysis')).toBeInTheDocument());
    {
      const fHeaderCount = container.querySelectorAll('table thead th').length;
      for (let __i = 0; __i < fHeaderCount; __i += 1) {
        const __ths = container.querySelectorAll('table thead th');
        if (!__ths[__i]) break;
        fireEvent.click(__ths[__i]);
      }
      for (let __i = 0; __i < fHeaderCount; __i += 1) {
        const __ths = container.querySelectorAll('table thead th');
        if (!__ths[__i]) break;
        fireEvent.click(__ths[__i]);
      }
    }
  });
});
