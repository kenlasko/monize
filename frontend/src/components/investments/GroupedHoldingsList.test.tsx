import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { GroupedHoldingsList } from './GroupedHoldingsList';

vi.mock('@heroicons/react/24/outline', () => ({
  ChevronDownIcon: () => <span data-testid="chevron-down" />,
  ChevronRightIcon: () => <span data-testid="chevron-right" />,
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    numberFormat: 'en-US',
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
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
            averageCost: 40, currentPrice: 50, costBasis: 4000, marketValue: 5000,
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
          { id: 'h1', symbol: 'XEQT', name: 'iShares', quantity: 10, averageCost: 40, currentPrice: 50, costBasis: 400, marketValue: 500, gainLoss: 100, gainLossPercent: 25, currencyCode: 'CAD' },
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
});
