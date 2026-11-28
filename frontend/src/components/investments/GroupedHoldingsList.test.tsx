import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor, within } from '@/test/render';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useHiddenColumnsStore } from '@/store/hiddenColumnsStore';
import { GroupedHoldingsList } from './GroupedHoldingsList';

// The account preference write. Hiding a column saves to this browser only
// (`useHiddenColumnsStore`), so the hidden-column tests assert it is never called.
const mockUpdatePreferences = vi.fn();
vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    updatePreferences: (...args: unknown[]) => mockUpdatePreferences(...args),
  },
}));

vi.mock('@heroicons/react/24/outline', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ChevronDownIcon: () => <span data-testid="chevron-down" />,
    ChevronRightIcon: () => <span data-testid="chevron-right" />,
  };
});

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number, currencyCode?: string) =>
        currencyCode ? `${currencyCode} $${n.toFixed(2)}` : `$${n.toFixed(2)}`,
      formatCurrencyPrecise: (n: number, currencyCode?: string) => {
        const abs = Math.abs(n);
        let digits = 2;
        if (n !== 0 && abs < 0.005) {
          digits = Math.min(6, Math.max(2, -Math.floor(Math.log10(abs)) + 2));
        }
        const s = `$${n.toFixed(digits)}`;
        return currencyCode ? `${currencyCode} ${s}` : s;
      },
      formatSignedPercent: (n: number, decimals = 2) =>
        `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`,
      formatNumber: (n: number, decimals = 2) => n.toFixed(decimals),
      formatQuantity: (n: number) =>
        new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 4 }).format(n),
      numberFormat: 'en-US',
    }),
  };
});

// USD -> CAD @ 1.35 for tests that exercise cross-currency holdings. Like the
// real hook, getRate returns null for an unresolved pair -- the component must
// treat that as unknown, never as an implicit 1:1 (review #1133).
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    getRate: (from: string, to?: string) => {
      const target = to || 'CAD';
      if (from === target) return 1;
      if (from === 'USD' && target === 'CAD') return 1.35;
      if (from === 'CAD' && target === 'USD') return 1 / 1.35;
      return null;
    },
    defaultCurrency: 'CAD',
  }),
}));

// Both handlers are required props; a test that is not about them passes these.
const clickHandlers = { onSecurityClick: vi.fn(), onCashClick: vi.fn() };

