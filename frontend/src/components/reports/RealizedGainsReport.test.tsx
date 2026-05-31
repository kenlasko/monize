import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { RealizedGainsReport } from './RealizedGainsReport';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (amount: number, _currency: string) => amount,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/hooks/useDateRange', () => {
  const resolvedRange = { start: '2025-01-01', end: '2026-01-01' };
  return {
    useDateRange: () => ({
      dateRange: '1y',
      setDateRange: vi.fn(),
      startDate: '',
      setStartDate: vi.fn(),
      endDate: '',
      setEndDate: vi.fn(),
      resolvedRange,
      isValid: true,
    }),
  };
});

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...inputs: any[]) => inputs.flat(Infinity).filter(Boolean).join(' '),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock('@/components/ui/ExportDropdown', () => ({
  ExportDropdown: ({ onExportCsv, onExportPdf }: any) => (
    <div data-testid="export-dropdown">
      <button data-testid="export-csv" onClick={onExportCsv}>CSV</button>
      <button data-testid="export-pdf" onClick={onExportPdf}>PDF</button>
    </div>
  ),
}));

const mockExportToCsv = vi.fn();
vi.mock('@/lib/csv-export', () => ({
  exportToCsv: (...args: any[]) => mockExportToCsv(...args),
}));

const mockExportToPdf = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

