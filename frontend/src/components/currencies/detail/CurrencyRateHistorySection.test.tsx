import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { buildRateHistoryRows } from '@/lib/currency-detail';
import { CurrencyRateHistorySection } from './CurrencyRateHistorySection';

// Years before the default one-year window, which ends today.
const rows = buildRateHistoryRows(
  [
    { rateDate: '2019-03-02', rate: 1.5, source: 'frankfurter', inverted: false },
    { rateDate: '2015-03-01', rate: 1.4, source: 'frankfurter', inverted: false },
  ],
  [
    {
      transactionId: 'tx-1',
      rateDate: '2019-03-02',
      rate: 1.53,
      kind: 'foreignEntry',
      accountName: 'CAD Chequing',
      payeeName: 'Hotel',
      marketRate: 1.5,
    },
  ],
);

describe('CurrencyRateHistorySection', () => {
  beforeEach(() => localStorage.clear());

  it('narrows the chart, the period figures and the table to one period', () => {
    render(<CurrencyRateHistorySection code="EUR" defaultCurrency="CAD" rows={rows} />);

    expect(screen.getByText('No rates in this period')).toBeInTheDocument();
    expect(
      screen.getByText('No transactions with an exchange rate in this period'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No exchange rates in this period' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^All$/ }));

    // Every row, back to 2015: the listing is not cut off at any year.
    expect(screen.getByRole('button', { name: 'All (3)' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Rates in Period' })).toHaveTextContent('3');
    expect(screen.getByRole('article', { name: 'Average Spread' })).toHaveTextContent('2.00%');
    expect(screen.getByText('Your transactions (1)')).toBeInTheDocument();
  });

  it('remembers the period per currency', () => {
    localStorage.setItem('currencyDetail:range:EUR', JSON.stringify({ dateRange: 'all' }));

    render(<CurrencyRateHistorySection code="EUR" defaultCurrency="CAD" rows={rows} />);

    expect(screen.getByRole('button', { name: 'All (3)' })).toBeInTheDocument();
  });

  it('holds the places of the chart and the table while the history loads', () => {
    render(<CurrencyRateHistorySection code="EUR" defaultCurrency="CAD" rows={null} />);

    expect(screen.getByText('Loading exchange rates...')).toBeInTheDocument();
    expect(screen.queryByText('Rates in Period')).not.toBeInTheDocument();
  });
});
