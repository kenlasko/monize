import { FX_RATE_DECIMALS, FX_RATE_DISPLAY_DECIMALS, roundFxRate } from '@/lib/format';
import type { StoredRate, TransactionRate } from '@/lib/exchange-rates';

/**
 * Where a rate on the currency detail page came from, as the reader filters
 * it: one of the two rate providers, one of their own transactions, or
 * anything else the table holds (a Money import, a row written before sources
 * were recorded).
 */
export const RATE_SOURCE_GROUPS = ['yahoo', 'frankfurter', 'transaction', 'other'] as const;
export type RateSourceGroup = (typeof RATE_SOURCE_GROUPS)[number];

export type RateSourceFilter = 'all' | RateSourceGroup;

/** The `source` a transaction-derived row carries; no provider writes it. */
export const TRANSACTION_RATE_SOURCE = 'transaction';

/**
 * The label key of a source slug, under `currencyDetail.sources`. The provider
 * slugs are the ones `exchange_rates.source` actually holds.
 */
export type RateSourceLabelKey =
  | 'yahooFinance'
  | 'yahooCrypto'
  | 'frankfurter'
  | 'frankfurterV2'
  | 'mnyImport'
  | 'transaction'
  | 'unknown';

export function rateSourceLabelKey(source: string | null): RateSourceLabelKey {
  switch (source) {
    case 'yahoo_finance':
      return 'yahooFinance';
    case 'yahoo_crypto':
      return 'yahooCrypto';
    case 'frankfurter':
      return 'frankfurter';
    case 'frankfurter_v2':
      return 'frankfurterV2';
    case 'mny_import':
      return 'mnyImport';
    case TRANSACTION_RATE_SOURCE:
      return 'transaction';
    default:
      return 'unknown';
  }
}

export function rateSourceGroup(source: string | null): RateSourceGroup {
  switch (source) {
    case 'yahoo_finance':
    case 'yahoo_crypto':
      return 'yahoo';
    // The v2 blend counts under the Frankfurter filter; its Source label tells
    // the two apart (docs/specs/frankfurter-v2-provider.md, decision 10).
    case 'frankfurter':
    case 'frankfurter_v2':
      return 'frankfurter';
    case TRANSACTION_RATE_SOURCE:
      return 'transaction';
    default:
      return 'other';
  }
}

/**
 * One row of the rate history: a stored provider observation, or a rate one
 * of the reader's own transactions settled at. Both are stated as reporting
 * currency units per 1 unit of the currency on the page. A provider row whose
 * stored value cannot be stated that way has `rate: null`, which renders as
 * unknown, never as 0 or 1.
 */
export interface RateHistoryRow {
  /** Unique across both kinds: a provider row per date, a transaction per id. */
  key: string;
  /** `YYYY-MM-DD`. */
  date: string;
  rate: number | null;
  /** Units of the currency per 1 reporting unit; `null` exactly when `rate` is. */
  inverseRate: number | null;
  source: string | null;
  group: RateSourceGroup;
  /** Set on a transaction-derived row only. */
  transaction?: Omit<TransactionRate, 'rateDate' | 'rate'>;
}

function inverseOf(rate: number | null): number | null {
  return rate !== null && rate > 0 ? roundFxRate(1 / rate) : null;
}

/**
 * The provider history and the transaction rates as one list, newest first; a
 * date holding both keeps both, the provider row first.
 */
export function buildRateHistoryRows(
  stored: readonly StoredRate[],
  transactionRates: readonly TransactionRate[],
): RateHistoryRow[] {
  const providerRows: RateHistoryRow[] = stored.map((row) => ({
    key: `provider:${row.rateDate}`,
    date: row.rateDate,
    rate: row.rate,
    inverseRate: inverseOf(row.rate),
    source: row.source,
    group: rateSourceGroup(row.source),
  }));
  const transactionRows: RateHistoryRow[] = transactionRates.map((row) => ({
    key: `transaction:${row.transactionId}`,
    date: row.rateDate,
    rate: row.rate,
    inverseRate: inverseOf(row.rate),
    source: TRANSACTION_RATE_SOURCE,
    group: 'transaction',
    transaction: {
      transactionId: row.transactionId,
      kind: row.kind,
      accountName: row.accountName,
      payeeName: row.payeeName,
      marketRate: row.marketRate,
    },
  }));
  return sortRateRows([...providerRows, ...transactionRows], 'date', 'desc', () => '');
}

