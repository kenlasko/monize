import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { FavouriteSecurities } from './FavouriteSecurities';
import { FavouriteSecurityQuote } from '@/types/investment';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
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
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: any) => selector({ preferences: { defaultCurrency: 'USD' } }),
}));

const quote = (overrides: Partial<FavouriteSecurityQuote> = {}): FavouriteSecurityQuote => ({
  securityId: '1',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  currencyCode: 'USD',
  currentPrice: 180,
  previousPrice: 174.5,
  dailyChange: 5.5,
  dailyChangePercent: 3.15,
  ...overrides,
});

describe('FavouriteSecurities', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('renders loading skeleton with title', () => {
    render(<FavouriteSecurities securities={[]} isLoading={true} />);
    expect(screen.getByText('Favourite Securities')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state with a link to the Securities page', () => {
    render(<FavouriteSecurities securities={[]} isLoading={false} />);
    expect(screen.getByText(/No favourite securities yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Securities page'));
    expect(mockPush).toHaveBeenCalledWith('/securities');
  });

  it('renders favourites with symbol, name, and price', () => {
    render(<FavouriteSecurities securities={[quote()]} isLoading={false} />);
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
    expect(screen.getByText('$180.00')).toBeInTheDocument();
  });

  it('expands precision for sub-penny securities instead of showing 0.00', () => {
    render(
      <FavouriteSecurities
        securities={[
          quote({ symbol: 'PENNY', name: 'Sub-penny Co', currencyCode: 'GBP', currentPrice: 0.000318, dailyChange: 0.000033, dailyChangePercent: 11.4 }),
        ]}
        isLoading={false}
      />,
    );
    // Price and change reveal their real figures rather than collapsing to 0.00.
    expect(screen.getByText(/0\.000318/)).toBeInTheDocument();
    expect(screen.getByText(/\+\$0\.000033 \(\+11\.40%\)/)).toBeInTheDocument();
  });

  it('shows positive change in green with a plus sign', () => {
    render(<FavouriteSecurities securities={[quote()]} isLoading={false} />);
    const changeEl = screen.getByText(/\+\$5\.50/);
    expect(changeEl.className).toContain('text-green');
  });

  it('shows negative change in red', () => {
    render(
      <FavouriteSecurities
        securities={[quote({ dailyChange: -2, dailyChangePercent: -1.1 })]}
        isLoading={false}
      />,
    );
    const changeEl = screen.getByText(/\$-2\.00/);
    expect(changeEl.className).toContain('text-red');
  });

  it('shows a placeholder when the security has no price yet', () => {
    render(
      <FavouriteSecurities
        securities={[quote({ currentPrice: null, previousPrice: null, dailyChange: 0, dailyChangePercent: 0 })]}
        isLoading={false}
      />,
    );
    expect(screen.getByText('No price yet')).toBeInTheDocument();
  });

  it('appends the currency code for foreign securities', () => {
    render(
      <FavouriteSecurities
        securities={[quote({ symbol: 'BMW', currencyCode: 'EUR', currentPrice: 95 })]}
        isLoading={false}
      />,
    );
    expect(screen.getByText('$95.00 EUR')).toBeInTheDocument();
  });

  it('shows a refresh button when onRefresh is provided and calls it on click', () => {
    const onRefresh = vi.fn();
    render(<FavouriteSecurities securities={[quote()]} isLoading={false} onRefresh={onRefresh} />);
    const refreshBtn = screen.getByTitle('Refresh prices');
    expect(refreshBtn).toBeInTheDocument();
    fireEvent.click(refreshBtn);
    expect(onRefresh).toHaveBeenCalled();
  });

  it('disables the refresh button while refreshing', () => {
    render(<FavouriteSecurities securities={[quote()]} isLoading={false} onRefresh={vi.fn()} isRefreshing={true} />);
    expect(screen.getByTitle('Refresh prices')).toBeDisabled();
  });

  it('does not render a refresh button without onRefresh', () => {
    render(<FavouriteSecurities securities={[quote()]} isLoading={false} />);
    expect(screen.queryByTitle('Refresh prices')).not.toBeInTheDocument();
  });

  it('navigates to securities from the title and footer link', () => {
    render(<FavouriteSecurities securities={[quote()]} isLoading={false} />);
    fireEvent.click(screen.getByText('Favourite Securities'));
    expect(mockPush).toHaveBeenCalledWith('/securities');
    fireEvent.click(screen.getByText('Manage securities'));
    expect(mockPush).toHaveBeenCalledWith('/securities');
  });
});
