import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { TopMovers } from './TopMovers';

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
  it('renders loading state', () => {
    render(<TopMovers movers={[]} isLoading={true} hasInvestmentAccounts={true} />);
    expect(screen.getByText('Top Movers')).toBeInTheDocument();
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

  it('renders movers with data', () => {
    const movers = [
      { securityId: '1', symbol: 'AAPL', name: 'Apple Inc.', currentPrice: 180, dailyChange: 5.5, dailyChangePercent: 3.15, currencyCode: 'USD' },
      { securityId: '2', symbol: 'MSFT', name: 'Microsoft', currentPrice: 400, dailyChange: -2.0, dailyChangePercent: -0.5, currencyCode: 'USD' },
    ] as any[];

    render(<TopMovers movers={movers} isLoading={false} hasInvestmentAccounts={true} />);
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    expect(screen.getByText('View portfolio')).toBeInTheDocument();
  });
});