describe('GroupedHoldingsList', () => {
  it('renders loading state', () => {
    render(<GroupedHoldingsList {...clickHandlers} holdingsByAccount={[]} isLoading={true} totalPortfolioValue={0} />);
    expect(screen.getByText('Holdings by Account')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state', () => {
    render(<GroupedHoldingsList {...clickHandlers} holdingsByAccount={[]} isLoading={false} totalPortfolioValue={0} />);
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

    render(<GroupedHoldingsList {...clickHandlers} holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={5500} />);
    expect(screen.getByText('RRSP')).toBeInTheDocument();
    expect(screen.getByText('XEQT')).toBeInTheDocument();
  });

  it('wraps each holding row into a labelled grid card below the mobile breakpoint', () => {
    const holdingsByAccount = [
      {
        accountId: 'a1', accountName: 'RRSP', currencyCode: 'CAD',
        totalMarketValue: 5000, totalCostBasis: 4000, totalGainLoss: 1000,
        totalGainLossPercent: 25, cashBalance: 500, cashAccountId: 'cash1', holdings: [
          { id: 'h1', symbol: 'XEQT', name: 'iShares Equity', quantity: 100, averageCost: 40, currentPrice: 50, costBasis: 4000, costBasisAccountCurrency: 4000, marketValue: 5000, gainLoss: 1000, gainLossPercent: 25, currencyCode: 'CAD' },
        ],
      },
    ] as any[];

    render(<GroupedHoldingsList {...clickHandlers} holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={5500} />);

    // The holding, cash and summary rows are grid cards below `sm` and ordinary
    // table rows from `sm` up, so a phone needs no horizontal scroll.
    const holdingRow = screen
      .getAllByRole('row')
      .find((row) => row.textContent?.includes('XEQT'));
    expect(holdingRow).toBeDefined();
    expect(holdingRow!.className).toContain('grid grid-cols-4');
    expect(holdingRow!.className).toContain('sm:table-row');

    // Every figure names its column inside the card, so a phone reader needs no
    // header (which is hidden below `sm`).
    for (const caption of ['Shares', 'Avg Cost', 'Price', 'Cost Basis', 'Mkt Value', 'Gain/Loss', '% Port']) {
      expect(holdingRow!.textContent).toContain(caption);
    }

    // The cash row is a card too and carries the same captions.
    const cashRow = screen
      .getAllByRole('row')
      .find((row) => row.textContent?.includes('Cash'));
    expect(cashRow).toBeDefined();
    expect(cashRow!.className).toContain('grid grid-cols-4');
  });

  it('shrinks figure cells to text-xs on a phone and restores text-sm from sm up', () => {
    // A phone card packs up to four figures on one line, so FIGURE_CELL renders
    // `text-xs` below `sm` to avoid reopening horizontal scroll -- while the
    // `sm`+ resolved size stays `text-sm` (`sm:text-sm`), identical to the base
    // table.
    const holdingsByAccount = [
      {
        accountId: 'a1', accountName: 'RRSP', currencyCode: 'CAD',
        totalMarketValue: 5000, totalCostBasis: 4000, totalGainLoss: 1000,
        totalGainLossPercent: 25, cashBalance: 500, cashAccountId: 'cash1', holdings: [
          { id: 'h1', symbol: 'XEQT', name: 'iShares Equity', quantity: 100, averageCost: 40, currentPrice: 50, costBasis: 4000, costBasisAccountCurrency: 4000, marketValue: 5000, gainLoss: 1000, gainLossPercent: 25, currencyCode: 'CAD' },
        ],
      },
    ] as any[];

    render(<GroupedHoldingsList {...clickHandlers} holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={5500} />);

    const figureCells = screen
      .getAllByRole('cell')
      .filter((c) => c.className.includes('sm:text-sm'));
    expect(figureCells.length).toBeGreaterThan(0);
    for (const cell of figureCells) {
      const classes = cell.className.split(/\s+/);
      expect(classes).toContain('text-xs');
      expect(classes).toContain('sm:text-sm');
      // Desktop size is unchanged: no bare `text-sm`, only the `sm:` variant.
      expect(classes).not.toContain('text-sm');
    }
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

    render(<GroupedHoldingsList {...clickHandlers} holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={5000} />);
    // Initially expanded — XEQT should be visible
    expect(screen.getByText('XEQT')).toBeInTheDocument();

    // Click to collapse
    fireEvent.click(screen.getByText('RRSP'));
    expect(screen.queryByText('XEQT')).not.toBeInTheDocument();
  });

  it('shows the server-converted account-currency values for foreign securities', () => {
    // CAD brokerage holding a USD security. Both account-currency figures come
    // from the backend, from the SAME valuation that produced the totals: the
    // cost basis at the historical rates, the market value at the server's live
    // snapshot. The row must NOT re-convert `marketValue` with the client's own
    // `getRate` (that was a second FX for one snapshot). The mock's USD->CAD is
    // 1.35, so a client conversion would read 1500 * 1.35 = 2025; the server's
    // snapshot says 2020, and 2020 is what the row shows.
    const holdingsByAccount = [
      {
        accountId: 'a1',
        accountName: 'CAD Brokerage',
        currencyCode: 'CAD',
        totalMarketValue: 2020,
        totalCostBasis: 1250,
        totalGainLoss: 770,
        totalGainLossPercent: 61.6,
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
            marketValueAccountCurrency: 2020,
            marketValueDefaultCurrency: 2020,
            gainLoss: 500,
            gainLossPercent: 50,
            currencyCode: 'USD',
          },
        ],
      },
    ] as any[];

    render(
      <GroupedHoldingsList
        {...clickHandlers}
        holdingsByAccount={holdingsByAccount}
        isLoading={false}
        totalPortfolioValue={2020}
      />,
    );

    // Primary values in the security's currency (USD)
    expect(screen.getByText(/USD \$1000\.00 USD/)).toBeInTheDocument(); // cost basis
    expect(screen.getByText(/USD \$1500\.00 USD/)).toBeInTheDocument(); // market value
    expect(screen.getByText(/USD \$500\.00 USD/)).toBeInTheDocument(); // gain/loss

    // Cost basis uses the historical account-currency value from the backend.
    expect(
      screen.getByText(/\u2248 CAD \$1250\.00 CAD/),
    ).toBeInTheDocument();
    // Market value uses the SERVER snapshot (2020 CAD), not the client's rate
    // (which would read 2025 CAD).
    expect(
      screen.getByText(/\u2248 CAD \$2020\.00 CAD/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/\u2248 CAD \$2025\.00 CAD/),
    ).not.toBeInTheDocument();
    // Gain/loss in CAD is derived from the two server figures: 2020 - 1250 = 770.
    expect(
      screen.getByText(/\u2248 CAD \$770\.00 CAD/),
    ).toBeInTheDocument();
  });

  it('reports the clicked holding by security id', () => {
    const onSecurityClick = vi.fn();
    const holdingsByAccount = [
      {
        accountId: 'a1', accountName: 'RRSP', currencyCode: 'CAD',
        totalMarketValue: 500, totalCostBasis: 400, totalGainLoss: 100,
        totalGainLossPercent: 25, cashBalance: 0,
        holdings: [
          { id: 'h1', securityId: 'sec-xeqt', symbol: 'XEQT', name: 'iShares', quantity: 10, averageCost: 40, currentPrice: 50, costBasis: 400, costBasisAccountCurrency: 400, marketValue: 500, gainLoss: 100, gainLossPercent: 25, currencyCode: 'CAD' },
        ],
      },
    ] as any[];
    render(<GroupedHoldingsList {...clickHandlers} holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={500} onSecurityClick={onSecurityClick} />);
    fireEvent.click(screen.getByText('XEQT'));
    // The id, not the symbol: the destination is that security's own page.
    expect(onSecurityClick).toHaveBeenCalledWith('sec-xeqt');
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
    render(<GroupedHoldingsList {...clickHandlers} holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={700} onCashClick={onCashClick} />);
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
    render(<GroupedHoldingsList {...clickHandlers} holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={700} />);
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
    render(<GroupedHoldingsList {...clickHandlers} holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={500} />);
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
    render(<GroupedHoldingsList {...clickHandlers} holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={300} />);
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
    render(<GroupedHoldingsList {...clickHandlers} holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={0} />);
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
    render(<GroupedHoldingsList {...clickHandlers} holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={500} />);
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
    render(<GroupedHoldingsList {...clickHandlers} holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={1350} />);
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
        {...clickHandlers}
        holdingsByAccount={holdingsByAccount}
        isLoading={false}
        totalPortfolioValue={500}
      />,
    );

    // No approximate conversion lines should appear when currencies match
    expect(screen.queryByText(/\u2248/)).not.toBeInTheDocument();
  });

  it("marks an account whose own totals are incomplete (recheck RR4-002)", () => {
    // The account totals are in the ACCOUNT's currency, a different conversion
    // from the portfolio's, so the global flag cannot speak for them: this list
    // rendered a known subtotal as the account's value and gain.
    const accounts = [
      {
        accountId: 'a1',
        accountName: 'Tokyo Brokerage',
        currencyCode: 'JPY',
        cashAccountId: null,
        cashBalance: 0,
        // The account must hold something, or the list renders its empty state
        // and there is no account row to inspect.
        holdings: [
          {
            id: 'h1',
            securityId: 'sec-1',
            symbol: 'EUSTX',
            name: 'Euro Stoxx',
            securityType: 'ETF',
            currencyCode: 'EUR',
            quantity: 10,
            averageCost: 50,
            costBasis: 500,
            costBasisAccountCurrency: null,
            currentPrice: 60,
            marketValue: 600,
            gainLoss: 100,
            gainLossPercent: 20,
          },
        ],
        totalCostBasis: 0,
        totalMarketValue: 0,
        totalGainLoss: 0,
        totalGainLossPercent: 0,
        netInvested: 0,
        fxComplete: false,
        missingRatePairs: ['EUR->JPY'],
        pricesComplete: true,
        unpricedSecurityIds: [],
        valuationComplete: false,
      },
    ];

    render(
      <GroupedHoldingsList
        {...clickHandlers}
        holdingsByAccount={accounts as never}
        isLoading={false}
        totalPortfolioValue={600}
      />,
    );

    // Names the account's own currency, because that is the conversion that failed
    // -- not the portfolio's reporting currency.
    expect(
      screen.getByText(/Partial: this account's totals leave out .* in JPY\./),
    ).toBeInTheDocument();
  });

  it("marks an incomplete account's gain as over its priced holdings only (A26-M38)", () => {
    const accounts = [
      {
        accountId: 'a1',
        accountName: 'Mixed Brokerage',
        currencyCode: 'CAD',
        cashAccountId: null,
        cashBalance: 0,
        holdings: [
          {
            id: 'h1', securityId: 'sec-1', symbol: 'AAA', name: 'Alpha',
            securityType: 'STOCK', currencyCode: 'CAD', quantity: 1000,
            averageCost: 80, costBasis: 80000, costBasisAccountCurrency: 80000,
            currentPrice: 100, marketValue: 100000, gainLoss: 20000,
            gainLossPercent: 25,
          },
          {
            id: 'h2', securityId: 'sec-2', symbol: 'BBB', name: 'Bravo',
            securityType: 'STOCK', currencyCode: 'CAD', quantity: 500,
            averageCost: 100, costBasis: 50000, costBasisAccountCurrency: 50000,
            currentPrice: null, marketValue: null, gainLoss: null,
            gainLossPercent: null,
          },
        ],
        totalCostBasis: 130000,
        gainCostBasis: 80000,
        unpricedCostBasis: 50000,
        totalMarketValue: 100000,
        unpricedHoldingsCount: 1,
        totalGainLoss: 20000,
        totalGainLossPercent: 25,
        netInvested: 0,
        fxComplete: true,
        missingRatePairs: [],
        pricesComplete: false,
        unpricedSecurityIds: ['sec-2'],
        valuationComplete: false,
      },
    ];

    render(
      <GroupedHoldingsList
        {...clickHandlers}
        holdingsByAccount={accounts as never}
        isLoading={false}
        totalPortfolioValue={100000}
      />,
    );

    expect(screen.queryByText(/-\$30000\.00/)).not.toBeInTheDocument();
    // The header's gain figure and the account-total row's gain and return are
    // all marked. (The AAA row's own gain is a single priced holding's, unmarked.)
    const header = screen.getByText(/\$20000\.00 \(\+25\.00%\)/);
    expect(header.closest('[data-testid="partial-total"]')).not.toBeNull();
    expect(screen.getAllByTestId('partial-total')).toHaveLength(3);
    expect(screen.getAllByText('Over priced holdings only').length).toBeGreaterThan(0);
  });

  it("says nothing for an account whose own totals are complete", () => {
    const accounts = [
      {
        accountId: 'a1',
        accountName: 'Tokyo Brokerage',
        currencyCode: 'JPY',
        cashAccountId: null,
        cashBalance: 0,
        holdings: [
          {
            id: 'h1',
            securityId: 'sec-1',
            symbol: 'EUSTX',
            name: 'Euro Stoxx',
            securityType: 'ETF',
            currencyCode: 'JPY',
            quantity: 10,
            averageCost: 50,
            costBasis: 500,
            costBasisAccountCurrency: 500,
            currentPrice: 60,
            marketValue: 600,
            gainLoss: 100,
            gainLossPercent: 20,
          },
        ],
        totalCostBasis: 500,
        totalMarketValue: 600,
        totalGainLoss: 100,
        totalGainLossPercent: 20,
        netInvested: 500,
        fxComplete: true,
        missingRatePairs: [],
        pricesComplete: true,
        unpricedSecurityIds: [],
        valuationComplete: true,
      },
    ];

    render(
      <GroupedHoldingsList
        {...clickHandlers}
        holdingsByAccount={accounts as never}
        isLoading={false}
        totalPortfolioValue={600}
      />,
    );

    expect(screen.queryByText(/Partial:/)).not.toBeInTheDocument();
  });

  it('omits the approx conversions when the pair has no rate (review #1133)', () => {
    // convert() used to pass the amount through unchanged for an unresolved
    // pair, so a EUR value rendered as an "approx JPY" figure right beside the
    // account's Partial marker. No rate: the account-currency value is
    // unknown, and unknown does not render.
    const accounts = [
      {
        accountId: 'a1',
        accountName: 'Tokyo Brokerage',
        currencyCode: 'JPY',
        cashAccountId: null,
        cashBalance: 0,
        holdings: [
          {
            id: 'h1',
            securityId: 'sec-1',
            symbol: 'EUSTX',
            name: 'Euro Stoxx',
            securityType: 'ETF',
            currencyCode: 'EUR',
            quantity: 10,
            averageCost: 50,
            costBasis: 500,
            costBasisAccountCurrency: null,
            currentPrice: 60,
            marketValue: 600,
            gainLoss: 100,
            gainLossPercent: 20,
          },
        ],
        totalCostBasis: 0,
        totalMarketValue: 0,
        totalGainLoss: 0,
        totalGainLossPercent: 0,
        netInvested: 0,
        fxComplete: false,
        missingRatePairs: ['EUR->JPY'],
        pricesComplete: true,
        unpricedSecurityIds: [],
        valuationComplete: false,
      },
    ];

    render(
      <GroupedHoldingsList
        {...clickHandlers}
        holdingsByAccount={accounts as never}
        isLoading={false}
        totalPortfolioValue={600}
      />,
    );

    // Neither the header's default-currency approximation (the account is
    // incomplete and JPY->CAD has no rate in this file's mock) nor the row's
    // account-currency approximation (EUR->JPY has none either) may render.
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
  });

  it('shows the portfolio percent as unknown when the valuation is incomplete (review #1133)', () => {
    // totalPortfolioValue is a known subtotal then, and a share of a subtotal
    // is not a share of the portfolio.
    const accounts = [
      {
        accountId: 'a1',
        accountName: 'CAD Brokerage',
        currencyCode: 'CAD',
        cashAccountId: null,
        cashBalance: 0,
        holdings: [
          {
            id: 'h1',
            securityId: 'sec-1',
            symbol: 'XEQT',
            name: 'iShares Equity',
            securityType: 'ETF',
            currencyCode: 'CAD',
            quantity: 10,
            averageCost: 40,
            costBasis: 400,
            costBasisAccountCurrency: 400,
            currentPrice: 50,
            marketValue: 500,
            gainLoss: 100,
            gainLossPercent: 25,
          },
        ],
        totalCostBasis: 400,
        totalMarketValue: 500,
        totalGainLoss: 100,
        totalGainLossPercent: 25,
        netInvested: 400,
        fxComplete: true,
        missingRatePairs: [],
        pricesComplete: true,
        unpricedSecurityIds: [],
        valuationComplete: true,
      },
    ];

    render(
      <GroupedHoldingsList
        {...clickHandlers}
        holdingsByAccount={accounts as never}
        isLoading={false}
        totalPortfolioValue={null}
      />,
    );

    // The server withheld the total (a price or rate is missing), so the share
    // of the KNOWN subtotal is not a share of the portfolio: `totalPortfolioValue`
    // being null is the whole signal.
    expect(screen.queryByText('100.0%')).not.toBeInTheDocument();
  });

  // The holding rows and the account/portfolio total must convert from ONE
  // snapshot -- the server's, the one that produced the total. Re-converting a
  // row's `marketValue` with the client's live `getRate` was a second FX, so
  // the rows did not sum to the total and a row's share used a denominator in a
  // different snapshot from its numerator (audit of #1397, point 9).
  describe('one FX snapshot for a holding and the total (point 9)', () => {
    it('reads the server-converted amount, not a divergent client rate', () => {
      // The mock resolves USD->CAD at 1.35, so a client conversion of the
      // 1500 USD market value would read 2025 CAD and a share of 2025/3600 =
      // 56.3%. The server's snapshot says 1800 CAD -- a deliberately different
      // rate -- and 1800 is what both the row and its share must use, so the
      // row agrees with the total the same snapshot produced.
      const holdingsByAccount = [
        {
          accountId: 'a1',
          accountName: 'CAD Brokerage',
          currencyCode: 'CAD',
          totalMarketValue: 1800,
          totalCostBasis: 1250,
          totalGainLoss: 550,
          totalGainLossPercent: 44,
          cashBalance: 0,
          holdings: [
            {
              id: 'h1',
              securityId: 'sec-aapl',
              symbol: 'AAPL',
              name: 'Apple Inc.',
              quantity: 10,
              averageCost: 100,
              currentPrice: 150,
              costBasis: 1000,
              costBasisAccountCurrency: 1250,
              marketValue: 1500,
              marketValueAccountCurrency: 1800,
              marketValueDefaultCurrency: 1800,
              gainLoss: 500,
              gainLossPercent: 50,
              currencyCode: 'USD',
            },
          ],
        },
      ] as any[];

      render(
        <GroupedHoldingsList
          {...clickHandlers}
          holdingsByAccount={holdingsByAccount}
          isLoading={false}
          totalPortfolioValue={3600}
        />,
      );

      const row = screen
        .getAllByRole('row')
        .find((r) => r.textContent?.includes('AAPL'))!;
      // The security-currency value is still shown (a real, different number).
      expect(row.textContent).toContain('USD $1500.00 USD');
      // The account-currency line is the server's 1800, never the client's 2025.
      expect(screen.getByText(/≈ CAD \$1800\.00 CAD/)).toBeInTheDocument();
      expect(
        screen.queryByText(/≈ CAD \$2025\.00 CAD/),
      ).not.toBeInTheDocument();
      // Share of portfolio: 1800 / 3600 = 50.0%, not the client rate's
      // 2025 / 3600 = 56.3%.
      const portCell = within(row).getAllByRole('cell').at(-1)!;
      expect(portCell.textContent).toContain('50.0%');
      expect(portCell.textContent).not.toContain('56.3%');
    });

    it('renders an unresolved pair as unknown, not a wrong-denominator percent', () => {
      // The server could not convert this holding's pair, so its account- and
      // reporting-currency values are null. The client's own rate for the pair
      // WOULD resolve (USD->CAD 1.35 in the mock), so the old code would have
      // computed a share from 1500 * 1.35 / 6000 = 33.8%. Reading the server's
      // null instead, the share is unknown ('-') -- not a wrong-denominator
      // percent from a second, divergent rate.
      const holdingsByAccount = [
        {
          accountId: 'a1',
          accountName: 'CAD Brokerage',
          currencyCode: 'CAD',
          cashBalance: 0,
          totalMarketValue: 0,
          totalCostBasis: 0,
          totalGainLoss: 0,
          totalGainLossPercent: 0,
          holdings: [
            {
              id: 'h1',
              securityId: 'sec-aapl',
              symbol: 'AAPL',
              name: 'Apple Inc.',
              securityType: 'ETF',
              quantity: 10,
              averageCost: 100,
              currentPrice: 150,
              costBasis: 1000,
              costBasisAccountCurrency: null,
              marketValue: 1500,
              marketValueAccountCurrency: null,
              marketValueDefaultCurrency: null,
              gainLoss: 500,
              gainLossPercent: 50,
              currencyCode: 'USD',
            },
          ],
        },
      ] as any[];

      render(
        <GroupedHoldingsList
          {...clickHandlers}
          holdingsByAccount={holdingsByAccount}
          isLoading={false}
          totalPortfolioValue={6000}
        />,
      );

      const row = screen
        .getAllByRole('row')
        .find((r) => r.textContent?.includes('AAPL'))!;
      // The security-currency value is still shown.
      expect(row.textContent).toContain('USD $1500.00 USD');
      // No account-currency approximation (the server's converted value is null).
      expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
      // The share of portfolio is unknown, never the client-rate 33.8%.
      const portCell = within(row).getAllByRole('cell').at(-1)!;
      expect(portCell.textContent).toContain('-');
      expect(portCell.textContent).not.toMatch(/\d/);
    });
  });
});

