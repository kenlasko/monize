import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { MonthlyCategoryBreakdownReport } from './MonthlyCategoryBreakdownReport';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    defaultCurrency: 'USD',
  }),
}));

let mockIsValid = true;
vi.mock('@/hooks/useDateRange', () => {
  const resolvedRange = { start: '2025-01-01', end: '2025-06-30' };
  return {
    useDateRange: () => ({
      dateRange: '6m',
      setDateRange: vi.fn(),
      startDate: '',
      setStartDate: vi.fn(),
      endDate: '',
      setEndDate: vi.fn(),
      resolvedRange,
      get isValid() {
        return mockIsValid;
      },
    }),
  };
});

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock('@/components/reports/ReportError', () => ({
  ReportError: ({ onRetry }: { onRetry?: () => void }) => (
    <div data-testid="report-error">
      <button onClick={onRetry}>retry</button>
    </div>
  ),
}));

const mockGetMonthlyCategoryBreakdown = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getMonthlyCategoryBreakdown: (...args: unknown[]) =>
      mockGetMonthlyCategoryBreakdown(...args),
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

const sampleResponse = {
  currency: 'USD',
  months: ['2025-01', '2025-02', '2025-03'],
  data: [
    {
      categoryId: 'cat-groceries',
      categoryName: 'Groceries',
      parentId: 'cat-food',
      parentName: 'Food & Dining',
      isIncome: false,
      valuesByMonth: { '2025-01': 100, '2025-02': 200, '2025-03': 300 },
      depositTotal: 0,
      withdrawalTotal: 600,
    },
    {
      categoryId: 'cat-salary',
      categoryName: 'Salary',
      parentId: null,
      parentName: null,
      isIncome: true,
      valuesByMonth: { '2025-01': 1000, '2025-02': 1000, '2025-03': 1000 },
      depositTotal: 3000,
      withdrawalTotal: 0,
    },
  ],
};

describe('MonthlyCategoryBreakdownReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    mockIsValid = true;
  });

  it('shows loading state initially', async () => {
    mockGetMonthlyCategoryBreakdown.mockReturnValue(new Promise(() => {}));
    render(<MonthlyCategoryBreakdownReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
    await act(async () => {});
  });

  it('renders empty state when no data returned', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue({
      currency: 'USD',
      months: [],
      data: [],
    });
    render(<MonthlyCategoryBreakdownReport />);
    await waitFor(() => {
      expect(screen.getByText('No data for this period.')).toBeInTheDocument();
    });
  });

  it('renders an error state when the fetch fails', async () => {
    mockGetMonthlyCategoryBreakdown.mockRejectedValue(new Error('boom'));
    render(<MonthlyCategoryBreakdownReport />);
    await act(async () => {});
    await waitFor(() => {
      expect(screen.getByTestId('report-error')).toBeInTheDocument();
    });
  });

  it('renders sections, category rows, subtotals and the grand summary', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(sampleResponse);
    render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });

    // Parent section header (also appears in the subtotal recap).
    expect(screen.getAllByText('Food & Dining').length).toBeGreaterThan(0);
    // Parentless income category gets the "Other" section.
    expect(screen.getByText('Salary')).toBeInTheDocument();
    expect(screen.getAllByText('Other expenses').length).toBeGreaterThan(0);

    // Subtotal rows reference each section title.
    expect(screen.getByText('Subtotal: Food & Dining')).toBeInTheDocument();

    // Grand summary rows.
    expect(screen.getByText('Summary')).toBeInTheDocument();
    expect(screen.getByText('Total expenses')).toBeInTheDocument();
    expect(screen.getByText('Total income')).toBeInTheDocument();
    expect(screen.getByText('Balance')).toBeInTheDocument();

    // Month headers (MM.YYYY).
    expect(screen.getByText('01.2025')).toBeInTheDocument();
    expect(screen.getByText('03.2025')).toBeInTheDocument();

    // Expense cell shows a negative sign, income a positive sign.
    expect(screen.getAllByText('- $100.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('+ $1000.00').length).toBeGreaterThan(0);
  });

  it('drills down to the transactions page when a non-zero cell is clicked', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(sampleResponse);
    render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });

    const cell = screen.getAllByText('- $100.00')[0];
    await act(async () => {
      fireEvent.click(cell);
    });

    expect(mockPush).toHaveBeenCalledTimes(1);
    const url = mockPush.mock.calls[0][0] as string;
    expect(url).toContain('/transactions?');
    expect(url).toContain('categoryIds=cat-groceries');
    expect(url).toContain('startDate=2025-01-01');
    expect(url).toContain('endDate=2025-01-31');
  });

  it('switches to percentage view when the toggle is checked', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(sampleResponse);
    render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });

    const toggle = screen.getByLabelText('Show percentages');
    await act(async () => {
      fireEvent.click(toggle);
    });

    // Groceries is the only expense, so its monthly value is 100% of expenses.
    await waitFor(() => {
      expect(screen.getAllByText('-100.0%').length).toBeGreaterThan(0);
    });
  });

  it('applies deviation highlighting when a category has 3+ non-zero months', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(sampleResponse);
    const { container } = render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });

    // Groceries averages 200 across 3 months; 100 is well below (green/low),
    // 300 is well above (red/high) for an expense category.
    const greenCells = container.querySelectorAll('[class*="bg-green-"]');
    const redCells = container.querySelectorAll('[class*="bg-red-"]');
    expect(greenCells.length).toBeGreaterThan(0);
    expect(redCells.length).toBeGreaterThan(0);
  });
});
