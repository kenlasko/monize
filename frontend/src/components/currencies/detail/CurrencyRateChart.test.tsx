import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { buildRateHistoryRows } from '@/lib/currency-detail';
import { CurrencyRateChart } from './CurrencyRateChart';

const rows = buildRateHistoryRows(
  [
    { rateDate: '2020-03-02', rate: 1.5, source: 'frankfurter', inverted: false },
    { rateDate: '2020-03-01', rate: 1.4, source: 'frankfurter', inverted: false },
  ],
  [
    {
      transactionId: 'tx-1',
      rateDate: '2020-03-02',
      rate: 1.25,
      kind: 'foreignEntry',
      accountName: 'CAD Chequing',
      payeeName: 'Hotel',
    },
  ],
);

describe('CurrencyRateChart', () => {
  beforeEach(() => localStorage.clear());

  it('names the direction and offers the window presets', () => {
    render(<CurrencyRateChart code="EUR" defaultCurrency="CAD" rows={rows} />);

    expect(screen.getByRole('heading', { name: 'Exchange Rate' })).toBeInTheDocument();
    expect(screen.getByText('CAD per 1 EUR')).toBeInTheDocument();
    expect(screen.getByText('Rate provider')).toBeInTheDocument();
  });

  it('says when the window holds no rate, and counts the highlighted transactions it shows', () => {
    render(<CurrencyRateChart code="EUR" defaultCurrency="CAD" rows={rows} />);

    // The default year window ends today, long after the fixture's dates.
    expect(screen.getByText('No exchange rates in this period')).toBeInTheDocument();
    expect(screen.getByText('Your transactions (0)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^All$/ }));
    expect(screen.queryByText('No exchange rates in this period')).not.toBeInTheDocument();
    expect(screen.getByText('Your transactions (1)')).toBeInTheDocument();
  });
});
