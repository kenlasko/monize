import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { IncomeBySourceReport } from './IncomeBySourceReport';

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
    dateRange: '1y',
    setDateRange: vi.fn(),
    startDate: '',
    setStartDate: vi.fn(),
    endDate: '',
    setEndDate: vi.fn(),
    resolvedRange: { start: '2024-01-01', end: '2025-01-01' },
    isValid: true,
  }),
}));

vi.mock('@/lib/chart-colours', () => ({
  CHART_COLOURS_INCOME: ['#22c55e', '#3b82f6', '#8b5cf6'],
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

const mockGetIncomeBySource = vi.fn();

vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getIncomeBySource: (...args: any[]) => mockGetIncomeBySource(...args),
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

describe('IncomeBySourceReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetIncomeBySource.mockReturnValue(new Promise(() => {}));
    render(<IncomeBySourceReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no data returned', async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [],
      totalIncome: 0,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText('No income data for this period.')).toBeInTheDocument();
    });
  });

  it('renders chart and legend with sample data', async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: 'cat-1', categoryName: 'Salary', total: 5000, color: '' },
        { categoryId: 'cat-2', categoryName: 'Freelance', total: 1000, color: '' },
      ],
      totalIncome: 6000,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText('Salary')).toBeInTheDocument();
    });
    expect(screen.getByText('Freelance')).toBeInTheDocument();
    expect(screen.getByText('Total Income')).toBeInTheDocument();
    expect(screen.getByText('$6000.00')).toBeInTheDocument();
  });

  it('renders controls', async () => {
    mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByTestId('date-range-selector')).toBeInTheDocument();
    });
    expect(screen.getByTestId('chart-view-toggle')).toBeInTheDocument();
  });
});
