import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { MonthlyCategoryBreakdownReport } from './MonthlyCategoryBreakdownReport';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      defaultCurrency: 'USD',
    }),
  };
});

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
    datePattern: 'MM/DD/YYYY',
  }),
}));

let mockIsValid = true;
const mockResolvedRange = { start: '2025-01-01', end: '2025-06-30' };
vi.mock('@/hooks/useDateRange', () => {
  return {
    useDateRange: () => ({
      dateRange: '6m',
      setDateRange: vi.fn(),
      startDate: '',
      setStartDate: vi.fn(),
      endDate: '',
      setEndDate: vi.fn(),
      resolvedRange: mockResolvedRange,
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

// The account filter and the tag controls read these on mount; the report is
// the unchanged one while no key is chosen.
vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: () => Promise.resolve([]) },
}));
vi.mock('@/lib/tags', () => ({
  tagsApi: { getAll: () => Promise.resolve([]) },
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
    mockResolvedRange.start = '2025-01-01';
    mockResolvedRange.end = '2025-06-30';
    window.localStorage.clear();
  });

  it('snaps a mid-month resolved start down to the first of the month', async () => {
    // Day-level presets (e.g. "3m" = 90 days) resolve to a mid-month start.
    // The report is month-columnar, so it must request the whole leading month
    // -- otherwise that month's column would silently drop early transactions
    // and disagree with a wider preset that includes the full month.
    mockResolvedRange.start = '2025-03-25';
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(sampleResponse);
    render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(mockGetMonthlyCategoryBreakdown).toHaveBeenCalled();
    });
    expect(mockGetMonthlyCategoryBreakdown).toHaveBeenCalledWith({
      startDate: '2025-03-01',
      endDate: '2025-06-30',
    });
  });

  it('drills into the month-snapped start, matching the rendered columns', async () => {
    mockResolvedRange.start = '2025-03-25';
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(sampleResponse);
    render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Groceries'));
    });

    const url = mockPush.mock.calls[0][0] as string;
    expect(url).toContain('startDate=2025-03-01');
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
    // A top-level income category with no subcategories is a line of its
    // own (in the detail and in the Summary recap), not an "Other income"
    // section.
    expect(screen.getAllByText('Salary')).toHaveLength(2);
    expect(screen.queryByText('Other income')).not.toBeInTheDocument();

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

  it('drills down to uncategorized transactions when the Uncategorized row is clicked', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue({
      currency: 'USD',
      months: ['2025-01', '2025-02', '2025-03'],
      data: [
        {
          categoryId: null,
          categoryName: 'Uncategorized',
          parentId: null,
          parentName: null,
          parentIsIncome: null,
          isIncome: false,
          valuesByMonth: { '2025-01': 50, '2025-02': 0, '2025-03': 70 },
          depositTotal: 0,
          withdrawalTotal: 120,
        },
      ],
      transfers: [],
    });
    render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('Uncategorized')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Uncategorized'));
    });

    expect(mockPush).toHaveBeenCalledTimes(1);
    const url = mockPush.mock.calls[0][0] as string;
    expect(url).toContain('/transactions?');
    // Reuses the existing "uncategorized" pseudo-filter (categoryId IS NULL);
    // no real category id and no extra backend query.
    expect(url).toContain('categoryIds=uncategorized');
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

  it('hides deviation highlighting when the toggle is switched off', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(sampleResponse);
    const { container } = render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });

    // Level-3 deviation cells (bg-{red,green}-200) are unique to the highlight
    // logic -- group headers use the -100 ramp, palettes the -50 ramp -- so they
    // isolate the deviation styling from the rest of the table.
    expect(
      container.querySelectorAll('[class*="bg-green-200"]').length,
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll('[class*="bg-red-200"]').length,
    ).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Highlight deviations'));
    });

    await waitFor(() => {
      expect(
        container.querySelectorAll('[class*="bg-green-200"]').length,
      ).toBe(0);
    });
    expect(container.querySelectorAll('[class*="bg-red-200"]').length).toBe(0);
  });

  it('persists the deviation toggle to localStorage and restores it', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(sampleResponse);
    const first = render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Highlight deviations'));
    });
    await waitFor(() => {
      expect(
        first.container.querySelectorAll('[class*="bg-red-200"]').length,
      ).toBe(0);
    });

    // Re-mounting reads the persisted toggle and stays muted without any
    // further interaction.
    first.unmount();
    const second = render(<MonthlyCategoryBreakdownReport />);
    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });
    expect(
      second.container.querySelectorAll('[class*="bg-red-200"]').length,
    ).toBe(0);
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
      expect(screen.getAllByText('Salary').length).toBeGreaterThan(0);
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

  it('drills into the category over the full range when its Total cell is clicked', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(sampleResponse);
    render(<MonthlyCategoryBreakdownReport />);

    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });

    // Groceries total is 100+200+300 = 600; the row's Total cell is the first
    // such button and drills with the same filter as the category name.
    const totals = screen.getAllByRole('button', { name: '- $600.00' });
    await act(async () => {
      fireEvent.click(totals[0]);
    });

    expect(mockPush).toHaveBeenCalledTimes(1);
    const url = mockPush.mock.calls[0][0] as string;
    expect(url).toContain('categoryIds=cat-groceries');
    expect(url).toContain('startDate=2025-01-01');
    expect(url).toContain('endDate=2025-06-30');
  });

  describe('row hover highlighting', () => {
    // The category column is sticky with its own opaque background, so it must
    // carry the row's group-hover tint or it paints over the hover highlight
    // (the whole row, including the name, should highlight together).
    it('highlights the sticky category column on subcategory and transfer rows', async () => {
      mockGetMonthlyCategoryBreakdown.mockResolvedValue(transfersResponse);
      render(<MonthlyCategoryBreakdownReport />);

      await waitFor(() => {
        expect(screen.getByText('From Chequing')).toBeInTheDocument();
      });

      // Category name cell (the detail row, ahead of the Summary recap).
      const salaryCell = screen.getAllByText('Salary')[0].closest('td');
      expect(salaryCell?.className).toContain('group-hover:bg-gray-50');
      const salaryRow = salaryCell?.closest('tr');
      expect(salaryRow?.className).toContain('group');
      expect(salaryRow?.className).toContain('hover:bg-gray-50');

      // Transfer name cell.
      const transferCell = screen.getByText('From Chequing').closest('td');
      expect(transferCell?.className).toContain('group-hover:bg-gray-50');
      expect(transferCell?.closest('tr')?.className).toContain('group');
    });

    it('highlights the category column on the Summary total and balance rows', async () => {
      mockGetMonthlyCategoryBreakdown.mockResolvedValue(transfersResponse);
      render(<MonthlyCategoryBreakdownReport />);

      await waitFor(() => {
        expect(screen.getByText('Summary')).toBeInTheDocument();
      });

      // Balance row (rendered inline in the summary).
      const balanceCell = screen
        .getByRole('button', { name: 'Balance' })
        .closest('td');
      expect(balanceCell?.className).toContain('group-hover:bg-gray-200');
      const balanceRow = balanceCell?.closest('tr');
      expect(balanceRow?.className).toContain('group');
      expect(balanceRow?.className).toContain('hover:bg-gray-200');

      // Total income summary row (rendered via renderSummaryRow).
      const incomeCell = screen
        .getByRole('button', { name: 'Total income' })
        .closest('td');
      expect(incomeCell?.className).toContain('group-hover:bg-gray-200');
      expect(incomeCell?.closest('tr')?.className).toContain('group');

      // Overall total row (only present when there are transfers).
      const overallCell = screen.getByText('Overall total').closest('td');
      expect(overallCell?.className).toContain('group-hover:bg-gray-300');
      expect(overallCell?.closest('tr')?.className).toContain('hover:bg-gray-300');
    });

    it('highlights the category column on the Summary recap rows', async () => {
      mockGetMonthlyCategoryBreakdown.mockResolvedValue(sampleResponse);
      const { container } = render(<MonthlyCategoryBreakdownReport />);

      await waitFor(() => {
        expect(screen.getByText('Groceries')).toBeInTheDocument();
      });

      // The per-section recap rows at the bottom of the Summary tint their
      // sticky title cell with the lighter recap hover shade.
      const recapCells = container.querySelectorAll(
        'td[class*="group-hover:bg-gray-100"]',
      );
      expect(recapCells.length).toBeGreaterThan(0);
      recapCells.forEach((cell) => {
        const row = cell.closest('tr');
        expect(row?.className).toContain('group');
        expect(row?.className).toContain('hover:bg-gray-100');
      });
    });
  });

  // A month-columnar report cannot fit a phone, and the sticky category column
  // is the width the months are missing. Dragging it sideways slides it out of
  // view and moves its right edge by the same amount, so the months take
  // exactly the width the names give up.
  describe('phone: collapsing the category column', () => {
    const PHONE_QUERY = '(max-width: 639px)';
    const FULL_WIDTH = 116;
    const MAX_OFFSET = FULL_WIDTH - 28; // never past the grabbable stub

    const setPhone = (isPhone: boolean) => {
      vi.mocked(window.matchMedia).mockImplementation(
        (query: string) =>
          ({
            matches: isPhone && query === PHONE_QUERY,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
          }) as unknown as MediaQueryList,
      );
    };

    afterEach(() => {
      unmountPrevious = null;
      setPhone(false);
    });

    // jsdom ships no PointerEvent, so the gesture is replayed with MouseEvents
    // carrying the pointer type names React dispatches on.
    const pointer = (type: string, target: Element, clientX: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
      });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      target.dispatchEvent(event);
    };

    const scroller = (container: HTMLElement) =>
      container.querySelector('.overflow-x-auto') as HTMLElement;

    let unmountPrevious: (() => void) | null = null;
    const renderPhoneReport = async () => {
      // Leaving an earlier render mounted would let `getByText` resolve against
      // it, so a remount test would assert on the wrong tree.
      unmountPrevious?.();
      setPhone(true);
      mockGetMonthlyCategoryBreakdown.mockResolvedValue(sampleResponse);
      const { container, unmount } = render(<MonthlyCategoryBreakdownReport />);
      unmountPrevious = unmount;
      await waitFor(() => {
        expect(screen.getByText('Groceries')).toBeInTheDocument();
      });
      return container;
    };

    const drag = async (container: HTMLElement, from: number, to: number) => {
      const cell = screen.getByText('Groceries').closest('td') as HTMLElement;
      await act(async () => {
        pointer('pointerdown', cell, from);
        pointer('pointermove', cell, to);
        pointer('pointerup', cell, to);
      });
    };

    it('narrows the column by exactly what it slides out of view', async () => {
      const container = await renderPhoneReport();
      const el = scroller(container);
      expect(el.style.getPropertyValue('--mcb-name-off')).toBe('0px');

      await drag(container, 100, 60); // dragged 40px to the left

      expect(el.style.getPropertyValue('--mcb-name-off')).toBe('40px');
      expect(el.style.getPropertyValue('--mcb-name-w')).toBe(
        `${FULL_WIDTH - 40}px`,
      );
      // The wrap width never moves, so the names do not reflow mid-drag.
      expect(el.style.getPropertyValue('--mcb-name-full')).toBe(
        `${FULL_WIDTH}px`,
      );
    });

    it('stops at a grabbable stub instead of collapsing to nothing', async () => {
      const container = await renderPhoneReport();

      await drag(container, 300, 0); // far past the full width

      expect(scroller(container).style.getPropertyValue('--mcb-name-off')).toBe(
        `${MAX_OFFSET}px`,
      );
    });

    it('remembers the offset across a remount', async () => {
      const container = await renderPhoneReport();
      await drag(container, 100, 70);
      expect(
        JSON.parse(
          window.localStorage.getItem(
            'monize-reports-monthly-category-breakdown-name-offset',
          ) as string,
        ),
      ).toBe(30);

      const second = await renderPhoneReport();
      expect(scroller(second).style.getPropertyValue('--mcb-name-off')).toBe(
        '30px',
      );
    });

    it('still drills down on a tap that never became a drag', async () => {
      await renderPhoneReport();
      const name = screen.getByText('Groceries');
      const cell = name.closest('td') as HTMLElement;

      await act(async () => {
        pointer('pointerdown', cell, 100);
        pointer('pointermove', cell, 102); // under the 4px threshold
        pointer('pointerup', cell, 102);
        fireEvent.click(name);
      });

      expect(mockPush).toHaveBeenCalled();
    });

    it('does not drill down on the click that ends a drag', async () => {
      const container = await renderPhoneReport();
      const name = screen.getByText('Groceries');

      await drag(container, 100, 40);
      await act(async () => {
        fireEvent.click(name);
      });
      expect(mockPush).not.toHaveBeenCalled();

      // The suppression is spent on that one click, not latched.
      await act(async () => {
        fireEvent.click(name);
      });
      expect(mockPush).toHaveBeenCalled();
    });

    it('does not swallow a later click when the drag produced none', async () => {
      const container = await renderPhoneReport();
      const cell = screen.getByText('Groceries').closest('td') as HTMLElement;

      // A drag released outside the cell arms the suppression but never spends
      // it, because no click follows; the next gesture must still work.
      await act(async () => {
        pointer('pointerdown', cell, 100);
        pointer('pointermove', cell, 40);
        pointer('pointerup', scroller(container), 40);
      });
      expect(mockPush).not.toHaveBeenCalled();

      await act(async () => {
        pointer('pointerdown', cell, 100);
        pointer('pointerup', cell, 100);
        fireEvent.click(screen.getByText('Groceries'));
      });
      expect(mockPush).toHaveBeenCalled();
    });

    it('leaves the column alone above the phone breakpoint', async () => {
      setPhone(false);
      mockGetMonthlyCategoryBreakdown.mockResolvedValue(sampleResponse);
      const { container } = render(<MonthlyCategoryBreakdownReport />);
      await waitFor(() => {
        expect(screen.getByText('Groceries')).toBeInTheDocument();
      });

      await drag(container, 100, 20);

      expect(scroller(container).style.getPropertyValue('--mcb-name-off')).toBe(
        '0px',
      );
    });
  });

  it('names the currencies left out of the figures when a rate is missing', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue({
      ...sampleResponse,
      missingCurrencies: ['JPY'],
      excludedCount: 2,
    });
    render(<MonthlyCategoryBreakdownReport />);
    const notice = await screen.findByTestId('partial-data-notice');
    expect(notice).toHaveTextContent('JPY');
    expect(notice).toHaveTextContent('USD');
  });

  it('shows no partial-data note when every row converted', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue({
      ...sampleResponse,
      missingCurrencies: [],
      excludedCount: 0,
    });
    render(<MonthlyCategoryBreakdownReport />);
    await screen.findByText('Groceries');
    expect(screen.queryByTestId('partial-data-notice')).not.toBeInTheDocument();
  });
});

