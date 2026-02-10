import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { BillPaymentHistoryReport } from './BillPaymentHistoryReport';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(2)}`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: '1y',
    setDateRange: vi.fn(),
    resolvedRange: { start: '2024-01-01', end: '2025-01-01' },
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

  it('renders failed state when data is null', async () => {
    mockGetBillPaymentHistory.mockRejectedValue(new Error('API error'));
    render(<BillPaymentHistoryReport />);
    await waitFor(() => {
      expect(screen.getByText('Failed to load bill payment history data.')).toBeInTheDocument();
    });
  });
});
