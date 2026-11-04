import type { PeriodResultReason } from '@/types/net-worth';

/**
 * Which repair a withheld period figure points the reader at.
 *
 * The marker carries one `UnknownAmount` cause and the server sends five, so
 * the mapping is made here rather than guessed -- the same decision
 * `movementUnknownReason` makes for a day's movement, for the same reason: an
 * unpriced holding is a price to add, a cash account with no balance is neither
 * a price nor a rate, an unconvertible amount is a rate to refresh, and a
 * boundary is nothing anybody can fix. Naming a price for a missing display
 * rate sends the reader to a screen where there is nothing to do.
 *
 * `zeroStart` and `noValueSeries` are both boundaries: a period that started at
 * nothing has no percentage to report, and a scope that produced no valued day
 * has nothing to compare. Neither is a defect to repair.
 *
 * `mwrUndefined` and `windowTooShort` are causes of the money-weighted return
 * alone and fall through to `noBaseline` for the same reason `zeroStart` does:
 * a window too short to annualise, or a schedule of flows with no single rate,
 * is a boundary rather than a price, a rate or a balance anybody can repair.
 *
 * `externallySettledTrade` and `mixedSplit` fall to the same marker for want of
 * a truer one: nothing is missing from the data, so naming a price, a rate or a
 * balance would send the reader to a screen with nothing to do on it. They
 * withhold only the ACCOUNT result; the invested figures every card shows do
 * not read where a trade's cash settled (#1516).
 */
export function periodResultUnknownReason(
  reasons: readonly PeriodResultReason[],
): 'noPrice' | 'displayFx' | 'noBaseline' | 'noCashBalance' {
  if (reasons.includes('incompletePrices')) return 'noPrice';
  if (reasons.includes('incompleteCash')) return 'noCashBalance';
  if (reasons.includes('missingRatePairs')) return 'displayFx';
  return 'noBaseline';
}

/**
 * Whether a withheld figure is waiting for DATA the reader can supply: a price,
 * a rate or a cash balance.
 *
 * The other reasons are boundaries -- a window too short to annualise, a start
 * of nothing, a schedule of flows with no single rate -- where nothing is
 * missing and a list of gaps would be an empty promise. A surface that offers a
 * repair checks this first.
 */
export function hasRepairableDataCause(
  reasons: readonly PeriodResultReason[],
): boolean {
  return (
    reasons.includes('incompletePrices') ||
    reasons.includes('incompleteCash') ||
    reasons.includes('missingRatePairs')
  );
}

/** The cause a withheld period's notice names, ranked as the marker ranks them. */
export type WithheldPeriodCause =
  | 'incompletePrices'
  | 'incompleteCash'
  | 'missingRatePairs';

/**
 * The one cause to print under a list of periods, some of which the server
 * withheld, or `null` when nothing was withheld for a cause worth printing.
 *
 * Ranked the way `periodResultUnknownReason` ranks a single figure -- a price
 * to add before a balance to explain before a rate to refresh. `zeroStart`,
 * `noValueSeries` and the money-weighted return's own `mwrUndefined` and
 * `windowTooShort` are boundaries, not defects: a portfolio younger than the
 * window has nothing to repair, so they print nothing and the list's own "n/a"
 * (or, when every period is one, the empty message) is the whole answer.
 */
export function withheldPeriodCause(
  reasonLists: ReadonlyArray<readonly PeriodResultReason[]>,
): WithheldPeriodCause | null {
  const reasons = new Set(reasonLists.flat());
  if (reasons.has('incompletePrices')) return 'incompletePrices';
  if (reasons.has('incompleteCash')) return 'incompleteCash';
  if (reasons.has('missingRatePairs')) return 'missingRatePairs';
  return null;
}

/**
 * The close a dated window is measured from, sent as `baselineDate` beside its
 * `startDate`: the day its series was requested from (`usePortfolioRangeWindow`'s
 * `start`) where that precedes the period itself (`periodStart`), as it does
 * for MTD. Undefined where the two are one day, so no second copy of the same
 * date goes out. Every request for a period result names a dated window this
 * way, so the portfolio's figure and its split by security are asked the same
 * question.
 */
export function periodBaselineDate(
  startDate: string | undefined,
  periodStartDate: string | undefined,
): string | undefined {
  return startDate && periodStartDate && startDate < periodStartDate
    ? startDate
    : undefined;
}
