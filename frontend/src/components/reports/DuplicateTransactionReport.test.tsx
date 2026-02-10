import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { DuplicateTransactionReport } from './DuplicateTransactionReport';

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

const mockGetDuplicateTransactions = vi.fn();

vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getDuplicateTransactions: (...args: any[]) => mockGetDuplicateTransactions(...args),
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

describe('DuplicateTransactionReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetDuplicateTransactions.mockReturnValue(new Promise(() => {}));
    render(<DuplicateTransactionReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders clean message when no duplicates found', async () => {
    mockGetDuplicateTransactions.mockResolvedValue({
      groups: [],
      summary: { totalGroups: 0, highCount: 0, mediumCount: 0, lowCount: 0, potentialSavings: 0 },
    });
    render(<DuplicateTransactionReport />);
    await waitFor(() => {
      expect(screen.getByText(/No potential duplicate transactions found/)).toBeInTheDocument();
    });
  });

  it('renders duplicate groups with data', async () => {
    mockGetDuplicateTransactions.mockResolvedValue({
      groups: [
        {
          key: 'group-1',
          confidence: 'high',
          reason: 'Same date, amount, and payee',
          transactions: [
            { id: 'tx-1', transactionDate: '2025-02-01', payeeName: 'Store A', amount: -50, accountName: 'Chequing' },
            { id: 'tx-2', transactionDate: '2025-02-01', payeeName: 'Store A', amount: -50, accountName: 'Chequing' },
          ],
        },
      ],
      summary: { totalGroups: 1, highCount: 1, mediumCount: 0, lowCount: 0, potentialSavings: 50 },
    });
    render(<DuplicateTransactionReport />);
    await waitFor(() => {
      expect(screen.getByText('high confidence')).toBeInTheDocument();
    });
    expect(screen.getByText('Potential Duplicates')).toBeInTheDocument();
    expect(screen.getByText('High Confidence')).toBeInTheDocument();
  });

  it('renders summary cards', async () => {
    mockGetDuplicateTransactions.mockResolvedValue({
      groups: [],
      summary: { totalGroups: 3, highCount: 1, mediumCount: 2, lowCount: 0, potentialSavings: 150 },
    });
    render(<DuplicateTransactionReport />);
    await waitFor(() => {
      expect(screen.getByText('Potential Duplicates')).toBeInTheDocument();
    });
    expect(screen.getByText('High Confidence')).toBeInTheDocument();
    expect(screen.getByText('Medium Confidence')).toBeInTheDocument();
    expect(screen.getByText('Potential Impact')).toBeInTheDocument();
  });
});
