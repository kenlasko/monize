import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { PortfolioValueReport } from './PortfolioValueReport';

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number, _currency?: string) => `$${n.toFixed(0)}`,
    formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
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

const STABLE_RESOLVED_RANGE = { start: '2024-01-01', end: '2026-01-01' };
vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: '2y',
    setDateRange: vi.fn(),
    startDate: '',
    setStartDate: vi.fn(),
    endDate: '',
    setEndDate: vi.fn(),
    resolvedRange: STABLE_RESOLVED_RANGE,
    isValid: true,
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

const mockDateRangeSelectorProps = vi.fn();
vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: (props: any) => {
    mockDateRangeSelectorProps(props);
    return <div data-testid="date-range-selector" />;
  },
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  Area: () => null,
  XAxis: ({ tickFormatter }: any) => <div>{tickFormatter ? tickFormatter('Jan 2024') : ''}</div>,
  YAxis: ({ tickFormatter }: any) => <div>{tickFormatter ? tickFormatter(1000) : ''}</div>,
  CartesianGrid: () => null,
  Tooltip: ({ content }: any) => {
    if (typeof content === 'function') {
      return (
        <div>
          {content({ active: true, payload: [{ value: 100, payload: { name: 'Jan' } }] })}
          {content({ active: false, payload: [] })}
        </div>
      );
    }
    return null;
  },
}));

const mockGetInvestmentsMonthly = vi.fn();
const mockGetInvestmentsDaily = vi.fn();
const mockGetPortfolioSummary = vi.fn();
const mockGetInvestmentAccounts = vi.fn();

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

describe('PortfolioValueReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [],
      allocation: [],
      totalPortfolioValue: 0,
      totalCostBasis: 0,
      totalGainLoss: 0,
      totalGainLossPercent: 0,
    });
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
      expect(screen.getByText('Current Value')).toBeInTheDocument();
    });
    expect(screen.getByText('Period Change')).toBeInTheDocument();
    expect(screen.getByText('Period Return')).toBeInTheDocument();
    expect(screen.getByText('Period High / Low')).toBeInTheDocument();
  });

  it('renders the area chart', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
      { month: '2024-07-01', value: 55000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [],
      allocation: [],
      totalPortfolioValue: 55000,
      totalCostBasis: 50000,
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
    // 'TFSA' appears in both the account selector dropdown and the breakdown table
    expect(screen.getAllByText('TFSA').length).toBeGreaterThanOrEqual(2);
  });

  it('passes date filter ranges including 1w, 1m, 3m, ytd to DateRangeSelector', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [],
      allocation: [],
      totalPortfolioValue: 0,
      totalCostBasis: 0,
      totalGainLoss: 0,
      totalGainLossPercent: 0,
    });
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
    expect(exportToPdf).toHaveBeenCalled();
  });

  it('changes selected account', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [], holdingsByAccount: [], allocation: [],
      totalPortfolioValue: 50000, totalCostBasis: 50000, totalGainLoss: 0, totalGainLossPercent: 0,
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA - Cash', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('All Accounts')).toBeInTheDocument();
    });
    const select = document.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: 'acc-1' } });
    });
  });

  it('renders with negative period change', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([
      { month: '2024-06-01', value: 60000 },
      { month: '2024-07-01', value: 55000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [], holdingsByAccount: [], allocation: [],
      totalPortfolioValue: 55000, totalCostBasis: 60000, totalGainLoss: -5000, totalGainLossPercent: -8.33,
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
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [], holdingsByAccount: [], allocation: [],
      totalPortfolioValue: 0, totalCostBasis: 0, totalGainLoss: 0, totalGainLossPercent: 0,
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio Value Over Time')).toBeInTheDocument();
    });
  });

  it('renders account selector dropdown', async () => {
    mockGetInvestmentsMonthly.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [],
      allocation: [],
      totalPortfolioValue: 0,
      totalCostBasis: 0,
      totalGainLoss: 0,
      totalGainLossPercent: 0,
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('All Accounts')).toBeInTheDocument();
    });
  });
});
