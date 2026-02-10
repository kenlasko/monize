import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { NetWorthChart } from './NetWorthChart';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  ReferenceDot: () => null,
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrencyLabel: (n: number) => `$${n}`,
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

describe('NetWorthChart', () => {
  it('renders loading state', () => {
    render(<NetWorthChart data={[]} isLoading={true} />);
    expect(screen.getByText('Net Worth')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state', () => {
    render(<NetWorthChart data={[]} isLoading={false} />);
    expect(screen.getByText('No net worth data available yet.')).toBeInTheDocument();
  });

  it('renders chart with data', () => {
    const data = [
      { month: '2024-01-01', netWorth: 10000 },
      { month: '2024-06-01', netWorth: 15000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    expect(screen.getByText('Past 12 months')).toBeInTheDocument();
    expect(screen.getByText('View full report')).toBeInTheDocument();
  });

  it('shows current net worth and change', () => {
    const data = [
      { month: '2024-01-01', netWorth: 10000 },
      { month: '2024-06-01', netWorth: 15000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    expect(screen.getByText('$15000')).toBeInTheDocument();
  });
});
