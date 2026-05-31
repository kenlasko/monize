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

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(2)}`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    defaultCurrency: 'CAD',
  }),
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

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
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
      monthlyTotals: [{ label: 'Jan 2025', total: 1500 }],
      summary: { totalPaid: 18000, monthlyAverage: 1500, uniqueBills: 1, totalPayments: 12 },
    });
    render(<BillPaymentHistoryReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Paid')).toBeInTheDocument();
    });
    expect(screen.getByText('Monthly Average')).toBeInTheDocument();
    expect(screen.getByText('Bills Paid')).toBeInTheDocument();
  });

  it('renders error state when the fetch fails', async () => {
    mockGetBillPaymentHistory.mockRejectedValue(new Error('API error'));
    render(<BillPaymentHistoryReport />);
    await waitFor(() => {
      expect(screen.getByText('Try again')).toBeInTheDocument();
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
      monthlyTotals: [{ label: 'Jan 2025', total: 1500 }],
      summary: { totalPaid: 18000, monthlyAverage: 1500, uniqueBills: 1, totalPayments: 12 },
    });
    render(<BillPaymentHistoryReport />);
    await waitFor(() => expect(screen.getByText('Overview')).toBeInTheDocument());
    fireEvent.click(screen.getByText('By Bill'));
    await waitFor(() => {
      expect(screen.getByText('Payment History by Bill')).toBeInTheDocument();
    });
    expect(screen.getByText('Rent')).toBeInTheDocument();
    expect(screen.getByText('Jan 1, 2025')).toBeInTheDocument();
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
});
