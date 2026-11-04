import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { MonthlyCategoryBreakdownReport } from './MonthlyCategoryBreakdownReport';

// How the report lays its rows out (discussion #2010): a top-level category
// with no subcategories is a line of its own, the Income, Expenses and
// Transfers groups fold down to their totals, and "Summary only" leaves just
// the Summary block.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
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
    formatMonth: (m: string) => m,
    dateFormat: 'MM/DD/YYYY',
    datePattern: 'MM/DD/YYYY',
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
    resolvedRange: { start: '2025-01-01', end: '2025-06-30' },
    isValid: true,
  }),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

const mockGetMonthlyCategoryBreakdown = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getMonthlyCategoryBreakdown: (...args: unknown[]) =>
      mockGetMonthlyCategoryBreakdown(...args),
  },
}));

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

const row = (
  categoryId: string | null,
  categoryName: string,
  amount: number,
  parent?: { id: string; name: string },
  isIncome = false,
) => ({
  categoryId,
  categoryName,
  parentId: parent?.id ?? null,
  parentName: parent?.name ?? null,
  parentIsIncome: parent ? isIncome : null,
  isIncome,
  valuesByMonth: { '2025-01': amount },
  depositTotal: isIncome ? amount : 0,
  withdrawalTotal: isIncome ? 0 : amount,
});

const AUTO = { id: 'cat-auto', name: 'Auto & Transport' };
const FEES = { id: 'cat-fees', name: 'Fees & Charges' };

const response = {
  currency: 'USD',
  months: ['2025-01'],
  data: [
    row('cat-salary', 'Salary', 1000, undefined, true),
    row('cat-gas', 'Gas & Fuel', 60, AUTO),
    row('cat-parking', 'Parking', 15, AUTO),
    row('cat-bank-fee', 'Bank Fee', 5, FEES),
    row('cat-entertainment', 'Entertainment', 40),
    row('cat-cigarettes', 'Cigarettes', 30),
    row(null, 'Uncategorized', 7),
  ],
  transfers: [
    {
      accountId: 'acc-chequing',
      accountName: 'Chequing',
      direction: 'from',
      valuesByMonth: { '2025-01': 500 },
    },
  ],
};

async function renderReport() {
  await act(async () => {
    render(<MonthlyCategoryBreakdownReport />);
  });
  await waitFor(() => {
    expect(screen.getByText('Gas & Fuel')).toBeInTheDocument();
  });
}

/** The text of every row's first cell, in document order. */
const rowLabels = () =>
  Array.from(document.querySelectorAll('tbody tr')).map(
    (tr) => tr.querySelector('td')?.textContent?.trim() ?? '',
  );

describe('MonthlyCategoryBreakdownReport: standalone categories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(response);
  });

  it('draws a category with no parent and no subcategories as one line, sorted among the parents', async () => {
    await renderReport();

    const labels = rowLabels();
    const expensesAt = labels.indexOf('Expenses');
    const detail = labels.slice(expensesAt, labels.indexOf('Total expenses'));
    expect(detail).toEqual([
      'Expenses',
      'Auto & Transport',
      'Gas & Fuel',
      'Parking',
      'Subtotal: Auto & Transport',
      'Cigarettes',
      'Entertainment',
      'Fees & Charges',
      'Bank Fee',
      'Subtotal: Fees & Charges',
      'Other expenses',
      'Uncategorized',
      'Subtotal: Other expenses',
    ]);
    expect(screen.queryByText('Subtotal: Cigarettes')).not.toBeInTheDocument();
    expect(
      screen.getAllByText('Cigarettes')[0].closest('tr'),
    ).toHaveAttribute('data-standalone');
  });

  it('lists a standalone category by name in the Summary recap, not under Other expenses', async () => {
    await renderReport();

    const labels = rowLabels();
    const recap = labels.slice(labels.lastIndexOf('') + 1);
    expect(recap).toEqual([
      'Salary',
      'Auto & Transport',
      'Cigarettes',
      'Entertainment',
      'Fees & Charges',
      'Other expenses',
      'Transfers',
    ]);
  });

  it('gives a standalone line its own figures, signed like any expense row', async () => {
    await renderReport();

    const line = screen.getAllByText('Cigarettes')[0].closest('tr')!;
    expect(line).toHaveTextContent('- $30.00');
  });

  it('puts a parent category\'s own spending inside its section, not under Other expenses', async () => {
    mockGetMonthlyCategoryBreakdown.mockResolvedValue({
      ...response,
      data: [
        row('cat-auto', 'Auto & Transport', 20),
        row('cat-gas', 'Gas & Fuel', 60, AUTO),
      ],
      transfers: [],
    });
    await renderReport();

    const labels = rowLabels();
    expect(labels.slice(0, 5)).toEqual([
      'Expenses',
      'Auto & Transport',
      'Auto & Transport',
      'Gas & Fuel',
      'Subtotal: Auto & Transport',
    ]);
    expect(screen.queryByText('Other expenses')).not.toBeInTheDocument();
    expect(
      screen.getByText('Subtotal: Auto & Transport').closest('tr'),
    ).toHaveTextContent('- $80.00');
  });

  it('exports a standalone category with no parent column', async () => {
    await renderReport();

    await act(async () => {
      fireEvent.click(screen.getByText('Export CSV'));
    });

    const rows = mockExportToCsv.mock.calls[0][2] as (string | number)[][];
    expect(rows).toContainEqual(['', 'Cigarettes', -30, -30, -30]);
    expect(rows).toContainEqual(['Auto & Transport', 'Gas & Fuel', -60, -60, -60]);
  });
});

