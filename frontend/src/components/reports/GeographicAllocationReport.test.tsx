import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { GeographicAllocationReport } from './GeographicAllocationReport';

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convertToDefault: (amount: number) => amount,
  }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Pie: ({ children }: any) => <div>{children}</div>,
  Bar: ({ children }: any) => <div>{children}</div>,
  Cell: () => null,
  XAxis: ({ tickFormatter }: any) => <div>{tickFormatter ? tickFormatter(100) : ''}</div>,
  YAxis: () => null,
  Tooltip: ({ content }: any) => {
    if (content && content.props !== undefined && content.type) {
      const C = content.type;
      const baseProps = content.props || {};
      try {
        return (
          <div>
            <C {...baseProps} active={true} payload={[{ payload: { region: 'NA', marketValue: 100, percentage: 50, count: 2 } }]} />
            <C {...baseProps} active={true} payload={[{ payload: { exchange: 'X', country: 'C', marketValue: 100, percentage: 50, count: 1 } }]} />
            <C {...baseProps} active={false} payload={[]} />
          </div>
        );
      } catch {
        return null;
      }
    }
    return null;
  },
  Legend: () => null,
}));

const mockGetPortfolioSummary = vi.fn();
const mockGetInvestmentAccounts = vi.fn();
const mockGetSecurities = vi.fn();
const mockGetCountryWeightings = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
    getSecurities: (...args: any[]) => mockGetSecurities(...args),
    getCountryWeightings: (...args: any[]) => mockGetCountryWeightings(...args),
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
];

