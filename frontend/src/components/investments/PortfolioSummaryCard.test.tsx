import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { PortfolioSummaryCard } from './PortfolioSummaryCard';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (n: number) => n,
    defaultCurrency: 'CAD',
  }),
}));

describe('PortfolioSummaryCard', () => {
  it('renders loading state', () => {
    render(<PortfolioSummaryCard summary={null} isLoading={true} />);
    expect(screen.getByText('Portfolio Summary')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state when no summary', () => {
    render(<PortfolioSummaryCard summary={null} isLoading={false} />);
    expect(screen.getByText('No investment data available.')).toBeInTheDocument();
  });

  it('renders portfolio summary with data', () => {
    const summary = {
      totalPortfolioValue: 50000,
      totalHoldingsValue: 45000,
      totalCashValue: 5000,
      totalGainLoss: 5000,
      totalGainLossPercent: 12.5,
      totalCostBasis: 40000,
      holdingsByAccount: [
        { accountId: 'a1', currencyCode: 'CAD', totalMarketValue: 45000, totalCostBasis: 40000, cashBalance: 5000, totalGainLoss: 5000, totalGainLossPercent: 12.5, holdings: [] },
      ],
    } as any;

    render(<PortfolioSummaryCard summary={summary} isLoading={false} />);
    expect(screen.getByText('Total Portfolio Value')).toBeInTheDocument();
    expect(screen.getByText('Holdings Value')).toBeInTheDocument();
    expect(screen.getByText('Cash Balance')).toBeInTheDocument();
    expect(screen.getByText('Total Gain/Loss')).toBeInTheDocument();
    expect(screen.getByText('Total Cost Basis')).toBeInTheDocument();
  });

  it('shows gain/loss percentage', () => {
    const summary = {
      totalPortfolioValue: 50000,
      totalHoldingsValue: 45000,
      totalCashValue: 5000,
      totalGainLoss: 5000,
      totalGainLossPercent: 12.5,
      totalCostBasis: 40000,
      holdingsByAccount: [
        { accountId: 'a1', currencyCode: 'CAD', totalMarketValue: 45000, totalCostBasis: 40000, cashBalance: 5000, totalGainLoss: 5000, totalGainLossPercent: 12.5, holdings: [] },
      ],
    } as any;

    render(<PortfolioSummaryCard summary={summary} isLoading={false} />);
    expect(screen.getByText('(+12.50%)')).toBeInTheDocument();
  });
});