describe('GroupedHoldingsList hidden columns', () => {
  // The stored `hiddenTableColumns.investmentHoldings` set (one per table kind,
  // read on the Investments page and the investment detail view alike) removes
  // a figure column from the DOM at every width: no header, no cell in any of
  // the three row kinds, no phone-card caption, and the account-total label
  // spans one column less for each hidden per-share column.
  const holdingsByAccount = [
    {
      accountId: 'a1', accountName: 'RRSP', currencyCode: 'CAD',
      totalMarketValue: 5000, totalCostBasis: 4000, totalGainLoss: 1000,
      totalGainLossPercent: 25, cashBalance: 500, cashAccountId: 'cash1', holdings: [
        { id: 'h1', securityId: 's1', symbol: 'XEQT', name: 'iShares Equity', quantity: 100, averageCost: 40, currentPrice: 50, costBasis: 4000, costBasisAccountCurrency: 4000, marketValue: 5000, gainLoss: 1000, gainLossPercent: 25, currencyCode: 'CAD' },
      ],
    },
  ] as any[];

  const ALL = ['shares', 'avgCost', 'price', 'costBasis', 'mktValue', 'gainLoss', 'portfolioPercent'];
  const CAPTIONS = ['Shares', 'Avg Cost', 'Price', 'Cost Basis', 'Mkt Value', 'Gain/Loss', '% Port'];

  const seed = (investmentHoldings: string[] | undefined) =>
    usePreferencesStore.setState({
      preferences: (investmentHoldings
        ? { hiddenTableColumns: { investmentHoldings } }
        : { hiddenTableColumns: {} }) as any,
    });

  const renderList = () =>
    render(
      <GroupedHoldingsList {...clickHandlers} holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={5500} />,
    );

  const rowWith = (text: string) =>
    screen.getAllByRole('row').find((row) => row.textContent?.includes(text))!;
  // jsdom applies no media queries, so the phone sort strip and the column
  // header row are both in the DOM; address the column header row (hidden
  // below `sm`) by its displaying class, and strip the sort glyph.
  const columnRow = () => document.querySelector<HTMLElement>('thead tr.sm\\:table-row')!;
  const headerLabels = () =>
    within(columnRow())
      .getAllByRole('columnheader')
      .map((th) => th.textContent?.replace(/[↑↓↕]/g, ''));
  const totalLabelSpan = () =>
    Number(screen.getByText('Account Total').closest('td')!.getAttribute('colspan'));

  beforeEach(() => {
    mockUpdatePreferences.mockReset();
    mockUpdatePreferences.mockImplementation(async (patch: Record<string, unknown>) => patch);
  });

  afterEach(() => {
    // Unmount first, so resetting the store re-renders nothing outside act().
    cleanup();
    usePreferencesStore.setState({ preferences: null });
  });

  it('renders every column with the default empty set, as before', () => {
    seed(undefined);
    renderList();
    expect(headerLabels()).toEqual(['Symbol', ...CAPTIONS]);
    expect(totalLabelSpan()).toBe(4);
    expect(within(rowWith('XEQT')).getAllByRole('cell')).toHaveLength(8);
    expect(within(rowWith('Available Balance')).getAllByRole('cell')).toHaveLength(8);
    expect(within(rowWith('Account Total')).getAllByRole('cell')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Columns' })).toBeInTheDocument();
  });

  it('removes a hidden Avg Cost from the header, every row, the captions and the label span', () => {
    seed(['avgCost']);
    renderList();

    expect(headerLabels()).toEqual(['Symbol', 'Shares', 'Price', 'Cost Basis', 'Mkt Value', 'Gain/Loss', '% Port']);
    for (const row of [rowWith('XEQT'), rowWith('Available Balance')]) {
      expect(row.textContent).not.toContain('Avg Cost');
      expect(within(row).getAllByRole('cell')).toHaveLength(7);
    }
    // The average cost itself ($40.00) is gone; the price ($50.00) stays.
    expect(rowWith('XEQT').textContent).not.toContain('$40.00');
    expect(rowWith('XEQT').textContent).toContain('$50.00');
    // Symbol, Shares and Price: the label spans three columns, not four.
    expect(totalLabelSpan()).toBe(3);
    // The phone card closes the gap: Price moves into Avg Cost's place.
    const priceCell = within(rowWith('XEQT'))
      .getAllByRole('cell')
      .find((cell) => cell.textContent?.startsWith('Price'))!;
    expect(priceCell.className).toContain('col-start-2 row-start-2');
    expect(screen.getByRole('button', { name: 'Columns, 1 hidden' })).toBeInTheDocument();
  });

  it('hides every figure column and keeps Symbol alone', () => {
    seed(ALL);
    renderList();

    expect(headerLabels()).toEqual(['Symbol']);
    expect(within(rowWith('XEQT')).getAllByRole('cell')).toHaveLength(1);
    expect(within(rowWith('Available Balance')).getAllByRole('cell')).toHaveLength(1);
    expect(within(rowWith('Account Total')).getAllByRole('cell')).toHaveLength(1);
    expect(totalLabelSpan()).toBe(1);
    // No caption and no figure: the card is the symbol and the name.
    expect(rowWith('XEQT').textContent).toBe('XEQTiShares Equity');
    // The account header above the table still carries the account's figures.
    expect(screen.getByRole('button', { name: /RRSP/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Columns, 7 hidden' })).toBeInTheDocument();
  });

  it('hides a column from the menu in the heading block and shows it again from there', async () => {
    seed(undefined);
    renderList();

    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Gain/Loss' }));
    });
    await waitFor(() => {
      expect(useHiddenColumnsStore.getState().columns).toEqual({ investmentHoldings: ['gainLoss'] });
    });
    expect(within(columnRow()).queryByRole('columnheader', { name: 'Gain/Loss' })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Gain/Loss' }));
    });
    await waitFor(() => {
      expect(useHiddenColumnsStore.getState().columns).toEqual({ investmentHoldings: [] });
    });
    expect(mockUpdatePreferences).not.toHaveBeenCalled();
    expect(within(columnRow()).getByRole('columnheader', { name: 'Gain/Loss' })).toBeInTheDocument();
  });

  it('hides a column from its header by right-click, and Symbol offers no sheet', async () => {
    seed(undefined);
    renderList();

    fireEvent.contextMenu(within(columnRow()).getByRole('columnheader', { name: 'Symbol' }));
    expect(screen.queryByRole('button', { name: /hide column/i })).not.toBeInTheDocument();

    fireEvent.contextMenu(within(columnRow()).getByRole('columnheader', { name: 'Shares' }));
    const hide = await screen.findByRole('button', { name: /hide column/i });
    await act(async () => {
      fireEvent.click(hide);
    });
    await waitFor(() => {
      expect(useHiddenColumnsStore.getState().columns).toEqual({ investmentHoldings: ['shares'] });
    });
    expect(within(columnRow()).queryByRole('columnheader', { name: 'Shares' })).not.toBeInTheDocument();
    expect(totalLabelSpan()).toBe(3);
  });
});

describe('GroupedHoldingsList sorting', () => {
  // Every column sorts with the shared `SortableHeader`, largest market value
  // first by default, and the accounts are listed by name (issue #1856).
  const holding = (over: Record<string, unknown>) => ({
    securityId: `s-${over.id}`, name: `${over.symbol} Fund`, averageCost: 10,
    currentPrice: 10, costBasis: 1000, costBasisAccountCurrency: 1000,
    gainLoss: 0, gainLossPercent: 0, currencyCode: 'CAD', ...over,
  });
  const holdingsByAccount = [
    {
      accountId: 'a2', accountName: 'TFSA', currencyCode: 'CAD',
      totalMarketValue: 100, totalCostBasis: 100, totalGainLoss: 0,
      totalGainLossPercent: 0, cashBalance: 0, cashAccountId: null, holdings: [
        holding({ id: 'h9', symbol: 'ZZZ', quantity: 1, marketValue: 100 }),
      ],
    },
    {
      accountId: 'a1', accountName: 'RRSP', currencyCode: 'CAD',
      totalMarketValue: 9000, totalCostBasis: 3000, totalGainLoss: 6000,
      totalGainLossPercent: 200, cashBalance: 0, cashAccountId: null, holdings: [
        holding({ id: 'h1', symbol: 'BBB', quantity: 30, marketValue: 1000 }),
        // USD 4000 is CAD 5400 in the account: larger than CAD 5000 though its
        // bare number is smaller.
        holding({ id: 'h2', symbol: 'AAA', quantity: 10, marketValue: 4000, marketValueAccountCurrency: 5400, marketValueDefaultCurrency: 5400, currencyCode: 'USD' }),
        holding({ id: 'h3', symbol: 'CCC', quantity: 20, marketValue: 5000 }),
        holding({ id: 'h4', symbol: 'DDD', quantity: 5, marketValue: null, currentPrice: null }),
      ],
    },
  ] as any[];

  const renderList = () =>
    render(
      <GroupedHoldingsList {...clickHandlers} holdingsByAccount={holdingsByAccount} isLoading={false} totalPortfolioValue={11500} />,
    );

  const accountOrder = () =>
    screen.getAllByRole('button', { name: /RRSP|TFSA/ }).map((b) => b.textContent?.match(/RRSP|TFSA/)?.[0]);
  // The RRSP table's holding rows, in DOM order, by symbol.
  const rrspOrder = () => {
    const table = screen.getAllByRole('table')[0];
    return Array.from(table.querySelectorAll('tbody tr'))
      .map((row) => row.querySelector('button div')?.textContent)
      .filter((text): text is string => !!text && /^[A-Z]{3}$/.test(text));
  };
  const columnRowOf = (table: HTMLElement) => table.querySelector<HTMLElement>('thead tr.sm\\:table-row')!;
  const phoneStripOf = (table: HTMLElement) => table.querySelector<HTMLElement>('thead tr.sm\\:hidden')!;
  const header = (name: string) =>
    within(columnRowOf(screen.getAllByRole('table')[0])).getByRole('columnheader', { name });

  afterEach(() => {
    cleanup();
    usePreferencesStore.setState({ preferences: null });
    useHiddenColumnsStore.setState({ columns: {} } as any);
  });

  it('lists accounts by name and holdings by account-currency market value, unknown last', () => {
    renderList();
    expect(accountOrder()).toEqual(['RRSP', 'TFSA']);
    expect(rrspOrder()).toEqual(['AAA', 'CCC', 'BBB', 'DDD']);
    expect(header('Mkt Value').getAttribute('aria-sort')).toBe('descending');
  });

  it('sorts by Symbol from its header, toggling the direction', async () => {
    renderList();
    await act(async () => { fireEvent.click(header('Symbol')); });
    expect(rrspOrder()).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
    await act(async () => { fireEvent.click(header('Symbol')); });
    expect(rrspOrder()).toEqual(['DDD', 'CCC', 'BBB', 'AAA']);
    expect(window.localStorage.getItem('investments.holdings.sort')).toContain('symbol');
  });

  it('sorts a hideable figure column from a plain click on its header', async () => {
    renderList();
    await act(async () => { fireEvent.click(header('Shares')); });
    expect(rrspOrder()).toEqual(['DDD', 'AAA', 'CCC', 'BBB']);
    // A click on the column already sorted reverses it; unknown stays last.
    await act(async () => { fireEvent.click(header('Mkt Value')); });
    expect(rrspOrder()).toEqual(['BBB', 'CCC', 'AAA', 'DDD']);
    expect(screen.queryByRole('button', { name: /hide column/i })).not.toBeInTheDocument();
  });

  it('offers the same sort controls in the phone strip and sorts from there', async () => {
    renderList();
    const table = screen.getAllByRole('table')[0];
    const labelsOf = (row: HTMLElement) =>
      Array.from(row.querySelectorAll('th')).map((th) => th.textContent?.replace(/[↑↓↕]/g, ''));
    expect(labelsOf(phoneStripOf(table))).toEqual(labelsOf(columnRowOf(table)));
    expect(labelsOf(phoneStripOf(table))).toHaveLength(8);

    await act(async () => { fireEvent.click(phoneStripOf(table).querySelectorAll('th')[0]); });
    expect(rrspOrder()).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
  });

  it('falls back from a remembered sort on a hidden column, and restores it when shown', () => {
    window.localStorage.setItem('investments.holdings.sort', JSON.stringify({ field: 'shares', direction: 'asc' }));
    useHiddenColumnsStore.setState({ columns: { investmentHoldings: ['shares'] } } as any);
    renderList();
    expect(rrspOrder()).toEqual(['AAA', 'CCC', 'BBB', 'DDD']);
    // No chip for the hidden column either.
    const table = screen.getAllByRole('table')[0];
    expect(phoneStripOf(table).textContent).not.toContain('Shares');

    act(() => { useHiddenColumnsStore.setState({ columns: { investmentHoldings: [] } } as any); });
    expect(rrspOrder()).toEqual(['DDD', 'AAA', 'CCC', 'BBB']);
  });
});
