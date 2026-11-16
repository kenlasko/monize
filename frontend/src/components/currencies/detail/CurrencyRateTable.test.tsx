import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { exportToCsv } from '@/lib/csv-export';
import { buildRateHistoryRows } from '@/lib/currency-detail';
import type { StoredRate, TransactionRate } from '@/lib/exchange-rates';
import { CurrencyRateTable } from './CurrencyRateTable';

vi.mock('@/lib/csv-export', () => ({
  exportToCsv: vi.fn(),
}));

/** 60 Frankfurter days, newest first, at 1.5000 + 0.001 per day. */
const stored: StoredRate[] = Array.from({ length: 60 }, (_, i) => {
  const day = new Date(Date.UTC(2026, 2, 31 - i)).toISOString().slice(0, 10);
  return { rateDate: day, rate: 1.5 + (60 - i) / 1000, source: 'frankfurter', inverted: false };
});

const transactionRates: TransactionRate[] = [
  {
    transactionId: 'tx-1',
    rateDate: '2026-03-15',
    rate: 1.25,
    kind: 'foreignEntry',
    accountName: 'CAD Chequing',
    payeeName: 'Hotel',
  },
  {
    transactionId: 'tx-2',
    rateDate: '2026-03-10',
    rate: 1.75,
    kind: 'transfer',
    accountName: 'Euro Chequing',
    // A transfer leg's payee names the transfer, which the kind already says.
    payeeName: 'Transfer to CAD Chequing',
  },
];

const rows = buildRateHistoryRows(
  [...stored, { rateDate: '2025-12-31', rate: 1.4, source: 'yahoo_finance', inverted: false }],
  transactionRates,
);

const bodyRows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1);

describe('CurrencyRateTable', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(exportToCsv).mockClear();
  });

  it('pages the rows, newest first, with the pager above and below the table', () => {
    render(<CurrencyRateTable code="EUR" defaultCurrency="CAD" rows={rows} />);

    expect(bodyRows()).toHaveLength(50);
    expect(within(bodyRows()[0]).getByText('1.560000')).toBeInTheDocument();
    // "Showing 1-50 of 63" at both ends.
    expect(screen.getAllByText(/63/).length).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getAllByTitle('Next page')[0]);
    expect(bodyRows()).toHaveLength(13);
  });

  it('filters by source with a count on each segment, and back to page 1', () => {
    render(<CurrencyRateTable code="EUR" defaultCurrency="CAD" rows={rows} />);

    fireEvent.click(screen.getAllByTitle('Next page')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Transactions (2)' }));

    expect(screen.getByRole('button', { name: 'Transactions (2)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(bodyRows()).toHaveLength(2);
    expect(screen.getByText('Foreign currency payment to Hotel in CAD Chequing')).toBeInTheDocument();
    expect(screen.getByText('Transfer in Euro Chequing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yahoo (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Frankfurter (60)' })).toBeInTheDocument();
    // Nothing is in Other, so it is not offered.
    expect(screen.queryByRole('button', { name: /Other/ })).not.toBeInTheDocument();
  });

  it('sorts by any column, and remembers the choice', () => {
    const { unmount } = render(<CurrencyRateTable code="EUR" defaultCurrency="CAD" rows={rows} />);

    fireEvent.click(screen.getByRole('button', { name: /CAD per EUR/ }));
    expect(within(bodyRows()[0]).getByText('1.250000')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /CAD per EUR/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );

    fireEvent.click(screen.getByRole('button', { name: /CAD per EUR/ }));
    expect(within(bodyRows()[0]).getByText('1.750000')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Source/ }));
    expect(within(bodyRows()[0]).getByText('Frankfurter (ECB)')).toBeInTheDocument();

    unmount();
    render(<CurrencyRateTable code="EUR" defaultCurrency="CAD" rows={rows} />);
    expect(screen.getByRole('columnheader', { name: /^Source/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
  });

  it('exports every filtered row, not only the page on screen', () => {
    render(<CurrencyRateTable code="EUR" defaultCurrency="CAD" rows={rows} />);

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect(exportToCsv).toHaveBeenCalledTimes(1);
    const [filename, headers, data] = vi.mocked(exportToCsv).mock.calls[0];
    expect(filename).toBe('EUR-CAD-exchange-rates');
    expect(headers).toEqual(['Date', 'CAD per EUR', 'EUR per CAD', 'Source', 'Details']);
    expect(data).toHaveLength(63);
    expect(data).toContainEqual([
      '2026-03-15',
      1.25,
      0.8,
      'Transaction',
      'Foreign currency payment to Hotel in CAD Chequing',
    ]);
  });

  it('shows a small inverse rate to six significant digits', () => {
    const coin = buildRateHistoryRows(
      [{ rateDate: '2026-01-01', rate: 144319.063489, source: 'yahoo_crypto', inverted: false }],
      [],
    );
    render(<CurrencyRateTable code="BTC" defaultCurrency="CAD" rows={coin} />);

    expect(screen.getByText('144,319.063489')).toBeInTheDocument();
    expect(screen.getByText('0.0000069291')).toBeInTheDocument();
  });

  it('shows an unknown rate as unknown, never as zero', () => {
    const withUnknown = buildRateHistoryRows(
      [{ rateDate: '2026-01-01', rate: null, source: null, inverted: true }],
      [],
    );
    render(<CurrencyRateTable code="EUR" defaultCurrency="CAD" rows={withUnknown} />);

    expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: 'Other (1)' })).toBeInTheDocument();
  });

  it('says so when there are no rates, and names the truncation notes', () => {
    render(
      <CurrencyRateTable
        code="EUR"
        defaultCurrency="CAD"
        rows={[]}
        notes={['Showing the 2,000 most recent stored rates; older ones are not listed.']}
      />,
    );

    expect(screen.getByText('No exchange rates yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(
      screen.getByText('Showing the 2,000 most recent stored rates; older ones are not listed.'),
    ).toBeInTheDocument();
  });
});
