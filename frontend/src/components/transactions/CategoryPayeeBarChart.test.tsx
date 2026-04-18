import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// Use vi.fn() so individual tests can override the implementation to simulate
// different currencies (e.g. USD with 2dp vs JPY with 0dp vs BHD with 3dp).
const mockFormatCurrency = vi.fn((n: number) => `$${n.toFixed(2)}`);
const mockFormatCurrencyAxis = vi.fn((n: number) => `$${n}`);

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: mockFormatCurrency,
    formatCurrencyAxis: mockFormatCurrencyAxis,
  }),
}));

describe('CategoryPayeeBarChart', () => {
  beforeEach(() => {
    // Reset to default USD-like 2-decimal behaviour before each test
    mockFormatCurrency.mockImplementation((n: number) => `$${n.toFixed(2)}`);
    mockFormatCurrency.mockClear();
  });

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

  it('renders a download button titled after the chart when data is present', () => {
    render(
      <CategoryPayeeBarChart
        data={[{ month: '2025-01', total: -500, count: 10 }]}
        isLoading={false}
      />
    );

    expect(
      screen.getByRole('button', { name: /download monthly totals as png/i }),
    ).toBeInTheDocument();
  });

  it('hides the download button in loading and empty states', () => {
    const { rerender } = render(
      <CategoryPayeeBarChart data={[]} isLoading={true} />,
    );
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();

    rerender(<CategoryPayeeBarChart data={[]} isLoading={false} />);
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();
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

    // Monthly avg = -1000 / 2 = -500 => $-500.00
    expect(screen.getByText('$-500.00')).toBeInTheDocument();
    // Total = -1000 => $-1000.00
    expect(screen.getByText('$-1000.00')).toBeInTheDocument();
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

    // Total = 3000 => $3000.00
    expect(screen.getByText('$3000.00')).toBeInTheDocument();
    // Transaction count = 15
    expect(screen.getByText('15')).toBeInTheDocument();
  });

  it('passes Monthly Avg and Total through formatCurrency', () => {
    render(
      <CategoryPayeeBarChart
        data={[
          { month: '2025-01', total: 400, count: 2 },
          { month: '2025-02', total: 600, count: 3 },
        ]}
        isLoading={false}
      />
    );

    // formatCurrency must be called with the monthly avg (500) and the total (1000)
    const calledWith = mockFormatCurrency.mock.calls.map(([n]) => n);
    expect(calledWith).toContain(500);
    expect(calledWith).toContain(1000);
  });

  it('shows 0 decimal places when formatCurrency returns 0dp (e.g. JPY)', () => {
    // Simulate a 0-decimal currency like JPY
    mockFormatCurrency.mockImplementation((n: number) => `¥${Math.round(n).toLocaleString('en-US')}`);

    render(
      <CategoryPayeeBarChart
        data={[
          { month: '2025-01', total: 60000, count: 3 },
          { month: '2025-02', total: 40000, count: 2 },
        ]}
        isLoading={false}
      />
    );

    // Monthly avg = 50,000 (no decimals)
    expect(screen.getByText('¥50,000')).toBeInTheDocument();
    // Total = 100,000 (no decimals)
    expect(screen.getByText('¥100,000')).toBeInTheDocument();
  });

  it('shows 3 decimal places when formatCurrency returns 3dp (e.g. BHD)', () => {
    // Simulate a 3-decimal currency like BHD
    mockFormatCurrency.mockImplementation((n: number) => `BD${n.toFixed(3)}`);

    render(
      <CategoryPayeeBarChart
        data={[
          { month: '2025-01', total: 100, count: 1 },
          { month: '2025-02', total: 200, count: 1 },
        ]}
        isLoading={false}
      />
    );

    // Monthly avg = 150 => BD150.000
    expect(screen.getByText('BD150.000')).toBeInTheDocument();
    // Total = 300 => BD300.000
    expect(screen.getByText('BD300.000')).toBeInTheDocument();
  });
});
