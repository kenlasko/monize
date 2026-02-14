import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { TopMovers } from './TopMovers';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatPercent: (n: number) => `${n.toFixed(2)}%`,
  }),
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: any) => selector({ preferences: { defaultCurrency: 'USD' } }),
}));

describe('TopMovers', () => {
  beforeEach(() => {
    mockPush.mockClear();
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
