import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { SpendingByCategoryReport } from './SpendingByCategoryReport';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(2)}`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: '3m',
    setDateRange: vi.fn(),
    startDate: '',
    setStartDate: vi.fn(),
    endDate: '',
    setEndDate: vi.fn(),
    resolvedRange: { start: '2025-01-01', end: '2025-03-31' },
    isValid: true,
  }),
}));

vi.mock('@/lib/chart-colours', () => ({
  CHART_COLOURS: ['#3b82f6', '#ef4444', '#22c55e', '#f97316'],
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock('@/components/ui/ChartViewToggle', () => ({
  ChartViewToggle: () => <div data-testid="chart-view-toggle" />,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  Pie: () => null,
  Cell: () => null,
  Tooltip: () => null,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
}));

const mockGetSpendingByCategory = vi.fn();

vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getSpendingByCategory: (...args: any[]) => mockGetSpendingByCategory(...args),
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

describe('SpendingByCategoryReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetSpendingByCategory.mockReturnValue(new Promise(() => {}));
    render(<SpendingByCategoryReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no data returned', async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      data: [],
      totalSpending: 0,
    });
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByText('No expense data for this period.')).toBeInTheDocument();
    });
  });

  it('renders chart and legend with sample data', async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        { categoryId: 'cat-1', categoryName: 'Groceries', total: 500, color: '#ff0000' },
        { categoryId: 'cat-2', categoryName: 'Utilities', total: 200, color: '' },
      ],
      totalSpending: 700,
    });
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });
    expect(screen.getByText('Utilities')).toBeInTheDocument();
    expect(screen.getByText('Total Expenses')).toBeInTheDocument();
    expect(screen.getByText('$700.00')).toBeInTheDocument();
  });

  it('renders date range selector and chart view toggle', async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      data: [{ categoryId: 'cat-1', categoryName: 'Food', total: 100, color: '' }],
      totalSpending: 100,
    });
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByTestId('date-range-selector')).toBeInTheDocument();
    });
    expect(screen.getByTestId('chart-view-toggle')).toBeInTheDocument();
  });

  it('renders category with provided color and percentage', async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        { categoryId: 'cat-1', categoryName: 'Food', total: 300, color: '#ff0000' },
        { categoryId: 'cat-2', categoryName: 'Rent', total: 700, color: '' },
      ],
      totalSpending: 1000,
    });
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByText('Food')).toBeInTheDocument();
    });
    expect(screen.getByText('Rent')).toBeInTheDocument();
    // Percentages in legend
    expect(screen.getByText('$300.00 (30.0%)')).toBeInTheDocument();
    expect(screen.getByText('$700.00 (70.0%)')).toBeInTheDocument();
  });

  it('renders category without categoryId as disabled', async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        { categoryId: '', categoryName: 'Uncategorized', total: 100, color: '' },
      ],
      totalSpending: 100,
    });
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByText('Uncategorized')).toBeInTheDocument();
    });
    // The button should be disabled
    const button = screen.getByText('Uncategorized').closest('button');
    expect(button).toBeDisabled();
  });

  it('handles API error gracefully', async () => {
    mockGetSpendingByCategory.mockRejectedValue(new Error('Network error'));
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByText('No expense data for this period.')).toBeInTheDocument();
    });
  });
});
