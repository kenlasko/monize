import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@/test/render';
import { InvestmentDetailView } from './InvestmentDetailView';
import type { Account } from '@/types/account';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({ ...numberFormatMockDefaults(), formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
  };
});

// Stub the heavy portfolio components -- they have their own tests.
vi.mock('@/components/investments/PortfolioSummaryCard', () => ({
  PortfolioSummaryCard: ({ summary }: { summary: { totalPortfolioValue: number } | null }) => (
    <div data-testid="portfolio-summary">{summary ? summary.totalPortfolioValue : 'no summary'}</div>
  ),
}));
vi.mock('@/components/investments/AssetAllocationChart', () => ({
  AssetAllocationChart: () => <div data-testid="allocation" />,
}));
vi.mock('@/components/investments/InvestmentValueChart', () => ({
  InvestmentValueChart: ({ refreshKey }: { refreshKey?: number }) => (
    <div data-testid="value-chart">{refreshKey}</div>
  ),
}));
// The stub exposes the two click handlers as buttons, so where a symbol or the
// cash row navigates to is observable without the real list.
vi.mock('@/components/investments/GroupedHoldingsList', () => ({
  GroupedHoldingsList: ({
    onSecurityClick,
    onCashClick,
  }: {
    onSecurityClick: (securityId: string) => void;
    onCashClick: (cashAccountId: string) => void;
  }) => (
    <div data-testid="holdings">
      <button type="button" onClick={() => onSecurityClick('sec-1')}>
        open security
      </button>
      <button type="button" onClick={() => onCashClick('cash-1')}>
        open cash
      </button>
    </div>
  ),
}));
vi.mock('@/components/investments/InvestmentTransactionList', () => ({
  InvestmentTransactionList: () => <div data-testid="inv-tx-list" />,
}));
// The register panel raises `onDataChanged` after any write on either ledger.
// The stub exposes that signal as a button so the wiring above it can be tested
// without driving a whole delete or form submission through the real panel --
// which has its own tests for when the signal is raised.
vi.mock('@/components/investments/InvestmentRegisterPanel', () => ({
  InvestmentRegisterPanel: ({ onDataChanged }: { onDataChanged?: () => void }) => (
    <button type="button" onClick={onDataChanged}>
      register wrote
    </button>
  ),
}));
vi.mock('@/components/reports/RefreshPricesButton', () => ({
  RefreshPricesButton: () => <button type="button">Refresh Prices</button>,
}));

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  usePathname: () => '/accounts/br-1',
  useParams: () => ({ id: 'br-1' }),
  useSearchParams: () => new URLSearchParams(),
}));

const mockGetInvestmentPair = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: { getInvestmentPair: (...a: unknown[]) => mockGetInvestmentPair(...a) },
}));

const mockGetPortfolioSummary = vi.fn();
const mockGetAllTransactionPages = vi.fn();
const mockGetRealizedGains = vi.fn();
// One market rate, so a foreign row's conversion is observable: 1 USD = 1.4 CAD.
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convert: (amount: number, from: string, to: string) =>
      from === to ? amount : from === 'USD' && to === 'CAD' ? amount * 1.4 : null,
  }),
}));

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...a: unknown[]) => mockGetPortfolioSummary(...a),
    getAllTransactionPages: (...a: unknown[]) => mockGetAllTransactionPages(...a),
    getRealizedGains: (...a: unknown[]) => mockGetRealizedGains(...a),
  },
}));

const brokerage = {
  id: 'br-1',
  accountType: 'INVESTMENT',
  accountSubType: 'INVESTMENT_BROKERAGE',
  name: 'RRSP',
  currencyCode: 'CAD',
  currentBalance: 0,
} as Account;

