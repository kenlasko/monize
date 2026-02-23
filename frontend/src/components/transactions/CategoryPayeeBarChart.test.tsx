import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { CategoryPayeeBarChart } from './CategoryPayeeBarChart';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: ({ children }: any) => <div data-testid="bar">{children}</div>,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />,
  CartesianGrid: () => <div data-testid="cartesian-grid" />,
  Tooltip: () => <div data-testid="tooltip" />,
  LabelList: () => <div data-testid="label-list" />,
  Cell: () => <div data-testid="cell" />,
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
  }),
}));

describe('CategoryPayeeBarChart', () => {
  it('renders loading state with title and pulse skeleton', () => {
    render(<CategoryPayeeBarChart data={[]} isLoading={true} />);
    expect(screen.getByText('Monthly Totals')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('shows empty state when no data', () => {
    render(<CategoryPayeeBarChart data={[]} isLoading={false} />);
    expect(screen.getByText('No transaction data available')).toBeInTheDocument();
  });

  it('renders bar chart with data and summary footer', () => {
    render(
      <CategoryPayeeBarChart
        data={[
          { month: '2025-01', total: -500, count: 10 },
          { month: '2025-02', total: -300, count: 8 },
          { month: '2025-03', total: -400, count: 12 },
        ]}
        isLoading={false}
      />
    );

    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    expect(screen.getByText('Monthly Avg')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('Transactions')).toBeInTheDocument();
  });

  it('shows correct summary values', () => {
    render(
      <CategoryPayeeBarChart
        data={[
          { month: '2025-01', total: -600, count: 10 },
          { month: '2025-02', total: -400, count: 5 },
        ]}
        isLoading={false}
      />
    );

    // Monthly avg = -1000 / 2 = -500
    expect(screen.getByText('$-500')).toBeInTheDocument();
    // Total = -1000
    expect(screen.getByText('$-1000')).toBeInTheDocument();
    // Transaction count = 15
    expect(screen.getByText('15')).toBeInTheDocument();
  });

  it('shows correct summary for positive totals', () => {
    render(
      <CategoryPayeeBarChart
        data={[
          { month: '2025-01', total: 1000, count: 5 },
          { month: '2025-02', total: 2000, count: 10 },
        ]}
        isLoading={false}
      />
    );

    // Total = 3000
    expect(screen.getByText('$3000')).toBeInTheDocument();
    // Transaction count = 15
    expect(screen.getByText('15')).toBeInTheDocument();
  });
});
