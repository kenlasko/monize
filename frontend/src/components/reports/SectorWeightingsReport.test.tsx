import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { SectorWeightingsReport } from './SectorWeightingsReport';

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
  useExchangeRates: () => ({ defaultCurrency: 'CAD' }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  XAxis: ({ tickFormatter }: any) => <div>{tickFormatter ? tickFormatter(100) : ''}</div>,
  YAxis: () => null,
  Tooltip: ({ content }: any) => {
    if (content && content.type) {
      const C = content.type;
      const baseProps = content.props || {};
      try {
        return (
          <div>
            <C {...baseProps} active={true} payload={[{ payload: { sector: 'Tech', direct: 100, etf: 50, total: 150, percentage: 50 } }]} />
            <C {...baseProps} active={true} payload={[{ payload: { sector: 'Health', direct: 0, etf: 0, total: 50, percentage: 10 } }]} />
            <C {...baseProps} active={false} payload={[]} />
          </div>
        );
      } catch { return null; }
    }
    return null;
  },
  Legend: () => null,
}));

const mockGetSectorWeightings = vi.fn();
const mockGetInvestmentAccounts = vi.fn();
const mockGetSecurities = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSectorWeightings: (...args: any[]) => mockGetSectorWeightings(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
    getSecurities: (...args: any[]) => mockGetSecurities(...args),
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

const mockWeightingsData = {
  items: [
    { sector: 'Technology', directValue: 18000, etfValue: 3750, totalValue: 21750, percentage: 71.31 },
    { sector: 'Healthcare', directValue: 0, etfValue: 1875, totalValue: 1875, percentage: 6.15 },
  ],
  totalPortfolioValue: 30500,
  totalDirectValue: 18000,
  totalEtfValue: 5625,
  unclassifiedValue: 6875,
};

const mockAccounts = [
  { id: 'acc-1', name: 'TFSA', accountSubType: 'INVESTMENT_BROKERAGE' },
  { id: 'acc-2', name: 'Cash Reserve', accountSubType: 'INVESTMENT_CASH' },
];

const mockSecurities = [
  { id: 's-1', symbol: 'AAPL', name: 'Apple Inc.', isActive: true },
  { id: 's-2', symbol: 'VTI', name: 'Vanguard Total Stock', isActive: true },
  { id: 's-3', symbol: 'OLD', name: 'Old Stock', isActive: false },
];

describe('SectorWeightingsReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetSectorWeightings.mockReturnValue(new Promise(() => {}));
    mockGetInvestmentAccounts.mockReturnValue(new Promise(() => {}));
    mockGetSecurities.mockReturnValue(new Promise(() => {}));
    render(<SectorWeightingsReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no sector data', async () => {
    mockGetSectorWeightings.mockResolvedValue({
      items: [],
      totalPortfolioValue: 0,
      totalDirectValue: 0,
      totalEtfValue: 0,
      unclassifiedValue: 0,
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue([]);
    render(<SectorWeightingsReport />);
    await waitFor(() => {
      expect(screen.getByText(/No investment holdings with sector data found/)).toBeInTheDocument();
    });
  });

  it('renders summary cards with data', async () => {
    mockGetSectorWeightings.mockResolvedValue(mockWeightingsData);
    mockGetInvestmentAccounts.mockResolvedValue(mockAccounts);
    mockGetSecurities.mockResolvedValue(mockSecurities);
    render(<SectorWeightingsReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Portfolio')).toBeInTheDocument();
    });
    expect(screen.getByText('Direct Exposure')).toBeInTheDocument();
    expect(screen.getByText('ETF Exposure')).toBeInTheDocument();
    expect(screen.getByText('Sectors')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument(); // 2 sector items
  });

  it('renders the chart container', async () => {
    mockGetSectorWeightings.mockResolvedValue(mockWeightingsData);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue([]);
    render(<SectorWeightingsReport />);
    await waitFor(() => {
      expect(screen.getByText('Sector Allocation')).toBeInTheDocument();
    });
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });

  it('renders data table with sector rows', async () => {
    mockGetSectorWeightings.mockResolvedValue(mockWeightingsData);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue([]);
    render(<SectorWeightingsReport />);
    await waitFor(() => {
      expect(screen.getByText('Technology')).toBeInTheDocument();
    });
    expect(screen.getByText('Healthcare')).toBeInTheDocument();
    expect(screen.getByText('71.3%')).toBeInTheDocument();
    expect(screen.getByText('6.2%')).toBeInTheDocument();
  });

  it('renders unclassified row when present', async () => {
    mockGetSectorWeightings.mockResolvedValue(mockWeightingsData);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue([]);
    render(<SectorWeightingsReport />);
    await waitFor(() => {
      expect(screen.getByText('Unclassified')).toBeInTheDocument();
    });
  });

  it('renders table footer with totals', async () => {
    mockGetSectorWeightings.mockResolvedValue(mockWeightingsData);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue([]);
    render(<SectorWeightingsReport />);
    await waitFor(() => {
      expect(screen.getByText('Total')).toBeInTheDocument();
    });
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('hides cash accounts from account filter dropdown', async () => {
    mockGetSectorWeightings.mockResolvedValue(mockWeightingsData);
    mockGetInvestmentAccounts.mockResolvedValue(mockAccounts);
    mockGetSecurities.mockResolvedValue(mockSecurities);
    render(<SectorWeightingsReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });

    fireEvent.click(trigger);

    // Brokerage account should be visible, cash account should not
    expect(screen.getByText('TFSA')).toBeInTheDocument();
    expect(screen.queryByText('Cash Reserve')).not.toBeInTheDocument();
  });

  it('hides inactive securities from security filter dropdown', async () => {
    mockGetSectorWeightings.mockResolvedValue(mockWeightingsData);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue(mockSecurities);
    render(<SectorWeightingsReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by security' });

    fireEvent.click(trigger);

    expect(screen.getByText('AAPL - Apple Inc.')).toBeInTheDocument();
    expect(screen.getByText('VTI - Vanguard Total Stock')).toBeInTheDocument();
    expect(screen.queryByText('OLD - Old Stock')).not.toBeInTheDocument();
  });

  it('shows clear filters button when filters are selected', async () => {
    mockGetSectorWeightings.mockResolvedValue(mockWeightingsData);
    mockGetInvestmentAccounts.mockResolvedValue(mockAccounts);
    mockGetSecurities.mockResolvedValue(mockSecurities);
    render(<SectorWeightingsReport />);
    await screen.findByRole('button', { name: 'Filter by account' });

    // Open account filter and select an account
    fireEvent.click(screen.getByRole('button', { name: 'Filter by account' }));
    await act(async () => { fireEvent.click(screen.getByText('TFSA')); });

    // Selecting a filter triggers reload; wait for it to settle
    await waitFor(() => {
      expect(screen.getByText('Clear Filters')).toBeInTheDocument();
    });
  });

  it('exports pdf', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetSectorWeightings.mockResolvedValue(mockWeightingsData);
    mockGetInvestmentAccounts.mockResolvedValue(mockAccounts);
    mockGetSecurities.mockResolvedValue(mockSecurities);
    render(<SectorWeightingsReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Portfolio')).toBeInTheDocument();
    });
    const exportBtn = screen.getByRole('button', { name: /export/i });
    await act(async () => { fireEvent.click(exportBtn); });
    const pdfBtn = screen.queryByText(/PDF/i);
    if (pdfBtn) { await act(async () => { fireEvent.click(pdfBtn); }); }
    expect(exportToPdf).toHaveBeenCalled();
  });

  it('shows a retryable error when the weightings load fails', async () => {
    mockGetSectorWeightings.mockRejectedValue(new Error('boom'));
    mockGetInvestmentAccounts.mockRejectedValue(new Error('boom'));
    mockGetSecurities.mockRejectedValue(new Error('boom'));
    render(<SectorWeightingsReport />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load report data/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });

  it('clears filters', async () => {
    mockGetSectorWeightings.mockResolvedValue(mockWeightingsData);
    mockGetInvestmentAccounts.mockResolvedValue(mockAccounts);
    mockGetSecurities.mockResolvedValue(mockSecurities);
    render(<SectorWeightingsReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });
    fireEvent.click(trigger);
    await act(async () => { fireEvent.click(screen.getByText('TFSA')); });
    await waitFor(() => {
      expect(screen.getByText('Clear Filters')).toBeInTheDocument();
    });
    await act(async () => { fireEvent.click(screen.getByText('Clear Filters')); });
  });

  it('closes dropdown when clicking outside', async () => {
    mockGetSectorWeightings.mockResolvedValue(mockWeightingsData);
    mockGetInvestmentAccounts.mockResolvedValue(mockAccounts);
    mockGetSecurities.mockResolvedValue(mockSecurities);
    render(<SectorWeightingsReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });

    // Open account filter
    fireEvent.click(trigger);
    expect(screen.getByText('TFSA')).toBeInTheDocument();

    // Click outside
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByText('TFSA')).not.toBeInTheDocument());
  });

  it('exercises every sortable column on the sector table', async () => {
    mockGetSectorWeightings.mockResolvedValue({
      items: [
        { sector: 'Tech', directValue: 5000, etfValue: 1000, totalValue: 6000, percentage: 60 },
        { sector: 'Finance', directValue: 2000, etfValue: 500, totalValue: 2500, percentage: 25 },
        { sector: 'Energy', directValue: 1000, etfValue: 0, totalValue: 1000, percentage: 10 },
      ],
      unclassifiedValue: 0,
      totalDirectValue: 8000,
      totalEtfValue: 1500,
      totalPortfolioValue: 9500,
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue([]);
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SectorWeightingsReport />));
    });
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const headerCount = container.querySelectorAll('table thead th').length;
    expect(headerCount).toBeGreaterThan(0);
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
});