describe('MonthlyCategoryBreakdownReport: a reload is not the previous answer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsValid = true;
    mockResolvedRange.start = '2025-01-01';
    mockResolvedRange.end = '2025-06-30';
    window.localStorage.clear();
  });

  async function loadThenChangeRange(next: () => unknown) {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(sampleResponse);
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<MonthlyCategoryBreakdownReport />);
    });
    await screen.findByText('Groceries');
    expect(screen.getByTitle('Export CSV')).toBeEnabled();

    mockGetMonthlyCategoryBreakdown.mockImplementation(next);
    mockResolvedRange.end = '2025-07-31';
    await act(async () => {
      view.rerender(<MonthlyCategoryBreakdownReport />);
    });
    await waitFor(() =>
      expect(mockGetMonthlyCategoryBreakdown).toHaveBeenLastCalledWith(
        expect.objectContaining({ endDate: '2025-07-31' }),
      ),
    );
  }

  it('disables the export while the next request has failed', async () => {
    await loadThenChangeRange(() => Promise.reject(new Error('500')));
    expect(screen.getByTitle('Export CSV')).toBeDisabled();
  });

  it('disables the export while the next request is pending', async () => {
    await loadThenChangeRange(() => new Promise(() => {}));
    expect(screen.getByTitle('Export CSV')).toBeDisabled();
  });
});
