import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@/test/render';
import { BankingDetailView } from './BankingDetailView';
import type { Account } from '@/types/account';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  usePathname: () => '/accounts/chq-1',
  useParams: () => ({ id: 'chq-1' }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({ ...numberFormatMockDefaults(), formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
  };
});vi.mock('@/components/transactions/BalanceHistoryChart', () => ({
  // The markers are serialised so a test can read what the view asked the
  // chart to mark (the overdue marker, discussion #1784).
  BalanceHistoryChart: ({ markers }: { markers?: unknown[] }) => (
    <div data-testid="balance-history-chart" data-markers={JSON.stringify(markers ?? [])} />
  ),
}));

const mockGetDailyBalances = vi.fn();
const mockGetBalanceForecast = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getDailyBalances: (...a: unknown[]) => mockGetDailyBalances(...a),
    getBalanceForecast: (...a: unknown[]) => mockGetBalanceForecast(...a),
  },
}));

const mockGetSummary = vi.fn();
const mockGetMonthlyTotals = vi.fn();
const mockGetGroupedTotals = vi.fn();
const mockGetAll = vi.fn();
const mockGetAllPages = vi.fn();
const mockGetRecurringCharges = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getSummary: (...a: unknown[]) => mockGetSummary(...a),
    getMonthlyTotals: (...a: unknown[]) => mockGetMonthlyTotals(...a),
    getGroupedTotals: (...a: unknown[]) => mockGetGroupedTotals(...a),
    getAll: (...a: unknown[]) => mockGetAll(...a),
    getAllPages: (...a: unknown[]) => mockGetAllPages(...a),
    getRecurringCharges: (...a: unknown[]) => mockGetRecurringCharges(...a),
  },
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'chq-1',
    accountType: 'CHEQUING',
    name: 'Everyday Chequing',
    currencyCode: 'CAD',
    currentBalance: 1500,
    interestRate: 1.5,
    ...overrides,
  } as Account;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDailyBalances.mockResolvedValue([
    { date: '2026-06-01', balance: 1000 },
    { date: '2026-06-15', balance: 1500 },
  ]);
  mockGetBalanceForecast.mockResolvedValue({
    accountId: 'chq-1',
    currencyCode: 'CAD',
    points: [
      { date: '2026-06-15', balance: 1500 },
      { date: '2026-07-01', balance: 2200 },
    ],
    complete: true,
    gaps: [],
  });
  mockGetSummary.mockResolvedValue({
    totalIncome: 2000,
    totalExpenses: 1500,
    netCashFlow: 500,
    transactionCount: 8,
  });
  mockGetMonthlyTotals.mockResolvedValue([{ month: '2026-06', total: 500, count: 3 }]);
  mockGetGroupedTotals.mockImplementation((params: { groupBy: string }) =>
    Promise.resolve(
      params.groupBy === 'payee'
        ? [{ id: 'p1', name: 'Corner Store', currencyCode: 'CAD', total: -300, count: 3 }]
        : [{ id: 'c1', name: 'Groceries', currencyCode: 'CAD', total: -450, count: 5 }],
    ),
  );
  mockGetAll.mockResolvedValue({ data: [], pagination: {} });
  mockGetAllPages.mockResolvedValue([]);
  mockGetRecurringCharges.mockResolvedValue([]);
});

async function renderView(account = makeAccount()) {
  await act(async () => {
    render(<BankingDetailView account={account} />);
  });
}