/** How many rows each filter segment holds, `all` included. */
export function countRateSourceGroups(
  rows: readonly RateHistoryRow[],
): Record<RateSourceFilter, number> {
  const counts: Record<RateSourceFilter, number> = {
    all: rows.length,
    yahoo: 0,
    frankfurter: 0,
    transaction: 0,
    other: 0,
  };
  for (const row of rows) counts[row.group] += 1;
  return counts;
}

export function filterRateRows(
  rows: readonly RateHistoryRow[],
  filter: RateSourceFilter,
): RateHistoryRow[] {
  return filter === 'all' ? [...rows] : rows.filter((row) => row.group === filter);
}

export const RATE_SORT_FIELDS = ['date', 'rate', 'inverseRate', 'source'] as const;
export type RateSortField = (typeof RATE_SORT_FIELDS)[number];
export type RateSortDirection = 'asc' | 'desc';

/**
 * A sorted copy. An unknown rate sorts last in either direction, since it is
 * not smaller or larger than any rate. Ties fall back to the date, newest
 * first, then to the provider row before the transaction rows, so a page
 * boundary never moves between two renders of the same list.
 */
export function sortRateRows(
  rows: readonly RateHistoryRow[],
  field: RateSortField,
  direction: RateSortDirection,
  sourceLabel: (row: RateHistoryRow) => string,
): RateHistoryRow[] {
  const sign = direction === 'asc' ? 1 : -1;
  const tieBreak = (a: RateHistoryRow, b: RateHistoryRow) =>
    b.date.localeCompare(a.date) || a.key.localeCompare(b.key);
  return [...rows].sort((a, b) => {
    if (field === 'rate' || field === 'inverseRate') {
      const av = a[field];
      const bv = b[field];
      if (av === null && bv === null) return tieBreak(a, b);
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * sign || tieBreak(a, b);
    }
    const compared =
      field === 'date'
        ? a.date.localeCompare(b.date)
        : sourceLabel(a).localeCompare(sourceLabel(b));
    return compared * sign || tieBreak(a, b);
  });
}

/** The rows dated inside `[start, end]`, either bound empty for none, in their order. */
export function rateRowsInWindow(
  rows: readonly RateHistoryRow[],
  start: string,
  end: string,
): RateHistoryRow[] {
  return rows.filter((row) => (!start || row.date >= start) && (!end || row.date <= end));
}

/** How many rates a period holds and the dates they span; `null` dates when none. */
export interface RatePeriodSummary {
  count: number;
  firstDate: string | null;
  lastDate: string | null;
}

export function summarizeRatePeriod(rows: readonly RateHistoryRow[]): RatePeriodSummary {
  let firstDate: string | null = null;
  let lastDate: string | null = null;
  for (const row of rows) {
    if (firstDate === null || row.date < firstDate) firstDate = row.date;
    if (lastDate === null || row.date > lastDate) lastDate = row.date;
  }
  return { count: rows.length, firstDate, lastDate };
}

/**
 * How far the rates the reader's own transactions settled at sit from the
 * stored market rate for their dates.
 *
 * Each transaction's spread is `|settled - market| / market`, so a payment
 * made at a rate above the market's and a refund made below it both count as
 * the distance they are rather than cancelling out. A transaction with no
 * stored market rate for its date cannot be measured: it is counted apart
 * (`unmeasured`) and left out of the average, never measured against 1 or 0.
 * `averagePercent` is `null` when nothing could be measured.
 */
export interface RateSpreadSummary {
  /** Transactions measured against a market rate. */
  measured: number;
  /** Transactions with no stored market rate for their date. */
  unmeasured: number;
  /** The oldest date among them, `YYYY-MM-DD`, or `null` when there are none. */
  earliestUnmeasured: string | null;
  /** The mean spread as a percentage (1.5 is 1.5%), or `null`. */
  averagePercent: number | null;
}

