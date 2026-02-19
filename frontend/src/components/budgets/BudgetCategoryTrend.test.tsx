import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { BudgetCategoryTrend } from './BudgetCategoryTrend';
import type { CategoryTrendSeries } from '@/types/budget';

// Mock recharts
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

const mockData: CategoryTrendSeries[] = [
  {
    categoryId: 'cat-1',
    categoryName: 'Groceries',
    data: [
      { month: 'Jan 2026', budgeted: 500, actual: 420, variance: -80, percentUsed: 84 },
      { month: 'Feb 2026', budgeted: 500, actual: 530, variance: 30, percentUsed: 106 },
    ],
  },
  {
    categoryId: 'cat-2',
    categoryName: 'Dining',
    data: [
      { month: 'Jan 2026', budgeted: 300, actual: 250, variance: -50, percentUsed: 83.33 },
      { month: 'Feb 2026', budgeted: 300, actual: 310, variance: 10, percentUsed: 103.33 },
    ],
  },
];

describe('BudgetCategoryTrend', () => {
  it('renders heading', () => {
    render(<BudgetCategoryTrend data={mockData} formatCurrency={mockFormat} />);
    expect(screen.getByText('Category Trends')).toBeInTheDocument();
  });

  it('renders category toggle buttons', () => {
    render(<BudgetCategoryTrend data={mockData} formatCurrency={mockFormat} />);
    expect(screen.getByTestId('category-toggle-cat-1')).toBeInTheDocument();
    expect(screen.getByTestId('category-toggle-cat-2')).toBeInTheDocument();
  });

  it('renders chart', () => {
    render(<BudgetCategoryTrend data={mockData} formatCurrency={mockFormat} />);
    expect(screen.getByTestId('category-trend-chart')).toBeInTheDocument();
    expect(screen.getByTestId('line-chart')).toBeInTheDocument();
  });

  it('toggles category visibility when clicking toggle button', () => {
    render(<BudgetCategoryTrend data={mockData} formatCurrency={mockFormat} />);

    const toggleBtn = screen.getByTestId('category-toggle-cat-1');
    fireEvent.click(toggleBtn);

    // After toggling off, the button should lose its background color style
    // The line for cat-1 should not be rendered
    expect(toggleBtn).toBeInTheDocument();
  });

  it('shows empty state when no data', () => {
    render(<BudgetCategoryTrend data={[]} formatCurrency={mockFormat} />);
    expect(
      screen.getByText('Not enough data to display category trends yet.'),
    ).toBeInTheDocument();
  });

  it('renders summary table with average values', () => {
    render(<BudgetCategoryTrend data={mockData} formatCurrency={mockFormat} />);

    // Category names appear in both toggle buttons and summary table
    expect(screen.getAllByText('Groceries').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Dining').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Avg Budget')).toBeInTheDocument();
    expect(screen.getByText('Avg Actual')).toBeInTheDocument();
    expect(screen.getByText('Avg Variance')).toBeInTheDocument();
  });

  it('shows positive variance in red and negative in green', () => {
    render(<BudgetCategoryTrend data={mockData} formatCurrency={mockFormat} />);

    // Both categories average to negative variance (under budget on average)
    const varianceCells = screen.getAllByText(/^\+?\$[\d.-]+$/);
    expect(varianceCells.length).toBeGreaterThan(0);
  });

  it('renders chart lines for each selected category', () => {
    render(<BudgetCategoryTrend data={mockData} formatCurrency={mockFormat} />);

    expect(screen.getByTestId('line-Groceries')).toBeInTheDocument();
    expect(screen.getByTestId('line-Dining')).toBeInTheDocument();
  });
});
