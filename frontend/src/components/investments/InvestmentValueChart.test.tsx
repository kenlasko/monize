import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { InvestmentValueChart } from './InvestmentValueChart';
import { netWorthApi } from '@/lib/net-worth';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convertToDefault: (amount: number) => amount,
    getRate: () => null,
  }),
}));

vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: '1y',
    setDateRange: vi.fn(),
    resolvedRange: { start: '2023-01-01', end: '2024-01-01' },
    isValid: true,
  }),
}));

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getInvestmentsMonthly: vi.fn().mockResolvedValue([
      { month: '2023-06-01', value: 10000 },
      { month: '2024-01-01', value: 15000 },
    ]),
  },
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

describe('InvestmentValueChart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mock implementation for each test
    vi.mocked(netWorthApi.getInvestmentsMonthly).mockResolvedValue([
      { month: '2023-06-01', value: 10000 },
      { month: '2024-01-01', value: 15000 },
    ]);
  });

  it('renders loading state initially', async () => {
    render(<InvestmentValueChart />);
    await waitFor(() => {
      expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
    });
  });

  it('renders title after data loads', async () => {
    render(<InvestmentValueChart />);
    const title = await screen.findByText('Portfolio Value Over Time');
    expect(title).toBeInTheDocument();
  });

  it('renders summary cards after data loads', async () => {
    render(<InvestmentValueChart />);
    const currentValue = await screen.findByText('Current Value');
    expect(currentValue).toBeInTheDocument();
    expect(screen.getByText('Change')).toBeInTheDocument();
    expect(screen.getByText('Change %')).toBeInTheDocument();
  });

  it('renders the chart component after data loads', async () => {
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('displays computed summary values', async () => {
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    // current: $15000, initial: $10000, change: $5000, percent: +50.0%
    expect(screen.getByText('$15000')).toBeInTheDocument();
    expect(screen.getByText('+$5000')).toBeInTheDocument();
    expect(screen.getByText('+50.0%')).toBeInTheDocument();
  });

  it('shows no data message when API returns empty', async () => {
    vi.mocked(netWorthApi.getInvestmentsMonthly).mockResolvedValue([]);
    render(<InvestmentValueChart />);
    const msg = await screen.findByText('No investment data for this period.');
    expect(msg).toBeInTheDocument();
    // Restore default mock
    vi.mocked(netWorthApi.getInvestmentsMonthly).mockResolvedValue([
      { month: '2023-06-01', value: 10000 },
      { month: '2024-01-01', value: 15000 },
    ]);
  });

  it('handles API failure gracefully', async () => {
    vi.mocked(netWorthApi.getInvestmentsMonthly).mockRejectedValue(new Error('Network error'));
    render(<InvestmentValueChart />);
    // Should not crash; shows no data since monthlyData stays empty
    const msg = await screen.findByText('No investment data for this period.');
    expect(msg).toBeInTheDocument();
    // Restore default mock
    vi.mocked(netWorthApi.getInvestmentsMonthly).mockResolvedValue([
      { month: '2023-06-01', value: 10000 },
      { month: '2024-01-01', value: 15000 },
    ]);
  });

  it('passes accountIds to API when provided', async () => {
    render(<InvestmentValueChart accountIds={['acc-1', 'acc-2']} />);
    await screen.findByText('Portfolio Value Over Time');
    expect(netWorthApi.getInvestmentsMonthly).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIds: 'acc-1,acc-2',
      })
    );
  });

  it('does not pass accountIds when empty array', async () => {
    render(<InvestmentValueChart accountIds={[]} />);
    await screen.findByText('Portfolio Value Over Time');
    expect(netWorthApi.getInvestmentsMonthly).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIds: undefined,
      })
    );
  });

  it('shows negative change values correctly', async () => {
    vi.mocked(netWorthApi.getInvestmentsMonthly).mockResolvedValue([
      { month: '2023-06-01', value: 20000 },
      { month: '2024-01-01', value: 15000 },
    ]);
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    // current: $15000, initial: $20000, change: -$5000, percent: -25.0%
    expect(screen.getByText('$15000')).toBeInTheDocument();
    expect(screen.getByText('-25.0%')).toBeInTheDocument();
  });
});
