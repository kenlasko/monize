import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { HoldingStatsTable } from './MonteCarloHoldingStatsTable';

const fmt = (v: number, currencyCode?: string) =>
  `${v.toFixed(0)} ${currencyCode ?? 'DEFAULT'}`;

/**
 * A deterministic stand-in for `useNumberFormat()`'s bundle. These are unit
 * tests of the pure helpers' branching, not of locale rendering -- the locale
 * cases live in `src/hooks/useNumberFormat.test.ts` and the component locale
 * regressions in `SecurityList.test.tsx`'s "number locale" block.
 */
const fmts = {
  formatCurrency: fmt,
  formatNumber: (v: number, d = 2) => v.toFixed(d),
  formatPercent: (v: number, d = 2) => `${v.toFixed(d)}%`,
};

describe('HoldingStatsTable', () => {
  it('renders loading state', () => {
    render(<HoldingStatsTable data={null} loading={true} formatters={fmts} />);
    expect(screen.getByText(/Loading holding stats/i)).toBeInTheDocument();
  });

  it('renders empty state when data is null', () => {
    render(<HoldingStatsTable data={null} loading={false} formatters={fmts} />);
    expect(screen.getByText(/Select one or more accounts/i)).toBeInTheDocument();
  });

  it('renders empty state when data is empty array', () => {
    render(<HoldingStatsTable data={[]} loading={false} formatters={fmts} />);
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
        formatters={fmts}
      />,
    );
    expect(screen.getByText('My Brokerage')).toBeInTheDocument();
    expect(screen.getByText(/USD/)).toBeInTheDocument();
    expect(screen.getByText(/No active holdings/)).toBeInTheDocument();
  });

  it('shows a dash, not a guessed currency, when the security has none', () => {
    render(
      <HoldingStatsTable
        data={[
          {
            accountId: 'a',
            accountName: 'Brokerage',
            currencyCode: 'USD',
            holdings: [
              {
                symbol: 'XYZ',
                name: 'No currency',
                currencyCode: null,
                quantity: 5,
                marketValue: 777,
                yearsObserved: 0,
                meanReturn: null,
                volatility: null,
              },
            ],
          },
        ]}
        loading={false}
        formatters={fmts}
      />,
    );
    expect(screen.queryByText(/777/)).not.toBeInTheDocument();
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
              { symbol: 'AAPL', name: 'Apple Inc.', currencyCode: 'USD', marketValue: 1000, meanReturn: 0.12, volatility: 0.2 },
              { symbol: 'NULLY', name: 'No Stats', currencyCode: 'USD', marketValue: 500, meanReturn: null, volatility: null },
            ],
          },
        ] as any}
        loading={false}
        formatters={fmts}
      />,
    );
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
    expect(screen.getByText('NULLY')).toBeInTheDocument();
    expect(screen.getByText('12.00%')).toBeInTheDocument();
    expect(screen.getByText('20.00%')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    // Formatted in the holding's own currency, not the default.
    expect(screen.getByText('1000 USD')).toBeInTheDocument();
  });
});
  it('renders an unpriced holding as unknown, not zero (recheck RR4-004)', () => {
    // The same report refuses to project from an incomplete current value while
    // this table told the user the unpriced holding was worth nothing. `null` and
    // `0` are different answers.
    const data = [
      {
        accountId: 'a1',
        accountName: 'RRSP',
        currencyCode: 'CAD',
        holdings: [
          {
            symbol: 'UNPRICED',
            name: 'No Quote Fund',
            currencyCode: 'CAD',
            quantity: 10,
            marketValue: null,
            yearsObserved: 3,
            meanReturn: 0.05,
            volatility: 0.1,
          },
        ],
      },
    ];

    render(
      <HoldingStatsTable
        data={data as never}
        loading={false}
        formatters={fmts}
      />,
    );

    expect(screen.getByText('UNPRICED')).toBeInTheDocument();
    // The em dash this table already uses for an unknown percentage, not a zero.
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    expect(screen.getAllByText('\u2014').length).toBeGreaterThan(0);
  });
  it("formats a holding in its own currency, not the default (RR5-004)", () => {
    // Default PLN, security USD, value 1,000. The table used the default-currency
    // formatter and printed "1,000 PLN" for a USD holding -- a value and its
    // currency are one tuple.
    render(
      <HoldingStatsTable
        data={[
          {
            accountId: 'a',
            accountName: 'IKZE',
            currencyCode: 'PLN',
            holdings: [
              { symbol: 'AAPL', name: 'Apple', currencyCode: 'USD', marketValue: 1000, meanReturn: 0.1, volatility: 0.2 },
            ],
          },
        ] as any}
        loading={false}
        formatters={fmts}
      />,
    );

    // The formatter echoes the currency it was handed: USD, not the PLN default.
    expect(screen.getByText('1000 USD')).toBeInTheDocument();
    expect(screen.queryByText('1000 PLN')).not.toBeInTheDocument();
  });