const cash = {
  id: 'cash-1',
  accountType: 'INVESTMENT',
  accountSubType: 'INVESTMENT_CASH',
  name: 'RRSP Cash',
  currencyCode: 'CAD',
  currentBalance: 500,
} as Account;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetInvestmentPair.mockResolvedValue({ brokerageAccount: brokerage, cashAccount: cash });
  mockGetPortfolioSummary.mockResolvedValue({
    totalPortfolioValue: 10000,
    totalCostBasis: 8000,
    totalGainLoss: 2000,
    totalGainLossPercent: 25,
    totalCashValue: 500,
    totalHoldingsValue: 9500,
    totalNetInvested: 8000,
    timeWeightedReturn: 0.1,
    cagr: 0.08,
    holdings: [],
    holdingsByAccount: [],
    allocation: [],
  });
  // Income is fetched one action at a time, server-side, so each call answers
  // with only the rows for the action it asked for.
  mockGetAllTransactionPages.mockImplementation((params: { action?: string }) =>
    Promise.resolve(
      params?.action === 'DIVIDEND'
        ? [{ id: 'd1', action: 'DIVIDEND', totalAmount: 50, amountCurrencyCode: 'CAD' }]
        : params?.action === 'INTEREST'
          ? [{ id: 'i1', action: 'INTEREST', totalAmount: 10, amountCurrencyCode: 'CAD' }]
          : [],
    ),
  );
  mockGetRealizedGains.mockResolvedValue([{ realizedGain: 120 }, { realizedGain: -20 }]);
});

async function renderView(account = brokerage) {
  await act(async () => {
    render(<InvestmentDetailView account={account} />);
  });
}