describe('BankingDetailView', () => {
  it('renders summary figures', async () => {
    await renderView();
    expect(screen.getByText('Current Balance')).toBeInTheDocument();
    expect(screen.getByText('Projected Balance')).toBeInTheDocument();
    expect(screen.getByText('Money In')).toBeInTheDocument();
    expect(screen.getByText('Money Out')).toBeInTheDocument();
    expect(screen.getByText('Average Balance')).toBeInTheDocument();
    // Interest rate card appears because the account has a rate.
    expect(screen.getByText('1.5%')).toBeInTheDocument();
  });

  it('projects the balance from the forecast and caps history at today', async () => {
    await renderView();
    await waitFor(() => expect(mockGetBalanceForecast).toHaveBeenCalledWith('chq-1'));
    // History is requested up to today so the forecast owns the future.
    expect(mockGetSummary).toHaveBeenCalledWith(expect.objectContaining({basis:'cash',accountId:'chq-1'}));
    expect(mockGetDailyBalances).toHaveBeenCalledWith(
      expect.objectContaining({ accountIds: 'chq-1', endDate: expect.any(String) }),
    );
    // Projected balance = last forecast point (2200); average from history = 1250.
    expect(screen.getByText('$2200.00')).toBeInTheDocument();
    expect(screen.getByText('$1250.00')).toBeInTheDocument();
  });

  // ---- An incomplete projection (issue #1247) ----

  describe('when the server could not complete the projection', () => {
    /** Only today's anchor comes back, with the reason beside it. */
    const withdrawnForecast = (
      gaps: Array<Record<string, unknown>>,
    ) =>
      mockGetBalanceForecast.mockResolvedValue({
        accountId: 'chq-1',
        currencyCode: 'CAD',
        points: [{ date: '2026-06-15', balance: 1500 }],
        complete: false,
        gaps,
      });

    it('shows the projected balance as unavailable rather than as today\'s figure', async () => {
      withdrawnForecast([
        {
          scheduledTransactionId: 'st-inv',
          name: 'Monthly ETF buy',
          reason: 'unresolvedSettlementRate',
          fromCurrency: 'USD',
          toCurrency: 'CAD',
        },
      ]);

      await renderView();

      // Assert inside the card: 1500 is also this account's Money Out, so a
      // document-wide query would pass for the wrong reason.
      const card = screen.getByLabelText('Projected Balance');
      expect(card).toContainElement(screen.getByTestId('unknown-amount'));
      // Today's balance is not a stand-in for a projection: the card carries no
      // money figure at all. (The note and the tooltip are prose, hence the
      // currency-shaped pattern rather than any digit.)
      expect(card.textContent).not.toMatch(/\$\s?[\d,]/);
    });

    it('says which schedule stopped it, names the pair, and how to fix it', async () => {
      withdrawnForecast([
        {
          scheduledTransactionId: 'st-inv',
          name: 'Monthly ETF buy',
          reason: 'unresolvedSettlementRate',
          fromCurrency: 'USD',
          toCurrency: 'CAD',
        },
      ]);

      await renderView();

      const panel = screen.getByTestId('balance-forecast-unavailable');
      expect(panel).toHaveTextContent('Monthly ETF buy');
      expect(panel).toHaveTextContent('USD');
      expect(panel).toHaveTextContent('CAD');
      // The fix, not just the diagnosis.
      expect(panel).toHaveTextContent(/refresh the rates/i);
    });

    it('explains a cross-currency transfer without offering a rate fix', async () => {
      withdrawnForecast([
        {
          scheduledTransactionId: 'st-xfer',
          name: 'From USD savings',
          reason: 'crossCurrencyTransfer',
          fromCurrency: 'USD',
          toCurrency: 'CAD',
        },
      ]);

      await renderView();

      const panel = screen.getByTestId('balance-forecast-unavailable');
      expect(panel).toHaveTextContent('From USD savings');
      expect(panel).toHaveTextContent(/set when the transfer posts/i);
      // Refreshing rates would not help here, so it is not suggested.
      expect(panel).not.toHaveTextContent(/refresh the rates/i);
    });

    it('draws the line when an older backend sends no completeness at all', async () => {
      // Mid rolling deploy the field is simply absent. That is not the server
      // saying it withheld anything -- those points are the ones it has always
      // sent -- so blanking the chart would invent a problem it never reported.
      mockGetBalanceForecast.mockResolvedValue({
        accountId: 'chq-1',
        currencyCode: 'CAD',
        points: [
          { date: '2026-06-15', balance: 1500 },
          { date: '2026-07-01', balance: 2200 },
        ],
      });

      await renderView();

      expect(
        screen.queryByTestId('balance-forecast-unavailable'),
      ).not.toBeInTheDocument();
      expect(screen.getByText('$2200.00')).toBeInTheDocument();
    });

    it('keeps the history line and says nothing when the forecast IS complete', async () => {
      await renderView();

      expect(
        screen.queryByTestId('balance-forecast-unavailable'),
      ).not.toBeInTheDocument();
      expect(screen.getByText('$2200.00')).toBeInTheDocument();
    });
  });

  it('renders the cash-flow report and top categories', async () => {
    await renderView();
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    expect(screen.getByText('Corner Store')).toBeInTheDocument();
    expect(screen.getByText('Cash Flow')).toBeInTheDocument();
    expect(screen.getByText('Top Categories')).toBeInTheDocument();
    expect(screen.getByText('Top Payees')).toBeInTheDocument();
  });

  it('detects interest earned YTD by category name', async () => {
    // Order of grouped-totals calls: category (month), payee (month), category (YTD).
    mockGetGroupedTotals
      .mockResolvedValueOnce([{ id: 'c1', name: 'Groceries', currencyCode: 'CAD', total: -450, count: 5 }])
      .mockResolvedValueOnce([{ id: 'p1', name: 'Store', currencyCode: 'CAD', total: -450, count: 5 }])
      .mockResolvedValueOnce([
        { id: 'i1', name: 'Interest Income', currencyCode: 'CAD', total: 12.34, count: 4 },
      ]);
    await renderView();
    await waitFor(() => expect(screen.getByText('Interest Earned')).toBeInTheDocument());
    expect(screen.getByText('$12.34')).toBeInTheDocument();
  });

  it('links a top category to its filtered transactions with the month range', async () => {
    await renderView();
    await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByText('Groceries'));
    });
    expect(mockPush).toHaveBeenCalledWith(
      expect.stringMatching(/^\/transactions\?basis=cash&accountId=chq-1&categoryId=c1&startDate=.+&endDate=.+$/),
    );
  });

  it('links a top payee to its detail page', async () => {
    await renderView();
    await waitFor(() => expect(screen.getByText('Corner Store')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByText('Corner Store'));
    });
    expect(mockPush).toHaveBeenCalledWith('/payees/p1');
  });

  it('links a top payee on a joint account to the register, not the payee page', async () => {
    // The payee belongs to the owner's ledger, so /payees/:id 404s in this
    // user's context; the register does serve the owner's rows for a joint
    // account, so the row has to go there instead.
    await renderView(makeAccount({ isJoint: true }));
    await waitFor(() => expect(screen.getByText('Corner Store')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByText('Corner Store'));
    });
    expect(mockPush).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/transactions\?basis=cash&accountId=chq-1&payeeId=p1&startDate=.+&endDate=.+$/,
      ),
    );
    expect(mockPush).not.toHaveBeenCalledWith('/payees/p1');
  });

  it('links Money In and Money Out to amount-filtered transactions', async () => {
    await renderView();
    await waitFor(() => expect(screen.getByText('Money In')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Money In' }));
    });
    expect(mockPush).toHaveBeenCalledWith(
      expect.stringMatching(/accountId=chq-1&amountFrom=0\.01&startDate=/),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Money Out' }));
    });
    expect(mockPush).toHaveBeenCalledWith(
      expect.stringMatching(/accountId=chq-1&amountTo=-0\.01&startDate=/),
    );
  });

  it('links Interest Earned to its category, filtered YTD', async () => {
    mockGetGroupedTotals
      .mockResolvedValueOnce([{ id: 'c1', name: 'Groceries', currencyCode: 'CAD', total: -450, count: 5 }])
      .mockResolvedValueOnce([{ id: 'p1', name: 'Store', currencyCode: 'CAD', total: -450, count: 5 }])
      .mockResolvedValueOnce([
        { id: 'int-1', name: 'Interest Income', currencyCode: 'CAD', total: 12.34, count: 4 },
      ]);
    await renderView();
    await waitFor(() => expect(screen.getByText('Interest Earned')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Interest Earned' }));
    });
    expect(mockPush).toHaveBeenCalledWith(
      expect.stringMatching(/accountId=chq-1&categoryIds=int-1&startDate=\d{4}-01-01&endDate=/),
    );
  });

  // ---- Overdue occurrences (discussion #1784) ----

  it('marks the overdue occurrences on the chart and under the projection', async () => {
    mockGetBalanceForecast.mockResolvedValue({
      accountId: 'chq-1',
      currencyCode: 'CAD',
      points: [
        { date: '2026-06-15', balance: 1500 },
        { date: '2026-06-16', balance: 1200 },
      ],
      complete: true,
      gaps: [],
      overdue: { date: '2026-06-16', count: 2, amount: -300 },
    });
    await renderView();
    await waitFor(() =>
      expect(screen.getByText('Includes 2 overdue scheduled transactions')).toBeInTheDocument(),
    );
    const markers = JSON.parse(
      screen.getByTestId('balance-history-chart').getAttribute('data-markers') as string,
    );
    expect(markers).toEqual([
      { date: '2026-06-16', direction: 'out', label: 'Includes 2 overdue scheduled transactions' },
    ]);
  });

  it('marks nothing when the forecast reports nothing overdue', async () => {
    await renderView();
    await waitFor(() => expect(mockGetBalanceForecast).toHaveBeenCalled());
    expect(
      screen.getByTestId('balance-history-chart').getAttribute('data-markers'),
    ).toBe('[]');
    expect(screen.queryByText(/overdue/)).not.toBeInTheDocument();
  });
});
