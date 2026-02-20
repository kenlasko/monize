import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { BalanceHistoryChart } from './BalanceHistoryChart';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Line: () => <div data-testid="line" />,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />,
  CartesianGrid: () => <div data-testid="cartesian-grid" />,
  Tooltip: () => <div data-testid="tooltip" />,
  ReferenceLine: () => <div data-testid="reference-line" />,
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
  }),
}));

describe('BalanceHistoryChart', () => {
  it('renders loading state with title and pulse skeleton', () => {
    render(
      <BalanceHistoryChart data={[]} isLoading={true} />
    );
    expect(screen.getByText('Balance History')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('shows empty state when no data returned', () => {
    render(
      <BalanceHistoryChart data={[]} isLoading={false} />
    );
    expect(screen.getByText('No balance data available')).toBeInTheDocument();
  });

  it('renders chart with data and summary footer', () => {
    render(
      <BalanceHistoryChart
        data={[
          { date: '2025-01-01', balance: 1000 },
          { date: '2025-01-02', balance: 750 },
          { date: '2025-01-03', balance: 900 },
        ]}
        isLoading={false}
      />
    );

    expect(screen.getByTestId('line-chart')).toBeInTheDocument();
    expect(screen.getByText('Starting')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.getByText('Min Balance')).toBeInTheDocument();
    expect(screen.getByText('$1000')).toBeInTheDocument();
    expect(screen.getByText('$900')).toBeInTheDocument();
    expect(screen.getByText('$750')).toBeInTheDocument();
  });

  it('shows "Lowest" label and warning when balance goes negative', () => {
    render(
      <BalanceHistoryChart
        data={[
          { date: '2025-01-01', balance: 100 },
          { date: '2025-01-02', balance: -50 },
        ]}
        isLoading={false}
      />
    );

    expect(screen.getByText('Lowest')).toBeInTheDocument();
    expect(screen.getByText('!')).toBeInTheDocument();
  });
});
