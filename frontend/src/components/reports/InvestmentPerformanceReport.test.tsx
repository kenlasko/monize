import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { InvestmentPerformanceReport } from './InvestmentPerformanceReport';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (amount: number, _currency: string) => amount,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/lib/chart-colours', () => ({
  CHART_COLOURS: ['#3b82f6', '#ef4444', '#22c55e'],
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  Pie: () => null,
  Cell: () => null,
  Tooltip: () => null,
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

describe('InvestmentPerformanceReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetPortfolioSummary.mockReturnValue(new Promise(() => {}));
    mockGetInvestmentAccounts.mockReturnValue(new Promise(() => {}));
    render(<InvestmentPerformanceReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no holdings', async () => {
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
    render(<InvestmentPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByText(/No investment holdings found/)).toBeInTheDocument();
    });
  });

  it('renders summary cards with portfolio data', async () => {
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [
        {
          id: 'h-1',
          symbol: 'VFV',
          name: 'Vanguard S&P 500',
          quantity: 100,
          averageCost: 90,
          currentPrice: 100,
          marketValue: 10000,
          costBasis: 9000,
          gainLoss: 1000,
          gainLossPercent: 11.11,
          currencyCode: 'CAD',
        },
      ],
      holdingsByAccount: [
        {
          accountId: 'acc-1',
          totalMarketValue: 10000,
          cashBalance: 500,
          totalCostBasis: 9000,
        },
      ],
      allocation: [
        { name: 'Equities', value: 10000, percentage: 100, color: '#3b82f6' },
      ],
      totalPortfolioValue: 10500,
      totalCostBasis: 9000,
      totalGainLoss: 1000,
      totalGainLossPercent: 11.11,
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<InvestmentPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Value')).toBeInTheDocument();
    });
    expect(screen.getByText('Cost Basis')).toBeInTheDocument();
    expect(screen.getByText('Total Gain/Loss')).toBeInTheDocument();
    expect(screen.getAllByText('Return').length).toBeGreaterThanOrEqual(1);
  });

  it('renders view type toggle buttons', async () => {
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [
        {
          id: 'h-1',
          symbol: 'XIC',
          name: 'iShares S&P/TSX',
          quantity: 50,
          averageCost: 30,
          currentPrice: 35,
          marketValue: 1750,
          costBasis: 1500,
          gainLoss: 250,
          gainLossPercent: 16.67,
          currencyCode: 'CAD',
        },
      ],
      holdingsByAccount: [],
      allocation: [],
      totalPortfolioValue: 1750,
      totalCostBasis: 1500,
      totalGainLoss: 250,
      totalGainLossPercent: 16.67,
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<InvestmentPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByText('Holdings')).toBeInTheDocument();
    });
    expect(screen.getByText('Allocation')).toBeInTheDocument();
  });
});
