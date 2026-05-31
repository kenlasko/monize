import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { HoldingsList } from './HoldingsList';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyPrecise: (n: number) => {
      const abs = Math.abs(n);
      let digits = 2;
      if (n !== 0 && abs < 0.005) {
        digits = Math.min(6, Math.max(2, -Math.floor(Math.log10(abs)) + 2));
      }
      return `$${n.toFixed(digits)}`;
    },
    formatSignedPercent: (n: number, decimals = 2) =>
      `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`,
    formatQuantity: (n: number) =>
      new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 4 }).format(n),
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

  it('renders dash for null values (averageCost, currentPrice, marketValue, gainLoss)', () => {
    const holdings = [
      { id: 'h1', symbol: 'XEQT', name: 'iShares', quantity: 10, averageCost: null, currentPrice: null, marketValue: null, gainLoss: null, gainLossPercent: null, currencyCode: 'CAD' },
    ] as any[];
    render(<HoldingsList holdings={holdings} isLoading={false} />);
    expect(screen.getAllByText('-').length).toBeGreaterThan(2);
  });

  it('shows positive gain/loss with green color class', () => {
    const holdings = [
      { id: 'h1', symbol: 'XEQT', name: 'iShares', quantity: 10, averageCost: 40, currentPrice: 50, marketValue: 500, gainLoss: 100, gainLossPercent: 25, currencyCode: 'CAD' },
    ] as any[];
    const { container } = render(<HoldingsList holdings={holdings} isLoading={false} />);
    expect(container.querySelector('.text-green-600')).toBeInTheDocument();
  });

  it('shows negative gain/loss with red color class', () => {
    const holdings = [
      { id: 'h1', symbol: 'XEQT', name: 'iShares', quantity: 10, averageCost: 50, currentPrice: 40, marketValue: 400, gainLoss: -100, gainLossPercent: -20, currencyCode: 'CAD' },
    ] as any[];
    const { container } = render(<HoldingsList holdings={holdings} isLoading={false} />);
    expect(container.querySelector('.text-red-600')).toBeInTheDocument();
  });

  it('shows null gain/loss (treated as 0) with green color', () => {
    const holdings = [
      { id: 'h1', symbol: 'XEQT', name: 'iShares', quantity: 10, averageCost: 40, currentPrice: 50, marketValue: 500, gainLoss: null, gainLossPercent: null, currencyCode: 'CAD' },
    ] as any[];
    const { container } = render(<HoldingsList holdings={holdings} isLoading={false} />);
    expect(container.querySelector('.text-green-600')).toBeInTheDocument();
  });

  it('shows negative percent without plus sign', () => {
    const holdings = [
      { id: 'h1', symbol: 'XEQT', name: 'iShares', quantity: 10, averageCost: 50, currentPrice: 40, marketValue: 400, gainLoss: -100, gainLossPercent: -20, currencyCode: 'CAD' },
    ] as any[];
    render(<HoldingsList holdings={holdings} isLoading={false} />);
    expect(screen.getByText('-20.00%')).toBeInTheDocument();
  });

  it('shows positive percent with plus sign', () => {
    const holdings = [
      { id: 'h1', symbol: 'XEQT', name: 'iShares', quantity: 10, averageCost: 40, currentPrice: 50, marketValue: 500, gainLoss: 100, gainLossPercent: 25, currencyCode: 'CAD' },
    ] as any[];
    render(<HoldingsList holdings={holdings} isLoading={false} />);
    expect(screen.getByText('+25.00%')).toBeInTheDocument();
  });
});
