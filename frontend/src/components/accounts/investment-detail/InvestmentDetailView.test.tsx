import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@/test/render';
import { InvestmentDetailView } from './InvestmentDetailView';
import type { Account } from '@/types/account';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
}));

// Stub the heavy portfolio components -- they have their own tests.
vi.mock('@/components/investments/PortfolioSummaryCard', () => ({
  PortfolioSummaryCard: () => <div data-testid="portfolio-summary" />,
}));
vi.mock('@/components/investments/AssetAllocationChart', () => ({
  AssetAllocationChart: () => <div data-testid="allocation" />,
}));
vi.mock('@/components/investments/InvestmentValueChart', () => ({
  InvestmentValueChart: () => <div data-testid="value-chart" />,
}));
vi.mock('@/components/investments/GroupedHoldingsList', () => ({
  GroupedHoldingsList: () => <div data-testid="holdings" />,
}));
vi.mock('@/components/investments/InvestmentTransactionList', () => ({
  InvestmentTransactionList: () => <div data-testid="inv-tx-list" />,
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
const mockGetTransactions = vi.fn();
const mockGetRealizedGains = vi.fn();
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...a: unknown[]) => mockGetPortfolioSummary(...a),
    getTransactions: (...a: unknown[]) => mockGetTransactions(...a),
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
  mockGetTransactions.mockImplementation((params: { startDate?: string }) =>
    Promise.resolve(
      params?.startDate
        ? {
            data: [
              { id: 'd1', action: 'DIVIDEND', totalAmount: 50 },
              { id: 'i1', action: 'INTEREST', totalAmount: 10 },
              { id: 'b1', action: 'BUY', totalAmount: 1000 },
            ],
            pagination: {},
          }
        : { data: [{ id: 't1', action: 'BUY', totalAmount: 1000 }], pagination: {} },
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

  it('links to the full investments view for this account', async () => {
    await renderView();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open in Investments' }));
    });
    expect(mockPush).toHaveBeenCalledWith('/investments?accountId=br-1');
  });

  it('falls back to a standalone brokerage when there is no pair', async () => {
    mockGetInvestmentPair.mockRejectedValue(new Error('400'));
    await renderView();
    await waitFor(() => expect(mockGetPortfolioSummary).toHaveBeenCalledWith(['br-1']));
  });
});