describe('InvestmentDetailView', () => {
  it('resolves the pair and scopes the summary to both accounts', async () => {
    await renderView();
    await waitFor(() => expect(mockGetPortfolioSummary).toHaveBeenCalled());
    expect(mockGetInvestmentPair).toHaveBeenCalledWith('br-1');
    expect(mockGetPortfolioSummary).toHaveBeenCalledWith(['br-1', 'cash-1']);
    expect(screen.getByTestId('portfolio-summary')).toBeInTheDocument();
    expect(screen.getByTestId('holdings')).toBeInTheDocument();
  });

  it('computes YTD dividends/interest and realized gains', async () => {
    await renderView();
    await waitFor(() => expect(screen.getByText('$60.00')).toBeInTheDocument());
    expect(screen.getByText('$100.00')).toBeInTheDocument();
  });

  // Discussion #1670: a reinvested dividend or interest payment is income as
  // surely as a cash one. The app writes a reinvest with no total, so the
  // figure values it at quantity x price.
  it('counts reinvested dividends and interest in the YTD figure', async () => {
    mockGetAllTransactionPages.mockImplementation((params: { action?: string }) =>
      Promise.resolve(
        params?.action === 'DIVIDEND'
          ? [{ id: 'd1', action: 'DIVIDEND', totalAmount: 50, amountCurrencyCode: 'CAD' }]
          : params?.action === 'REINVEST'
            ? [{ id: 'r1', action: 'REINVEST', quantity: 2, price: 15, commission: 0, totalAmount: 0, amountCurrencyCode: 'CAD' }]
            : params?.action === 'REINVEST_INTEREST'
              ? [{ id: 'r2', action: 'REINVEST_INTEREST', quantity: 1, price: 4, commission: 0, totalAmount: 0, amountCurrencyCode: 'CAD' }]
              : [],
      ),
    );

    await renderView();
    // 50 cash + 30 reinvested dividend + 4 reinvested interest.
    await waitFor(() => expect(screen.getByText('$84.00')).toBeInTheDocument());
  });

  // A USD dividend in a CAD account is in USD. Read as CAD it was 50; at the
  // row's own settlement rate it is 67.50, and a VOID row paid nothing.
  it("converts each payment from its own currency at the row's rate, and leaves a VOID row out", async () => {
    mockGetAllTransactionPages.mockImplementation((params: { action?: string }) =>
      Promise.resolve(
        params?.action === 'DIVIDEND'
          ? [
              { id: 'd1', action: 'DIVIDEND', accountId: 'br-1', totalAmount: 50, amountCurrencyCode: 'USD', exchangeRate: 1.35 },
              { id: 'd2', action: 'DIVIDEND', accountId: 'br-1', status: 'VOID', totalAmount: 900, amountCurrencyCode: 'CAD' },
            ]
          : [],
      ),
    );

    await renderView();
    await waitFor(() => expect(screen.getByText('$67.50')).toBeInTheDocument());
  });

  it('shows the year as unknown when a payment cannot be converted', async () => {
    mockGetAllTransactionPages.mockImplementation((params: { action?: string }) =>
      Promise.resolve(
        params?.action === 'DIVIDEND'
          ? [
              { id: 'd1', action: 'DIVIDEND', accountId: 'br-1', totalAmount: 50, amountCurrencyCode: 'CAD' },
              { id: 'd2', action: 'DIVIDEND', accountId: 'br-1', totalAmount: 10, amountCurrencyCode: 'JPY', exchangeRate: 0 },
            ]
          : [],
      ),
    );

    await renderView();
    await waitFor(() => expect(screen.getByTestId('unknown-amount')).toBeInTheDocument());
    expect(screen.queryByText('$50.00')).not.toBeInTheDocument();
  });

  // The YTD income figure asked for 500 rows in one page. The endpoint caps a
  // page at 200 and answers 400 rather than clamping, the .catch() below turned
  // that into an empty list, and the figure read $0.00 for every account, every
  // year -- with nothing on screen to say the request had failed at all.
  it('asks for income a page at a time, never as one over-cap request', async () => {
    await renderView();
    await waitFor(() => expect(mockGetAllTransactionPages).toHaveBeenCalled());

    const params = mockGetAllTransactionPages.mock.calls.map(([p]) => p);
    expect(params.map((p) => p.action).sort()).toEqual([
      'DIVIDEND',
      'INTEREST',
      'REINVEST',
      'REINVEST_INTEREST',
    ]);
    // No caller-supplied page size: the helper's default is the cap itself.
    expect(params.every((p) => p.limit === undefined && p.pageSize === undefined)).toBe(true);
    expect(params.every((p) => p.accountIds === 'br-1,cash-1')).toBe(true);
  });

  // Lowering the old literal to the cap would have swapped a visible zero for a
  // silent undercount, which is the worse failure of the two: a year with more
  // than one page of income has to total all of it.
  it('counts income past the first page', async () => {
    mockGetAllTransactionPages.mockImplementation((params: { action?: string }) =>
      Promise.resolve(
        params?.action === 'DIVIDEND'
          ? Array.from({ length: 250 }, (_, i) => ({
              id: `d${i}`,
              action: 'DIVIDEND',
              totalAmount: 2,
              amountCurrencyCode: 'CAD',
            }))
          : [],
      ),
    );

    await renderView();
    await waitFor(() => expect(screen.getByText('$500.00')).toBeInTheDocument());
  });

  // A failed lookup is not a year without income, but it is all the component
  // can say -- so the rest of the page must still render rather than blanking.
  it('survives an income lookup that fails', async () => {
    mockGetAllTransactionPages.mockRejectedValue(new Error('boom'));
    await renderView();
    await waitFor(() => expect(mockGetPortfolioSummary).toHaveBeenCalled());
    expect(screen.getByTestId('portfolio-summary')).toBeInTheDocument();
  });

  // The header owns both actions now (InvestmentDetailActions), so the body
  // must not grow a second copy of either.
  it('renders no action row of its own', async () => {
    await renderView();
    expect(screen.queryByRole('button', { name: 'Open in Investments' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh Prices' })).not.toBeInTheDocument();
  });

  it('re-fetches when the header bumps the refresh key', async () => {
    let rendered: ReturnType<typeof render>;
    await act(async () => {
      rendered = render(<InvestmentDetailView account={brokerage} refreshKey={0} />);
    });
    await waitFor(() => expect(mockGetPortfolioSummary).toHaveBeenCalledTimes(1));

    await act(async () => {
      rendered!.rerender(<InvestmentDetailView account={brokerage} refreshKey={1} />);
    });

    await waitFor(() => expect(mockGetPortfolioSummary).toHaveBeenCalledTimes(2));
  });

  // A price refresh (the header's, or the automatic one every 15 minutes) moves
  // the valuation only: the pair, the year's income and the realized gains are
  // not priced, so they are not asked again.
  it('re-asks only the summary when only the refresh key moved', async () => {
    let rendered: ReturnType<typeof render>;
    await act(async () => {
      rendered = render(<InvestmentDetailView account={brokerage} refreshKey={0} />);
    });
    await waitFor(() => expect(screen.getByText('$60.00')).toBeInTheDocument());
    mockGetPortfolioSummary.mockResolvedValueOnce({ totalPortfolioValue: 10400, holdings: [], holdingsByAccount: [], allocation: [] });

    await act(async () => {
      rendered!.rerender(<InvestmentDetailView account={brokerage} refreshKey={1} />);
    });

    await waitFor(() => expect(screen.getByTestId('portfolio-summary')).toHaveTextContent('10400'));
    expect(mockGetPortfolioSummary).toHaveBeenLastCalledWith(['br-1', 'cash-1']);
    expect(mockGetInvestmentPair).toHaveBeenCalledTimes(1);
    expect(mockGetRealizedGains).toHaveBeenCalledTimes(1);
  });

  // Nobody is waiting on that reload, and the figures it would replace are
  // still a valuation: "No data", no income and no gains would be invented.
  it('keeps every figure when the summary fails after a price refresh', async () => {
    let rendered: ReturnType<typeof render>;
    await act(async () => {
      rendered = render(<InvestmentDetailView account={brokerage} refreshKey={0} />);
    });
    await waitFor(() => expect(screen.getByText('$60.00')).toBeInTheDocument());
    mockGetPortfolioSummary.mockRejectedValueOnce(new Error('timeout'));

    await act(async () => {
      rendered!.rerender(<InvestmentDetailView account={brokerage} refreshKey={1} />);
    });

    expect(mockGetPortfolioSummary).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('portfolio-summary')).toHaveTextContent('10000');
    expect(screen.getByText('$60.00')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
  });

  // Issue #1190: a cash deposit changed the cash balance the Holdings by Account
  // list draws, and only the register below it reloaded -- the holdings, the
  // summary card and the allocation kept their pre-write figures until the page
  // was reloaded by hand.
  it('re-fetches the holdings and summary when the register reports a write', async () => {
    await renderView();
    await waitFor(() => expect(mockGetPortfolioSummary).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'register wrote' }));
    });

    await waitFor(() => expect(mockGetPortfolioSummary).toHaveBeenCalledTimes(2));
    expect(mockGetInvestmentPair).toHaveBeenCalledTimes(2);
  });

  // The value chart fetches its own series and has its own sessionStorage cache,
  // so re-running this component's load says nothing to it -- the write has to
  // reach it as a prop.
  it('passes the write through to the value chart', async () => {
    await renderView();
    expect(screen.getByTestId('value-chart')).toHaveTextContent('0');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'register wrote' }));
    });

    await waitFor(() =>
      expect(screen.getByTestId('value-chart')).toHaveTextContent('1'),
    );
  });

  // Issue #2255: the list was rendered without its click handlers, so the
  // symbol drew as a link and clicking it did nothing.
  it('opens the security when a holding is clicked', async () => {
    await renderView();
    fireEvent.click(screen.getByRole('button', { name: 'open security' }));
    expect(mockPush).toHaveBeenCalledWith('/securities/sec-1');
  });

  it('opens the cash register when the cash row is clicked', async () => {
    await renderView();
    fireEvent.click(screen.getByRole('button', { name: 'open cash' }));
    expect(mockPush).toHaveBeenCalledWith('/transactions?accountId=cash-1');
  });

  it('falls back to a standalone brokerage when there is no pair', async () => {
    mockGetInvestmentPair.mockRejectedValue(new Error('400'));
    await renderView();
    await waitFor(() => expect(mockGetPortfolioSummary).toHaveBeenCalledWith(['br-1']));
  });
});
