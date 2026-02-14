import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { UncategorizedTransactionsReport } from './UncategorizedTransactionsReport';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: '3m',
    setDateRange: vi.fn(),
    resolvedRange: { start: '2025-01-01', end: '2025-03-31' },
    isValid: true,
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

const mockGetUncategorizedTransactions = vi.fn();

vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getUncategorizedTransactions: (...args: any[]) => mockGetUncategorizedTransactions(...args),
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

describe('UncategorizedTransactionsReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetUncategorizedTransactions.mockReturnValue(new Promise(() => {}));
    render(<UncategorizedTransactionsReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders all-categorized message when no uncategorized transactions', async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [],
      summary: { totalCount: 0, expenseCount: 0, expenseTotal: 0, incomeCount: 0, incomeTotal: 0 },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText(/All transactions are categorized/)).toBeInTheDocument();
    });
  });

  it('renders transaction table with data', async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: 'tx-1',
          transactionDate: '2025-02-15',
          payeeName: 'Unknown Store',
          description: 'Card payment',
          accountName: 'Chequing',
          amount: -50.00,
        },
      ],
      summary: { totalCount: 1, expenseCount: 1, expenseTotal: 50, incomeCount: 0, incomeTotal: 0 },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText('Unknown Store')).toBeInTheDocument();
    });
    expect(screen.getByText('Total Uncategorized')).toBeInTheDocument();
  });

  it('renders summary cards', async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [],
      summary: { totalCount: 5, expenseCount: 3, expenseTotal: 150, incomeCount: 2, incomeTotal: 500 },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Uncategorized')).toBeInTheDocument();
    });
    expect(screen.getByText('Uncategorized Expenses')).toBeInTheDocument();
    expect(screen.getByText('Uncategorized Income')).toBeInTheDocument();
  });
});
