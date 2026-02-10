import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { HoldingsList } from './HoldingsList';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    numberFormat: 'en-US',
  }),
}));

describe('HoldingsList', () => {
  it('renders loading state', () => {
    render(<HoldingsList holdings={[]} isLoading={true} />);
    expect(screen.getByText('Holdings')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state', () => {
    render(<HoldingsList holdings={[]} isLoading={false} />);
    expect(screen.getByText('No holdings in this portfolio.')).toBeInTheDocument();
  });

  it('renders holdings table with data', () => {
    const holdings = [
      {
        id: 'h1', symbol: 'AAPL', name: 'Apple Inc.', quantity: 10,
        averageCost: 150, currentPrice: 180, marketValue: 1800,
        gainLoss: 300, gainLossPercent: 20, currencyCode: 'CAD',
      },
    ] as any[];

    render(<HoldingsList holdings={holdings} isLoading={false} />);
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
    expect(screen.getByText('$1800.00')).toBeInTheDocument();
  });

  it('renders table headers correctly', () => {
    const holdings = [
      { id: '1', symbol: 'X', name: 'X', quantity: 1, averageCost: 1, currentPrice: 1, marketValue: 1, gainLoss: 0, gainLossPercent: 0, currencyCode: 'CAD' },
    ] as any[];

    render(<HoldingsList holdings={holdings} isLoading={false} />);
    expect(screen.getByText('Symbol')).toBeInTheDocument();
    expect(screen.getByText('Shares')).toBeInTheDocument();
    expect(screen.getByText('Avg Cost')).toBeInTheDocument();
    expect(screen.getByText('Price')).toBeInTheDocument();
    expect(screen.getByText('Market Value')).toBeInTheDocument();
    expect(screen.getByText('Gain/Loss')).toBeInTheDocument();
  });
});
