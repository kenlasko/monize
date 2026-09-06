import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { InvestmentTransactionHistoryReport } from './InvestmentTransactionHistoryReport';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      defaultCurrency: 'CAD',
    }),
  };
});
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (amount: number, _currency: string) => amount,
    defaultCurrency: 'CAD',
  }),
}));

const STABLE_RANGE = { start: '2025-01-01', end: '2026-01-01' };
vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: '1y',
    setDateRange: vi.fn(),
    startDate: '',
    setStartDate: vi.fn(),
    endDate: '',
    setEndDate: vi.fn(),
    resolvedRange: STABLE_RANGE,
    isValid: true,
  }),
}));

// Spread the real module rather than replacing it: the phone captions render
// `CellLabel`, which reads `cn` from here, and a bare factory blanks every other
// export of the module for the whole graph under test.
vi.mock('@/lib/utils', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

const mockGetTransactions = vi.fn();
const mockGetInvestmentAccounts = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getTransactions: (...args: any[]) => mockGetTransactions(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
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

describe('InvestmentTransactionHistoryReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetTransactions.mockReturnValue(new Promise(() => {}));
    mockGetInvestmentAccounts.mockReturnValue(new Promise(() => {}));
    render(<InvestmentTransactionHistoryReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no transactions', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<InvestmentTransactionHistoryReport />);
    await waitFor(() => {
      expect(screen.getByText(/No investment transactions found/)).toBeInTheDocument();
    });
  });

  it('renders summary cards with transaction data', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2025-06-15',
          action: 'BUY',
          totalAmount: 5000,
          quantity: 50,
          price: 100,
          accountId: 'acc-1',
          security: { symbol: 'AAPL', name: 'Apple Inc.' },
        },
        {
          id: 'tx-2',
          transactionDate: '2025-07-10',
          action: 'DIVIDEND',
          totalAmount: 100,
          quantity: null,
          price: null,
          accountId: 'acc-1',
          security: { symbol: 'AAPL', name: 'Apple Inc.' },
        },
        {
          id: 'tx-3',
          transactionDate: '2025-08-20',
          action: 'SELL',
          totalAmount: -3000,
          quantity: -30,
          price: 100,
          accountId: 'acc-1',
          security: { symbol: 'MSFT', name: 'Microsoft Corp.' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<InvestmentTransactionHistoryReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Transactions')).toBeInTheDocument();
    });
    expect(screen.getByText('Total Volume')).toBeInTheDocument();
    expect(screen.getByText('Action Types')).toBeInTheDocument();
    expect(screen.getByText('Securities Traded')).toBeInTheDocument();
  });

  it('renders activity summary with action badges', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2025-06-15',
          action: 'BUY',
          totalAmount: 5000,
          quantity: 50,
          price: 100,
          accountId: 'acc-1',
          security: { symbol: 'AAPL', name: 'Apple Inc.' },
        },
        {
          id: 'tx-2',
          transactionDate: '2025-07-10',
          action: 'DIVIDEND',
          totalAmount: 100,
          quantity: null,
          price: null,
          accountId: 'acc-1',
          security: { symbol: 'AAPL', name: 'Apple Inc.' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<InvestmentTransactionHistoryReport />);
    await waitFor(() => {
      expect(screen.getByText('Activity Summary')).toBeInTheDocument();
    });
    // 'Buy' appears in dropdown option, activity summary badge, and transaction table
    expect(screen.getAllByText('Buy').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Dividend').length).toBeGreaterThanOrEqual(2);
  });

  it('renders transaction history table', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2025-06-15',
          action: 'BUY',
          totalAmount: 5000,
          quantity: 50,
          price: 100,
          accountId: 'acc-1',
          security: { symbol: 'VFV', name: 'Vanguard S&P 500' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<InvestmentTransactionHistoryReport />);
    await waitFor(() => {
      expect(screen.getByText(/Transaction History/)).toBeInTheDocument();
    });
    expect(screen.getByText('VFV')).toBeInTheDocument();
    // 'Buy' appears in dropdown option, activity summary badge, and transaction table
    expect(screen.getAllByText('Buy').length).toBeGreaterThanOrEqual(2);
  });

  it('renders filter controls', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<InvestmentTransactionHistoryReport />);
    await waitFor(() => {
      expect(screen.getByText('All Accounts')).toBeInTheDocument();
    });
    expect(screen.getByText('All Actions')).toBeInTheDocument();
    expect(screen.getByTestId('date-range-selector')).toBeInTheDocument();
  });

  it('filters transactions by action client-side without re-fetching', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2025-06-15',
          action: 'BUY',
          totalAmount: 5000,
          quantity: 50,
          price: 100,
          accountId: 'acc-1',
          security: { symbol: 'AAPL', name: 'Apple Inc.' },
        },
        {
          id: 'tx-2',
          transactionDate: '2025-08-20',
          action: 'SELL',
          totalAmount: -3000,
          quantity: -30,
          price: 100,
          accountId: 'acc-1',
          security: { symbol: 'MSFT', name: 'Microsoft Corp.' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<InvestmentTransactionHistoryReport />);
    await waitFor(() => {
      expect(screen.getByText('AAPL')).toBeInTheDocument();
    });
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    const fetchCallsBefore = mockGetTransactions.mock.calls.length;

    // Open the action MultiSelect and select "Buy"
    fireEvent.click(screen.getByRole('button', { name: 'Filter by action' }));
    const buyLabels = screen.getAllByText('Buy');
    await act(async () => { fireEvent.click(buyLabels[buyLabels.length - 1]); });

    // SELL row is filtered out without any additional API call
    await waitFor(() => {
      expect(screen.queryByText('MSFT')).not.toBeInTheDocument();
    });
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(mockGetTransactions.mock.calls.length).toBe(fetchCallsBefore);
  });

  it('counts unique securities traded', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2025-06-15',
          action: 'BUY',
          totalAmount: 5000,
          quantity: 50,
          price: 100,
          accountId: 'acc-1',
          security: { symbol: 'AAPL', name: 'Apple' },
        },
        {
          id: 'tx-2',
          transactionDate: '2025-06-16',
          action: 'BUY',
          totalAmount: 3000,
          quantity: 30,
          price: 100,
          accountId: 'acc-1',
          security: { symbol: 'AAPL', name: 'Apple' },
        },
        {
          id: 'tx-3',
          transactionDate: '2025-06-17',
          action: 'BUY',
          totalAmount: 2000,
          quantity: 20,
          price: 100,
          accountId: 'acc-1',
          security: { symbol: 'MSFT', name: 'Microsoft' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<InvestmentTransactionHistoryReport />);
    await waitFor(() => {
      expect(screen.getByText('Securities Traded')).toBeInTheDocument();
    });
    // 2 unique securities: AAPL and MSFT
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('exercises every sortable column on the transaction table', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx1',
          accountId: 'acc-1',
          security: { symbol: 'AAPL', name: 'Apple Inc.' },
          transactionDate: '2024-01-15',
          quantity: 10,
          price: 150,
          totalAmount: 1500,
          action: 'BUY',
        },
        {
          id: 'tx2',
          accountId: 'acc-1',
          security: { symbol: 'MSFT', name: 'Microsoft' },
          transactionDate: '2024-02-20',
          quantity: 5,
          price: 300,
          totalAmount: 1500,
          action: 'BUY',
        },
        {
          id: 'tx3',
          accountId: 'acc-1',
          security: null,
          transactionDate: '2024-03-10',
          quantity: null,
          price: null,
          totalAmount: 50,
          action: 'DIVIDEND',
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Brokerage', accountSubType: 'INVESTMENT_CASH', currencyCode: 'CAD' },
    ]);
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<InvestmentTransactionHistoryReport />));
    });
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    // `<thead>` now holds TWO rows -- the phone sort strip and the column header
    // row -- so address the column header row by the class that displays it
    // rather than taking every `th` in the head (which would click each field
    // twice per pass and say nothing about which row it exercised).
    const columnHeaderRow = container.querySelector('table thead tr.hidden');
    if (!columnHeaderRow) throw new Error('column header row (hidden sm:table-row) not found');
    const headerCount = columnHeaderRow.querySelectorAll('th').length;
    expect(headerCount).toBe(7);
    for (let pass = 0; pass < 2; pass += 1) {
      for (let i = 0; i < headerCount; i += 1) {
        const ths = columnHeaderRow.querySelectorAll('th');
        if (!ths[i]) break;
        await act(async () => { fireEvent.click(ths[i]); });
      }
    }
  });

  it('restores the persisted account selection', async () => {
    window.localStorage.setItem(
      'monize-reports-investment-transactions-accounts',
      JSON.stringify(['acc-1']),
    );
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([{ id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' }]);
    render(<InvestmentTransactionHistoryReport />);
    await waitFor(() => {
      expect(mockGetTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: 'acc-1' }),
      );
    });
  });
});