const mockGetRealizedGains = vi.fn();
const mockGetInvestmentAccounts = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getRealizedGains: (...args: any[]) => mockGetRealizedGains(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
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

const gainEntry = (overrides: Partial<Record<string, unknown>> = {}) => ({
  transactionId: 'sell-1',
  transactionDate: '2025-06-15',
  accountId: 'acc-1',
  accountName: 'TFSA',
  accountCurrencyCode: 'CAD',
  securityId: 'sec-1',
  symbol: 'AAPL',
  securityName: 'Apple Inc.',
  securityCurrencyCode: 'CAD',
  quantity: 50,
  price: 110,
  commission: 0,
  proceeds: 5500,
  costBasis: 5000,
  realizedGain: 500,
  ...overrides,
});

describe('RealizedGainsReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetRealizedGains.mockReturnValue(new Promise(() => {}));
    mockGetInvestmentAccounts.mockReturnValue(new Promise(() => {}));
    render(<RealizedGainsReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no sell transactions', async () => {
    mockGetRealizedGains.mockResolvedValue([]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByText(/No sell transactions found/)).toBeInTheDocument();
    });
  });

  it('renders summary cards with realized gain data', async () => {
    mockGetRealizedGains.mockResolvedValue([
      gainEntry(),
      gainEntry({
        transactionId: 'sell-2',
        transactionDate: '2025-08-20',
        symbol: 'MSFT',
        securityName: 'Microsoft Corp.',
        proceeds: 3300,
        costBasis: 3000,
        realizedGain: 300,
      }),
    ]);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Proceeds')).toBeInTheDocument();
    });
    expect(screen.getByText('Cost Basis')).toBeInTheDocument();
    expect(screen.getByText('Realized Gain/Loss')).toBeInTheDocument();
    expect(screen.getByText('Securities Sold')).toBeInTheDocument();
  });

  it('renders view type toggle buttons', async () => {
    mockGetRealizedGains.mockResolvedValue([]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByTitle('Chart')).toBeInTheDocument();
    });
    expect(screen.getByTitle('Table')).toBeInTheDocument();
  });

  it('renders chart with gain data', async () => {
    mockGetRealizedGains.mockResolvedValue([gainEntry()]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByText('Realized Gains by Security')).toBeInTheDocument();
    });
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });

  it('renders sell transactions table', async () => {
    mockGetRealizedGains.mockResolvedValue([gainEntry()]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByText(/Sell Transactions/)).toBeInTheDocument();
    });
    expect(screen.getByText('AAPL')).toBeInTheDocument();
  });

  it('queries the realized-gains endpoint with the selected date range', async () => {
    mockGetRealizedGains.mockResolvedValue([]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(mockGetRealizedGains).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: '2025-01-01',
          endDate: '2026-01-01',
        }),
      );
    });
  });

  it('switches to table view when Table button is clicked', async () => {
    mockGetRealizedGains.mockResolvedValue([gainEntry()]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByTitle('Table')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle('Table'));
    });
    expect(screen.getByText('Realized Gains Detail')).toBeInTheDocument();
  });

  it('switches back to chart view when Chart button is clicked', async () => {
    mockGetRealizedGains.mockResolvedValue([gainEntry()]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByTitle('Table')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle('Table'));
    });
    expect(screen.getByText('Realized Gains Detail')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTitle('Chart'));
    });
    expect(screen.getByText('Realized Gains by Security')).toBeInTheDocument();
  });

  it('shows table view with security rows and totals', async () => {
    mockGetRealizedGains.mockResolvedValue([
      gainEntry(),
      gainEntry({
        transactionId: 'sell-loss',
        symbol: 'TSLA',
        securityName: 'Tesla Inc.',
        proceeds: 2000,
        costBasis: 3000,
        realizedGain: -1000,
      }),
    ]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByTitle('Table')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle('Table'));
    });
    expect(screen.getAllByText('TSLA').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Tesla Inc.').length).toBeGreaterThan(0);
    expect(screen.getByText('Total')).toBeInTheDocument();
  });

  it('shows no gains or losses message when all chartData gains are zero', async () => {
    mockGetRealizedGains.mockResolvedValue([
      gainEntry({ proceeds: 5000, costBasis: 5000, realizedGain: 0 }),
    ]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByText('No gains or losses to display.')).toBeInTheDocument();
    });
  });

  it('shows gainers and losers count in Securities Sold card', async () => {
    mockGetRealizedGains.mockResolvedValue([
      gainEntry({ transactionId: 'g1', symbol: 'AAPL', realizedGain: 500 }),
      gainEntry({ transactionId: 'l1', symbol: 'TSLA', realizedGain: -200 }),
    ]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByText('1 gain')).toBeInTheDocument();
    });
    expect(screen.getByText('1 loss')).toBeInTheDocument();
  });

  it('shows only gainers count when no losers', async () => {
    mockGetRealizedGains.mockResolvedValue([
      gainEntry({ transactionId: 'g1', symbol: 'AAPL', realizedGain: 500 }),
    ]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByText('1 gain')).toBeInTheDocument();
    });
  });

  it('shows only losers count when no gainers', async () => {
    mockGetRealizedGains.mockResolvedValue([
      gainEntry({ transactionId: 'l1', symbol: 'TSLA', realizedGain: -300 }),
    ]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByText('1 loss')).toBeInTheDocument();
    });
  });

  it('shows negative total gain in red', async () => {
    mockGetRealizedGains.mockResolvedValue([
      gainEntry({ symbol: 'TSLA', realizedGain: -1000 }),
    ]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      // negative gain card has red class
      const gainCard = screen.getByText('Realized Gain/Loss').nextElementSibling as HTMLElement;
      expect(gainCard.className).toMatch(/red/);
    });
  });

  it('exports CSV with realized gains data', async () => {
    mockGetRealizedGains.mockResolvedValue([gainEntry()]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByTestId('export-csv')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-csv'));
    });
    expect(mockExportToCsv).toHaveBeenCalledWith(
      'realized-gains',
      expect.arrayContaining(['Security', 'Date Sold']),
      expect.any(Array),
    );
  });

  it('exports CSV with dash for return % when cost basis is zero', async () => {
    mockGetRealizedGains.mockResolvedValue([
      gainEntry({ costBasis: 0, proceeds: 1000, realizedGain: 1000 }),
    ]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByTestId('export-csv')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-csv'));
    });
    expect(mockExportToCsv).toHaveBeenCalled();
    const rows = mockExportToCsv.mock.calls[0][2] as any[][];
    // Last column (Return %) should be '-' when costBasis is 0
    expect(rows[0][rows[0].length - 1]).toBe('-');
  });

  it('exports CSV with N/A for symbol when symbol is null', async () => {
    mockGetRealizedGains.mockResolvedValue([
      gainEntry({ symbol: null }),
    ]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByTestId('export-csv')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-csv'));
    });
    expect(mockExportToCsv).toHaveBeenCalled();
    const rows = mockExportToCsv.mock.calls[0][2] as any[][];
    expect(rows[0][0]).toBe('N/A');
  });

  it('exports PDF with realized gains data', async () => {
    mockGetRealizedGains.mockResolvedValue([gainEntry()]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByTestId('export-pdf')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    await waitFor(() => {
      expect(mockExportToPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Realized Gains Report',
          filename: 'realized-gains',
        }),
      );
    });
  });

  it('uses Unknown symbol and name for entries with no symbol/securityName', async () => {
    mockGetRealizedGains.mockResolvedValue([
      gainEntry({ symbol: null, securityName: null }),
    ]);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByText(/Sell Transactions/)).toBeInTheDocument();
    });
    // Table view should show N/A for null symbol
    await act(async () => {
      fireEvent.click(screen.getByTitle('Table'));
    });
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('Unknown Security')).toBeInTheDocument();
  });

  it('filters out INVESTMENT_BROKERAGE accounts from the account filter', async () => {
    mockGetRealizedGains.mockResolvedValue([]);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-cash', name: 'TFSA Cash', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      { id: 'acc-broker', name: 'TFSA Brokerage', currencyCode: 'CAD', accountSubType: 'INVESTMENT_BROKERAGE' },
    ]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByText('No sell transactions found for this period.')).toBeInTheDocument();
    });
    // Open the account filter: cash account appears; brokerage should not
    fireEvent.click(screen.getByRole('button', { name: 'Filter by account' }));
    expect(screen.getByText('TFSA Cash')).toBeInTheDocument();
    expect(screen.queryByText('TFSA Brokerage')).not.toBeInTheDocument();
  });

  it('shows a retryable error when realized gains fail to load', async () => {
    mockGetRealizedGains.mockRejectedValue(new Error('Network error'));
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load report data/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });

  it('handles API error for accounts gracefully', async () => {
    mockGetRealizedGains.mockResolvedValue([]);
    mockGetInvestmentAccounts.mockRejectedValue(new Error('Network error'));
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByText('No sell transactions found for this period.')).toBeInTheDocument();
    });
  });

  it('formats values with currency code when a foreign-currency account is selected', async () => {
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-usd', name: 'US Brokerage', currencyCode: 'USD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetRealizedGains.mockResolvedValue([gainEntry({ accountCurrencyCode: 'USD' })]);
    render(<RealizedGainsReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });
    // Select the USD account to trigger isForeign = true path
    await act(async () => { fireEvent.click(trigger); });
    await act(async () => {
      fireEvent.click(screen.getByText('US Brokerage'));
    });
    await waitFor(() => {
      // When isForeign, fmtValue appends the currency code
      // Look for any element containing "USD" as a suffix (formatCurrencyFull appends " USD")
      expect(screen.getAllByText(/USD$/).length).toBeGreaterThan(0);
    });
  });

  it('uses convertToDefault when no account is selected (All Accounts)', async () => {
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetRealizedGains.mockResolvedValue([
      gainEntry({ accountCurrencyCode: 'USD', proceeds: 1000, costBasis: 800, realizedGain: 200 }),
    ]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Proceeds')).toBeInTheDocument();
    });
    // No account selected -> toDisplay calls convertToDefault (which is identity in mock)
    expect(screen.getByText(/Sell Transactions/)).toBeInTheDocument();
  });

  it('exercises sort headers on security and sells tables', async () => {
    mockGetRealizedGains.mockResolvedValue([
      gainEntry({ transactionId: 'sell-bbb', symbol: 'BBB', securityName: 'Bravo', transactionDate: '2024-02-15', quantity: 5, price: 100, proceeds: 500, costBasis: 400, realizedGain: 100, accountCurrencyCode: 'CAD' }),
      gainEntry({ transactionId: 'sell-aaa', symbol: 'AAA', securityName: 'Alpha', transactionDate: '2024-01-15', quantity: 10, price: 50, proceeds: 500, costBasis: 600, realizedGain: -100, accountCurrencyCode: 'CAD' }),
      gainEntry({ transactionId: 'sell-ccc', symbol: 'CCC', securityName: 'Charlie', transactionDate: '2024-03-15', quantity: 2, price: 200, proceeds: 400, costBasis: 300, realizedGain: 100, accountCurrencyCode: 'CAD' }),
    ]);
    const { container } = render(<RealizedGainsReport />);
    await waitFor(() => expect(screen.getByTitle('Table')).toBeInTheDocument());
    // Switch to security table view.
    fireEvent.click(screen.getByTitle('Table'));
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    // First table = securities (Symbol/Trades/Proceeds/Cost Basis/Gain) summary.
    // Second table = individual sell transactions.
    const tableCount = container.querySelectorAll('table').length;
    for (let t = 0; t < tableCount; t += 1) {
      const tableNow = container.querySelectorAll('table')[t];
      const headerCount = tableNow.querySelectorAll('thead th').length;
      for (let i = 0; i < headerCount; i += 1) {
        const ths = container.querySelectorAll('table')[t].querySelectorAll('thead th');
        if (!ths[i]) break;
        fireEvent.click(ths[i]);
      }
      for (let i = 0; i < headerCount; i += 1) {
        const ths = container.querySelectorAll('table')[t].querySelectorAll('thead th');
        if (!ths[i]) break;
        fireEvent.click(ths[i]);
      }
    }
  });
});
