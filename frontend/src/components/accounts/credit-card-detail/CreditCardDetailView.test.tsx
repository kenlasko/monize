import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@/test/render';
import { CreditCardDetailView } from './CreditCardDetailView';
import type { Account } from '@/types/account';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({ ...numberFormatMockDefaults(), formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
  };
});vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ dateFormat: 'browser', datePattern: 'YYYY-MM-DD', formatDate: (d: Date) => `date:${d.getFullYear()}` }),
}));
vi.mock('@/components/transactions/BalanceHistoryChart', () => ({
  // The markers are serialised so a test can read what the view asked the
  // chart to mark (the overdue marker, discussion #1784).
  BalanceHistoryChart: ({ markers }: { markers?: unknown[] }) => (
    <div data-testid="balance-history-chart" data-markers={JSON.stringify(markers ?? [])} />
  ),
}));

const mockGetStatementCycle = vi.fn();
const mockGetInterestPaid = vi.fn();
const mockGetDailyBalances = vi.fn();
const mockGetBalanceForecast = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getStatementCycle: (...a: unknown[]) => mockGetStatementCycle(...a),
    getInterestPaid: (...a: unknown[]) => mockGetInterestPaid(...a),
    getDailyBalances: (...a: unknown[]) => mockGetDailyBalances(...a),
    getBalanceForecast: (...a: unknown[]) => mockGetBalanceForecast(...a),
  },
}));

const mockGetGroupedTotals = vi.fn();
const mockGetAll = vi.fn();
const mockGetAllPages = vi.fn();
const mockGetRecurringCharges = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getGroupedTotals: (...a: unknown[]) => mockGetGroupedTotals(...a),
    getAll: (...a: unknown[]) => mockGetAll(...a),
    getAllPages: (...a: unknown[]) => mockGetAllPages(...a),
    getRecurringCharges: (...a: unknown[]) => mockGetRecurringCharges(...a),
  },
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'cc-1',
    accountType: 'CREDIT_CARD',
    name: 'My Visa',
    currencyCode: 'CAD',
    currentBalance: -1200,
    creditLimit: 5000,
    interestRate: 19.99,
    ...overrides,
  } as Account;
}

const cycle = {
  accountId: 'cc-1',
  currencyCode: 'CAD',
  cycleStart: '2026-06-10',
  cycleEnd: '2026-07-09',
  lastSettlementDate: '2026-06-10',
  nextSettlementDate: '2026-07-10',
  daysUntilSettlement: 2,
  paymentDueDate: '2026-07-15',
  daysUntilPaymentDue: 7,
  statementBalance: -1000,
  statementBalanceDate: '2026-06-08',
  amountPaidSinceStatement: 200,
  expensesSinceStatement: 350,
  currentBalance: -1200,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetStatementCycle.mockResolvedValue(cycle);
  mockGetInterestPaid.mockResolvedValue({ amount: 45.5, count: 3 });
  mockGetDailyBalances.mockResolvedValue([{ date: '2026-06-01', balance: -1000 }]);
  mockGetBalanceForecast.mockResolvedValue({
    points: [{ date: '2026-06-01', balance: -1000 }],
    complete: true,
    gaps: [],
  });
  mockGetGroupedTotals.mockResolvedValue([
    { id: 'c1', name: 'Groceries', currencyCode: 'CAD', total: -450, count: 5 },
    { id: 'c2', name: 'Gas', currencyCode: 'CAD', total: -200, count: 2 },
  ]);
  mockGetAll.mockResolvedValue({
    data: [{ id: 'tx1', payeeId: 'p1', payeeName: 'Netflix' }],
    pagination: { hasMore: false },
  });
  mockGetAllPages.mockResolvedValue([{ id: 'tx1', payeeId: 'p1', payeeName: 'Netflix' }]);
  mockGetRecurringCharges.mockResolvedValue([
    {
      payeeName: 'Netflix',
      amounts: [-15],
      dates: ['2026-05-01', '2026-06-01'],
      frequency: 'monthly',
      currentAmount: -15,
      previousAmount: -15,
      categoryName: 'Streaming',
    },
  ]);
});

async function renderView(account = makeAccount()) {
  await act(async () => {
    render(<CreditCardDetailView account={account} />);
  });
}

