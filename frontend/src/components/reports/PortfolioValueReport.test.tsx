import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { PortfolioValueReport } from './PortfolioValueReport';

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

vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: '2y',
    setDateRange: vi.fn(),
    startDate: '',
    setStartDate: vi.fn(),
    endDate: '',
    setEndDate: vi.fn(),
    resolvedRange: { start: '2024-01-01', end: '2026-01-01' },
    isValid: true,
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

const mockGetInvestmentsMonthly = vi.fn();
const mockGetPortfolioSummary = vi.fn();
const mockGetInvestmentAccounts = vi.fn();

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getInvestmentsMonthly: (...args: any[]) => mockGetInvestmentsMonthly(...args),
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
