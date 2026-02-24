import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { MonthlyComparisonReport } from './MonthlyComparisonReport';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${Math.round(n)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/lib/chart-colours', () => ({
  CHART_COLOURS: ['#3b82f6', '#ef4444', '#22c55e', '#f97316'],
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

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockGetMonthlyComparison = vi.fn();

vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getMonthlyComparison: (...args: any[]) => mockGetMonthlyComparison(...args),
  },
}));

const mockResponse = {
  currentMonth: '2026-01',
  previousMonth: '2025-12',
  currentMonthLabel: 'January 2026',
  previousMonthLabel: 'December 2025',
  currency: 'CAD',
  incomeExpenses: {
    currentMonth: '2026-01',
    previousMonth: '2025-12',
    currentIncome: 5000,
    previousIncome: 4500,
    incomeChange: 500,
    incomeChangePercent: 11.11,
    currentExpenses: 3000,
    previousExpenses: 3500,
    expensesChange: -500,
    expensesChangePercent: -14.29,
    currentSavings: 2000,
    previousSavings: 1000,
    savingsChange: 1000,
    savingsChangePercent: 100,
  },
  notes: {
    savingsNote: 'In January 2026, you saved 100.0% more than December 2025 for a total of $2,000.00',
    incomeNote: 'Your total income in January 2026 was $5,000.00 which is $500.00 more than December 2025',
  },
  expenses: {
    currentMonth: [
      { categoryId: 'cat-1', categoryName: 'Groceries', color: '#ff0000', total: 800 },
      { categoryId: 'cat-2', categoryName: 'Utilities', color: '#00ff00', total: 400 },
    ],
    previousMonth: [
      { categoryId: 'cat-1', categoryName: 'Groceries', color: '#ff0000', total: 700 },
    ],
    comparison: [
      {
        categoryId: 'cat-1',
        categoryName: 'Groceries',
        color: '#ff0000',
        currentTotal: 800,
        previousTotal: 700,
        change: 100,
        changePercent: 14.29,
      },
      {
        categoryId: 'cat-2',
        categoryName: 'Utilities',
        color: '#00ff00',
        currentTotal: 400,
        previousTotal: 0,
        change: 400,
        changePercent: 100,
      },
    ],
    currentTotal: 1200,
    previousTotal: 700,
  },
  topCategories: {
    currentMonth: [
      { categoryId: 'cat-1', categoryName: 'Groceries', color: '#ff0000', total: 800 },
    ],
    previousMonth: [
      { categoryId: 'cat-1', categoryName: 'Groceries', color: '#ff0000', total: 700 },
    ],
  },
  netWorth: {
    monthlyHistory: [
      { month: '2025-12', netWorth: 50000 },
      { month: '2026-01', netWorth: 52000 },
    ],
    currentNetWorth: 52000,
    previousNetWorth: 50000,
    netWorthChange: 2000,
    netWorthChangePercent: 4,
  },
  investments: {
    accountPerformance: [
      {
        accountId: 'acc-1',
        accountName: 'My Brokerage',
        currentValue: 12000,
        startValue: 10000,
        annualizedReturn: 20,
      },
    ],
    topMovers: [
      {
        securityId: 'sec-1',
        symbol: 'AAPL',
        name: 'Apple Inc.',
        currentPrice: 195.5,
        previousPrice: 190.0,
        change: 5.5,
        changePercent: 2.89,
        marketValue: 19550,
      },
    ],
  },
};

