import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// Both widths read the same resolved window here; what differs is how the
// report snaps its start and which presets it offers. A custom window keeps the
// resolved start; an N-year preset counts calendar years instead.
const mockResolvedRange = { start: '2024-11-15', end: '2025-06-30' };
let mockDateRange = 'custom';
vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: mockDateRange,
    setDateRange: vi.fn(),
    startDate: '',
    setStartDate: vi.fn(),
    endDate: '',
    setEndDate: vi.fn(),
    resolvedRange: mockResolvedRange,
    isValid: true,
  }),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: ({ ranges }: { ranges: readonly string[] }) => (
    <div data-testid="date-range-selector" data-ranges={ranges.join(',')} />
  ),
}));

const mockGetMonthlyCategoryBreakdown = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getMonthlyCategoryBreakdown: (...args: unknown[]) => mockGetMonthlyCategoryBreakdown(...args),
  },
}));
vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: () => Promise.resolve([]) },
}));
vi.mock('@/lib/tags', () => ({
  tagsApi: { getAll: () => Promise.resolve([]) },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const mockExportToCsv = vi.fn();
vi.mock('@/lib/csv-export', () => ({
  exportToCsv: (...args: unknown[]) => mockExportToCsv(...args),
}));

const breakdownByPeriodSpy = vi.fn();
vi.mock('@/lib/breakdown-period', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/breakdown-period')>();
  return {
    ...actual,
    breakdownByPeriod: (...args: Parameters<typeof actual.breakdownByPeriod>) => {
      breakdownByPeriodSpy();
      return actual.breakdownByPeriod(...args);
    },
  };
});

const PERIOD_KEY = 'monize-reports-monthly-category-breakdown-period';
const SORT_COLUMN_KEY = 'monize-reports-monthly-category-breakdown-sort-column';

const response = {
  currency: 'USD',
  months: ['2024-11', '2024-12', '2025-01', '2025-02'],
  data: [
    {
      categoryId: 'cat-groceries',
      categoryName: 'Groceries',
      parentId: 'cat-food',
      parentName: 'Food & Dining',
      parentIsIncome: false,
      isIncome: false,
      valuesByMonth: { '2024-11': 100, '2024-12': 200, '2025-01': 300, '2025-02': 400 },
      depositTotal: 0,
      withdrawalTotal: 1000,
    },
  ],
  transfers: [
    {
      accountId: 'acc-chequing',
      accountName: 'Chequing',
      direction: 'from',
      valuesByMonth: { '2024-12': 50, '2025-02': 25 },
    },
  ],
  missingCurrencies: [],
  excludedCount: 0,
};

async function renderReport() {
  await act(async () => {
    render(<MonthlyCategoryBreakdownReport />);
  });
  await screen.findByText('Groceries');
}

describe('MonthlyCategoryBreakdownReport yearly view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockDateRange = 'custom';
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(response);
  });

  it('starts an N-year preset on 1 January N years back', async () => {
    mockDateRange = '5y';
    window.localStorage.setItem(PERIOD_KEY, '"year"');
    await renderReport();
    const year = new Date().getFullYear();
    expect(mockGetMonthlyCategoryBreakdown).toHaveBeenLastCalledWith(
      expect.objectContaining({ startDate: `${year - 5}-01-01` }),
    );
  });

  it('opens monthly, with the monthly presets', async () => {
    await renderReport();
    expect(screen.getByRole('button', { name: 'Monthly' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('date-range-selector')).toHaveAttribute('data-ranges', '3m,6m,1y,ytd');
    expect(screen.getByText('11/2024')).toBeInTheDocument();
    expect(screen.getByText('Avg/month')).toBeInTheDocument();
    expect(mockGetMonthlyCategoryBreakdown).toHaveBeenLastCalledWith(
      expect.objectContaining({ startDate: '2024-11-01', endDate: '2025-06-30' }),
    );
  });

  it('switches to one column per year, summing the months, and remembers it', async () => {
    await renderReport();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yearly' }));
    });

    expect(screen.getByRole('button', { name: 'Yearly' })).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem(PERIOD_KEY)).toBe('"year"');
    expect(screen.getByTestId('date-range-selector')).toHaveAttribute('data-ranges', '2y,5y,10y,all');
    expect(screen.getByText('2024')).toBeInTheDocument();
    expect(screen.getByText('2025')).toBeInTheDocument();
    expect(screen.queryByText('11/2024')).not.toBeInTheDocument();
    // 2024 = 100 + 200, 2025 = 300 + 400; the average is over two years.
    expect(screen.getAllByText('- $300.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('- $700.00').length).toBeGreaterThan(0);
    expect(screen.getByText('Avg/year')).toBeInTheDocument();
    expect(screen.getAllByText('- $500.00').length).toBeGreaterThan(0);
    // The window starts on 1 January of its first year.
    await waitFor(() =>
      expect(mockGetMonthlyCategoryBreakdown).toHaveBeenLastCalledWith(
        expect.objectContaining({ startDate: '2024-01-01', endDate: '2025-06-30' }),
      ),
    );
  });

  it('drills a year cell into that year, ending where the window ends', async () => {
    window.localStorage.setItem(PERIOD_KEY, '"year"');
    await renderReport();

    await act(async () => {
      fireEvent.click(screen.getAllByText('- $300.00')[0]);
    });
    let url = mockPush.mock.calls[0][0] as string;
    expect(url).toContain('categoryIds=cat-groceries');
    expect(url).toContain('startDate=2024-01-01');
    expect(url).toContain('endDate=2024-12-31');

    await act(async () => {
      fireEvent.click(screen.getAllByText('- $700.00')[0]);
    });
    url = mockPush.mock.calls[1][0] as string;
    expect(url).toContain('startDate=2025-01-01');
    expect(url).toContain('endDate=2025-06-30');
  });

  it('drills a yearly transfer cell into that year', async () => {
    window.localStorage.setItem(PERIOD_KEY, '"year"');
    await renderReport();
    await act(async () => {
      fireEvent.click(screen.getAllByText('+ $50.00')[0]);
    });
    const url = mockPush.mock.calls[0][0] as string;
    expect(url).toContain('categoryIds=transfer');
    expect(url).toContain('accountIds=acc-chequing');
    expect(url).toContain('startDate=2024-01-01');
    expect(url).toContain('endDate=2024-12-31');
  });

  it('hides the current year until Include current year is on', async () => {
    const year = new Date().getFullYear();
    mockGetMonthlyCategoryBreakdown.mockResolvedValue({
      ...response,
      months: [`${year - 1}-06`, `${year}-01`],
      data: [
        {
          ...response.data[0],
          valuesByMonth: { [`${year - 1}-06`]: 100, [`${year}-01`]: 900 },
        },
      ],
      transfers: [],
    });
    window.localStorage.setItem(PERIOD_KEY, '"year"');
    await renderReport();

    expect(screen.queryAllByText('- $900.00')).toHaveLength(0);
    expect(screen.queryByLabelText('Include current month')).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Include current year'));
    });
    expect(screen.getAllByText('- $900.00').length).toBeGreaterThan(0);
  });

  it('drops a sort on a month column when switching to years', async () => {
    window.localStorage.setItem(SORT_COLUMN_KEY, '"2025-01"');
    await renderReport();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yearly' }));
    });
    expect(window.localStorage.getItem(SORT_COLUMN_KEY)).toBe('"category"');
  });

  it('re-sorts the folded years without folding every month again', async () => {
    window.localStorage.setItem(PERIOD_KEY, '"year"');
    await renderReport();
    const folds = breakdownByPeriodSpy.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByText('Total'));
    });
    expect(breakdownByPeriodSpy.mock.calls.length).toBe(folds);
  });

  it('exports the yearly columns under a yearly file name', async () => {
    window.localStorage.setItem(PERIOD_KEY, '"year"');
    await renderReport();
    await act(async () => {
      fireEvent.click(screen.getByText('Export CSV'));
    });
    const [filename, headers, rows] = mockExportToCsv.mock.calls[0];
    expect(filename).toBe('yearly-category-breakdown');
    expect(headers).toEqual(['Parent category', 'Category', '2024', '2025', 'Total', 'Avg/year']);
    expect(rows[0]).toEqual(['Food & Dining', 'Groceries', -300, -700, -1000, -500]);
  });
});
