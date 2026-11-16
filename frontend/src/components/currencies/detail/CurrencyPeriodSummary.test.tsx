import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { buildRateHistoryRows } from '@/lib/currency-detail';
import type { TransactionRate } from '@/lib/exchange-rates';
import { CurrencyPeriodSummary } from './CurrencyPeriodSummary';

const stored = [{ rateDate: '2026-03-02', rate: 1.5, source: 'frankfurter', inverted: false }];

const transaction = (id: string, rate: number, marketRate: number | null): TransactionRate => ({
  transactionId: id,
  rateDate: '2026-03-02',
  rate,
  kind: 'foreignEntry',
  accountName: 'CAD Chequing',
  payeeName: null,
  marketRate,
});

const spreadCard = () => screen.getByRole('article', { name: 'Average Spread' });

describe('CurrencyPeriodSummary', () => {
  it('averages the spread over the measured transactions', () => {
    render(
      <CurrencyPeriodSummary
        code="EUR"
        defaultCurrency="CAD"
        rows={buildRateHistoryRows(stored, [transaction('a', 1.53, 1.5), transaction('b', 1.44, 1.5)])}
      />,
    );

    expect(spreadCard()).toHaveTextContent('3.00%');
    expect(spreadCard()).toHaveTextContent(
      'How far your 2 transactions were from the stored rate for the same date, higher or lower',
    );
  });

  it('names the transactions it could not measure and how to fetch their rate', () => {
    render(
      <CurrencyPeriodSummary
        code="EUR"
        defaultCurrency="CAD"
        rows={buildRateHistoryRows(stored, [transaction('a', 1.53, 1.5), transaction('b', 1.44, null)])}
      />,
    );

    expect(spreadCard()).toHaveTextContent('2.00%');
    // The exact pair and the oldest date it is missing on, then where to get it.
    expect(spreadCard()).toHaveTextContent(
      '1 more has no stored EUR->CAD rate within 45 days before the date, the earliest on 03/02/2026',
    );
    expect(spreadCard()).toHaveTextContent('Fill gaps in rate history above fetches what the provider holds.');
  });

  it('withholds the average when no transaction could be measured, and says why', () => {
    render(<CurrencyPeriodSummary code="EUR" defaultCurrency="CAD" rows={buildRateHistoryRows(stored, [transaction('a', 1.53, null)])} />);

    expect(spreadCard()).toHaveTextContent('—');
    expect(spreadCard()).toHaveTextContent(
      '1 transaction has no stored EUR->CAD rate within 45 days before the date to compare with, the earliest on 03/02/2026.',
    );
    expect(spreadCard()).not.toHaveTextContent('0.00%');
  });

  it('says a period holds no rates rather than spanning no dates', () => {
    render(<CurrencyPeriodSummary code="EUR" defaultCurrency="CAD" rows={[]} />);

    const rates = screen.getByRole('article', { name: 'Rates in Period' });
    expect(rates).toHaveTextContent('0');
    expect(rates).toHaveTextContent('No rates in this period');
    expect(spreadCard()).toHaveTextContent('No transactions with an exchange rate in this period');
  });
});
