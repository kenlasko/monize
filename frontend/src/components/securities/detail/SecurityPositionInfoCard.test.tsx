import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityPositionInfoCard } from './SecurityPositionInfoCard';
import type {
  Security,
  SecurityDetail,
  SecurityDetailActivity,
  SecurityDetailPosition,
} from '@/types/investment';

function security(overrides: Partial<Security> = {}): Security {
  return {
    id: 'sec-1',
    symbol: 'IUSQ',
    name: 'All World',
    securityType: 'ETF',
    exchange: 'XETRA',
    currencyCode: 'EUR',
    description: null,
    tags: [],
    isActive: true,
    isFavourite: false,
    skipPriceUpdates: false,
    sector: null,
    industry: null,
    sectorWeightings: null,
    countryWeightings: null,
    assetWeightings: null,
    website: null,
    irWebsite: null,
    quoteProvider: 'yahoo',
    msnInstrumentId: null,
    lastPriceSource: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function position(
  overrides: Partial<SecurityDetailPosition> = {},
): SecurityDetailPosition {
  return {
    quantity: 100,
    averageCost: 100,
    currentPrice: 130,
    costBasis: 10000,
    marketValue: 13000,
    gainLoss: 3000,
    gainLossPercent: 30,
    ...overrides,
  };
}

function activity(
  overrides: Partial<SecurityDetailActivity> = {},
): SecurityDetailActivity {
  return {
    firstTransactionDate: '2022-03-12',
    lastTransactionDate: '2026-06-20',
    totalInvested: 10000,
    totalSold: 0,
    dividends: 200,
    fees: 50,
    realizedGain: null,
    realizedGainCurrency: null,
    realizedGainCurrencies: [],
    realizedSaleCount: 0,
    transactionCount: 4,
    ...overrides,
  };
}

function detail(overrides: Partial<SecurityDetail> = {}): SecurityDetail {
  return {
    security: security(),
    position: position(),
    accounts: [],
    activity: activity(),
    hasTransactions: true,
    isPositionClosed: false,
    ...overrides,
  };
}

describe('SecurityPositionInfoCard', () => {
  it('reports the lifetime totals in the security currency', () => {
    render(<SecurityPositionInfoCard detail={detail()} />);
    expect(screen.getByText('€10,000.00')).toBeInTheDocument();
    expect(screen.getByText('€200.00')).toBeInTheDocument();
    expect(screen.getByText('€50.00')).toBeInTheDocument();
  });

  describe('a security in the catalogue that was never traded', () => {
    // Found in the E2E suite: the card filled every lifetime total with a
    // formatted zero, so a security nobody bought read as a position that had
    // lost the lot. "Never held" is the whole answer; the totals are not facts
    // about it.
    function untraded() {
      return detail({
        hasTransactions: false,
        position: position({
          quantity: 0,
          averageCost: null,
          currentPrice: null,
          costBasis: null,
          marketValue: null,
          gainLoss: null,
          gainLossPercent: null,
        }),
        activity: activity({
          totalInvested: 0,
          totalSold: 0,
          dividends: 0,
          fees: 0,
          firstTransactionDate: null,
          lastTransactionDate: null,
          realizedGain: null,
          realizedGainCurrency: null,
          realizedGainCurrencies: [],
          realizedSaleCount: 0,
        }),
      });
    }

    it('leaves the lifetime totals out rather than showing zeros', () => {
      render(<SecurityPositionInfoCard detail={untraded()} />);
      expect(screen.queryByText('€0.00')).not.toBeInTheDocument();
    });

    it.each([
      ['Total invested'],
      ['Total sold'],
      ['Dividends'],
      ['Fees'],
    ])('drops the %s row', (label) => {
      render(<SecurityPositionInfoCard detail={untraded()} />);
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    });

    it('still says the position was never held', () => {
      render(<SecurityPositionInfoCard detail={untraded()} />);
      expect(screen.getByText('Never held')).toBeInTheDocument();
    });

    it('keeps showing the totals for a security that was traded', () => {
      // The other half of the rule: a real zero on a real position is a fact.
      render(
        <SecurityPositionInfoCard
          detail={detail({ activity: activity({ dividends: 0 }) })}
        />,
      );
      expect(screen.getByText('Dividends')).toBeInTheDocument();
      expect(screen.getAllByText('€0.00').length).toBeGreaterThan(0);
    });
  });

  describe('status', () => {
    it('calls a never-traded security never held', () => {
      render(
        <SecurityPositionInfoCard
          detail={detail({ hasTransactions: false })}
        />,
      );
      expect(screen.getByText('Never held')).toBeInTheDocument();
    });

    it('calls a sold-out position closed', () => {
      render(
        <SecurityPositionInfoCard detail={detail({ isPositionClosed: true })} />,
      );
      expect(screen.getByText('Closed')).toBeInTheDocument();
    });

    it('calls a held position open', () => {
      render(<SecurityPositionInfoCard detail={detail()} />);
      expect(screen.getByText('Open')).toBeInTheDocument();
    });
  });

  describe('realized P/L', () => {
    it('shows the gain in the currency the replay denominated it in', () => {
      render(
        <SecurityPositionInfoCard
          detail={detail({
            activity: activity({
              realizedGain: 750.5,
              realizedGainCurrency: 'PLN',
              realizedGainCurrencies: ['PLN'],
              realizedSaleCount: 2,
            }),
          })}
        />,
      );
      // PLN, not the security's EUR: the average-cost replay works in the
      // holding account's currency and this page converts nothing.
      expect(screen.getByText(/750\.50/)).toBeInTheDocument();
      expect(screen.queryByText(/€750\.50/)).not.toBeInTheDocument();
    });

    it('names the currencies instead of going blank when they differ', () => {
      render(
        <SecurityPositionInfoCard
          detail={detail({
            activity: activity({
              realizedGain: null,
              realizedGainCurrency: null,
              realizedGainCurrencies: ['EUR', 'PLN'],
              realizedSaleCount: 3,
            }),
          })}
        />,
      );
      // A blank row is how "you never sold" reads. Saying the gains exist but
      // sit in two currencies is a different statement, and the true one.
      expect(
        screen.getByText('Realized in EUR, PLN, so not added up'),
      ).toBeInTheDocument();
    });

    it('shows the known part of the gain beside the unknown marker, never in its place', () => {
      render(
        <SecurityPositionInfoCard
          detail={detail({
            activity: activity({
              realizedGain: null,
              realizedGainComplete: false,
              realizedGainKnownSubtotal: 120.5,
              realizedGainCurrency: 'PLN',
              realizedGainCurrencies: ['PLN'],
              realizedSaleCount: 2,
            }),
          })}
        />,
      );
      expect(screen.getByText(/Known part:.*120\.50/)).toBeInTheDocument();
      // The subtotal appears once, as the known part; the figure's own place
      // holds the unknown marker.
      expect(screen.getAllByText(/120\.50/)).toHaveLength(1);
    });

    it('shows no known part when the gains are unknown and none is known in one currency', () => {
      render(
        <SecurityPositionInfoCard
          detail={detail({
            activity: activity({
              realizedGain: null,
              realizedGainComplete: false,
              realizedGainKnownSubtotal: null,
              realizedGainCurrency: null,
              realizedGainCurrencies: ['EUR', 'PLN'],
              realizedSaleCount: 2,
            }),
          })}
        />,
      );
      expect(screen.queryByText(/Known part/)).not.toBeInTheDocument();
    });

    it('leaves the row out entirely when nothing was ever sold', () => {
      render(<SecurityPositionInfoCard detail={detail()} />);
      expect(screen.queryByText(/Realized P\/L/)).not.toBeInTheDocument();
    });
  });

  describe('total return', () => {
    it('adds income and realized gains to the unrealized gain', () => {
      render(
        <SecurityPositionInfoCard
          detail={detail({
            activity: activity({
              realizedGain: 500,
              realizedGainCurrency: 'EUR',
              realizedGainCurrencies: ['EUR'],
              realizedSaleCount: 1,
            }),
          })}
        />,
      );
      // 3000 unrealized + 500 realized + 200 income = 3700 on 10000; fees are already in the basis.
      expect(screen.getByText(/\+€3,700\.00/)).toBeInTheDocument();
      expect(screen.getByText(/\+37\.00%/)).toBeInTheDocument();
    });

    it('counts only income for a security still held but never sold', () => {
      render(<SecurityPositionInfoCard detail={detail()} />);
      // 3000 + 200 - 50 = 3150 on 10000.
      expect(screen.getByText(/\+€3,200\.00/)).toBeInTheDocument();
    });

    it('is withheld when the realized gain sits in another currency', () => {
      render(
        <SecurityPositionInfoCard
          detail={detail({
            activity: activity({
              realizedGain: 500,
              realizedGainCurrency: 'PLN',
              realizedGainCurrencies: ['PLN'],
              realizedSaleCount: 1,
            }),
          })}
        />,
      );
      // Adding PLN to EUR would need a rate this page has no business applying.
      expect(screen.queryByText('Total return')).not.toBeInTheDocument();
    });

    it('is withheld when the position could not be priced', () => {
      render(
        <SecurityPositionInfoCard
          detail={detail({
            position: position({
              marketValue: null,
              costBasis: null,
              gainLoss: null,
              gainLossPercent: null,
            }),
          })}
        />,
      );
      expect(screen.queryByText('Total return')).not.toBeInTheDocument();
    });

    it('needs no market value once the position is closed', () => {
      render(
        <SecurityPositionInfoCard
          detail={detail({
            isPositionClosed: true,
            position: position({
              quantity: 0,
              marketValue: null,
              costBasis: null,
              gainLoss: null,
              gainLossPercent: null,
            }),
            activity: activity({
              totalSold: 11000,
              realizedGain: 900,
              realizedGainCurrency: 'EUR',
              realizedGainCurrencies: ['EUR'],
              realizedSaleCount: 1,
            }),
          })}
        />,
      );
      // Nothing is held, so there is no unrealized part to be unable to price:
      // 900 realized + 200 income = 1100.
      expect(screen.getByText(/\+€1,100\.00/)).toBeInTheDocument();
    });
  });
});
