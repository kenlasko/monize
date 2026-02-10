import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { InvestmentValueChart } from './InvestmentValueChart';

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
  it('renders loading state initially', () => {
    render(<InvestmentValueChart />);
    // Initially shows loading skeleton
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
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
});
