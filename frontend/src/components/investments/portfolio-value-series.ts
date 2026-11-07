import { netWorthApi } from '@/lib/net-worth';
import { investmentsApi } from '@/lib/investments';
import { investedValue } from '@/lib/invested-value';
import { isIntradayRange } from './portfolio-chart-utils';

/**
 * The INVESTED value of a portfolio over one of the value chart's windows
 * (`PORTFOLIO_CHART_RANGES`): the securities alone, the way the Investments
 * page's Portfolio Value over Time chart plots them. The chart keeps its own
 * loader (it caches intraday bars and surfaces the withheld points' causes);
 * the dashboard hero reads the same series through this one.
 */

/** Ranges drawn from daily closes; the longer ones sample each month's end. */
export const PORTFOLIO_DAILY_RANGES: ReadonlySet<string> = new Set([
  '1w',
  'mtd',
  '1m',
  '3m',
  'ytd',
  '1y',
  '2y',
]);

/**
 * Whether a point's INVESTED value is one the server could work out. The chart
 * plots the securities alone, so a cash account with no balance for the day
 * (`cashComplete`) cannot make it wrong and is not read. Absent flags are no
 * information, which is why both reads are `=== false`.
 */
export function isInvestedPointComplete(point: {
  pricesComplete?: boolean;
  fxComplete?: boolean;
}): boolean {
  return point.pricesComplete !== false && point.fxComplete !== false;
}

export interface PortfolioValuePoint {
  /** A calendar date (`YYYY-MM-DD`), or an ISO timestamp for an intraday bar. */
  at: string;
  /** `null` where a price or a rate was missing: drawn as a gap, never a dip. */
  value: number | null;
  intraday: boolean;
}

export interface PortfolioValueSeries {
  points: PortfolioValuePoint[];
  /**
   * True when 1D was asked for and a holding's quote provider has no intraday
   * bars: there is no daily stand-in for a single day, so there are no points.
   */
  intradayUnavailable: boolean;
}

export async function loadPortfolioValueSeries(params: {
  range: string;
  start: string;
  end: string;
  /** Comma-joined account ids; absent is every investment account. */
  accountIds?: string;
}): Promise<PortfolioValueSeries> {
  const { range, start, end, accountIds } = params;

  const daily = async (sampled: boolean): Promise<PortfolioValueSeries> => {
    const rows = await netWorthApi.getInvestmentsDaily({
      startDate: start || undefined,
      endDate: end,
      accountIds,
      ...(sampled ? { sampling: 'monthEnd' as const } : {}),
    });
    return {
      points: rows.map((r) => ({
        at: r.date,
        value: isInvestedPointComplete(r) ? investedValue(r) : null,
        intraday: false,
      })),
      intradayUnavailable: false,
    };
  };

  if (isIntradayRange(range)) {
    let response: Awaited<ReturnType<typeof investmentsApi.getIntradayValue>>;
    try {
      response = await investmentsApi.getIntradayValue({ range, accountIds });
    } catch {
      // As on the Investments page: a failed intraday request falls back to
      // the daily closes, so the reader still sees the window.
      return daily(false);
    }
    if (response.fallbackToDaily) {
      if (range === '1d') return { points: [], intradayUnavailable: true };
      return daily(false);
    }
    return {
      points: response.points.map((p) => ({
        at: p.timestamp,
        value: isInvestedPointComplete(p) ? investedValue(p) : null,
        intraday: true,
      })),
      intradayUnavailable: false,
    };
  }

  return daily(!PORTFOLIO_DAILY_RANGES.has(range));
}
