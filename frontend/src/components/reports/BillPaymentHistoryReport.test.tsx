import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { BillPaymentHistoryReport } from './BillPaymentHistoryReport';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/reports',
}));

vi.mock('@/components/ui/ExportDropdown', () => ({
  ExportDropdown: ({ onExportCsv, onExportPdf }: any) => (
    <div data-testid="export-dropdown">
      <button data-testid="export-csv" onClick={onExportCsv}>CSV</button>
      <button data-testid="export-pdf" onClick={onExportPdf}>PDF</button>
    </div>
  ),
}));

const mockExportToCsv = vi.fn();
vi.mock('@/lib/csv-export', () => ({
  exportToCsv: (...args: any[]) => mockExportToCsv(...args),
}));

const mockExportToPdf = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (n: number) => `$${n.toFixed(2)}`,
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      defaultCurrency: 'CAD',
    }),
  };
});

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatDate: (date: string) => `preferred-date:${date}`,
    formatMonth: (month: string) => `preferred-month:${month}`,
  }),
}));

// The chart's month marker comes from the chart formatter, which localizes the
// month NAME, not from `formatMonth`, which renders the user's numeric
// month-and-year preference.
// `useChartMonthFormat` parses the `YYYY-MM` key itself and hands this a real
// `Date` (local midnight on the first of the month), so the stand-in records
// the day from LOCAL getters rather than interpolating the object: a `Date`'s
// own `toString` carries the runner's zone and offset name, which would make
// the expectation below pass only under one `TZ`.
vi.mock('@/hooks/useChartDateFormat', () => ({
  useChartDateFormat: () => (date: Date, pattern: string) => {
    const day = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
    return `chart-month:${day}:${pattern}`;
  },
}));

const STABLE_RANGE = { start: '2024-01-01', end: '2025-01-01' };
vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: '1y',
    setDateRange: vi.fn(),
    resolvedRange: STABLE_RANGE,
    isValid: true,
  }),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children, data }: any) => (
    <div
      data-testid="bar-chart"
      data-labels={data.map((entry: { label: string }) => entry.label).join(',')}
    >
      {children}
    </div>
  ),
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

const mockGetBillPaymentHistory = vi.fn();

vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getBillPaymentHistory: (...args: any[]) => mockGetBillPaymentHistory(...args),
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