describe('CreditCardDetailView', () => {
  it('renders the summary cards from the account fields', async () => {
    await renderView();
    expect(screen.getByText('Current Balance')).toBeInTheDocument();
    expect(screen.getByText('Credit Limit')).toBeInTheDocument();
    expect(screen.getByText('19.99%')).toBeInTheDocument();
    expect(screen.getByText('Utilization')).toBeInTheDocument();
  });

  it('loads and shows the statement cycle', async () => {
    await renderView();
    await waitFor(() => expect(screen.getByText('Statement Balance')).toBeInTheDocument());
    expect(mockGetStatementCycle).toHaveBeenCalledWith('cc-1');
    expect(screen.getByText(/Cycle:/)).toBeInTheDocument();
    expect(screen.getByText('7 days remaining')).toBeInTheDocument();
  });

  it('shows the cycle spending breakdown', async () => {
    await renderView();
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    expect(screen.getByText('Gas')).toBeInTheDocument();
    expect(mockGetGroupedTotals).toHaveBeenCalledWith(
      expect.objectContaining({ basis:'cash', groupBy: 'category', accountIds: ['cc-1'] }),
    );
  });

  it('includes unreconciled pre-cycle charges in the spending breakdown', async () => {
    await renderView();
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    // Late-posting charges from before the cycle start still count toward the
    // cycle's spending until they are reconciled.
    expect(mockGetGroupedTotals).toHaveBeenCalledWith(
      expect.objectContaining({ includeUnreconciledBeforeStart: true }),
    );
  });

  it('shows YTD interest and fees', async () => {
    await renderView();
    await waitFor(() => expect(screen.getByText('3 charges')).toBeInTheDocument());
  });

  it('shows the payoff calculator for a carried balance', async () => {
    await renderView();
    expect(screen.getByText('Payoff Calculator')).toBeInTheDocument();
  });

  it('shows recurring charges detected on the card', async () => {
    await renderView();
    await waitFor(() => expect(screen.getByText('Netflix')).toBeInTheDocument());
    // Detection is asked for by account. It used to be asked for by a payee
    // list the panel built by reading the card's transactions, which is the
    // request that outgrew the URL on a card with many payees.
    expect(mockGetRecurringCharges).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'cc-1' }),
    );
    expect(mockGetRecurringCharges.mock.calls[0][0]).not.toHaveProperty('payeeIds');
  });

  // Issue #1247: an incomplete projection is withheld and explained rather than
  // drawn as a line that stops at today with no reason given.
  it('explains a withheld projection instead of drawing a stub line', async () => {
    mockGetBalanceForecast.mockResolvedValue({
      points: [{ date: '2026-06-01', balance: -1000 }],
      complete: false,
      gaps: [
        {
          scheduledTransactionId: 'st-inv',
          name: 'Monthly ETF buy',
          reason: 'unresolvedSettlementRate',
          fromCurrency: 'USD',
          toCurrency: 'CAD',
        },
      ],
    });

    await renderView();

    const panel = screen.getByTestId('balance-forecast-unavailable');
    expect(panel).toHaveTextContent('Monthly ETF buy');
    expect(panel).toHaveTextContent(/refresh the rates/i);
  });

  it('says nothing when the projection is complete', async () => {
    await renderView();

    expect(
      screen.queryByTestId('balance-forecast-unavailable'),
    ).not.toBeInTheDocument();
  });

  it('does not offer a make-a-payment action', async () => {
    await renderView();
    expect(
      screen.queryByRole('button', { name: 'Make a Payment' }),
    ).not.toBeInTheDocument();
  });

  it('shows the unavailable hint when no settlement day is configured', async () => {
    mockGetStatementCycle.mockRejectedValue(new Error('400'));
    await renderView();
    await waitFor(() =>
      expect(screen.getByText('Statement cycle unavailable')).toBeInTheDocument(),
    );
    // Spending still loads for the current month.
    expect(mockGetGroupedTotals).toHaveBeenCalled();
  });

  // Discussion #1784: the same marker as the banking view.
  it('marks the overdue occurrences on the balance chart', async () => {
    mockGetBalanceForecast.mockResolvedValue({
      points: [
        { date: '2026-06-01', balance: -1000 },
        { date: '2026-06-02', balance: -1080 },
      ],
      complete: true,
      gaps: [],
      overdue: { date: '2026-06-02', count: 1, amount: -80 },
    });
    await renderView();
    await waitFor(() => {
      const markers = JSON.parse(
        screen.getByTestId('balance-history-chart').getAttribute('data-markers') as string,
      );
      expect(markers).toEqual([
        { date: '2026-06-02', direction: 'out', label: 'Includes 1 overdue scheduled transaction' },
      ]);
    });
  });
});