export function summarizeRateSpread(rows: readonly RateHistoryRow[]): RateSpreadSummary {
  let measured = 0;
  let unmeasured = 0;
  let earliestUnmeasured: string | null = null;
  let total = 0;
  for (const row of rows) {
    if (!row.transaction || row.rate === null) continue;
    const market = row.transaction.marketRate;
    if (market === null || !(market > 0)) {
      unmeasured += 1;
      if (earliestUnmeasured === null || row.date < earliestUnmeasured) earliestUnmeasured = row.date;
      continue;
    }
    measured += 1;
    total += Math.abs(row.rate - market) / market;
  }
  return {
    measured,
    unmeasured,
    earliestUnmeasured,
    averagePercent: measured === 0 ? null : (total / measured) * 100,
  };
}

/** A point on the rate chart: `t` is the date's local-midnight time. */
export interface RateChartPoint {
  t: number;
  date: string;
  rate: number;
}

/** A transaction rate on the chart, with what its tooltip names. */
export interface TransactionRateChartPoint extends RateChartPoint {
  transactionId: string;
  kind: TransactionRate['kind'];
  accountName: string;
  payeeName: string | null;
}

export interface RateChartSeries {
  /** The provider line, oldest first; a day with no usable rate is absent. */
  provider: RateChartPoint[];
  /** The reader's own settled rates, oldest first, drawn as highlighted dots. */
  transactions: TransactionRateChartPoint[];
}

function chartTime(date: string): number {
  return new Date(`${date}T00:00:00`).getTime();
}

/**
 * The chart's two series over `[start, end]` (either bound empty for none).
 * The line is every provider observation in the window; the dots are the
 * transaction rates in it. An unknown rate is left out rather than drawn as 0.
 */
export function buildRateChartSeries(
  rows: readonly RateHistoryRow[],
  start: string,
  end: string,
): RateChartSeries {
  const inWindow = rateRowsInWindow(rows, start, end)
    .filter((row) => row.rate !== null)
    .sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  const provider: RateChartPoint[] = [];
  const transactions: TransactionRateChartPoint[] = [];
  for (const row of inWindow) {
    const point = { t: chartTime(row.date), date: row.date, rate: row.rate as number };
    if (row.transaction) {
      transactions.push({
        ...point,
        transactionId: row.transaction.transactionId,
        kind: row.transaction.kind,
        accountName: row.transaction.accountName,
        payeeName: row.transaction.payeeName,
      });
    } else {
      provider.push(point);
    }
  }
  return { provider, transactions };
}

/** The oldest date any row holds, for the chart's pan bound; `''` when none. */
export function earliestRateDate(rows: readonly RateHistoryRow[]): string {
  let earliest = '';
  for (const row of rows) {
    if (!earliest || row.date < earliest) earliest = row.date;
  }
  return earliest;
}

/**
 * The places a rate is shown at: the app's six for any rate of 1 or more, and
 * for a smaller one as many as keep six significant digits, up to the ten
 * the rate column stores. A coin's inverse rate (0.0000069 BTC per CAD) read
 * as 0.000007 at six places, which says almost nothing about it.
 */
export function rateDisplayDecimals(rate: number): number {
  if (!(rate > 0) || rate >= 1) return FX_RATE_DISPLAY_DECIMALS;
  const leadingZeros = Math.ceil(-Math.log10(rate)) - 1;
  return Math.min(FX_RATE_DECIMALS, FX_RATE_DISPLAY_DECIMALS + leadingZeros);
}

/**
 * The places a rate axis needs to tell its ticks apart: none for a six-digit
 * coin price, two for tens, four around 1, and more below.
 */
export function rateAxisDecimals(maxRate: number): number {
  if (maxRate >= 1000) return 0;
  if (maxRate >= 10) return 2;
  if (maxRate >= 1) return 4;
  return rateDisplayDecimals(maxRate);
}