describe('MonthlyComparisonReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetMonthlyComparison.mockReturnValue(new Promise(() => {}));
    render(<MonthlyComparisonReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders month picker with correct labels', async () => {
    mockGetMonthlyComparison.mockResolvedValue(mockResponse);
    render(<MonthlyComparisonReport />);
    await waitFor(() => {
      // Month label appears in picker, pie chart titles, table headers, and top categories
      expect(screen.getAllByText('January 2026').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getByText('vs December 2025')).toBeInTheDocument();
  });

  it('renders income vs expenses section with values', async () => {
    mockGetMonthlyComparison.mockResolvedValue(mockResponse);
    render(<MonthlyComparisonReport />);
    await waitFor(() => {
      expect(screen.getByText('Income vs Expenses')).toBeInTheDocument();
    });
    expect(screen.getByText('Income')).toBeInTheDocument();
    expect(screen.getByText('Expenses')).toBeInTheDocument();
    expect(screen.getByText('Savings')).toBeInTheDocument();
  });

  it('renders summary notes', async () => {
    mockGetMonthlyComparison.mockResolvedValue(mockResponse);
    render(<MonthlyComparisonReport />);
    await waitFor(() => {
      expect(screen.getByText('Summary')).toBeInTheDocument();
    });
    expect(screen.getByText(mockResponse.notes.savingsNote)).toBeInTheDocument();
    expect(screen.getByText(mockResponse.notes.incomeNote)).toBeInTheDocument();
  });

  it('renders expense comparison table with category names', async () => {
    mockGetMonthlyComparison.mockResolvedValue(mockResponse);
    render(<MonthlyComparisonReport />);
    await waitFor(() => {
      expect(screen.getByText('Monthly Expenses Compared')).toBeInTheDocument();
    });
    // Category names appear in multiple sections (pie chart, comparison table, top categories)
    expect(screen.getAllByText('Groceries').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Utilities').length).toBeGreaterThanOrEqual(1);
  });

  it('renders top 5 categories section', async () => {
    mockGetMonthlyComparison.mockResolvedValue(mockResponse);
    render(<MonthlyComparisonReport />);
    await waitFor(() => {
      expect(screen.getByText('Top 5 Expense Categories')).toBeInTheDocument();
    });
  });

  it('renders net worth section with bar chart', async () => {
    mockGetMonthlyComparison.mockResolvedValue(mockResponse);
    render(<MonthlyComparisonReport />);
    await waitFor(() => {
      expect(screen.getByText('Your Net Worth')).toBeInTheDocument();
    });
    // Should show the net worth note text with explicit month
    expect(screen.getByText(/Your net worth in January 2026 was/)).toBeInTheDocument();
    expect(screen.getByText(/compared to December 2025/)).toBeInTheDocument();
  });

  it('renders investment performance section', async () => {
    mockGetMonthlyComparison.mockResolvedValue(mockResponse);
    render(<MonthlyComparisonReport />);
    await waitFor(() => {
      expect(screen.getByText('Investment Performance')).toBeInTheDocument();
    });
    expect(screen.getByText('Top Movers')).toBeInTheDocument();
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
  });

  it('hides investment section when no data', async () => {
    const noInvestments = {
      ...mockResponse,
      investments: { accountPerformance: [], topMovers: [] },
    };
    mockGetMonthlyComparison.mockResolvedValue(noInvestments);
    render(<MonthlyComparisonReport />);
    await waitFor(() => {
      expect(screen.getByText('Your Net Worth')).toBeInTheDocument();
    });
    expect(screen.queryByText('Investment Performance')).not.toBeInTheDocument();
  });

  it('shows empty net worth message when no history', async () => {
    const noNetWorth = {
      ...mockResponse,
      netWorth: {
        monthlyHistory: [],
        currentNetWorth: 0,
        previousNetWorth: 0,
        netWorthChange: 0,
        netWorthChangePercent: 0,
      },
    };
    mockGetMonthlyComparison.mockResolvedValue(noNetWorth);
    render(<MonthlyComparisonReport />);
    await waitFor(() => {
      expect(screen.getByText('No net worth data available.')).toBeInTheDocument();
    });
  });

  it('shows error state when API fails', async () => {
    mockGetMonthlyComparison.mockRejectedValue(new Error('Network error'));
    render(<MonthlyComparisonReport />);
    await waitFor(() => {
      expect(screen.getByText('Failed to load report data.')).toBeInTheDocument();
    });
  });

  it('renders delta badges with correct colors for positive change', async () => {
    mockGetMonthlyComparison.mockResolvedValue(mockResponse);
    render(<MonthlyComparisonReport />);
    await waitFor(() => {
      expect(screen.getByText('+11.1%')).toBeInTheDocument(); // income
    });
  });

  it('renders expense comparison with change amounts and percentages', async () => {
    mockGetMonthlyComparison.mockResolvedValue(mockResponse);
    render(<MonthlyComparisonReport />);
    await waitFor(() => {
      expect(screen.getByText('+$100.00')).toBeInTheDocument(); // Groceries change
    });
    expect(screen.getByText('+14.3%')).toBeInTheDocument(); // Groceries change percent
  });
});
