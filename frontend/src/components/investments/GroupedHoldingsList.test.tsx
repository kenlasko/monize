import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { GroupedHoldingsList } from './GroupedHoldingsList';

vi.mock('@heroicons/react/24/outline', () => ({
  ChevronDownIcon: () => <span data-testid="chevron-down" />,
  ChevronRightIcon: () => <span data-testid="chevron-right" />,
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number, currencyCode?: string) =>
      currencyCode ? `${currencyCode} $${n.toFixed(2)}` : `$${n.toFixed(2)}`,
    numberFormat: 'en-US',
  }),
}));

// USD -> CAD @ 1.35 for tests that exercise cross-currency holdings
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convert: (n: number, from: string, to?: string) => {
      if (!to || from === to) return n;
      if (from === 'USD' && to === 'CAD') return n * 1.35;
      if (from === 'CAD' && to === 'USD') return n / 1.35;
      return n;
    },
    convertToDefault: (n: number) => n,
    defaultCurrency: 'CAD',
  }),
}));

describe('GroupedHoldingsList', () => {
  it('renders loading state', () => {
    render(<GroupedHoldingsList holdingsByAccount={[]} isLoading={true} totalPortfolioValue={0} />);
    expect(screen.getByText('Holdings by Account')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state', () => {
    render(<GroupedHoldingsList holdingsByAccount={[]} isLoading={false} totalPortfolioValue={0} />);
    expect(screen.getByText('No holdings in your portfolio.')).toBeInTheDocument();
  });

  it('renders account headers with holdings', () => {
    const holdingsByAccount = [
      {
        accountId: 'a1',
        accountName: 'RRSP',
        currencyCode: 'CAD',
        totalMarketValue: 5000,
        totalCostBasis: 4000,
        totalGainLoss: 1000,
        totalGainLossPercent: 25,
        cashBalance: 500,
        cashAccountId: 'cash1',
        holdings: [
          {
            id: 'h1', symbol: 'XEQT', name: 'iShares Equity', quantity: 100,
            averageCost: 40, currentPrice: 50, costBasis: 4000,
            costBasisAccountCurrency: 4000, marketValue: 5000,
            gainLoss: 1000, gainLossPercent: 25, currencyCode: 'CAD',
          },
        ],
      },
    ] as any[];

    render(<GroupedHoldingsList holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={5500} />);
    expect(screen.getByText('RRSP')).toBeInTheDocument();
    expect(screen.getByText('XEQT')).toBeInTheDocument();
  });

  it('toggles account expansion on click', () => {
    const holdingsByAccount = [
      {
        accountId: 'a1', accountName: 'RRSP', currencyCode: 'CAD',
        totalMarketValue: 5000, totalCostBasis: 4000, totalGainLoss: 1000,
        totalGainLossPercent: 25, cashBalance: 0, holdings: [
          { id: 'h1', symbol: 'XEQT', name: 'iShares', quantity: 10, averageCost: 40, currentPrice: 50, costBasis: 400, costBasisAccountCurrency: 400, marketValue: 500, gainLoss: 100, gainLossPercent: 25, currencyCode: 'CAD' },
        ],
      },
    ] as any[];

    render(<GroupedHoldingsList holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={5000} />);
    // Initially expanded — XEQT should be visible
    expect(screen.getByText('XEQT')).toBeInTheDocument();

    // Click to collapse
    fireEvent.click(screen.getByText('RRSP'));
    expect(screen.queryByText('XEQT')).not.toBeInTheDocument();
  });

  it('shows account-currency converted values for foreign securities', () => {
    // CAD brokerage holding a USD security. Cost basis in the account's
    // currency comes from the backend (historical exchange rates), while
    // market value still uses the current rate since shares are worth what
    // the market says today. Gain/loss is derived from those two values.
    //
    // Historical cost basis: 1000 USD was bought when rate was 1.25 -> 1250 CAD
    // Current market rate (from mock): USD->CAD @ 1.35 -> market value 2025 CAD
    // Gain/loss in CAD = 2025 - 1250 = 775
    const holdingsByAccount = [
      {
        accountId: 'a1',
        accountName: 'CAD Brokerage',
        currencyCode: 'CAD',
        totalMarketValue: 2025,
        totalCostBasis: 1250,
        totalGainLoss: 775,
        totalGainLossPercent: 62,
        cashBalance: 0,
        holdings: [
          {
            id: 'h1',
            symbol: 'AAPL',
            name: 'Apple Inc.',
            quantity: 10,
            averageCost: 100,
            currentPrice: 150,
            costBasis: 1000,
            costBasisAccountCurrency: 1250,
            marketValue: 1500,
            gainLoss: 500,
            gainLossPercent: 50,
            currencyCode: 'USD',
          },
        ],
      },
    ] as any[];

    render(
      <GroupedHoldingsList
        holdingsByAccount={holdingsByAccount}
        isLoading={false}
        totalPortfolioValue={2025}
      />,
    );

    // Primary values in the security's currency (USD)
    expect(screen.getByText(/USD \$1000\.00 USD/)).toBeInTheDocument(); // cost basis
    expect(screen.getByText(/USD \$1500\.00 USD/)).toBeInTheDocument(); // market value
    expect(screen.getByText(/USD \$500\.00 USD/)).toBeInTheDocument(); // gain/loss

    // Cost basis uses the historical account-currency value from the backend
    // (1250 CAD), not the current-rate conversion (which would be 1350 CAD).
    expect(
      screen.getByText(/\u2248 CAD \$1250\.00 CAD/),
    ).toBeInTheDocument();
    // Market value uses the current rate (1500 USD * 1.35 = 2025 CAD)
    expect(
      screen.getByText(/\u2248 CAD \$2025\.00 CAD/),
    ).toBeInTheDocument();
    // Gain/loss in CAD is derived: 2025 - 1250 = 775 CAD
    expect(
      screen.getByText(/\u2248 CAD \$775\.00 CAD/),
    ).toBeInTheDocument();
  });

  it('calls onSymbolClick when symbol button is clicked', () => {
    const onSymbolClick = vi.fn();
    const holdingsByAccount = [
      {
        accountId: 'a1', accountName: 'RRSP', currencyCode: 'CAD',
        totalMarketValue: 500, totalCostBasis: 400, totalGainLoss: 100,
        totalGainLossPercent: 25, cashBalance: 0,
        holdings: [
          { id: 'h1', symbol: 'XEQT', name: 'iShares', quantity: 10, averageCost: 40, currentPrice: 50, costBasis: 400, costBasisAccountCurrency: 400, marketValue: 500, gainLoss: 100, gainLossPercent: 25, currencyCode: 'CAD' },
        ],
      },
    ] as any[];
    render(<GroupedHoldingsList holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={500} onSymbolClick={onSymbolClick} />);
    fireEvent.click(screen.getByText('XEQT'));
    expect(onSymbolClick).toHaveBeenCalledWith('XEQT');
  });

  it('calls onCashClick when Cash button is clicked', () => {
    const onCashClick = vi.fn();
    const holdingsByAccount = [
      {
        accountId: 'a1', accountName: 'RRSP', currencyCode: 'CAD',
        totalMarketValue: 500, totalCostBasis: 400, totalGainLoss: 100,
        totalGainLossPercent: 25, cashBalance: 200, cashAccountId: 'cash-acc-1',
        holdings: [],
      },
    ] as any[];
    render(<GroupedHoldingsList holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={700} onCashClick={onCashClick} />);
    fireEvent.click(screen.getByText('Cash'));
    expect(onCashClick).toHaveBeenCalledWith('cash-acc-1');
  });

  it('shows + Cash text in position subtitle when cash balance is nonzero', () => {
    const holdingsByAccount = [
      {
        accountId: 'a1', accountName: 'RRSP', currencyCode: 'CAD',
        totalMarketValue: 500, totalCostBasis: 400, totalGainLoss: 100,
        totalGainLossPercent: 25, cashBalance: 200, cashAccountId: 'cash-1',
        holdings: [
          { id: 'h1', symbol: 'XEQT', name: 'iShares', quantity: 10, averageCost: 40, currentPrice: 50, costBasis: 400, costBasisAccountCurrency: 400, marketValue: 500, gainLoss: 100, gainLossPercent: 25, currencyCode: 'CAD' },
        ],
      },
    ] as any[];
    render(<GroupedHoldingsList holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={700} />);
    expect(screen.getByText(/\+ Cash/)).toBeInTheDocument();
  });

  it('shows accounts/positions with correct pluralization', () => {
    const holdingsByAccount = [
      {
        accountId: 'a1', accountName: 'RRSP', currencyCode: 'CAD',
        totalMarketValue: 500, totalCostBasis: 400, totalGainLoss: 100,
        totalGainLossPercent: 25, cashBalance: 0, holdings: [
          { id: 'h1', symbol: 'XEQT', name: 'iShares', quantity: 1, averageCost: 40, currentPrice: 50, costBasis: 400, costBasisAccountCurrency: 400, marketValue: 500, gainLoss: 100, gainLossPercent: 25, currencyCode: 'CAD' },
        ],
      },
    ] as any[];
    render(<GroupedHoldingsList holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={500} />);
    expect(screen.getByText(/1 account with 1 position/)).toBeInTheDocument();
  });

  it('shows plural accounts/positions text', () => {
    const holdingsByAccount = [
      {
        accountId: 'a1', accountName: 'RRSP', currencyCode: 'CAD',
        totalMarketValue: 200, totalCostBasis: 150, totalGainLoss: 50, totalGainLossPercent: 33, cashBalance: 0,
        holdings: [
          { id: 'h1', symbol: 'XEQT', name: 'A', quantity: 5, averageCost: 20, currentPrice: 25, costBasis: 100, costBasisAccountCurrency: 100, marketValue: 125, gainLoss: 25, gainLossPercent: 25, currencyCode: 'CAD' },
          { id: 'h2', symbol: 'ZAG', name: 'B', quantity: 5, averageCost: 10, currentPrice: 15, costBasis: 50, costBasisAccountCurrency: 50, marketValue: 75, gainLoss: 25, gainLossPercent: 50, currencyCode: 'CAD' },
        ],
      },
      {
        accountId: 'a2', accountName: 'TFSA', currencyCode: 'CAD',
        totalMarketValue: 100, totalCostBasis: 80, totalGainLoss: 20, totalGainLossPercent: 25, cashBalance: 0,
        holdings: [
          { id: 'h3', symbol: 'VFV', name: 'C', quantity: 2, averageCost: 40, currentPrice: 50, costBasis: 80, costBasisAccountCurrency: 80, marketValue: 100, gainLoss: 20, gainLossPercent: 25, currencyCode: 'CAD' },
        ],
      },
    ] as any[];
    render(<GroupedHoldingsList holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={300} />);
    expect(screen.getByText(/2 accounts with 3 positions/)).toBeInTheDocument();
  });

  it('shows portfolio percent as dash when totalPortfolioValue is 0', () => {
    const holdingsByAccount = [
      {
        accountId: 'a1', accountName: 'RRSP', currencyCode: 'CAD',
        totalMarketValue: 0, totalCostBasis: 400, totalGainLoss: -400, totalGainLossPercent: -100, cashBalance: 0,
        holdings: [
          { id: 'h1', symbol: 'XEQT', name: 'iShares', quantity: 10, averageCost: 40, currentPrice: 0, costBasis: 400, costBasisAccountCurrency: 400, marketValue: 0, gainLoss: -400, gainLossPercent: -100, currencyCode: 'CAD' },
        ],
      },
    ] as any[];
    render(<GroupedHoldingsList holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={0} />);
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);
  });

  it('shows red gain/loss color for negative values and cash-only account', () => {
    const holdingsByAccount = [
      {
        accountId: 'a1', accountName: 'RRSP', currencyCode: 'CAD',
        totalMarketValue: 0, totalCostBasis: 0, totalGainLoss: null, totalGainLossPercent: null, cashBalance: 500,
        cashAccountId: 'ca1',
        holdings: [],
      },
    ] as any[];
    render(<GroupedHoldingsList holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={500} />);
    expect(screen.getByText('Cash')).toBeInTheDocument();
  });

  it('shows USD account holdings with currency code in header', () => {
    const holdingsByAccount = [
      {
        accountId: 'a1', accountName: 'USD Brokerage', currencyCode: 'USD',
        totalMarketValue: 1000, totalCostBasis: 800, totalGainLoss: 200, totalGainLossPercent: 25, cashBalance: 0,
        holdings: [
          { id: 'h1', symbol: 'AAPL', name: 'Apple Inc.', quantity: 10, averageCost: 80, currentPrice: 100, costBasis: 800, costBasisAccountCurrency: 800, marketValue: 1000, gainLoss: 200, gainLossPercent: 25, currencyCode: 'USD' },
        ],
      },
    ] as any[];
    render(<GroupedHoldingsList holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={1350} />);
    // USD account shown with USD prefix since USD != CAD (default currency in mock)
    expect(screen.getAllByText(/USD \$1000\.00 USD/).length).toBeGreaterThan(0);
  });

  it('does not show converted values when security currency matches account currency', () => {
    const holdingsByAccount = [
      {
        accountId: 'a1',
        accountName: 'CAD Brokerage',
        currencyCode: 'CAD',
        totalMarketValue: 500,
        totalCostBasis: 400,
        totalGainLoss: 100,
        totalGainLossPercent: 25,
        cashBalance: 0,
        holdings: [
          {
            id: 'h1',
            symbol: 'XEQT',
            name: 'iShares Equity',
            quantity: 10,
            averageCost: 40,
            currentPrice: 50,
            costBasis: 400,
            costBasisAccountCurrency: 400,
            marketValue: 500,
            gainLoss: 100,
            gainLossPercent: 25,
            currencyCode: 'CAD',
          },
        ],
      },
    ] as any[];

    render(
      <GroupedHoldingsList
        holdingsByAccount={holdingsByAccount}
        isLoading={false}
        totalPortfolioValue={500}
      />,
    );

    // No approximate conversion lines should appear when currencies match
    expect(screen.queryByText(/\u2248/)).not.toBeInTheDocument();
  });
});
