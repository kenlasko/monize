import { format, subDays, subYears } from 'date-fns';
import { roundToDecimals } from './format';
import type {
  SecurityPrice,
  SecurityHistoryTransaction,
} from '@/types/investment';

/** What the detail page's main chart plots. */
export type SecurityChartMode = 'price' | 'value' | 'return';

/** The trailing periods the Performance card reports. */
export const PERFORMANCE_PERIODS = [
  '1m',
  '3m',
  'ytd',
  '1y',
  '3y',
  '5y',
] as const;

export type PerformancePeriod = (typeof PERFORMANCE_PERIODS)[number];

/** Presets offered above the chart, in the keys `resolveRangePreset` knows. */
export const CHART_RANGES = ['1m', '3m', 'ytd', '1y', '5y', 'all'] as const;

/** One close price, oldest-first once through `toPriceSeries`. */
export interface SecurityPricePoint {
  /** ISO `yyyy-MM-dd`. */
  date: string;
  /** The quoted close: what the security traded at. */
  close: number;
  /**
   * The split- and dividend-adjusted close, when the provider supplies one.
   * Undefined otherwise, which is why every reader goes through
   * `totalReturnOf` rather than touching this directly.
   */
  totalReturnClose?: number;
  /**
   * ISO instant the quote was struck, when the row carries one. `date` says
   * which trading day the price belongs to; this says when within it, which is
   * the difference between "today's price" and "today's close".
   */
  quotedAt?: string;
}

/**
 * The value to measure a *return* from: the adjusted close where there is one,
 * the quoted close otherwise. Mirrors the backend's own
 * `COALESCE(adjusted_close, close_price)`, so a percentage shown here and one
 * computed server-side describe the same thing.
 *
 * Anything that shows a *price* -- the quote in the header, the price chart,
 * position value -- must keep using `close`: the adjusted series is not what the
 * security traded at.
 */
export function totalReturnOf(point: SecurityPricePoint): number {
  return point.totalReturnClose ?? point.close;
}

/** The share count from `date` onwards, until the next step. */
export interface QuantityStep {
  date: string;
  quantity: number;
}

/** A point in the shape `BalanceHistoryChart` consumes. */
export interface SeriesPoint {
  date: string;
  balance: number;
}

/**
 * Close prices as an oldest-first series. The prices API returns newest-first,
 * and every calculation here walks forward in time.
 */
