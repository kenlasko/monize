import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { TopMovers, rankMovers } from './TopMovers';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyPrecise: (n: number) => {
        const abs = Math.abs(n);
        let digits = 2;
        if (n !== 0 && abs < 0.005) {
          const exp = Math.floor(Math.log10(abs));
          digits = Math.min(6, Math.max(2, -exp + 2));
        }
        return `$${n.toFixed(digits)}`;
      },
      formatPercent: (n: number) => `${n.toFixed(2)}%`,
    }),
  };
});
// The widget ranks Holdings by the day's move converted into the reader's own
// currency, so the table is mocked with one pair that converts (EUR) and one
// that does not (GBP) -- both branches of the ranking rule have a fixture.
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'USD',
    convertToDefault: (amount: number, from: string) =>
      from === 'USD' ? amount : from === 'EUR' ? amount * 2 : null,
  }),
}));

describe('TopMovers', () => {
  beforeEach(() => {
    mockPush.mockClear();
    localStorage.clear();
  });

  it('renders loading state with title and pulse skeleton', () => {
    render(<TopMovers movers={[]} isLoading={true} hasInvestmentAccounts={true} />);
    expect(screen.getByText('Top Movers')).toBeInTheDocument();
    expect(screen.getByText('Daily change')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state with no investment accounts', () => {
    render(<TopMovers movers={[]} isLoading={false} hasInvestmentAccounts={false} />);
    expect(screen.getByText('Add investment accounts to track daily movers.')).toBeInTheDocument();
  });

  it('renders empty state with investment accounts but no movers', () => {
    render(<TopMovers movers={[]} isLoading={false} hasInvestmentAccounts={true} />);
    expect(screen.getByText('No price changes available yet.')).toBeInTheDocument();
  });

  it('renders movers with symbol, name, and price', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple Inc.', currentPrice: 180, dailyChange: 5.5, dailyChangePercent: 3.15, currencyCode: 'USD' },
      { securityId: '2', symbol: 'MSFT', name: 'Microsoft', currentPrice: 400, dailyChange: -2.0, dailyChangePercent: -0.5, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
    expect(screen.getByText('$180.00')).toBeInTheDocument();
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    expect(screen.getByText('Microsoft')).toBeInTheDocument();
    expect(screen.getByText('$400.00')).toBeInTheDocument();
  });

  it('expands precision for sub-penny movers instead of showing 0.00', () => {
    const movers = [
      { securityId: '1', symbol: 'PENNY', name: 'Sub-penny Co', currentPrice: 0.000318, dailyChange: 0.000033, dailyChangePercent: 11.4, currencyCode: 'GBP' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    // Price and change reveal their real figures rather than collapsing to 0.00.
    expect(screen.getByText(/0\.000318/)).toBeInTheDocument();
    expect(screen.getByText(/\+\$0\.000033 \(\+11\.40%\)/)).toBeInTheDocument();
  });

  it('shows positive change with plus sign and green color', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5.5, dailyChangePercent: 3.15, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    const changeEl = screen.getByText(/\+\$5\.50/);
    expect(changeEl).toBeInTheDocument();
    expect(changeEl.className).toContain('text-green');
  });

  it('shows negative change with red color', () => {
    const movers = [
      { securityId: '2', symbol: 'MSFT', name: 'Microsoft', currentPrice: 400, dailyChange: -2.0, dailyChangePercent: -0.5, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    const changeEl = screen.getByText(/\$-2\.00/);
    expect(changeEl).toBeInTheDocument();
    expect(changeEl.className).toContain('text-red');
  });

  it('shows View portfolio link and navigates on click', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5, dailyChangePercent: 2.8, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    fireEvent.click(screen.getByText('View portfolio'));
    expect(mockPush).toHaveBeenCalledWith('/investments');
  });

  it('links the title to investments', () => {
    render(<TopMovers movers={[]} isLoading={false} hasInvestmentAccounts={true} />);
    expect(screen.getByRole('link', { name: 'Top Movers' })).toHaveAttribute(
      'href',
      '/investments',
    );
  });

  it('shows the five biggest movers, not the first five it was handed', () => {
    // Daily changes of -8, -6, -4, -2, 0, 2, 4, 6: the five largest moves in
    // either direction are SYM0, SYM1, SYM7, SYM2 and SYM6. SYM4 did not move
    // and is nobody's top mover, whatever position it arrived in.
    const movers = Array.from({ length: 8 }, (_, i) => ({
      securityId: `${i}`, symbol: `SYM${i}`, name: `Company ${i}`,
      currentPrice: 100 + i, dailyChange: (i - 4) * 2, dailyChangePercent: (i - 4) * 0.5,
      currencyCode: 'USD',
    })) as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);

    expect(screen.getAllByRole('button', { name: /Price history for/ })).toHaveLength(5);
    expect(screen.getByText('SYM0')).toBeInTheDocument();
    expect(screen.getByText('SYM7')).toBeInTheDocument();
    expect(screen.queryByText('SYM4')).not.toBeInTheDocument();
  });

  it('renders the All/Gainers/Losers filter selector', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5, dailyChangePercent: 2.8, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('Gainers')).toBeInTheDocument();
    expect(screen.getByText('Losers')).toBeInTheDocument();
  });

  it('filters to only gainers when Gainers is selected', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5, dailyChangePercent: 2.8, currencyCode: 'USD' },
      { securityId: '2', symbol: 'MSFT', name: 'Microsoft', currentPrice: 400, dailyChange: -2, dailyChangePercent: -0.5, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    fireEvent.click(screen.getByText('Gainers'));
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.queryByText('MSFT')).not.toBeInTheDocument();
  });

  it('filters to only losers when Losers is selected', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5, dailyChangePercent: 2.8, currencyCode: 'USD' },
      { securityId: '2', symbol: 'MSFT', name: 'Microsoft', currentPrice: 400, dailyChange: -2, dailyChangePercent: -0.5, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    fireEvent.click(screen.getByText('Losers'));
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    expect(screen.queryByText('AAPL')).not.toBeInTheDocument();
  });

  it('persists the selected filter to localStorage and restores it on remount', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5, dailyChangePercent: 2.8, currencyCode: 'USD' },
      { securityId: '2', symbol: 'MSFT', name: 'Microsoft', currentPrice: 400, dailyChange: -2, dailyChangePercent: -0.5, currencyCode: 'USD' },
    ] as any[];

    const { unmount } = render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    fireEvent.click(screen.getByText('Losers'));
    expect(localStorage.getItem('dashboard.topMovers.filter')).toBe('losers');
    unmount();

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    expect(screen.queryByText('AAPL')).not.toBeInTheDocument();
  });

  it('shows an empty message when the selected filter has no matches', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5, dailyChangePercent: 2.8, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    fireEvent.click(screen.getByText('Losers'));
    expect(screen.getByText('No losers today.')).toBeInTheDocument();
  });

  it('shows refresh button when onRefresh is provided', () => {
    const onRefresh = vi.fn();
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5, dailyChangePercent: 2.8, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} onRefresh={onRefresh} />);
    const refreshBtn = screen.getByTitle('Refresh prices');
    expect(refreshBtn).toBeInTheDocument();
    fireEvent.click(refreshBtn);
    expect(onRefresh).toHaveBeenCalled();
  });

  it('disables refresh button when isRefreshing is true', () => {
    const onRefresh = vi.fn();
    render(<TopMovers movers={[]} isLoading={true} hasInvestmentAccounts={true} onRefresh={onRefresh} isRefreshing={true} />);
    const refreshBtn = screen.getByTitle('Refresh prices');
    expect(refreshBtn).toBeDisabled();
  });

  it('shows currency code for foreign securities', () => {
    const movers = [
      { securityId: '1', symbol: 'BMW', name: 'BMW AG', currentPrice: 95, dailyChange: 2, dailyChangePercent: 2.1, currencyCode: 'EUR' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    // Foreign currency should show currency code after amount
    expect(screen.getByText('$95.00 EUR')).toBeInTheDocument();
  });

  it('opens the security\'s price history when a row is clicked', () => {
    const movers = [
      { securityId: 'sec-1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5, dailyChangePercent: 2.8, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    // The row names itself with its own content; the action is screen-reader
    // text inside it, not an aria-label that would hide the price and change.
    const row = screen.getByRole('button', { name: /Price history for AAPL/ });
    expect(row).toHaveAccessibleName(expect.stringContaining('Apple'));
    expect(row).toHaveAccessibleName(expect.stringContaining('$180.00'));
    fireEvent.click(row);

    // The detail page's Price history tab, which replaced the modal the
    // securities list used to open, reached
    // by deep link rather than by a second copy of it on the dashboard.
    expect(mockPush).toHaveBeenCalledWith('/securities/sec-1?tab=prices');
  });

  it('re-ranks and re-labels the list when the Price/Holdings toggle changes, and remembers it', () => {
    // In the order the server sends: biggest percentage move first. BIG holds
    // one share of an expensive security and SMALL holds a thousand of a cheap
    // one, so the percentage ranking and the "what did this do to my portfolio"
    // ranking are opposites and neither can look right by inheriting the other.
    const movers = [
      {
        securityId: '2', symbol: 'SMALL', name: 'Small', currencyCode: 'USD',
        currentPrice: 20, dailyChange: 8, dailyChangePercent: 40,
        marketValue: 20000, dailyValueChange: 8000,
      },
      {
        securityId: '1', symbol: 'BIG', name: 'Big', currencyCode: 'USD',
        currentPrice: 900, dailyChange: 400, dailyChangePercent: 0.5,
        marketValue: 900, dailyValueChange: 400,
      },
    ] as any[];

    const { unmount } = render(
      <TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />,
    );
    const symbolsInOrder = () =>
      screen.getAllByRole('button', { name: /Price history for/ }).map((row) =>
        row.textContent?.includes('BIG') ? 'BIG' : 'SMALL',
      );
    // Price: the steepest percentage move first, and the quote on the row.
    expect(symbolsInOrder()).toEqual(['SMALL', 'BIG']);
    expect(screen.getByText('$20.00')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Holdings' }));
    // Holdings: the position's value and what the day did to it, biggest first.
    expect(symbolsInOrder()).toEqual(['SMALL', 'BIG']);
    expect(screen.getByText('$20000.00')).toBeInTheDocument();
    expect(screen.getByText('+$8000.00')).toBeInTheDocument();
    expect(screen.queryByText('$20.00')).not.toBeInTheDocument();

    // The choice is a per-browser convenience, kept across a remount.
    unmount();
    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    expect(screen.getByRole('button', { name: 'Holdings' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('ranks Holdings by the move in value, putting the biggest mover of money first', () => {
    // SMALL has the steeper percentage move; BIG moved more of the reader's
    // money. Under Holdings the order is the order of the figures on screen.
    const movers = [
      {
        securityId: '1', symbol: 'SMALL', name: 'Small', currencyCode: 'USD',
        currentPrice: 20, dailyChange: 8, dailyChangePercent: 40,
        marketValue: 200, dailyValueChange: 80,
      },
      {
        securityId: '2', symbol: 'BIG', name: 'Big', currencyCode: 'USD',
        currentPrice: 900, dailyChange: 9, dailyChangePercent: 1,
        marketValue: 90000, dailyValueChange: 900,
      },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Holdings' }));

    expect(
      screen.getAllByRole('button', { name: /Price history for/ }).map((row) =>
        row.textContent?.includes('BIG') ? 'BIG' : 'SMALL',
      ),
    ).toEqual(['BIG', 'SMALL']);
  });

  it('shows the unknown marker for a holding with no price rather than a zero value', () => {
    const movers = [
      {
        securityId: '1', symbol: 'GIC', name: 'No price', currencyCode: 'USD',
        currentPrice: 100, dailyChange: 1, dailyChangePercent: 1,
        marketValue: null, dailyValueChange: null,
      },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Holdings' }));

    expect(screen.getAllByTestId('unknown-amount')).toHaveLength(2);
  });

  it('does not show currency code for default currency securities', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currentPrice: 180, dailyChange: 5, dailyChangePercent: 2.8, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    expect(screen.getByText('$180.00')).toBeInTheDocument();
    // Should not have 'USD' appended
    expect(screen.queryByText('$180.00 USD')).not.toBeInTheDocument();
  });
});

describe('rankMovers', () => {
  // A big holding moves the most money on a small percentage; a small one moves
  // the most percent on very little. The two orders are genuinely different, so
  // each is pinned here rather than assumed to follow from the other.
  const row = (
    symbol: string,
    dailyChangePercent: number,
    dailyValueChange: number,
    valueChange: number | null = dailyValueChange,
  ) => ({
    mover: {
      securityId: symbol,
      symbol,
      name: symbol,
      currencyCode: 'USD',
      currentPrice: 100,
      previousPrice: 100,
      dailyChange: dailyChangePercent,
      dailyChangePercent,
      marketValue: 10_000,
      dailyValueChange,
    },
    valueChange,
  });

  /**
   * In the order the server sends: descending absolute daily change PERCENT.
   * The fixture is deliberately not in money order -- a branch that passed the
   * incoming order through showed the percent ranking under the Holdings
   * heading, and a fixture already sorted by money could not tell the two apart.
   */
  const rows = [row('SMALL', 40, 8), row('MID', -6, -120), row('BIG', 0.5, 400)];
  const symbols = (ranked: ReturnType<typeof rankMovers>) =>
    ranked.map((r) => r.mover.symbol);

  it('ranks by what the day did to the position for all + holdings', () => {
    expect(symbols(rankMovers(rows, 'all', 'holdings'))).toEqual(['BIG', 'MID', 'SMALL']);
  });

  it('re-ranks by the size of the percentage move for all + price', () => {
    expect(symbols(rankMovers(rows, 'all', 'price'))).toEqual(['SMALL', 'MID', 'BIG']);
  });

  it('ranks gainers by the chosen metric', () => {
    expect(symbols(rankMovers(rows, 'gainers', 'holdings'))).toEqual(['BIG', 'SMALL']);
    expect(symbols(rankMovers(rows, 'gainers', 'price'))).toEqual(['SMALL', 'BIG']);
  });

  it('ranks losers by the steepest fall under the chosen metric', () => {
    const losers = [row('A', -1, -50), row('B', -25, -10)];
    expect(symbols(rankMovers(losers, 'losers', 'holdings'))).toEqual(['A', 'B']);
    expect(symbols(rankMovers(losers, 'losers', 'price'))).toEqual(['B', 'A']);
  });

  it("ranks the day's move in the reader's currency, not in the security's", () => {
    // 100 in a currency worth twice the reader's moved more of their money than
    // 150 in their own. Ranking the native figures would print them the other
    // way round.
    const mixed = [row('HOME', 1, 150, 150), row('ABROAD', 1, 100, 200)];
    expect(symbols(rankMovers(mixed, 'all', 'holdings'))).toEqual(['ABROAD', 'HOME']);
  });

  it('ranks a move with no comparable size after every move that has one', () => {
    // No rate into the display currency: the row keeps its own figures and its
    // own direction, but it cannot claim to be the biggest of anything.
    const unconvertible = row('NORATE', 1, 9_999, null);
    expect(symbols(rankMovers([unconvertible, row('KNOWN', 1, 10)], 'all', 'holdings'))).toEqual([
      'KNOWN',
      'NORATE',
    ]);
    // Its direction is still known, so it is a gainer -- last among them.
    expect(
      symbols(rankMovers([unconvertible, row('KNOWN', 1, 10)], 'gainers', 'holdings')),
    ).toEqual(['KNOWN', 'NORATE']);
    // Under Price nothing is unknown: the percentage is the security's own.
    expect(symbols(rankMovers([unconvertible, row('KNOWN', 5, 10)], 'all', 'price'))).toEqual([
      'KNOWN',
      'NORATE',
    ]);
  });

  it('takes at most the limit', () => {
    const many = Array.from({ length: 9 }, (_, i) => row(`S${i}`, 9 - i, 9 - i));
    expect(rankMovers(many, 'all', 'holdings')).toHaveLength(5);
  });

  it("leaves the caller's array alone", () => {
    const order = symbols(rows as never[]);
    rankMovers(rows, 'all', 'price');
    expect(symbols(rows as never[])).toEqual(order);
  });
});
