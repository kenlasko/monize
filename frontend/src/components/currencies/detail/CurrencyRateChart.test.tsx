import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { buildRateHistoryRows, rateRowsInWindow } from '@/lib/currency-detail';
import { CurrencyRateChart, chartDays } from './CurrencyRateChart';

const txPoint = (id: string, date: string, rate: number) => ({
  transactionId: id,
  date,
  t: new Date(`${date}T00:00:00`).getTime(),
  rate,
  kind: 'foreignEntry' as const,
  accountName: 'CAD Chequing',
  payeeName: null,
  marketRate: null,
});

describe('chartDays', () => {
  it('gathers several transaction rates on one day when no provider rate is in the window', () => {
    const days = chartDays(
      [],
      [
        txPoint('a', '2020-03-01', 1.2),
        txPoint('b', '2020-03-01', 1.3),
        txPoint('c', '2020-03-02', 1.4),
      ] as never,
    );
    expect(days.map((d) => [d.date, d.rate, d.transactions.map((p) => p.transactionId)])).toEqual([
      ['2020-03-01', null, ['a', 'b']],
      ['2020-03-02', null, ['c']],
    ]);
  });

  it('hangs each transaction rate on the provider day on or before it', () => {
    const provider = [
      { t: 1, date: '2020-03-01', rate: 1.4 },
      { t: 2, date: '2020-03-03', rate: 1.5 },
    ];
    const days = chartDays(
      provider as never,
      [
        txPoint('a', '2020-03-01', 1.2),
        txPoint('b', '2020-03-02', 1.3),
        txPoint('c', '2020-03-04', 1.6),
      ] as never,
    );
    expect(days.map((d) => d.transactions.map((p) => p.transactionId))).toEqual([['a', 'b'], ['c']]);
    // The provider rows themselves are not changed.
    expect(provider[0]).not.toHaveProperty('transactions');
  });
});

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
      marketRate: 1.5,
    },
  ],
);

const renderChart = (props: Partial<Parameters<typeof CurrencyRateChart>[0]> = {}) =>
  render(
    <CurrencyRateChart
      code="EUR"
      defaultCurrency="CAD"
      rows={rows}
      dateRange="all"
      onDateRangeChange={vi.fn()}
      {...props}
    />,
  );

describe('CurrencyRateChart', () => {
  it('names the direction and offers the window presets', () => {
    renderChart();

    expect(screen.getByRole('heading', { name: 'Exchange Rate' })).toBeInTheDocument();
    expect(screen.getByText('CAD per 1 EUR')).toBeInTheDocument();
    expect(screen.getByText('Rate provider')).toBeInTheDocument();
  });

  it('says when the window holds no rate, and counts the highlighted transactions it shows', () => {
    const { rerender } = renderChart({
      dateRange: '1y',
      rows: rateRowsInWindow(rows, '2025-01-01', '2025-12-31'),
    });

    expect(screen.getByText('No exchange rates in this period')).toBeInTheDocument();
    expect(screen.getByText('Your transactions (0)')).toBeInTheDocument();

    rerender(
      <CurrencyRateChart
        code="EUR"
        defaultCurrency="CAD"
        rows={rows}
        dateRange="all"
        onDateRangeChange={vi.fn()}
      />,
    );
    expect(screen.queryByText('No exchange rates in this period')).not.toBeInTheDocument();
    expect(screen.getByText('Your transactions (1)')).toBeInTheDocument();
  });

  it('hands a chosen preset to the section that owns the period', () => {
    const onDateRangeChange = vi.fn();
    renderChart({ dateRange: '1y', onDateRangeChange });

    fireEvent.click(screen.getByRole('button', { name: /^All$/ }));

    expect(onDateRangeChange).toHaveBeenCalledWith('all');
  });
});
