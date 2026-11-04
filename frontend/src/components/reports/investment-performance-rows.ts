import type { HoldingWithMarketValue } from '@/types/investment';
import type { SecurityPeriodResult, SecurityPeriodResults } from '@/types/net-worth';
import { aggregateHoldingsBySecurity } from '@/lib/aggregate-holdings';
import { compareValues } from '@/hooks/useSortableTable';

export type HoldingsSortField =
  | 'symbol'
  | 'quantity'
  | 'averageCost'
  | 'currentPrice'
  | 'marketValue'
  | 'gainLoss'
  | 'gainLossPercent'
  | 'priceChangePercent';

/**
 * One line of the Investment Performance report's holdings table.
 *
 * The point-in-time columns (shares, average cost, price, market value) are
 * today's holdings, from the portfolio summary. The period columns are the
 * server's split of the invested period result by security
 * (`docs/specs/investment-performance-report-period.md`), and are never
 * derived here.
 */
export interface PerformanceHoldingRow {
  securityId: string;
  /** Null only when the server could not name a security it measured. */
  symbol: string | null;
  name: string | null;
  /** The currency the point-in-time columns are in. */
  currencyCode: string;
  quantity: number;
  averageCost: number | null;
  currentPrice: number | null;
  marketValue: number | null;
  /** Per-account point-in-time rows; empty for a position closed in the window. */
  accountBreakdowns: HoldingWithMarketValue[];
  /** The window's figures; null while they load, after a failure, or for a security they omit. */
  period: SecurityPeriodResult | null;
  /** Sold out inside the window: measured over it, but held no longer. */
  closed: boolean;
}

/**
 * Today's holdings, one per security, each beside its figures for the window,
 * followed by every security the window measured that is no longer held. A
 * position sold inside the window is a row, so the rows add up to the
 * period's gain on the cards above them.
 */
export function buildPerformanceRows(
  holdings: HoldingWithMarketValue[],
  results: SecurityPeriodResults | null,
): PerformanceHoldingRow[] {
  const bySecurity = new Map(
    (results?.securities ?? []).map((row) => [row.securityId, row]),
  );
  const held = aggregateHoldingsBySecurity(holdings).map(
    (holding): PerformanceHoldingRow => ({
      securityId: holding.securityId,
      symbol: holding.symbol,
      name: holding.name,
      currencyCode: holding.currencyCode,
      quantity: holding.quantity,
      averageCost: holding.averageCost,
      currentPrice: holding.currentPrice,
      marketValue: holding.marketValue,
      accountBreakdowns: holding.accountBreakdowns,
      period: bySecurity.get(holding.securityId) ?? null,
      closed: false,
    }),
  );
  const heldIds = new Set(held.map((row) => row.securityId));
  const closed = (results?.securities ?? [])
    .filter((row) => !heldIds.has(row.securityId))
    .map(
      (row): PerformanceHoldingRow => ({
        securityId: row.securityId,
        symbol: row.symbol,
        name: row.name,
        currencyCode: row.securityCurrency ?? '',
        quantity: row.endQuantity,
        // No shares are held, so there is no cost to average.
        averageCost: null,
        currentPrice: row.endClose,
        // Holding nothing is worth nothing: a known zero, not an unknown.
        marketValue: row.endQuantity === 0 ? 0 : null,
        accountBreakdowns: [],
        period: row,
        closed: true,
      }),
    );
  return [...held, ...closed];
}

function sortValue(row: PerformanceHoldingRow, field: HoldingsSortField): unknown {
  switch (field) {
    case 'symbol':
      return row.symbol;
    case 'quantity':
      return row.quantity;
    case 'averageCost':
      return row.averageCost;
    case 'currentPrice':
      return row.currentPrice;
    case 'marketValue':
      return row.marketValue;
    case 'gainLoss':
      return row.period?.investmentPnl ?? null;
    case 'gainLossPercent':
      return row.period?.investmentReturnPercent ?? null;
    case 'priceChangePercent':
      return row.period?.priceChangePercent ?? null;
  }
}

/** The rows in the table's order; an unknown sorts last either way. */
export function sortPerformanceRows(
  rows: readonly PerformanceHoldingRow[],
  field: HoldingsSortField,
  direction: 'asc' | 'desc',
): PerformanceHoldingRow[] {
  return [...rows].sort((a, b) => {
    const left = sortValue(a, field);
    const right = sortValue(b, field);
    if (left == null || right == null) return compareValues(left, right);
    const comparison = compareValues(left, right);
    return direction === 'asc' ? comparison : -comparison;
  });
}

/** The symbols of the rows whose period figure is withheld for `matches`. */
export function symbolsWhere(
  rows: readonly PerformanceHoldingRow[],
  matches: (period: SecurityPeriodResult) => boolean,
): string[] {
  return rows
    .filter((row) => row.period !== null && matches(row.period))
    .map((row) => row.symbol ?? row.securityId);
}