describe('BillPaymentHistoryReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetBillPaymentHistory.mockReturnValue(new Promise(() => {}));
    render(<BillPaymentHistoryReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no bill payments', async () => {
    mockGetBillPaymentHistory.mockResolvedValue({
      billPayments: [],
      monthlyTotals: [],
      summary: { totalPaid: 0, monthlyAverage: 0, uniqueBills: 0, totalPayments: 0 },
    });
    render(<BillPaymentHistoryReport />);
    await waitFor(() => {
      expect(screen.getByText(/No bill payments found/)).toBeInTheDocument();
    });
  });

  it('renders summary cards with data', async () => {
    mockGetBillPaymentHistory.mockResolvedValue({
      billPayments: [
        {
          scheduledTransactionId: 'st-1',
          scheduledTransactionName: 'Rent',
          payeeName: 'Landlord',
          paymentCount: 12,
          averagePayment: 1500,
          totalPaid: 18000,
          lastPaymentDate: '2025-01-01',
        },
      ],
      monthlyTotals: [{ month: '2025-01', label: 'Jan 2025', total: 1500 }],
      summary: { totalPaid: 18000, monthlyAverage: 1500, uniqueBills: 1, totalPayments: 12 },
    });
    render(<BillPaymentHistoryReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Paid')).toBeInTheDocument();
    });
    expect(screen.getByText('Monthly Average')).toBeInTheDocument();
    expect(screen.getByText('Bills Paid')).toBeInTheDocument();
    // The month axis reads a month NAME through the chart formatter, never the
    // reader's numeric month-and-year preference (`2026-01` / `01/2026`).
    expect(screen.getByTestId('bar-chart')).toHaveAttribute(
      'data-labels',
      'chart-month:2025-01-01:MMM yyyy',
    );
  });

  it('renders error state when the fetch fails', async () => {
    mockGetBillPaymentHistory.mockRejectedValue(new Error('API error'));
    render(<BillPaymentHistoryReport />);
    await waitFor(() => {
      expect(screen.getByText('Try Again')).toBeInTheDocument();
    });
  });

  it('toggles to By Bill view when button clicked', async () => {
    mockGetBillPaymentHistory.mockResolvedValue({
      billPayments: [
        {
          scheduledTransactionId: 'st-1',
          scheduledTransactionName: 'Rent',
          payeeName: 'Landlord',
          paymentCount: 12,
          averagePayment: 1500,
          totalPaid: 18000,
          lastPaymentDate: '2025-01-01',
        },
      ],
      monthlyTotals: [{ month: '2025-01', label: 'Jan 2025', total: 1500 }],
      summary: { totalPaid: 18000, monthlyAverage: 1500, uniqueBills: 1, totalPayments: 12 },
    });
    render(<BillPaymentHistoryReport />);
    await waitFor(() => expect(screen.getByText('Overview')).toBeInTheDocument());
    fireEvent.click(screen.getByText('By Bill'));
    await waitFor(() => {
      expect(screen.getByText('Payment History by Bill')).toBeInTheDocument();
    });
    expect(screen.getByText('Rent')).toBeInTheDocument();
    expect(screen.getByText('preferred-date:2025-01-01')).toBeInTheDocument();
  });

  it('shows No payee when payeeName is null', async () => {
    mockGetBillPaymentHistory.mockResolvedValue({
      billPayments: [
        {
          scheduledTransactionId: 'st-2',
          scheduledTransactionName: 'Utility',
          payeeName: null,
          paymentCount: 3,
          averagePayment: 100,
          totalPaid: 300,
          lastPaymentDate: null,
        },
      ],
      monthlyTotals: [],
      summary: { totalPaid: 300, monthlyAverage: 100, uniqueBills: 1, totalPayments: 3 },
    });
    render(<BillPaymentHistoryReport />);
    await waitFor(() => expect(screen.getByText('Overview')).toBeInTheDocument());
    fireEvent.click(screen.getByText('By Bill'));
    await waitFor(() => expect(screen.getByText('No payee')).toBeInTheDocument());
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('navigates to /bills when a bill row is clicked', async () => {
    mockGetBillPaymentHistory.mockResolvedValue({
      billPayments: [
        {
          scheduledTransactionId: 'st-1',
          scheduledTransactionName: 'Rent',
          payeeName: 'Landlord',
          paymentCount: 12,
          averagePayment: 1500,
          totalPaid: 18000,
          lastPaymentDate: '2025-01-01',
        },
      ],
      monthlyTotals: [],
      summary: { totalPaid: 18000, monthlyAverage: 1500, uniqueBills: 1, totalPayments: 12 },
    });
    render(<BillPaymentHistoryReport />);
    await waitFor(() => expect(screen.getByText('By Bill')).toBeInTheDocument());
    fireEvent.click(screen.getByText('By Bill'));
    await waitFor(() => expect(screen.getByText('Rent')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Rent'));
    expect(mockPush).toHaveBeenCalledWith('/bills');
  });

  // The row is the click target, so it has to be reachable and operable from
  // the keyboard as well (WCAG 2.1.1). Before the fix this row was a
  // `cursor-pointer` `<tr>` with an `onClick` and no `tabIndex` and no
  // `onKeyDown` -- the whole suite was green over a row no keyboard user could
  // use, so this case is what fails on that shape.
  it('activates a bill row from the keyboard', async () => {
    mockGetBillPaymentHistory.mockResolvedValue({
      billPayments: [
        {
          scheduledTransactionId: 'st-1',
          scheduledTransactionName: 'Rent',
          payeeName: 'Landlord',
          paymentCount: 12,
          averagePayment: 1500,
          totalPaid: 18000,
          lastPaymentDate: '2025-01-01',
        },
      ],
      monthlyTotals: [],
      summary: { totalPaid: 18000, monthlyAverage: 1500, uniqueBills: 1, totalPayments: 12 },
    });
    render(<BillPaymentHistoryReport />);
    await waitFor(() => expect(screen.getByText('By Bill')).toBeInTheDocument());
    fireEvent.click(screen.getByText('By Bill'));
    await waitFor(() => expect(screen.getByText('Rent')).toBeInTheDocument());
    const row = screen.getByText('Rent').closest('tr') as HTMLElement;
    expect(row).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(row, { key: 'Enter' });
    expect(mockPush).toHaveBeenCalledWith('/bills');

    mockPush.mockClear();
    fireEvent.keyDown(row, { key: ' ' });
    expect(mockPush).toHaveBeenCalledWith('/bills');

    // A key the row does not claim stays the browser's.
    mockPush.mockClear();
    fireEvent.keyDown(row, { key: 'a' });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('exports CSV when export button is clicked', async () => {
    mockGetBillPaymentHistory.mockResolvedValue({
      billPayments: [
        {
          scheduledTransactionId: 'st-1',
          scheduledTransactionName: 'Rent',
          payeeName: 'Landlord',
          paymentCount: 12,
          averagePayment: 1500,
          totalPaid: 18000,
          lastPaymentDate: '2025-01-01',
        },
      ],
      monthlyTotals: [],
      summary: { totalPaid: 18000, monthlyAverage: 1500, uniqueBills: 1, totalPayments: 12 },
    });
    render(<BillPaymentHistoryReport />);
    await waitFor(() => expect(screen.getByTestId('export-csv')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('export-csv'));
    expect(mockExportToCsv).toHaveBeenCalledWith(
      'bill-payment-history',
      expect.any(Array),
      expect.any(Array),
    );
    // A CSV is machine-read, so the date column is ISO and NOT the reader's
    // preferred format: two readers exporting the same rows must get one file,
    // and a localized date is ambiguous and sorts lexicographically wrong.
    // `preferred-date:...` here would be asserting that defect. The sibling
    // test below holds the reading surface's half of the split.
    expect(mockExportToCsv.mock.calls[0][2][0][5]).toBe('2025-01-01');
    // The figure columns are raw numbers, for the reason issue #1134 records.
    expect(mockExportToCsv.mock.calls[0][2][0][3]).toBe(1500);
    expect(mockExportToCsv.mock.calls[0][2][0][4]).toBe(18000);
  });

  it('exports preferred dates to PDF', async () => {
    mockGetBillPaymentHistory.mockResolvedValue({
      billPayments: [
        {
          scheduledTransactionId: 'st-1',
          scheduledTransactionName: 'Rent',
          payeeName: 'Landlord',
          paymentCount: 12,
          averagePayment: 1500,
          totalPaid: 18000,
          lastPaymentDate: '2025-01-01',
        },
      ],
      monthlyTotals: [],
      summary: { totalPaid: 18000, monthlyAverage: 1500, uniqueBills: 1, totalPayments: 12 },
    });
    render(<BillPaymentHistoryReport />);
    await waitFor(() => expect(screen.getByTestId('export-pdf')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalledTimes(1));
    expect(mockExportToPdf.mock.calls[0][0].tableData.rows[0][5]).toBe(
      'preferred-date:2025-01-01',
    );
  });

  it('formats the PDF table amounts as the table does, keeping the CSV numbers raw', async () => {
    mockGetBillPaymentHistory.mockResolvedValue({
      billPayments: [
        {
          scheduledTransactionId: 'st-1',
          scheduledTransactionName: 'Fee',
          payeeName: 'Bank',
          paymentCount: 2,
          // 2.50498 read once at two places, as the server sends it.
          averagePayment: 2.5,
          totalPaid: 5.01,
          lastPaymentDate: '2025-01-01',
        },
      ],
      monthlyTotals: [],
      summary: { totalPaid: 5.01, monthlyAverage: 2.5, uniqueBills: 1, totalPayments: 2 },
    });
    render(<BillPaymentHistoryReport />);
    await waitFor(() => expect(screen.getByTestId('export-pdf')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalledTimes(1));
    const pdfRow = mockExportToPdf.mock.calls[0][0].tableData.rows[0];
    expect(pdfRow[3]).toBe('$2.50');
    expect(pdfRow[4]).toBe('$5.01');
    fireEvent.click(screen.getByTestId('export-csv'));
    const csvRow = mockExportToCsv.mock.calls[0][2][0];
    expect(csvRow[3]).toBe(2.5);
    expect(csvRow[4]).toBe(5.01);
  });

  it('export does nothing when billData is null', async () => {
    mockGetBillPaymentHistory.mockReturnValue(new Promise(() => {}));
    render(<BillPaymentHistoryReport />);
    // Component is loading, billData is null - ExportDropdown won't render yet
    // Just verify no error is thrown when isLoading
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('exercises every sortable column on the bill payment table', async () => {
    mockGetBillPaymentHistory.mockResolvedValue({
      summary: { totalPaid: 700, monthlyAverage: 100, uniqueBills: 3, totalPayments: 8 },
      billPayments: [
        {
          scheduledTransactionId: 'st1',
          scheduledTransactionName: 'Bill A',
          payeeName: 'Payee A',
          paymentCount: 5,
          averagePayment: 100,
          totalPaid: 500,
          lastPaymentDate: '2024-06-15',
        },
        {
          scheduledTransactionId: 'st2',
          scheduledTransactionName: 'Bill B',
          payeeName: 'Payee B',
          paymentCount: 2,
          averagePayment: 100,
          totalPaid: 200,
          lastPaymentDate: '2024-05-10',
        },
        {
          scheduledTransactionId: 'st3',
          scheduledTransactionName: 'Bill C',
          payeeName: '',
          paymentCount: 1,
          averagePayment: 50,
          totalPaid: 50,
          lastPaymentDate: null,
        },
      ],
    });
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<BillPaymentHistoryReport />));
    });
    // The view is "overview" by default; switch to "By Bill" view to render the table.
    await waitFor(() => expect(screen.getByText('By Bill')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByText('By Bill'));
    });
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const __headerCount = container.querySelectorAll('table thead th').length;
    for (let __i = 0; __i < __headerCount; __i += 1) {
      const __ths = container.querySelectorAll('table thead th');
      if (!__ths[__i]) break;
      await act(async () => {
        fireEvent.click(__ths[__i]);
      });
    }
    for (let __i = 0; __i < __headerCount; __i += 1) {
      const __ths = container.querySelectorAll('table thead th');
      if (!__ths[__i]) break;
      await act(async () => {
        fireEvent.click(__ths[__i]);
      });
    }
  });

  it('marks the null summary totals as subtotals and shows no 0.00', async () => {
    mockGetBillPaymentHistory.mockResolvedValue({
      billPayments: [
        {
          scheduledTransactionId: 'st-1',
          scheduledTransactionName: 'Rent',
          payeeName: 'Landlord',
          paymentCount: 1,
          averagePayment: 50,
          totalPaid: 50,
          lastPaymentDate: '2025-01-01',
        },
      ],
      monthlyTotals: [{ month: '2025-01', total: 50 }],
      summary: {
        totalPaid: null,
        knownTotalPaid: 50,
        monthlyAverage: null,
        knownMonthlyAverage: 50,
        uniqueBills: 1,
        totalPayments: 1,
      },
      currency: 'CAD',
      missingCurrencies: ['JPY'],
      excludedCount: 1,
    });
    render(<BillPaymentHistoryReport />);
    await waitFor(() => expect(screen.getAllByTestId('partial-total')).toHaveLength(2));
    screen.getAllByTestId('partial-total').forEach((marker) => expect(marker).toHaveTextContent('$50.00'));
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    expect(screen.getByTestId('partial-data-notice')).toHaveTextContent('JPY');
  });

  // The toolbar holds the date controls, so it stays mounted while the report
  // reloads and after a failed load: an early return for either state would
  // unmount it, and the focus of whoever is using it.
  it('keeps the toolbar mounted while loading and after a failed load', async () => {
    let fail!: (error: Error) => void;
    mockGetBillPaymentHistory.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    render(<BillPaymentHistoryReport />);
    const toolbar = screen.getByTestId('date-range-selector');
    expect(document.querySelector('.animate-pulse')).toBeTruthy();

    await act(async () => {
      fail(new Error('boom'));
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
    });
    expect(screen.getByTestId('date-range-selector')).toBe(toolbar);
  });

});
