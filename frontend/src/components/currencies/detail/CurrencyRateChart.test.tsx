import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { buildRateHistoryRows, rateRowsInWindow } from '@/lib/currency-detail';
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
