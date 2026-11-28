import type { ConvertedTotal } from "@/lib/currency-total";

/**
 * Reading the completeness flags the net-worth series carries per month, in the
 * terms `PartialTotal` already speaks.
 *
 * A month with `fxComplete: false` has `assets`, `liabilities` and `netWorth`
 * that are SUBTOTALS of what converted. The flag is optional (an older backend
 * mid-deploy sends none), and absent means no information, so every read is
 * `=== false`.
 */

/** The source currency of a `"ZZZ->USD"` pair as the server names it. */
export function pairSourceCurrency(pair: string): string {
  const arrow = pair.indexOf("->");
  return arrow === -1 ? pair : pair.slice(0, arrow);
}

/** The distinct source currencies behind a list of pairs, first seen first. */
export function missingCurrenciesFromPairs(
  pairs: readonly string[] | undefined,
): string[] {
  return [...new Set((pairs ?? []).map(pairSourceCurrency))];
}

/** The distinct pairs across several months, first seen first. */
export function unionPairs(
  sources: ReadonlyArray<
    { missingRatePairs?: readonly string[] } | null | undefined
  >,
): string[] {
  return [...new Set(sources.flatMap((s) => s?.missingRatePairs ?? []))];
}

/**
 * A figure as a `ConvertedTotal`: complete unless `complete` is `false`, in
 * which case it names the currencies behind `pairs` and counts one excluded
 * component per pair (at least one, so a flag with no pairs still marks it).
 */
export function partialTotalFor(
  value: number,
  complete: boolean | undefined,
  pairs?: readonly string[],
): ConvertedTotal {
  if (complete !== false)
    return { value, missingCurrencies: [], excludedCount: 0 };
  return {
    value,
    missingCurrencies: missingCurrenciesFromPairs(pairs),
    excludedCount: Math.max(pairs?.length ?? 0, 1),
  };
}

/** True when the month's net worth is a subtotal, by either side or the month. */
export function netWorthIsPartial(month: {
  fxComplete?: boolean;
  assetsFxComplete?: boolean;
  liabilitiesFxComplete?: boolean;
}): boolean {
  return (
    month.fxComplete === false ||
    month.assetsFxComplete === false ||
    month.liabilitiesFxComplete === false
  );
}

/** The assets figure's own flag, falling back to the month's. */
export function assetsFxComplete(month: {
  fxComplete?: boolean;
  assetsFxComplete?: boolean;
}): boolean | undefined {
  return month.assetsFxComplete ?? month.fxComplete;
}

/** The liabilities figure's own flag, falling back to the month's. */
export function liabilitiesFxComplete(month: {
  fxComplete?: boolean;
  liabilitiesFxComplete?: boolean;
}): boolean | undefined {
  return month.liabilitiesFxComplete ?? month.fxComplete;
}

/**
 * A summary figure to print: the server's total, or its known subtotal when the
 * server withheld the total (`null`). `null` when both are absent, which is
 * unknown and renders as such (`UnknownAmount`), never 0. The caller labels a
 * withheld total partial with `summaryTotal`.
 */
export function totalOrSubtotal(
  total: number | null | undefined,
  knownSubtotal: number | undefined,
): number | null {
  return total ?? knownSubtotal ?? null;
}

/**
 * One summary figure as a `ConvertedTotal`, partial from whether ITS OWN total
 * was withheld (`null`), never from the summary-wide flags: a missing cost rate
 * must not mark a market value that is fully known. An older backend sends no
 * `known*Subtotal` and a numeric total, so there the summary's flags are all
 * there is to read. `null` when the figure is unknown outright.
 */
export function summaryTotal(
  total: number | null | undefined,
  knownSubtotal: number | undefined,
  source: PortfolioCompleteness | null | undefined,
  /** The figure's own causes, when the server names them apart from the summary's. */
  causes?: { pairs: readonly string[]; unpriced: number },
): ConvertedTotal | null {
  const value = totalOrSubtotal(total, knownSubtotal);
  if (value === null) return null;
  const withheld =
    total === null ||
    (knownSubtotal === undefined && isPortfolioPartial(source));
  if (!withheld) return { value, missingCurrencies: [], excludedCount: 0 };
  const pairs = causes?.pairs ?? source?.missingRatePairs ?? [];
  const unpriced =
    causes?.unpriced ??
    source?.unpricedHoldingsCount ??
    source?.unpricedSecurityIds?.length ??
    0;
  return {
    value,
    missingCurrencies: missingCurrenciesFromPairs(pairs),
    excludedCount: Math.max(pairs.length + unpriced, 1),
  };
}

/**
 * The completeness a portfolio figure carries, from whichever aggregate it was
 * read off: the summary (`unpricedSecurityIds`), one account of it
 * (`unpricedHoldingsCount`), or an intraday response. Every field is optional
 * because an older backend sends none of them, and absent is no information.
 */
export interface PortfolioCompleteness {
  valuationComplete?: boolean;
  fxComplete?: boolean;
  pricesComplete?: boolean;
  missingRatePairs?: readonly string[];
  unpricedSecurityIds?: readonly string[];
  unpricedHoldingsCount?: number;
}

/**
 * True when a figure over this aggregate is a SUBTOTAL: any of the flags is
 * exactly `false`, or a holding is counted as unpriced. `valuationComplete` is
 * `fxComplete && pricesComplete`, so reading all three is only defence against
 * a payload that sends one of them.
 */
export function isPortfolioPartial(
  source: PortfolioCompleteness | null | undefined,
): boolean {
  if (!source) return false;
  return (
    source.valuationComplete === false ||
    source.fxComplete === false ||
    source.pricesComplete === false ||
    (source.unpricedHoldingsCount ?? 0) > 0
  );
}

/**
 * A portfolio figure as a `ConvertedTotal`: complete unless
 * `isPortfolioPartial`, in which case it names the currencies behind the missing
 * pairs and counts what was left out -- one per pair, one per unpriced holding,
 * and at least one so a bare `false` flag still marks the figure.
 */
export function portfolioPartialTotal(
  value: number,
  source: PortfolioCompleteness | null | undefined,
): ConvertedTotal {
  if (!source || !isPortfolioPartial(source)) {
    return { value, missingCurrencies: [], excludedCount: 0 };
  }
  const pairs = source.missingRatePairs ?? [];
  const unpriced =
    source.unpricedHoldingsCount ?? source.unpricedSecurityIds?.length ?? 0;
  return {
    value,
    missingCurrencies: missingCurrenciesFromPairs(pairs),
    excludedCount: Math.max(pairs.length + unpriced, 1),
  };
}
