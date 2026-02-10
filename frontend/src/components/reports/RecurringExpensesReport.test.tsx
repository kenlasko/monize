import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { RecurringExpensesReport } from './RecurringExpensesReport';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(2)}`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/lib/chart-colours', () => ({
  CHART_COLOURS: ['#3b82f6', '#ef4444', '#22c55e'],
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  Pie: () => null,
  Cell: () => null,
  Tooltip: () => null,
}));

const mockGetRecurringExpenses = vi.fn();

vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getRecurringExpenses: (...args: any[]) => mockGetRecurringExpenses(...args),
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

describe('RecurringExpensesReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetRecurringExpenses.mockReturnValue(new Promise(() => {}));
    render(<RecurringExpensesReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no recurring expenses', async () => {
    mockGetRecurringExpenses.mockResolvedValue({
      data: [],
      summary: { uniquePayees: 0, totalRecurring: 0, monthlyEstimate: 0 },
    });
    render(<RecurringExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText(/No recurring expenses found/)).toBeInTheDocument();
    });
  });

  it('renders summary and table with data', async () => {
    mockGetRecurringExpenses.mockResolvedValue({
      data: [
        {
          payeeId: 'p-1',
          payeeName: 'Netflix',
          categoryName: 'Entertainment',
          frequency: 'Monthly',
          occurrences: 6,
          averageAmount: 15.99,
          totalAmount: 95.94,
          lastTransactionDate: '2025-01-15',
        },
      ],
      summary: { uniquePayees: 1, totalRecurring: 95.94, monthlyEstimate: 15.99 },
    });
    render(<RecurringExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText('Netflix')).toBeInTheDocument();
    });
    expect(screen.getByText('Recurring Expenses')).toBeInTheDocument();
    expect(screen.getByText('6-Month Total')).toBeInTheDocument();
    expect(screen.getByText('Monthly Estimate')).toBeInTheDocument();
  });

  it('renders failed state when data is null', async () => {
    mockGetRecurringExpenses.mockRejectedValue(new Error('API error'));
    render(<RecurringExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText('Failed to load recurring expenses data.')).toBeInTheDocument();
    });
  });
});
