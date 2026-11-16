import { describe, it, expect } from 'vitest';
import {
  buildRateChartSeries,
  buildRateHistoryRows,
  countRateSourceGroups,
  earliestRateDate,
  filterRateRows,
  rateAxisDecimals,
  rateDisplayDecimals,
  rateSourceGroup,
  rateRowsInWindow,
  rateSourceLabelKey,
  sortRateRows,
  summarizeRatePeriod,
  summarizeRateSpread,
  type RateHistoryRow,
} from './currency-detail';
import type { StoredRate, TransactionRate } from './exchange-rates';

const stored: StoredRate[] = [
  { rateDate: '2026-03-03', rate: 1.6, source: 'frankfurter', inverted: false },
  { rateDate: '2026-03-02', rate: null, source: 'yahoo_finance', inverted: true },
  { rateDate: '2026-03-01', rate: 1.5, source: 'yahoo_finance', inverted: false },
  { rateDate: '2026-02-01', rate: 1.4, source: 'mny_import', inverted: false },
];

const transactionRates: TransactionRate[] = [
  {
    transactionId: 'tx-2',
    rateDate: '2026-03-03',
    rate: 1.25,
    kind: 'transfer',
    accountName: 'Euro Chequing',
    payeeName: null,
    marketRate: null,
  },
  {
    transactionId: 'tx-1',
    rateDate: '2026-03-01',
    rate: 2,
    kind: 'foreignEntry',
    accountName: 'CAD Chequing',
    payeeName: 'Hotel',
    marketRate: 1.6,
  },
];

const label = (row: RateHistoryRow) => row.source ?? '';

describe('rate sources', () => {
  it('groups every provider slug, and anything unknown as other', () => {
    expect(rateSourceGroup('yahoo_finance')).toBe('yahoo');
    expect(rateSourceGroup('yahoo_crypto')).toBe('yahoo');
    expect(rateSourceGroup('frankfurter')).toBe('frankfurter');
    // The v2 blend shares the Frankfurter filter; its label tells them apart.
    expect(rateSourceGroup('frankfurter_v2')).toBe('frankfurter');
    expect(rateSourceGroup('transaction')).toBe('transaction');
    expect(rateSourceGroup('mny_import')).toBe('other');
    expect(rateSourceGroup(null)).toBe('other');
  });

  it('names each slug, and an unknown one as unknown', () => {
    expect(rateSourceLabelKey('yahoo_crypto')).toBe('yahooCrypto');
    expect(rateSourceLabelKey('mny_import')).toBe('mnyImport');
    expect(rateSourceLabelKey('frankfurter')).toBe('frankfurter');
    expect(rateSourceLabelKey('frankfurter_v2')).toBe('frankfurterV2');
    expect(rateSourceLabelKey('transaction')).toBe('transaction');
    expect(rateSourceLabelKey('test')).toBe('unknown');
  });
});

describe('buildRateHistoryRows', () => {
  const rows = buildRateHistoryRows(stored, transactionRates);

  it('lists both kinds newest first, a provider row before a transaction on the same date', () => {
    expect(rows.map((row) => row.key)).toEqual([
      'provider:2026-03-03',
      'transaction:tx-2',
      'provider:2026-03-02',
      'provider:2026-03-01',
      'transaction:tx-1',
      'provider:2026-02-01',
    ]);
  });

  it('states the inverse, and keeps an unknown rate unknown in both directions', () => {
    expect(rows[0]).toMatchObject({ rate: 1.6, inverseRate: 0.625, group: 'frankfurter' });
    expect(rows[2]).toMatchObject({ rate: null, inverseRate: null });
    expect(rows[1]).toMatchObject({
      rate: 1.25,
      inverseRate: 0.8,
      source: 'transaction',
      group: 'transaction',
      transaction: { transactionId: 'tx-2', kind: 'transfer', accountName: 'Euro Chequing' },
    });
  });

  it('counts each filter segment, and filters to one', () => {
    expect(countRateSourceGroups(rows)).toEqual({
      all: 6,
      yahoo: 2,
      frankfurter: 1,
      transaction: 2,
      other: 1,
    });
    expect(filterRateRows(rows, 'transaction').map((row) => row.key)).toEqual([
      'transaction:tx-2',
      'transaction:tx-1',
    ]);
    expect(filterRateRows(rows, 'all')).toHaveLength(6);
  });

  it('finds the oldest date', () => {
    expect(earliestRateDate(rows)).toBe('2026-02-01');
    expect(earliestRateDate([])).toBe('');
  });
});

describe('sortRateRows', () => {
  const rows = buildRateHistoryRows(stored, transactionRates);

  it('sorts by rate either way, an unknown rate last both times', () => {
    expect(sortRateRows(rows, 'rate', 'asc', label).map((row) => row.rate)).toEqual([
      1.25, 1.4, 1.5, 1.6, 2, null,
    ]);
    expect(sortRateRows(rows, 'rate', 'desc', label).map((row) => row.rate)).toEqual([
      2, 1.6, 1.5, 1.4, 1.25, null,
    ]);
  });

  it('sorts by the inverse rate', () => {
    expect(sortRateRows(rows, 'inverseRate', 'asc', label).map((row) => row.rate)).toEqual([
      2, 1.6, 1.5, 1.4, 1.25, null,
    ]);
  });

  it('sorts by date oldest first, and by source label with the newest first among equals', () => {
    expect(sortRateRows(rows, 'date', 'asc', label)[0].date).toBe('2026-02-01');
    expect(sortRateRows(rows, 'source', 'asc', label).map((row) => row.key)).toEqual([
      'provider:2026-03-03',
      'provider:2026-02-01',
      'transaction:tx-2',
      'transaction:tx-1',
      'provider:2026-03-02',
      'provider:2026-03-01',
    ]);
  });

  it('does not reorder its input', () => {
    const before = rows.map((row) => row.key);
    sortRateRows(rows, 'rate', 'asc', label);
    expect(rows.map((row) => row.key)).toEqual(before);
  });
});

