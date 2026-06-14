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

// Deterministic month formatting (the real hook is locale-dependent for the
// 'browser' default). Renders YYYY-MM as MM/YYYY so headers are assertable.
vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatDate: (d: string) => d,
    formatMonth: (m: string) => {
      const [year, mon] = m.split('-');
      return `${mon}/${year}`;
    },
    dateFormat: 'MM/DD/YYYY',
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

const mockExportToCsv = vi.fn();
vi.mock('@/lib/csv-export', () => ({
  exportToCsv: (...args: unknown[]) => mockExportToCsv(...args),
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
      parentIsIncome: false,
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
      parentIsIncome: null,
      isIncome: true,
      valuesByMonth: { '2025-01': 1000, '2025-02': 1000, '2025-03': 1000 },
      depositTotal: 3000,
      withdrawalTotal: 0,
    },
  ],
  transfers: [],
};

describe('MonthlyCategoryBreakdownReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    mockIsValid = true;
    window.localStorage.clear();
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

    // Parent section header for the expense group.
    expect(screen.getAllByText('Food & Dining').length).toBeGreaterThan(0);
    // Parentless income category collects into the "Other income" section.
    expect(screen.getByText('Salary')).toBeInTheDocument();
    expect(screen.getAllByText('Other income').length).toBeGreaterThan(0);

    // Top-level group headers separate income from expenses.
    expect(screen.getByText('Income')).toBeInTheDocument();
    expect(screen.getByText('Expenses')).toBeInTheDocument();

    // Subtotal rows reference each section title.
    expect(screen.getByText('Subtotal: Food & Dining')).toBeInTheDocument();

    // Per-group totals (also echoed in the summary) plus the balance row.
    expect(screen.getByText('Summary')).toBeInTheDocument();
    expect(screen.getAllByText('Total expenses').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Total income').length).toBeGreaterThan(0);
    expect(screen.getByText('Balance')).toBeInTheDocument();

    // Month headers follow the user's date format (mocked here as MM/YYYY).
    expect(screen.getByText('01/2025')).toBeInTheDocument();
    expect(screen.getByText('03/2025')).toBeInTheDocument();

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

  it('drills down using the full report range when a category name is clicked', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(sampleResponse);
    render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Groceries'));
    });

    expect(mockPush).toHaveBeenCalledTimes(1);
    const url = mockPush.mock.calls[0][0] as string;
    expect(url).toContain('/transactions?');
    expect(url).toContain('categoryIds=cat-groceries');
    // Full resolved report range, not a single month.
    expect(url).toContain('startDate=2025-01-01');
    expect(url).toContain('endDate=2025-06-30');
  });

  it('drills down into every child category when a section header is clicked', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(sampleResponse);
    render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });

    // The first "Food & Dining" occurrence is the clickable section header.
    const header = screen.getAllByText('Food & Dining')[0];
    await act(async () => {
      fireEvent.click(header);
    });

    expect(mockPush).toHaveBeenCalledTimes(1);
    const url = mockPush.mock.calls[0][0] as string;
    expect(url).toContain('/transactions?');
    expect(url).toContain('categoryIds=cat-groceries');
    expect(url).toContain('startDate=2025-01-01');
    expect(url).toContain('endDate=2025-06-30');
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

  it('persists the percentage toggle to localStorage and restores it', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(sampleResponse);
    const first = render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Show percentages'));
    });
    await waitFor(() => {
      expect(screen.getAllByText('-100.0%').length).toBeGreaterThan(0);
    });

    // Re-mounting the report reads the persisted toggle and stays in
    // percentage mode without any further interaction.
    first.unmount();
    render(<MonthlyCategoryBreakdownReport />);
    await waitFor(() => {
      expect(screen.getAllByText('-100.0%').length).toBeGreaterThan(0);
    });
  });

  it('exports the breakdown as a CSV when the export button is clicked', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(sampleResponse);
    render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Export CSV'));
    });

    expect(mockExportToCsv).toHaveBeenCalledTimes(1);
    const [filename, headers, rows] = mockExportToCsv.mock.calls[0];
    expect(filename).toBe('monthly-category-breakdown');
    // Parent + Category + 3 months + Total + Avg/month columns.
    expect(headers).toHaveLength(7);
    expect(headers[0]).toBe('Parent category');
    expect(headers[1]).toBe('Category');

    // Groceries row: expense values are negated to match the table display.
    const groceries = rows.find((r: unknown[]) => r[1] === 'Groceries');
    expect(groceries).toBeDefined();
    expect(groceries[0]).toBe('Food & Dining');
    expect(groceries[2]).toBe(-100);

    // Summary rows are appended.
    expect(rows.some((r: unknown[]) => r[1] === 'Total expenses')).toBe(true);
    expect(rows.some((r: unknown[]) => r[1] === 'Total income')).toBe(true);
    expect(rows.some((r: unknown[]) => r[1] === 'Balance')).toBe(true);
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

  // Two expense subcategories under one parent: a normal spend and a
  // refund-heavy one whose net is positive (negative expense magnitude). The
  // subcategories must sort alphabetically and the subtotal must net them out.
  const mixedSignResponse = {
    currency: 'USD',
    months: ['2025-01'],
    data: [
      {
        categoryId: 'sub-zebra',
        categoryName: 'Zebra',
        parentId: 'cat-auto',
        parentName: 'Auto',
        parentIsIncome: false,
        isIncome: false,
        valuesByMonth: { '2025-01': 100 },
        depositTotal: 0,
        withdrawalTotal: 100,
      },
      {
        categoryId: 'sub-apple',
        categoryName: 'Apple',
        parentId: 'cat-auto',
        parentName: 'Auto',
        parentIsIncome: false,
        isIncome: false,
        valuesByMonth: { '2025-01': -30 },
        depositTotal: 30,
        withdrawalTotal: 0,
      },
    ],
    transfers: [],
  };

  it('sorts subcategories alphabetically within a section', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(mixedSignResponse);
    render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('Apple')).toBeInTheDocument();
    });

    // Apple (A) must render before Zebra (Z), not in amount order.
    const apple = screen.getByText('Apple');
    const zebra = screen.getByText('Zebra');
    expect(
      apple.compareDocumentPosition(zebra) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('nets a positive-total expense subcategory into the section subtotal', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(mixedSignResponse);
    render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('Subtotal: Auto')).toBeInTheDocument();
    });

    // Subtotal = 100 + (-30) = 70, NOT 100 + 30 = 130.
    expect(screen.getAllByText('- $70.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('- $130.00')).not.toBeInTheDocument();
  });

  it('re-sorts rows by amount when a value column header is clicked', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(mixedSignResponse);
    render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('Apple')).toBeInTheDocument();
    });

    // Default (alphabetical): Apple before Zebra. Sorting by the Total column
    // descending puts Zebra (100) before Apple (-30).
    await act(async () => {
      fireEvent.click(screen.getByText('Total'));
    });

    await waitFor(() => {
      const apple = screen.getByText('Apple');
      const zebra = screen.getByText('Zebra');
      expect(
        zebra.compareDocumentPosition(apple) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  const transfersResponse = {
    currency: 'USD',
    months: ['2025-01'],
    data: [
      {
        categoryId: 'cat-salary',
        categoryName: 'Salary',
        parentId: null,
        parentName: null,
        parentIsIncome: null,
        isIncome: true,
        valuesByMonth: { '2025-01': 1000 },
        depositTotal: 1000,
        withdrawalTotal: 0,
      },
    ],
    transfers: [
      {
        accountId: 'acc-chequing',
        accountName: 'Chequing',
        direction: 'from',
        valuesByMonth: { '2025-01': 500 },
      },
      {
        accountId: 'acc-savings',
        accountName: 'Savings',
        direction: 'to',
        valuesByMonth: { '2025-01': -200 },
      },
    ],
  };

  it('renders a transfers section with from/to rows and an overall total', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(transfersResponse);
    render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('From Chequing')).toBeInTheDocument();
    });

    // Transfers group header and a "to" row (shown negative).
    expect(screen.getAllByText('Transfers').length).toBeGreaterThan(0);
    expect(screen.getByText('To Savings')).toBeInTheDocument();

    // Net transfers = 500 + (-200) = 300.
    expect(screen.getAllByText('+ $300.00').length).toBeGreaterThan(0);
    // Overall total = income (1000) - expenses (0) + transfers (300) = 1300.
    expect(screen.getByText('Overall total')).toBeInTheDocument();
    expect(screen.getAllByText('+ $1300.00').length).toBeGreaterThan(0);
  });

  it('excludes the in-progress current month unless opted in', async () => {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(
      now.getMonth() + 1,
    ).padStart(2, '0')}`;
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonth = `${prev.getFullYear()}-${String(
      prev.getMonth() + 1,
    ).padStart(2, '0')}`;

    mockGetMonthlyCategoryBreakdown.mockResolvedValue({
      currency: 'USD',
      months: [prevMonth, currentMonth],
      data: [
        {
          categoryId: 'cat-salary',
          categoryName: 'Salary',
          parentId: null,
          parentName: null,
          parentIsIncome: null,
          isIncome: true,
          valuesByMonth: { [prevMonth]: 1000, [currentMonth]: 500 },
          depositTotal: 1500,
          withdrawalTotal: 0,
        },
      ],
      transfers: [],
    });
    render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('Salary')).toBeInTheDocument();
    });

    // By default the current (in-progress) month column is hidden, so its
    // value (500) does not appear anywhere.
    expect(screen.queryAllByText('+ $500.00').length).toBe(0);

    // Opting in brings the current month back.
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Include current month'));
    });
    await waitFor(() => {
      expect(screen.getAllByText('+ $500.00').length).toBeGreaterThan(0);
    });
  });

  it('drills into an account\'s transfers when a transfer row is clicked', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(transfersResponse);
    render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('From Chequing')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('From Chequing'));
    });

    expect(mockPush).toHaveBeenCalledTimes(1);
    const url = mockPush.mock.calls[0][0] as string;
    expect(url).toContain('/transactions?');
    expect(url).toContain('categoryIds=transfer');
    expect(url).toContain('accountIds=acc-chequing');
    expect(url).toContain('startDate=2025-01-01');
    expect(url).toContain('endDate=2025-06-30');
  });

  it('drills into income categories when the Total income summary row is clicked', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(sampleResponse);
    render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });

    // Only the summary "Total income" is a button (the group total is plain).
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Total income' }));
    });

    expect(mockPush).toHaveBeenCalledTimes(1);
    const url = mockPush.mock.calls[0][0] as string;
    expect(url).toContain('/transactions?');
    expect(url).toContain('categoryIds=cat-salary');
    expect(url).toContain('startDate=2025-01-01');
    expect(url).toContain('endDate=2025-06-30');
  });
});
