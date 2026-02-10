import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { CashFlowReport } from './CashFlowReport';

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
    dateRange: '6m',
    setDateRange: vi.fn(),
    startDate: '',
    setStartDate: vi.fn(),
    endDate: '',
    setEndDate: vi.fn(),
    resolvedRange: { start: '2024-07-01', end: '2025-01-01' },
    isValid: true,
  }),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  ReferenceLine: () => null,
}));

const mockGetCashFlow = vi.fn();
const mockGetIncomeBySource = vi.fn();
const mockGetSpendingByCategory = vi.fn();

vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getCashFlow: (...args: any[]) => mockGetCashFlow(...args),
    getIncomeBySource: (...args: any[]) => mockGetIncomeBySource(...args),
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

describe('CashFlowReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetCashFlow.mockReturnValue(new Promise(() => {}));
    mockGetIncomeBySource.mockReturnValue(new Promise(() => {}));
    mockGetSpendingByCategory.mockReturnValue(new Promise(() => {}));
    render(<CashFlowReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders summary cards and chart with data', async () => {
    mockGetCashFlow.mockResolvedValue({
      data: [
        { month: '2024-07', income: 5000, expenses: 3000, net: 2000 },
      ],
      totals: { income: 5000, expenses: 3000, net: 2000 },
    });
    mockGetIncomeBySource.mockResolvedValue({
      data: [{ categoryId: 'c-1', categoryName: 'Salary', total: 5000 }],
      totalIncome: 5000,
    });
    mockGetSpendingByCategory.mockResolvedValue({
      data: [{ categoryId: 'c-2', categoryName: 'Rent', total: 2000 }],
      totalSpending: 2000,
    });
    render(<CashFlowReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Inflows')).toBeInTheDocument();
    });
    expect(screen.getByText('Total Outflows')).toBeInTheDocument();
    expect(screen.getByText('Net Cash Flow')).toBeInTheDocument();
    expect(screen.getByText('Monthly Cash Flow')).toBeInTheDocument();
  });

  it('renders inflow and outflow breakdown tables', async () => {
    mockGetCashFlow.mockResolvedValue({
      data: [],
      totals: { income: 5000, expenses: 3000, net: 2000 },
    });
    mockGetIncomeBySource.mockResolvedValue({
      data: [{ categoryId: 'c-1', categoryName: 'Salary', total: 5000 }],
      totalIncome: 5000,
    });
    mockGetSpendingByCategory.mockResolvedValue({
      data: [{ categoryId: 'c-2', categoryName: 'Groceries', total: 1500 }],
      totalSpending: 1500,
    });
    render(<CashFlowReport />);
    await waitFor(() => {
      expect(screen.getByText('Inflows by Category')).toBeInTheDocument();
    });
    expect(screen.getByText('Outflows by Category')).toBeInTheDocument();
    expect(screen.getByText('Salary')).toBeInTheDocument();
    expect(screen.getByText('Groceries')).toBeInTheDocument();
  });
});