describe('MonthlyCategoryBreakdownReport: folding a group', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(response);
  });

  it('folds Expenses down to its total and back', async () => {
    await renderReport();
    const header = screen.getByRole('button', { name: 'Expenses' });
    expect(header).toHaveAttribute('aria-expanded', 'true');

    await act(async () => {
      fireEvent.click(header);
    });

    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Gas & Fuel')).not.toBeInTheDocument();
    expect(screen.queryByText('Subtotal: Auto & Transport')).not.toBeInTheDocument();
    // The group total stays, and so does the Summary recap of each section.
    const labels = rowLabels();
    expect(labels.slice(labels.indexOf('Expenses'), labels.indexOf('Expenses') + 2)).toEqual([
      'Expenses',
      'Total expenses',
    ]);
    expect(screen.getAllByText('Cigarettes')).toHaveLength(1);
    // The other groups are untouched.
    expect(screen.getAllByText('Salary')).toHaveLength(2);
    expect(screen.getByText('From Chequing')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(header);
    });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Gas & Fuel')).toBeInTheDocument();
  });

  it('folds Transfers down to the Total transfers row', async () => {
    await renderReport();

    await act(async () => {
      // The Summary recap's Transfers row is a button too; the header is the
      // one that discloses.
      fireEvent.click(
        screen.getByRole('button', { name: 'Transfers', expanded: true }),
      );
    });

    expect(screen.queryByText('From Chequing')).not.toBeInTheDocument();
    const labels = rowLabels();
    const at = labels.indexOf('Transfers');
    expect(labels.slice(at, at + 2)).toEqual(['Transfers', 'Total transfers']);
    expect(screen.getByText('Gas & Fuel')).toBeInTheDocument();
  });

  it('folds Income down to its total', async () => {
    await renderReport();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Income' }));
    });

    const labels = rowLabels();
    expect(labels.slice(0, 2)).toEqual(['Income', 'Total income']);
    // Only the Summary recap still names the category.
    expect(screen.getAllByText('Salary')).toHaveLength(1);
  });

  it('remembers which groups are folded across a remount', async () => {
    const { unmount } = render(<MonthlyCategoryBreakdownReport />);
    await waitFor(() => {
      expect(screen.getByText('Gas & Fuel')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expenses' }));
    });
    unmount();

    await act(async () => {
      render(<MonthlyCategoryBreakdownReport />);
    });
    await waitFor(() => {
      expect(screen.getByText('From Chequing')).toBeInTheDocument();
    });
    expect(screen.queryByText('Gas & Fuel')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expenses' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('folds nothing when the stored value is not a list', async () => {
    window.localStorage.setItem(
      'monize-reports-monthly-category-breakdown-collapsed-groups',
      JSON.stringify({ expense: true }),
    );
    await renderReport();

    expect(screen.getByRole('button', { name: 'Expenses' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expenses' }));
    });
    expect(screen.queryByText('Gas & Fuel')).not.toBeInTheDocument();
  });
});

describe('MonthlyCategoryBreakdownReport: Summary only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockGetMonthlyCategoryBreakdown.mockResolvedValue(response);
  });

  it('hides the income, expense and transfer detail and keeps the Summary', async () => {
    await renderReport();

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Summary only'));
    });

    expect(screen.queryByRole('button', { name: 'Income' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expenses' })).not.toBeInTheDocument();
    expect(screen.queryByText('Gas & Fuel')).not.toBeInTheDocument();
    expect(screen.queryByText('From Chequing')).not.toBeInTheDocument();

    const labels = rowLabels();
    expect(labels[0]).toBe('Summary');
    expect(labels).toContain('Balance');
    expect(labels).toContain('Overall total');
    expect(labels).toContain('Cigarettes');
    expect(labels).toContain('Auto & Transport');
  });

  it('remembers the choice across a remount', async () => {
    const { unmount } = render(<MonthlyCategoryBreakdownReport />);
    await waitFor(() => {
      expect(screen.getByText('Gas & Fuel')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Summary only'));
    });
    unmount();

    await act(async () => {
      render(<MonthlyCategoryBreakdownReport />);
    });
    await waitFor(() => {
      expect(screen.getByText('Summary')).toBeInTheDocument();
    });
    expect(screen.queryByText('Gas & Fuel')).not.toBeInTheDocument();
  });
});