const mockSecurities = [
  { id: 's-1', symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', isActive: true },
  { id: 's-2', symbol: 'RY.TO', name: 'Royal Bank of Canada', exchange: 'TSX', isActive: true },
];

const mockAccounts = [
  { id: 'acc-1', name: 'TFSA', accountSubType: 'INVESTMENT_BROKERAGE' },
];

const emptyCountryWeightings = {
  items: [],
  totalPortfolioValue: 0,
  totalDirectValue: 0,
  totalEtfValue: 0,
  unclassifiedValue: 0,
};

describe('GeographicAllocationReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Country look-through is fetched on mount regardless of the active view.
    mockGetCountryWeightings.mockResolvedValue(emptyCountryWeightings);
  });

  it('shows loading state initially', () => {
    mockGetPortfolioSummary.mockReturnValue(new Promise(() => {}));
    mockGetInvestmentAccounts.mockReturnValue(new Promise(() => {}));
    mockGetSecurities.mockReturnValue(new Promise(() => {}));
    render(<GeographicAllocationReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no holdings', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: [] });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue([]);
    render(<GeographicAllocationReport />);
    await waitFor(() => {
      expect(screen.getByText(/No investment holdings found/)).toBeInTheDocument();
    });
  });

  it('renders summary cards with data', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue(mockAccounts);
    mockGetSecurities.mockResolvedValue(mockSecurities);
    render(<GeographicAllocationReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Portfolio')).toBeInTheDocument();
    });
    expect(screen.getByText('Regions')).toBeInTheDocument();
    expect(screen.getByText('Exchanges')).toBeInTheDocument();
    expect(screen.getByText('Top Region')).toBeInTheDocument();
  });

  it('renders region view by default with pie chart', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue(mockSecurities);
    render(<GeographicAllocationReport />);
    await waitFor(() => {
      expect(screen.getByText('Regional Allocation')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pie-chart')).toBeInTheDocument();
  });

  it('switches to exchange view', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue(mockSecurities);
    render(<GeographicAllocationReport />);
    await waitFor(() => {
      expect(screen.getByText('By Exchange')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('By Exchange'));
    await waitFor(() => {
      expect(screen.getByText('Exchange Allocation')).toBeInTheDocument();
    });
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });

  it('renders region data in table', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue(mockSecurities);
    render(<GeographicAllocationReport />);
    await waitFor(() => {
      expect(screen.getAllByText('North America').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders exchange data when switched to exchange view', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue(mockSecurities);
    render(<GeographicAllocationReport />);
    await waitFor(() => {
      expect(screen.getByText('By Exchange')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('By Exchange'));
    await waitFor(() => {
      expect(screen.getByText('NASDAQ')).toBeInTheDocument();
    });
    expect(screen.getByText('TSX')).toBeInTheDocument();
  });

  it('handles error in static data load', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: [] });
    mockGetInvestmentAccounts.mockRejectedValue(new Error('boom'));
    mockGetSecurities.mockRejectedValue(new Error('boom'));
    render(<GeographicAllocationReport />);
    await waitFor(() => {
      expect(screen.getByText(/No investment holdings/)).toBeInTheDocument();
    });
  });

  it('handles error in loadData', async () => {
    mockGetPortfolioSummary.mockRejectedValue(new Error('boom'));
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue([]);
    render(<GeographicAllocationReport />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load report data/)).toBeInTheDocument();
    });
  });

  it('opens account filter, toggles selection, and clears filters', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', accountSubType: 'INVESTMENT_BROKERAGE' },
      { id: 'acc-2', name: 'Cash Acc', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetSecurities.mockResolvedValue(mockSecurities);
    render(<GeographicAllocationReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Portfolio')).toBeInTheDocument();
    });
    const trigger = screen.getByRole('button', { name: 'Filter by account' });
    await act(async () => { fireEvent.click(trigger); });
    // Cash sub-account is hidden; only the brokerage account is offered.
    expect(screen.queryByText('Cash Acc')).not.toBeInTheDocument();
    // Toggle TFSA on, then clear it
    await act(async () => { fireEvent.click(screen.getByText('TFSA')); });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Filter by account' })).toHaveTextContent('TFSA');
    });
    await act(async () => { fireEvent.click(screen.getByText('Clear')); });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Filter by account' })).toHaveTextContent('All Accounts');
    });
  });

  it('shows no options message when no investment accounts are available', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Cash', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetSecurities.mockResolvedValue(mockSecurities);
    render(<GeographicAllocationReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Portfolio')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Filter by account' }));
    });
    expect(screen.getByText('No options found')).toBeInTheDocument();
  });

  it('exports pdf in region and exchange views', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue(mockSecurities);
    render(<GeographicAllocationReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Portfolio')).toBeInTheDocument();
    });
    const exportBtn = screen.getByRole('button', { name: /export/i });
    await act(async () => {
      fireEvent.click(exportBtn);
    });
    const pdfBtn = screen.queryByText(/PDF/i);
    if (pdfBtn) {
      await act(async () => {
        fireEvent.click(pdfBtn);
      });
    }
    // Switch to exchange view and export again
    fireEvent.click(screen.getByText('By Exchange'));
    await act(async () => {
      fireEvent.click(exportBtn);
    });
    const pdfBtn2 = screen.queryByText(/PDF/i);
    if (pdfBtn2) {
      await act(async () => {
        fireEvent.click(pdfBtn2);
      });
    }
    expect(exportToPdf).toHaveBeenCalled();
  });

  it('handles holding with unknown exchange', async () => {
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [
        { ...mockHoldings[0], securityId: 's-x' },
      ],
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue([
      { id: 's-x', symbol: 'X', name: 'X', exchange: undefined, isActive: true },
    ]);
    render(<GeographicAllocationReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Portfolio')).toBeInTheDocument();
    });
  });

  it('renders table footer with totals', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue(mockSecurities);
    render(<GeographicAllocationReport />);
    await waitFor(() => {
      expect(screen.getByText('Total')).toBeInTheDocument();
    });
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('exercises every sortable column on region and exchange tables', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue(mockSecurities);
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<GeographicAllocationReport />));
    });
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    // Region view (default).
    const __headerCount = container.querySelectorAll('table thead th').length;
    for (let __i = 0; __i < __headerCount; __i += 1) {
      const __ths = container.querySelectorAll('table thead th');
      if (!__ths[__i]) break;
      await act(async () => { fireEvent.click(__ths[__i]); });
    }
    for (let __i = 0; __i < __headerCount; __i += 1) {
      const __ths = container.querySelectorAll('table thead th');
      if (!__ths[__i]) break;
      await act(async () => { fireEvent.click(__ths[__i]); });
    }
    // Switch to Exchange view by clicking the toggle button (text: Exchange).
    const exchangeBtns = screen.queryAllByRole('button', { name: 'Exchange' });
    if (exchangeBtns.length > 0) {
      await act(async () => { fireEvent.click(exchangeBtns[0]); });
      await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
      const __exHeaderCount = container.querySelectorAll('table thead th').length;
      for (let __i = 0; __i < __exHeaderCount; __i += 1) {
        const __ths = container.querySelectorAll('table thead th');
        if (!__ths[__i]) break;
        await act(async () => { fireEvent.click(__ths[__i]); });
      }
      for (let __i = 0; __i < __exHeaderCount; __i += 1) {
        const __ths = container.querySelectorAll('table thead th');
        if (!__ths[__i]) break;
        await act(async () => { fireEvent.click(__ths[__i]); });
      }
    }
  });

  it('renders the country look-through view with an "Other" remainder', async () => {
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetInvestmentAccounts.mockResolvedValue(mockAccounts);
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetCountryWeightings.mockResolvedValue({
      items: [
        { country: 'United States', directValue: 0, etfValue: 600, totalValue: 600, percentage: 60 },
        { country: 'Canada', directValue: 0, etfValue: 300, totalValue: 300, percentage: 30 },
      ],
      totalPortfolioValue: 1000,
      totalDirectValue: 0,
      totalEtfValue: 900,
      unclassifiedValue: 100,
    });

    render(<GeographicAllocationReport />);

    await waitFor(() => {
      expect(screen.getByText('By Country')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('By Country'));
    });

    await waitFor(() => {
      expect(
        screen.getByText('Country Allocation (look-through)'),
      ).toBeInTheDocument();
    });
    // The unclassified remainder is surfaced as an "Other" row.
    expect(screen.getByText('Other')).toBeInTheDocument();
  });
});