describe('buildRateChartSeries', () => {
  const rows = buildRateHistoryRows(stored, transactionRates);

  it('splits the window into the provider line and the transaction dots, oldest first', () => {
    const series = buildRateChartSeries(rows, '2026-03-01', '2026-03-31');

    expect(series.provider.map((point) => [point.date, point.rate])).toEqual([
      ['2026-03-01', 1.5],
      ['2026-03-03', 1.6],
    ]);
    expect(series.transactions.map((point) => [point.date, point.rate, point.payeeName])).toEqual([
      ['2026-03-01', 2, 'Hotel'],
      ['2026-03-03', 1.25, null],
    ]);
  });

  it('leaves an unknown rate off the chart rather than drawing it as zero', () => {
    const series = buildRateChartSeries(rows, '', '');
    expect(series.provider.map((point) => point.date)).not.toContain('2026-03-02');
    expect(series.provider).toHaveLength(3);
  });
});

describe('rate precision', () => {
  it('keeps six places from 1 up, and six significant digits below it', () => {
    expect(rateDisplayDecimals(144319.063489)).toBe(6);
    expect(rateDisplayDecimals(1.6)).toBe(6);
    expect(rateDisplayDecimals(0.625)).toBe(6);
    expect(rateDisplayDecimals(0.0092)).toBe(8);
    // A coin's inverse: 0.0000069 has five zeros after the point.
    expect(rateDisplayDecimals(0.0000069)).toBe(10);
    expect(rateDisplayDecimals(0)).toBe(6);
  });

  it('gives the axis as many places as its scale needs', () => {
    expect(rateAxisDecimals(148500)).toBe(0);
    expect(rateAxisDecimals(95.5)).toBe(2);
    expect(rateAxisDecimals(1.6)).toBe(4);
    expect(rateAxisDecimals(0.0092)).toBe(8);
  });
});

describe('the selected period', () => {
  const rows = buildRateHistoryRows(stored, transactionRates);

  it('keeps the rows dated inside it, either bound open', () => {
    expect(rateRowsInWindow(rows, '2026-03-01', '2026-03-02').map((row) => row.key)).toEqual([
      'provider:2026-03-02',
      'provider:2026-03-01',
      'transaction:tx-1',
    ]);
    expect(rateRowsInWindow(rows, '', '')).toHaveLength(rows.length);
    expect(rateRowsInWindow(rows, '2026-03-03', '')).toHaveLength(2);
  });

  it('counts its rates and the dates they span, and none as no dates', () => {
    expect(summarizeRatePeriod(rows)).toEqual({
      count: 6,
      firstDate: '2026-02-01',
      lastDate: '2026-03-03',
    });
    expect(summarizeRatePeriod([])).toEqual({ count: 0, firstDate: null, lastDate: null });
  });
});

describe('summarizeRateSpread', () => {
  const transaction = (id: string, rate: number, marketRate: number | null): TransactionRate => ({
    transactionId: id,
    rateDate: '2026-03-01',
    rate,
    kind: 'foreignEntry',
    accountName: 'CAD Chequing',
    payeeName: null,
    marketRate,
  });

  it('averages each transaction’s distance from the market rate, above or below it', () => {
    const rows = buildRateHistoryRows(stored, [
      transaction('above', 1.02, 1),
      transaction('below', 0.97, 1),
    ]);

    const spread = summarizeRateSpread(rows);

    // 2% above and 3% below are 2.5% apart on average, not -0.5%.
    expect(spread.measured).toBe(2);
    expect(spread.unmeasured).toBe(0);
    expect(spread.earliestUnmeasured).toBeNull();
    expect(spread.averagePercent).toBeCloseTo(2.5, 10);
  });

  it('leaves out a transaction with no market rate for its date, and counts it apart', () => {
    const spread = summarizeRateSpread(buildRateHistoryRows(stored, transactionRates));

    // tx-1 settled at 2 against 1.6; tx-2 has no stored rate for its date.
    expect(spread).toMatchObject({ measured: 1, unmeasured: 1, earliestUnmeasured: '2026-03-03' });
    expect(spread.averagePercent).toBeCloseTo(25, 10);
  });

  it('has no average when nothing could be measured, rather than a zero spread', () => {
    expect(
      summarizeRateSpread(buildRateHistoryRows(stored, [transaction('a', 1.5, null)])),
    ).toEqual({ measured: 0, unmeasured: 1, earliestUnmeasured: '2026-03-01', averagePercent: null });
    expect(summarizeRateSpread(buildRateHistoryRows(stored, []))).toEqual({
      measured: 0,
      unmeasured: 0,
      earliestUnmeasured: null,
      averagePercent: null,
    });
  });
});
