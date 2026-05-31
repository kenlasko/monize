import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { CurrencyExposureReport } from './CurrencyExposureReport';

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convertToDefault: (amount: number) => amount,
    getRate: (currency: string) => currency === 'CAD' ? 1 : 1.365,
  }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  Pie: () => null,
  Cell: () => null,
  Tooltip: ({ content }: any) => {
    if (content && content.type) {
      const C = content.type;
      const baseProps = content.props || {};
      try {
        return (
          <div>
            <C {...baseProps} active={true} payload={[{ payload: { name: 'CAD', currency: 'CAD', nativeValue: 100, convertedValue: 100, value: 100, percentage: 50, count: 2 } }]} />
            <C {...baseProps} active={false} payload={[]} />
          </div>
        );
      } catch { return null; }
    }
    return null;
  },
  Legend: () => null,
}));

const mockGetPortfolioSummary = vi.fn();
const mockGetInvestmentAccounts = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
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
  },
  {
    id: 'h-2',
    accountId: 'acc-1',
    securityId: 's-2',
    symbol: 'RY.TO',
    name: 'Royal Bank of Canada',
    securityType: 'STOCK',
    currencyCode: 'CAD',
    quantity: 20,
    averageCost: 120,
    costBasis: 2400,
    currentPrice: 140,
    marketValue: 2800,
    gainLoss: 400,
    gainLossPercent: 16.67,
  },
  {
    id: 'h-3',
    accountId: 'acc-1',
    securityId: 's-3',
    symbol: 'TD.TO',
    name: 'Toronto-Dominion Bank',
    securityType: 'STOCK',
    currencyCode: 'CAD',
    quantity: 15,
    averageCost: 80,
    costBasis: 1200,
    currentPrice: 90,
    marketValue: 1350,
    gainLoss: 150,
    gainLossPercent: 12.5,
  },
];

const mockAccounts = [
  { id: 'acc-1', name: 'TFSA', accountSubType: 'INVESTMENT_BROKERAGE' },
  { id: 'acc-2', name: 'Cash Reserve', accountSubType: 'INVESTMENT_CASH' },
];

describe('CurrencyExposureReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetPortfolioSummary.mockReturnValue(new Promise(() => {}));
    mockGetInvestmentAccounts.mockReturnValue(new Promise(() => {}));
    render(<CurrencyExposureReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no holdings', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: [] });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<CurrencyExposureReport />);
    await waitFor(() => {
      expect(screen.getByText(/No investment holdings found/)).toBeInTheDocument();
    });
  });

  it('renders summary cards with data', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue(mockAccounts);
    render(<CurrencyExposureReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Portfolio')).toBeInTheDocument();
    });
    expect(screen.getByText('Currencies')).toBeInTheDocument();
    expect(screen.getByText(/Home Currency/)).toBeInTheDocument();
    expect(screen.getByText('Foreign Exposure')).toBeInTheDocument();
  });

  it('renders pie chart', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<CurrencyExposureReport />);
    await waitFor(() => {
      expect(screen.getByText('Currency Allocation')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pie-chart')).toBeInTheDocument();
  });

  it('renders data table with currency rows', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<CurrencyExposureReport />);
    await waitFor(() => {
      expect(screen.getAllByText('CAD').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getByText('USD')).toBeInTheDocument();
  });

  it('keeps content and the account dropdown mounted while a filter change reloads', async () => {
    mockGetPortfolioSummary.mockResolvedValueOnce({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue(mockAccounts);
    render(<CurrencyExposureReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Portfolio')).toBeInTheDocument();
    });

    // The reload triggered by the filter change hangs so isLoading stays true
    // throughout the assertions below.
    mockGetPortfolioSummary.mockReturnValueOnce(new Promise(() => {}));

    fireEvent.click(screen.getByRole('button', { name: 'Filter by account' }));
    await act(async () => {
      fireEvent.click(screen.getByText('TFSA'));
    });

    // Wait for the debounced reload to actually fire (second summary fetch).
    await waitFor(() => {
      expect(mockGetPortfolioSummary).toHaveBeenCalledTimes(2);
    });

    // Mid-reload the report must update in place: existing content and the open
    // account dropdown stay mounted instead of being replaced by the full-page
    // skeleton (which would close the dropdown).
    expect(screen.getByText('Total Portfolio')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeFalsy();
    expect(screen.getByText('Select All')).toBeInTheDocument();
  });

  it('shows correct number of currencies', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<CurrencyExposureReport />);
    await waitFor(() => {
      // "Currencies" label in summary card should exist, and "2" appears multiple places
      expect(screen.getByText('Currencies')).toBeInTheDocument();
      expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders table with exchange rate column', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<CurrencyExposureReport />);
    await waitFor(() => {
      expect(screen.getByText(/Rate to CAD/)).toBeInTheDocument();
    });
  });

  it('renders table footer with totals', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<CurrencyExposureReport />);
    await waitFor(() => {
      expect(screen.getByText('Total')).toBeInTheDocument();
    });
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('hides cash accounts from account filter dropdown', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue(mockAccounts);
    render(<CurrencyExposureReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });

    fireEvent.click(trigger);
    expect(screen.getByText('TFSA')).toBeInTheDocument();
    expect(screen.queryByText('Cash Reserve')).not.toBeInTheDocument();
  });

  it('reflects the selected account in the filter trigger', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue(mockAccounts);
    render(<CurrencyExposureReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });

    fireEvent.click(trigger);
    await act(async () => { fireEvent.click(screen.getByText('TFSA')); });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Filter by account' })).toHaveTextContent('TFSA');
    });
  });

  it('exports pdf', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue(mockAccounts);
    render(<CurrencyExposureReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Portfolio')).toBeInTheDocument();
    });
    const exportBtn = screen.getByRole('button', { name: /export/i });
    await act(async () => { fireEvent.click(exportBtn); });
    const pdfBtn = screen.queryByText(/PDF/i);
    if (pdfBtn) {
      await act(async () => { fireEvent.click(pdfBtn); });
    }
    expect(exportToPdf).toHaveBeenCalled();
  });

  it('handles error in loadData', async () => {
    mockGetPortfolioSummary.mockRejectedValue(new Error('boom'));
    mockGetInvestmentAccounts.mockRejectedValue(new Error('boom'));
    render(<CurrencyExposureReport />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load report data/)).toBeInTheDocument();
    });
  });

  it('clears the account filter via the Clear action', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue(mockAccounts);
    render(<CurrencyExposureReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });
    fireEvent.click(trigger);
    await act(async () => { fireEvent.click(screen.getByText('TFSA')); });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Filter by account' })).toHaveTextContent('TFSA');
    });
    await act(async () => { fireEvent.click(screen.getByText('Clear')); });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Filter by account' })).toHaveTextContent('All Accounts');
    });
  });

  it('closes dropdown when clicking outside', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue(mockAccounts);
    render(<CurrencyExposureReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });

    fireEvent.click(trigger);
    expect(screen.getByText('TFSA')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByText('TFSA')).not.toBeInTheDocument());
  });
});
