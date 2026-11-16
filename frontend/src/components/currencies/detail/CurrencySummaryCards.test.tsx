import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import type { CurrencyUsageSummary } from '@/lib/exchange-rates';
import type { RateHistoryRow } from '@/lib/currency-detail';
import { CurrencySummaryCards } from './CurrencySummaryCards';

const usage = (overrides: Partial<CurrencyUsageSummary> = {}): CurrencyUsageSummary => ({
  code: 'EUR',
  reportingCurrency: 'CAD',
  transactionCount: 4,
  firstTransactionDate: '2024-05-01',
  lastTransactionDate: '2026-03-20',
  totalInCurrency: 440,
  totalInReportingCurrency: 664,
  knownReportingSubtotal: 664,
  unconvertedCount: 0,
  missingPairs: [],
  ...overrides,
});

const latest: RateHistoryRow = {
  key: 'provider:2026-03-20',
  date: '2026-03-20',
  rate: 1.6,
  inverseRate: 0.625,
  source: 'frankfurter',
  group: 'frankfurter',
};

describe('CurrencySummaryCards', () => {
  it('shows the count, both totals and the latest rate', () => {
    render(
      <CurrencySummaryCards code="EUR" defaultCurrency="CAD" usage={usage()} latestRate={latest} />,
    );

    expect(screen.getByText('Transactions')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('Since 2024')).toBeInTheDocument();
    expect(screen.getByText('Total in EUR')).toBeInTheDocument();
    expect(screen.getByText('Total in CAD')).toBeInTheDocument();
    expect(screen.getByText('1 EUR = 1.600000 CAD')).toBeInTheDocument();
    expect(screen.getByText(/Frankfurter \(ECB\)/)).toBeInTheDocument();
  });

  it('relabels a partial conversion and names what is missing', () => {
    render(
      <CurrencySummaryCards
        code="EUR"
        defaultCurrency="CAD"
        usage={usage({
          totalInReportingCurrency: null,
          knownReportingSubtotal: 150,
          unconvertedCount: 3,
          missingPairs: ['EUR->CAD'],
        })}
        latestRate={latest}
      />,
    );

    expect(screen.queryByText('Total in CAD')).not.toBeInTheDocument();
    expect(screen.getByText('Converted Part in CAD')).toBeInTheDocument();
    expect(screen.getByText(/3 transactions are left out: no EUR->CAD rate/)).toBeInTheDocument();
  });

  it('withholds the total in the currency when an amount in it is unknown', () => {
    render(
      <CurrencySummaryCards
        code="EUR"
        defaultCurrency="CAD"
        usage={usage({ totalInCurrency: null })}
        latestRate={latest}
      />,
    );

    expect(screen.getByText('A transaction paid in EUR has no amount recorded in it')).toBeInTheDocument();
  });

  it('says there is no stored rate, and leaves the card out while the rates are unknown', () => {
    const { rerender } = render(
      <CurrencySummaryCards code="EUR" defaultCurrency="CAD" usage={usage()} latestRate={null} />,
    );
    expect(screen.getByText('No stored rates yet')).toBeInTheDocument();

    rerender(
      <CurrencySummaryCards code="EUR" defaultCurrency="CAD" usage={usage()} latestRate={undefined} />,
    );
    expect(screen.queryByText('Latest Rate')).not.toBeInTheDocument();
  });

  it('shows one total and no rate on the default currency page', () => {
    render(
      <CurrencySummaryCards
        code="CAD"
        defaultCurrency="CAD"
        usage={usage({ code: 'CAD', totalInCurrency: 12 })}
        latestRate={undefined}
      />,
    );

    expect(screen.getAllByText(/Total in CAD/)).toHaveLength(1);
    expect(screen.queryByText('Latest Rate')).not.toBeInTheDocument();
  });

  it('shows a known zero as a number', () => {
    render(
      <CurrencySummaryCards
        code="EUR"
        defaultCurrency="CAD"
        usage={usage({
          transactionCount: 0,
          firstTransactionDate: null,
          totalInCurrency: 0,
          totalInReportingCurrency: 0,
          knownReportingSubtotal: 0,
        })}
        latestRate={latest}
      />,
    );

    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });
});
