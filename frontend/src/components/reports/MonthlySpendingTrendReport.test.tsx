import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { MonthlySpendingTrendReport } from './MonthlySpendingTrendReport';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
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

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

const mockGetIncomeVsExpenses = vi.fn();

vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getIncomeVsExpenses: (...args: any[]) => mockGetIncomeVsExpenses(...args),
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

describe('MonthlySpendingTrendReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetIncomeVsExpenses.mockReturnValue(new Promise(() => {}));
    render(<MonthlySpendingTrendReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no data returned', async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [],
    });
    render(<MonthlySpendingTrendReport />);
    await waitFor(() => {
      expect(screen.getByText('No data for this period.')).toBeInTheDocument();
    });
  });

  it('renders chart and summary with sample data', async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [
        { month: '2024-01', income: 5000, expenses: 3000, net: 2000 },
        { month: '2024-02', income: 5200, expenses: 3500, net: 1700 },
      ],
    });
    render(<MonthlySpendingTrendReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Income')).toBeInTheDocument();
    });
    expect(screen.getByText('Total Expenses')).toBeInTheDocument();
    expect(screen.getByText('Avg Monthly Income')).toBeInTheDocument();
    expect(screen.getByText('Avg Monthly Expenses')).toBeInTheDocument();
  });

  it('renders date range selector', async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({ data: [] });
    render(<MonthlySpendingTrendReport />);
    await waitFor(() => {
      expect(screen.getByTestId('date-range-selector')).toBeInTheDocument();
    });
  });

  it('renders line chart when data present', async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [
        { month: '2024-01', income: 5000, expenses: 3000, net: 2000 },
      ],
    });
    render(<MonthlySpendingTrendReport />);
    await waitFor(() => {
      expect(screen.getByTestId('line-chart')).toBeInTheDocument();
    });
  });

  it('handles API error gracefully', async () => {
    mockGetIncomeVsExpenses.mockRejectedValue(new Error('Network error'));
    render(<MonthlySpendingTrendReport />);
    await waitFor(() => {
      expect(screen.getByText('No data for this period.')).toBeInTheDocument();
    });
  });
});
