import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { BudgetTrendChart } from './BudgetTrendChart';

// Mock recharts to avoid rendering actual SVGs in tests
vi.mock('recharts', () => ({
  LineChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="line-chart">{children}</div>
  ),
  Line: ({ name }: { name: string }) => <div data-testid={`line-${name}`} />,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />,
  CartesianGrid: () => <div data-testid="grid" />,
  Tooltip: () => <div data-testid="tooltip" />,
  Legend: () => <div data-testid="legend" />,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
}));

const mockFormat = (amount: number) => `$${amount.toFixed(2)}`;

const mockData = [
  { month: 'Sep', budgeted: 5000, actual: 4800 },
  { month: 'Oct', budgeted: 5000, actual: 5200 },
  { month: 'Nov', budgeted: 5200, actual: 5100 },
  { month: 'Dec', budgeted: 5200, actual: 6000 },
  { month: 'Jan', budgeted: 5200, actual: 4900 },
  { month: 'Feb', budgeted: 5200, actual: 3100 },
];

describe('BudgetTrendChart', () => {
  it('renders heading', () => {
    render(<BudgetTrendChart data={mockData} formatCurrency={mockFormat} />);

    expect(screen.getByText('Budget vs Actual Trend')).toBeInTheDocument();
  });

  it('renders chart with data', () => {
    render(<BudgetTrendChart data={mockData} formatCurrency={mockFormat} />);

    expect(screen.getByTestId('line-chart')).toBeInTheDocument();
    expect(screen.getByTestId('line-Budgeted')).toBeInTheDocument();
    expect(screen.getByTestId('line-Actual')).toBeInTheDocument();
  });

  it('shows empty state when no data', () => {
    render(<BudgetTrendChart data={[]} formatCurrency={mockFormat} />);

    expect(
      screen.getByText('Not enough data to display trends yet.'),
    ).toBeInTheDocument();
  });

  it('renders responsive container', () => {
    render(<BudgetTrendChart data={mockData} formatCurrency={mockFormat} />);

    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });
});
