import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { HoldingStatsTable } from './MonteCarloHoldingStatsTable';

const fmt = (v: number) => `$${v.toFixed(0)}`;

describe('HoldingStatsTable', () => {
  it('renders loading state', () => {
    render(<HoldingStatsTable data={null} loading={true} formatCurrency={fmt} />);
    expect(screen.getByText(/Loading holding stats/i)).toBeInTheDocument();
  });

  it('renders empty state when data is null', () => {
    render(<HoldingStatsTable data={null} loading={false} formatCurrency={fmt} />);
    expect(screen.getByText(/Select one or more accounts/i)).toBeInTheDocument();
  });

  it('renders empty state when data is empty array', () => {
    render(<HoldingStatsTable data={[]} loading={false} formatCurrency={fmt} />);
    expect(screen.getByText(/Select one or more accounts/i)).toBeInTheDocument();
  });

  it('renders no-active-holdings message when holdings are empty', () => {
    render(
      <HoldingStatsTable
        data={[
          {
            accountId: 'a',
            accountName: 'My Brokerage',
            currencyCode: 'USD',
            holdings: [],
          },
        ] as any}
        loading={false}
        formatCurrency={fmt}
      />,
    );
    expect(screen.getByText('My Brokerage')).toBeInTheDocument();
    expect(screen.getByText(/USD/)).toBeInTheDocument();
    expect(screen.getByText(/No active holdings/)).toBeInTheDocument();
  });

  it('renders holdings rows including null mean/volatility', () => {
    render(
      <HoldingStatsTable
        data={[
          {
            accountId: 'a',
            accountName: 'Brokerage',
            currencyCode: 'USD',
            holdings: [
              { symbol: 'AAPL', name: 'Apple Inc.', marketValue: 1000, meanReturn: 0.12, volatility: 0.2 },
              { symbol: 'NULLY', name: 'No Stats', marketValue: 500, meanReturn: null, volatility: null },
            ],
          },
        ] as any}
        loading={false}
        formatCurrency={fmt}
      />,
    );
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
    expect(screen.getByText('NULLY')).toBeInTheDocument();
    expect(screen.getByText('12.00%')).toBeInTheDocument();
    expect(screen.getByText('20.00%')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('$1000')).toBeInTheDocument();
  });
});