export function toPriceSeries(
  prices: readonly SecurityPrice[],
): SecurityPricePoint[] {
  return prices
    .map((price) => {
      const adjusted = Number(price.adjustedClose);
      return {
        date: price.priceDate.slice(0, 10),
        close: Number(price.closePrice),
        totalReturnClose:
          price.adjustedClose !== null && isFinite(adjusted) && adjusted > 0
            ? adjusted
            : undefined,
        quotedAt: price.quotedAt ?? undefined,
      };
    })
    .filter((point) => isFinite(point.close))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The position's size over time, as a step per date it changed.
 *
 * Read straight off `runningQuantityAll`, which the backend already computes by
 * replaying the history -- so the steps here agree with the running totals the
 * transaction table shows rather than being a second, parallel tally. Several
 * trades on one day collapse to that day's final balance.
 */
export function buildQuantitySteps(
  transactions: readonly SecurityHistoryTransaction[],
): QuantityStep[] {
  const byDate = new Map<string, number>();
  for (const transaction of transactions) {
    const date = transaction.transactionDate.slice(0, 10);
    // The history is ordered, so the last write for a day is that day's close.
    byDate.set(date, Number(transaction.runningQuantityAll) || 0);
  }
  return [...byDate.entries()]
    .map(([date, quantity]) => ({ date, quantity }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * What the price data says about whether the instrument pays out.
 *
 * - `distributing` -- the adjusted series diverges from the quoted close, which
 *   happens when a distribution is paid.
 * - `accumulating` -- both series exist and agree throughout, so nothing was ever
 *   paid out. (A share class that simply never declared a dividend looks the
 *   same, which is why the UI words this as observed rather than declared.)
 * - `unknown` -- no adjusted series to compare against, so there is nothing to
 *   conclude. MSN supplies none.
 */
export type DistributionPolicy = 'distributing' | 'accumulating' | 'unknown';

/**
 * Relative gap between the two series big enough to mean a real distribution
 * rather than rounding at the provider's 6dp.
 */
const DISTRIBUTION_EPSILON = 0.0005;

/**
 * Read the distribution behaviour off the price history.
 *
 * Yahoo's quoted close is adjusted for splits; its adjusted close is adjusted for
 * splits *and* dividends. So the two agreeing across the whole series means
 * nothing was ever distributed, and a gap means something was. This is an
 * inference from data rather than a field an issuer told us, and the wording
 * around it has to say so.
 *
 * Checked against Yahoo's own series for a known pair, rather than assumed:
 * IUSQ.DE (iShares MSCI ACWI, accumulating) returns close === adjclose at every
 * monthly point, while VWRL.AS (Vanguard FTSE All-World, distributing) sits
 * about 3% below its quoted close throughout -- roughly sixty times
 * DISTRIBUTION_EPSILON, so the threshold has ample margin over provider
 * rounding. The sign is consistent too: the adjusted series runs below the
 * quoted one, because Yahoo back-adjusts history for each distribution.
 */
export function inferDistributionPolicy(
  series: readonly SecurityPricePoint[],
): DistributionPolicy {
  const comparable = series.filter(
    (point) => point.totalReturnClose !== undefined && point.close > 0,
  );
  // Nothing to compare, or only the newest point (where the two always agree,
  // because no distribution has happened since).
  if (comparable.length < 2) return 'unknown';

  // Only a gap in the direction back-adjustment actually produces counts: the
  // adjusted series runs *below* the quoted one, never above. An adjusted close
  // above the quoted close is bad provider data, and reading it as a
  // distribution would relabel an accumulating fund on the strength of the one
  // thing this model says cannot happen.
  //
  // One diverging point is still enough. A distribution back-adjusts every close
  // before it, so a long history diverges across a stretch -- but a series with
  // only one point older than the payout has only that one to show it, and
  // demanding two would read that fund as accumulating.
  const diverges = comparable.some(
    (point) =>
      (point.close - (point.totalReturnClose as number)) / point.close >
      DISTRIBUTION_EPSILON,
  );
  return diverges ? 'distributing' : 'accumulating';
}

/**
 * Shares held on `date`: the most recent step at or before it, or zero for a
 * date before the first trade.
 */
export function quantityAt(
  steps: readonly QuantityStep[],
  date: string,
): number {
  let quantity = 0;
  for (const step of steps) {
    if (step.date > date) break;
    quantity = step.quantity;
  }
  return quantity;
}

/**
 * Turn a price window into the series the chart draws.
 *
 * `price` is the quoted close. `value` multiplies it by the shares held that
 * day, so the line answers "what was my position worth" rather than "what did
 * one unit cost". `return` re-bases the window on its own first point, which is
 * why it must be given the already-filtered window: a 1Y return is measured
 * from the start of that year of data, not from the start of all history.
 */
export function buildChartSeries(
  window: readonly SecurityPricePoint[],
  steps: readonly QuantityStep[],
  mode: SecurityChartMode,
): SeriesPoint[] {
  if (mode === 'price') {
    return window.map((point) => ({ date: point.date, balance: point.close }));
  }

  if (mode === 'value') {
    // Both series are date-ordered, so one walk over the steps serves the whole
    // window. Calling `quantityAt` per point re-scans the steps from the
    // beginning each time, which is O(points x steps) -- fine for a month of a
    // lightly traded holding, wasteful for a decade of daily closes against
    // years of trades, and this runs on every chart render.
    let stepIndex = 0;
    let quantity = 0;
    return window.map((point) => {
      while (
        stepIndex < steps.length &&
        steps[stepIndex].date <= point.date
      ) {
        quantity = steps[stepIndex].quantity;
        stepIndex += 1;
      }
      return {
        date: point.date,
        balance: roundToDecimals(point.close * quantity, 4),
      };
    });
  }

  // Return mode reads the same adjusted series the Performance card does, so the
  // chart's 1Y and the card's 1Y cannot disagree.
  const baseline = window[0] ? totalReturnOf(window[0]) : undefined;
  // Without a usable baseline there is no percentage to state, so the caller
  // gets an empty series and renders the chart's own no-data state.
  if (baseline === undefined || baseline === 0) return [];
  return window.map((point) => ({
    date: point.date,
    balance: roundToDecimals((totalReturnOf(point) / baseline - 1) * 100, 4),
  }));
}

/**
 * First day of a trailing period, in the same conventions
 * `resolveRangePreset` uses (a month is 30 days, a quarter 90, YTD is Jan 1),
 * plus the 3-year period the Performance card needs and that preset lacks.
 */
export function periodStartDate(
  period: PerformancePeriod,
  now: Date = new Date(),
): string {
  switch (period) {
    case '1m':
      return format(subDays(now, 30), 'yyyy-MM-dd');
    case '3m':
      return format(subDays(now, 90), 'yyyy-MM-dd');
    case 'ytd':
      return `${now.getFullYear()}-01-01`;
    case '1y':
      return format(subYears(now, 1), 'yyyy-MM-dd');
    case '3y':
      return format(subYears(now, 3), 'yyyy-MM-dd');
    case '5y':
      return format(subYears(now, 5), 'yyyy-MM-dd');
  }
}

/**
 * Percent change from the last price at or before `startDate` to the newest
 * price in the series.
 *
 * Returns null when the history does not reach back that far. That is the whole
 * point of the null: a security listed two years ago has no five-year return,
 * and measuring from its first day instead would report a number that looks
 * like one.
 */
export function computePeriodReturn(
  series: readonly SecurityPricePoint[],
  startDate: string,
): number | null {
  if (series.length === 0) return null;

  let baseline: SecurityPricePoint | undefined;
  for (const point of series) {
    if (point.date > startDate) break;
    baseline = point;
  }
  if (!baseline) return null;

  const latest = series[series.length - 1];
  // A baseline that is also the newest point spans no time at all.
  if (latest.date === baseline.date) return null;

  // Dividends belong in a return, so this runs on the adjusted series where the
  // provider gives one. A distributing fund measured on price alone understates
  // its return by its whole yield.
  const from = totalReturnOf(baseline);
  const to = totalReturnOf(latest);
  if (from === 0) return null;

  return roundToDecimals((to / from - 1) * 100, 2);
}

/**
 * Everything the position's own return needs. Every money field must already be
 * in `securityCurrency`; nothing here converts, and the guards below refuse the
 * figure rather than mix units.
 */
export interface PositionReturnInput {
  /** Cost of every acquiring leg, commission included; null when unknown. */
  totalInvested: number | null;
  /** Worth of what is still held; null when it cannot be known. */
  marketValue: number | null;
  /** Cost basis of what is still held; null when it cannot be known. */
  costBasis: number | null;
  dividends: number;
  realizedGain: number | null;
  realizedGainCurrency: string | null;
  /** Zero means never sold, which is a realised gain of nothing. */
  realizedSaleCount: number;
  securityCurrency: string;
  /** True once the position has been sold down to nothing. */
  isPositionClosed: boolean;
}

export interface PositionReturn {
  /** Unrealised + realised + income, in the security's currency. */
  profit: number;
  /** That profit over the capital ever put in, as a percentage. */
  percent: number;
}

/**
 * What the *position* returned, as distinct from what the security did.
 *
 * The Performance card answers "how has this instrument moved", which is a fact
 * about the market. This answers "what did I make on it", which also depends on
 * when the shares were bought, what was sold, and what it paid out. Readers
 * conflate the two, so the page has to state both.
 *
 * A deliberately simple measure: total profit over the capital ever deployed,
 * not annualised and not weighted by how long each tranche was held. It is not
 * TWR and not IRR, and the copy beside it must not imply otherwise -- those need
 * a full cash-flow series, which lives in the portfolio calculation.
 *
 * Returns null rather than a figure whenever a component is unknown or sits in
 * another currency. A partial total here would read as a complete one.
 */
export function computePositionReturn(
  input: PositionReturnInput,
): PositionReturn | null {
  // No capital in means no return to state -- and no denominator either.
  if (input.totalInvested === null || !(input.totalInvested > 0)) return null;

  let realized = 0;
  if (input.realizedSaleCount > 0) {
    // Null here means the sales spanned currencies; a different currency means
    // converting, which this page deliberately never does.
    if (
      input.realizedGain === null ||
      input.realizedGainCurrency !== input.securityCurrency
    ) {
      return null;
    }
    realized = input.realizedGain;
  }

  let unrealized = 0;
  if (!input.isPositionClosed) {
    if (input.marketValue === null || input.costBasis === null) return null;
    unrealized = input.marketValue - input.costBasis;
  }

  // Commissions are not subtracted again: the cost basis and the realized gain
  // already carry them (buy commission in the basis, sell commission in the
  // proceeds), so taking `fees` off here counted each one twice.
  const profit = roundToDecimals(unrealized + realized + input.dividends, 4);
  return {
    profit,
    percent: roundToDecimals((profit / input.totalInvested) * 100, 2),
  };
}

/**
 * The host a document link points at, for the address column.
 *
 * A factsheet URL runs to a couple of hundred characters and none of them say as
 * much as "ishares.com" does; the whole address is still on the link's tooltip.
 * `www.` comes off because it is noise in a column of hosts. An address that
 * cannot be parsed is shown as it was typed rather than hidden -- the reader is
 * the one who can tell what is wrong with it.
 */
export function documentHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}

/** A closed date window, in ISO `yyyy-MM-dd`. */
export interface DateWindow {
  start: string;
  end: string;
}

/** Whole days a window covers; at least one, so it can always be stepped. */
function windowDays(range: DateWindow): number {
  const start = new Date(`${range.start}T00:00:00`).getTime();
  const end = new Date(`${range.end}T00:00:00`).getTime();
  return Math.max(1, Math.round((end - start) / 86_400_000));
}

/**
 * The same window moved `spansBack` of its own lengths into the past.
 *
 * A range preset picks how much history to show; this picks *which* stretch of
 * it. Selecting 1Y and then stepping back twice shows the year before last at
 * the same zoom, rather than forcing a jump to 5Y and squinting. Steps are one
 * full window, so consecutive views share only their boundary day and the line
 * reads continuously across a step.
 */
export function shiftWindow(range: DateWindow, spansBack: number): DateWindow {
  if (spansBack <= 0 || !range.start || !range.end) return range;
  const days = windowDays(range) * spansBack;
  const shift = (iso: string): string =>
    format(subDays(new Date(`${iso}T00:00:00`), days), 'yyyy-MM-dd');
  return { start: shift(range.start), end: shift(range.end) };
}

/**
 * How many steps back there is still data for, given the oldest date on record.
 *
 * Zero when the window already reaches the beginning: the control that steps
 * back has to be able to say when there is nothing left to step to, or it
 * scrolls off into empty charts.
 */
export function maxSpansBack(range: DateWindow, earliest: string): number {
  if (!range.start || !range.end || !earliest) return 0;
  const start = new Date(`${range.start}T00:00:00`).getTime();
  const oldest = new Date(`${earliest}T00:00:00`).getTime();
  if (oldest >= start) return 0;
  const gapDays = (start - oldest) / 86_400_000;
  return Math.ceil(gapDays / windowDays(range));
}

/** Prices within `[start, end]`; an empty `start` means "from the beginning". */
export function filterPriceWindow(
  series: readonly SecurityPricePoint[],
  start: string,
  end: string,
): SecurityPricePoint[] {
  return series.filter(
    (point) => (!start || point.date >= start) && (!end || point.date <= end),
  );
}

/** Most decimal places a price column will show, matching NUMERIC(24,10). */
export const MAX_PRICE_DECIMALS = 10;

/** Fewest, so a whole-number price still reads as money. */
const MIN_PRICE_DECIMALS = 2;

/**
 * What a TRADE's per-share price is shown at: enough to see that 141 shares
 * went at 5.8220567376 rather than at 5.82, and no more than a person reads.
 * A price derived from an executed total is stored at ten decimals
 * (INV-TRADE-001); six is what `formatPrice` shows and what this matches.
 */
export const TRADE_PRICE_DISPLAY_DECIMALS = 6;

/** Decimal places a single number is written with, or null if not readable. */
function decimalPlacesOf(value: number): number | null {
  if (!isFinite(value)) return null;
  // Round to the most a column will ever show before counting. Otherwise binary
  // float noise decides the width of the whole column: a value that arrived as
  // 0.30000000000000004 rather than 0.3 counts as seventeen decimals and takes
  // every row to the maximum. Storage is NUMERIC(24,10), so nothing past the
  // tenth place is information anyway.
  const text = Math.abs(roundToDecimals(value, MAX_PRICE_DECIMALS)).toString();
  // Exponent form (a very small price): the digits are there but not countable
  // this way, so let the caller fall back to the maximum.
  if (text.includes('e')) return null;
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * One decimal count for a whole price table, so the column does not jag.
 *
 * Providers hand back both `93.239998` and `93.18` in the same series -- the
 * first is a float artefact of a value that was really 93.24 -- and formatting
 * each to its own precision put two and six decimals side by side in one column
 * of figures that should be scannable at a glance. The widest count any value
 * needs is the one they all use, so every row lines up.
 *
 * `max` caps it for a column that shows fewer than the storage scale -- a
 * trade's price column passes `TRADE_PRICE_DISPLAY_DECIMALS`, so a price
 * derived from an executed total reads as 5.822057 rather than as all ten
 * stored decimals.
 */
export function priceDecimals(
  values: readonly (number | null)[],
  max: number = MAX_PRICE_DECIMALS,
): number {
  let widest = MIN_PRICE_DECIMALS;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const places = decimalPlacesOf(value);
    // Unreadable means "at least as precise as anything we can count", so it
    // takes the column straight to the maximum.
    if (places === null) return max;
    if (places > widest) widest = places;
  }
  return Math.min(widest, max);
}

/** A month's worth of price rows, newest month first within its year. */
export interface PriceMonthGroup {
  /** `yyyy-MM` -- the expand/collapse key, and what `formatMonth` takes. */
  key: string;
  prices: SecurityPrice[];
}

/** A year of price rows, newest first. */
export interface PriceYearGroup {
  /** `yyyy`, also the expand/collapse key. */
  key: string;
  /** Rows across the whole year, so a collapsed year can still state its size. */
  count: number;
  months: PriceMonthGroup[];
}

/**
 * Group a price history into years, then months, newest first.
 *
 * A security backfilled from the provider carries thousands of daily closes, and
 * a flat table of them is unreadable however it is paged: there is no way to get
 * to March 2023 except by scrolling past everything after it. Years and months
 * are the units people actually navigate a price history by.
 *
 * Rows keep the API's newest-first order inside each month, so the newest row of
 * the newest month is the first thing in the first group.
 */
export function groupPricesByPeriod(
  prices: readonly SecurityPrice[],
): PriceYearGroup[] {
  const byMonth = new Map<string, SecurityPrice[]>();
  for (const price of prices) {
    const month = price.priceDate.slice(0, 7);
    const bucket = byMonth.get(month);
    if (bucket) bucket.push(price);
    else byMonth.set(month, [price]);
  }

  const byYear = new Map<string, PriceMonthGroup[]>();
  // Descending by month key, so both levels read newest first.
  for (const month of [...byMonth.keys()].sort((a, b) => b.localeCompare(a))) {
    const year = month.slice(0, 4);
    const group: PriceMonthGroup = {
      key: month,
      prices: byMonth.get(month) as SecurityPrice[],
    };
    const bucket = byYear.get(year);
    if (bucket) bucket.push(group);
    else byYear.set(year, [group]);
  }

  return [...byYear.keys()]
    .sort((a, b) => b.localeCompare(a))
    .map((year) => {
      const months = byYear.get(year) as PriceMonthGroup[];
      return {
        key: year,
        count: months.reduce((sum, month) => sum + month.prices.length, 0),
        months,
      };
    });
}

/** Every expand/collapse key in a grouping: both years and months. */
export function allPriceGroupKeys(groups: readonly PriceYearGroup[]): string[] {
  return groups.flatMap((year) => [
    year.key,
    ...year.months.map((month) => month.key),
  ]);
}

/**
 * What to open on arrival: the newest year and its newest month, so the recent
 * prices are on screen without a click while everything older stays folded.
 */
export function defaultOpenPriceGroups(
  groups: readonly PriceYearGroup[],
): string[] {
  const newestYear = groups[0];
  if (!newestYear) return [];
  const newestMonth = newestYear.months[0];
  return newestMonth ? [newestYear.key, newestMonth.key] : [newestYear.key];
}
