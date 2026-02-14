import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { NetWorthChart } from './NetWorthChart';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

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
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('renders loading state with title and pulse skeleton', () => {
    render(<NetWorthChart data={[]} isLoading={true} />);
    expect(screen.getByText('Net Worth')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
    expect(screen.queryByTestId('area-chart')).not.toBeInTheDocument();
  });

  it('renders empty state when no data', () => {
    render(<NetWorthChart data={[]} isLoading={false} />);
    expect(screen.getByText('No net worth data available yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('area-chart')).not.toBeInTheDocument();
  });

  it('renders chart with data and shows current net worth', () => {
    const data = [
      { month: '2024-01-01', netWorth: 10000 },
      { month: '2024-06-01', netWorth: 15000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    expect(screen.getByText('Past 12 months')).toBeInTheDocument();
    expect(screen.getByText('View full report')).toBeInTheDocument();
    expect(screen.getByText('$15000')).toBeInTheDocument();
  });

  it('shows positive change with plus sign and green styling', () => {
    const data = [
      { month: '2024-01-01', netWorth: 10000 },
      { month: '2024-06-01', netWorth: 15000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    // Change is +5000, 50%
    const changeEl = screen.getByText(/\+\$5000/);
    expect(changeEl).toBeInTheDocument();
    expect(changeEl.className).toContain('text-green');
  });

  it('shows negative change with red styling', () => {
    const data = [
      { month: '2024-01-01', netWorth: 15000 },
      { month: '2024-06-01', netWorth: 10000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    // Change is -5000
    const changeEl = screen.getByText(/\$-5000/);
    expect(changeEl).toBeInTheDocument();
    expect(changeEl.className).toContain('text-red');
  });

  it('navigates to net worth report on title click', () => {
    const data = [
      { month: '2024-01-01', netWorth: 10000 },
      { month: '2024-06-01', netWorth: 15000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    fireEvent.click(screen.getByText('Net Worth'));
    expect(mockPush).toHaveBeenCalledWith('/reports/net-worth');
  });

  it('navigates to report on View full report click', () => {
    const data = [
      { month: '2024-01-01', netWorth: 10000 },
      { month: '2024-06-01', netWorth: 15000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    fireEvent.click(screen.getByText('View full report'));
    expect(mockPush).toHaveBeenCalledWith('/reports/net-worth');
  });

  it('navigates to report on loading state title click', () => {
    render(<NetWorthChart data={[]} isLoading={true} />);
    fireEvent.click(screen.getByText('Net Worth'));
    expect(mockPush).toHaveBeenCalledWith('/reports/net-worth');
  });

  it('navigates to report on empty state title click', () => {
    render(<NetWorthChart data={[]} isLoading={false} />);
    fireEvent.click(screen.getByText('Net Worth'));
    expect(mockPush).toHaveBeenCalledWith('/reports/net-worth');
  });

  it('shows negative net worth with red styling', () => {
    const data = [
      { month: '2024-01-01', netWorth: -5000 },
      { month: '2024-06-01', netWorth: -3000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    const currentEl = screen.getByText('$-3000');
    expect(currentEl.className).toContain('text-red');
  });

  it('handles single data point correctly (no min/max dots)', () => {
    const data = [
      { month: '2024-01-01', netWorth: 10000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    // Single data point: change = 0, percent = 0
    expect(screen.getByText('$10000')).toBeInTheDocument();
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });
});
