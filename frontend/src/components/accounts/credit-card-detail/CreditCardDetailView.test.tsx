import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@/test/render';
import { CreditCardDetailView } from './CreditCardDetailView';
import type { Account } from '@/types/account';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
}));
vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: Date) => `date:${d.getFullYear()}` }),
}));
vi.mock('@/components/transactions/BalanceHistoryChart', () => ({
  BalanceHistoryChart: () => <div data-testid="balance-history-chart" />,
}));

const mockGetStatementCycle = vi.fn();
const mockGetInterestPaid = vi.fn();
const mockGetDailyBalances = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getStatementCycle: (...a: unknown[]) => mockGetStatementCycle(...a),
    getInterestPaid: (...a: unknown[]) => mockGetInterestPaid(...a),
    getDailyBalances: (...a: unknown[]) => mockGetDailyBalances(...a),
  },
}));

const mockGetGroupedTotals = vi.fn();
const mockGetAll = vi.fn();
const mockGetRecurringCharges = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getGroupedTotals: (...a: unknown[]) => mockGetGroupedTotals(...a),
    getAll: (...a: unknown[]) => mockGetAll(...a),
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
  amountPaidSinceStatement: 200,
  currentBalance: -1200,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetStatementCycle.mockResolvedValue(cycle);
  mockGetInterestPaid.mockResolvedValue({ amount: 45.5, count: 3 });
  mockGetDailyBalances.mockResolvedValue([{ date: '2026-06-01', balance: -1000 }]);
  mockGetGroupedTotals.mockResolvedValue([
    { id: 'c1', name: 'Groceries', currencyCode: 'CAD', total: -450, count: 5 },
    { id: 'c2', name: 'Gas', currencyCode: 'CAD', total: -200, count: 2 },
  ]);
  mockGetAll.mockResolvedValue({
    data: [{ id: 'tx1', payeeId: 'p1', payeeName: 'Netflix' }],
    pagination: { hasMore: false },
  });
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
      expect.objectContaining({ groupBy: 'category', accountIds: ['cc-1'] }),
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
    expect(mockGetAll).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'cc-1' }),
    );
    expect(mockGetRecurringCharges).toHaveBeenCalledWith(
      expect.objectContaining({ payeeIds: ['p1'] }),
    );
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
});
