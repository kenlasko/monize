import { chartColors, chartSeriesColor } from '@/lib/chart-colors';
import { periodResultUnknownReason } from '@/components/investments/portfolio-period-result';
import { parseLocalDate } from '@/lib/utils';
import type {
  AccountTwrSeries,
  PeriodResultReason,
  PortfolioTwrSeries,
  PortfolioTwrSeriesByAccount,
  TwrSeriesPoint,
} from '@/types/net-worth';

/** The key of the one line in the portfolio grouping. */
export const PORTFOLIO_RETURN_KEY = 'portfolio';

/** One drawn line. */
export interface ReturnLine {
  key: string;
  label: string;
  color: string;
  /** The combined portfolio is drawn heavier than any one account's line. */
  heavy: boolean;
}

/** One merged row: a timestamp plus each line's percent return (by key). */
export interface ReturnRow {
  ts: number;
  [lineKey: string]: number | null;
}

/** A series the server withheld, and why, in the words a reader can act on. */
export interface WithheldReturnLine {
  key: string;
  label: string;
  cause: 'noPrice' | 'displayFx' | 'noBaseline' | 'noHistory';
}

export interface ReturnView {
  rows: ReturnRow[];
  lines: ReturnLine[];
  withheld: WithheldReturnLine[];
}

/**
 * A scope or window with no valued day at all (`noValueSeries`): no history to
 * chart, which is not the same as a history with nothing invested in it.
 */
function hasNoHistory(reasons: readonly PeriodResultReason[]): boolean {
  return reasons.includes('noValueSeries');
}

/** `noCashBalance` is the account result's cause; this measure reads no cash. */
function causeOf(reasons: readonly PeriodResultReason[]): WithheldReturnLine['cause'] {
  if (hasNoHistory(reasons)) return 'noHistory';
  const cause = periodResultUnknownReason(reasons);
  return cause === 'noCashBalance' ? 'noBaseline' : cause;
}

/**
 * Merge series that share a window into the rows Recharts consumes.
 *
 * Presentation only: the arithmetic is the server's, and a withheld series
 * contributes no line (`points` is empty and `complete` false), never a flat
 * line at zero that reads as a portfolio that did nothing. A date a series has
 * no point for stays `null`, a break rather than a bridge.
 */
function mergeRows(
  drawn: ReadonlyArray<{ key: string; points: readonly TwrSeriesPoint[] }>,
): ReturnRow[] {
  const byDate = new Map<string, ReturnRow>();
  for (const { key, points } of drawn) {
    for (const point of points) {
      let row = byDate.get(point.date);
      if (!row) {
        row = { ts: parseLocalDate(point.date).getTime() };
        for (const other of drawn) row[other.key] = null;
        byDate.set(point.date, row);
      }
      row[key] = point.returnPercent;
    }
  }
  return [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, row]) => row);
}

/** The whole portfolio (or the filtered accounts together) as one heavy line. */
export function buildPortfolioReturnView(
  series: PortfolioTwrSeries,
  label: string,
): ReturnView {
  if (!series.complete || series.points.length === 0) {
    // The one line has no history: the chart's own empty state says so, rather
    // than a "Not drawn" row naming the only series there is.
    if (hasNoHistory(series.reasons)) return { rows: [], lines: [], withheld: [] };
    return {
      rows: [],
      lines: [],
      withheld: [{ key: PORTFOLIO_RETURN_KEY, label, cause: causeOf(series.reasons) }],
    };
  }
  return {
    rows: mergeRows([{ key: PORTFOLIO_RETURN_KEY, points: series.points }]),
    lines: [{ key: PORTFOLIO_RETURN_KEY, label, color: chartColors.primary, heavy: true }],
    withheld: [],
  };
}

/**
 * One line per account, in the order the server answered them (the order the
 * request named them), each coloured by its position so an account keeps its
 * colour as others are withheld. An account the server withheld is named, with
 * its cause, rather than quietly absent: dropping it makes a chart of two
 * accounts out of a request for three, and reads as complete.
 */
export function buildAccountReturnView(
  response: PortfolioTwrSeriesByAccount,
  nameOf: (accountId: string) => string,
): ReturnView {
  const lines: ReturnLine[] = [];
  const withheld: WithheldReturnLine[] = [];
  const drawn: Array<{ key: string; points: readonly TwrSeriesPoint[] }> = [];
  response.accounts.forEach((entry: AccountTwrSeries, index) => {
    const label = nameOf(entry.accountId);
    if (!entry.complete || entry.points.length === 0) {
      withheld.push({ key: entry.accountId, label, cause: causeOf(entry.reasons) });
      return;
    }
    drawn.push({ key: entry.accountId, points: entry.points });
    lines.push({
      key: entry.accountId,
      label,
      color: chartSeriesColor(index),
      heavy: false,
    });
  });
  return { rows: mergeRows(drawn), lines, withheld };
}
