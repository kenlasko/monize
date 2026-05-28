import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { TopMovers } from './TopMovers';

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

  it('navigates to investments on title click', () => {
    render(<TopMovers movers={[]} isLoading={false} hasInvestmentAccounts={true} />);
    fireEvent.click(screen.getByText('Top Movers'));
    expect(mockPush).toHaveBeenCalledWith('/investments');
  });

  it('shows maximum of 5 movers', () => {
    const movers = Array.from({ length: 8 }, (_, i) => ({
      securityId: `${i}`, symbol: `SYM${i}`, name: `Company ${i}`,
      currentPrice: 100 + i, dailyChange: i - 4, dailyChangePercent: (i - 4) * 0.5,
      currencyCode: 'USD',
    })) as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    // Should only show first 5
    expect(screen.getByText('SYM0')).toBeInTheDocument();
    expect(screen.getByText('SYM4')).toBeInTheDocument();
    expect(screen.queryByText('SYM5')).not.toBeInTheDocument();
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
