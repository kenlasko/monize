import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@/test/render';
import { LineOfCreditView } from './LineOfCreditView';
import { Account } from '@/types/account';

const mockGetDailyBalances = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getDailyBalances: (...args: unknown[]) => mockGetDailyBalances(...args),
  },
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
  }),
}));

// Keep the chart lightweight; it has its own tests.
vi.mock('@/components/transactions/BalanceHistoryChart', () => ({
  BalanceHistoryChart: ({ data, isLoading }: { data: unknown[]; isLoading: boolean }) => (
    <div data-testid="balance-history-chart">
      {isLoading ? 'loading' : `points:${data.length}`}
    </div>
  ),
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'loc-1',
    accountType: 'LINE_OF_CREDIT',
    name: 'Home Equity Line',
    currencyCode: 'CAD',
    openingBalance: 0,
    currentBalance: -3000,
    creditLimit: 10000,
    isCanadianMortgage: false,
    isVariableRate: false,
    ...overrides,
  } as Account;
}

async function renderView(account: Account) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<LineOfCreditView account={account} />);
  });
  return result!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDailyBalances.mockResolvedValue([
    { date: '2020-01-01', balance: 0, accountId: 'loc-1', currencyCode: 'CAD' },
    { date: '2020-06-01', balance: -5000, accountId: 'loc-1', currencyCode: 'CAD' },
    { date: '2026-01-01', balance: -3000, accountId: 'loc-1', currencyCode: 'CAD' },
  ]);
});

describe('LineOfCreditView', () => {
  it('shows balance, credit limit, available credit, and utilization', async () => {
    await renderView(makeAccount());

    expect(screen.getByText('Current Balance')).toBeInTheDocument();
    expect(screen.getByText('$3000.00')).toBeInTheDocument();
    expect(screen.getByText('Credit Limit')).toBeInTheDocument();
    expect(screen.getByText('$10000.00')).toBeInTheDocument();
    expect(screen.getByText('Available Credit')).toBeInTheDocument();
    expect(screen.getByText('$7000.00')).toBeInTheDocument();
    expect(screen.getByText('Utilization')).toBeInTheDocument();
    expect(screen.getByText('30.0%')).toBeInTheDocument();
  });

  it('loads and renders the balance history for the account', async () => {
    await renderView(makeAccount());

    expect(mockGetDailyBalances).toHaveBeenCalledWith({ accountIds: 'loc-1' });
    expect(screen.getByTestId('balance-history-chart')).toHaveTextContent('points:3');
  });

  it('does not show a fixed origination principal or amortization schedule', async () => {
    await renderView(makeAccount());

    expect(screen.queryByText('Original Amount')).not.toBeInTheDocument();
    expect(screen.queryByText('Loan Schedule')).not.toBeInTheDocument();
    expect(screen.queryByText('Overpayment Simulator')).not.toBeInTheDocument();
  });

  it('shows the peak balance instead of limit stats when no credit limit is set', async () => {
    await renderView(makeAccount({ creditLimit: null }));

    expect(screen.queryByText('Credit Limit')).not.toBeInTheDocument();
    expect(screen.queryByText('Utilization')).not.toBeInTheDocument();
    expect(screen.getByText('Highest Balance')).toBeInTheDocument();
    // Deepest point in the mocked series is -5000
    expect(screen.getByText('$5000.00')).toBeInTheDocument();
  });

  it('shows an empty state when there is no balance history', async () => {
    mockGetDailyBalances.mockResolvedValue([]);
    await renderView(makeAccount());

    expect(screen.getByText('No balance history available.')).toBeInTheDocument();
  });
});
