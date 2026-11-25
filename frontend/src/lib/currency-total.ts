import { FIAT_MONEY_DECIMALS, fromMoneyUnits, roundMoney, toMoneyUnits } from './format';

/**
 * Guard places a converted component is accumulated at beyond the target's
 * money precision, so the sum is rounded once, after the components are
 * added: the server's `FxAggregate` holds four plus eight
 * (`docs/specs/report-rounding-and-aggregation.md` rule 2). Rounding each
 * component to four places first read two 124.752474 rows as 249.5050 where
 * the server, and their sum, read 249.5049.
 */
const GUARD_DECIMALS = 8;

/**
 * The significant digits a double holds any decimal at (`DBL_DIG`); a
 * converted double's own noise sits beyond them.
 */
const DOUBLE_DECIMAL_DIGITS = 15;

/** Places past the guarded ones the accumulator counts in, for a small component's own digits. */
const SMALL_COMPONENT_DECIMALS = 8;

/**
 * A converted component in `10^-scale` units, held at its fifteen significant
 * digits and never at fewer than `guarded` places, as the server's
 * `FxAggregate` holds it: a component whose exact value has at most fifteen
 * significant digits is then held exactly. The guarded places alone rounded a
 * small one's digits away: 7.681 EUR at 1.2475589116 is 9.5824999999996,
 * which twelve places read as 9.5825, so two of them read 19.17 where their
 * sum, 19.1649999999992, reads 19.16 (issue #2414).
 */
function accumulationUnits(value: number, guarded: number, scale: number): bigint {
  if (value === 0) return BigInt(0);
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const at = Math.min(scale, Math.max(guarded, DOUBLE_DECIMAL_DIGITS - 1 - magnitude));
  return toMoneyUnits(value, at) * BigInt(10) ** BigInt(scale - at);
}

/**
 * Summing amounts that each need converting, while keeping track of the ones
 * that could not be.
 *
 * A total is only a total when every component is known
 * (`docs/financial-calculation-contract.md`). Conversion is where components go
 * missing on the client: `useExchangeRates().convert` returns `null` for a pair
 * it has no rate for, and the honest answer is a *subtotal* plus the list of
 * currencies it had to leave out -- never a figure presented as complete, and
 * never a silently smaller one.
 *
 * The pair travels together deliberately. A caller holding only the number
 * cannot tell 20,000 of assets from 120,000 of assets with a 100,000 hole in it,
 * which is exactly the state the Accounts page used to render as net worth.
 */
export interface ConvertedTotal {
  /**
   * Sum of the components that converted. A subtotal whenever `missing` is
   * non-empty -- name it accordingly at the point of display, and mark it.
   */
  value: number;
  /**
   * Source currencies with no usable rate to the target, in first-seen order.
   * Empty means the total is complete.
   */
  missingCurrencies: string[];
  /** Number of components excluded from `value`. */
  excludedCount: number;
  /**
   * The unrounded sum `value` was read from. Present on a total
   * `sumConverted` accumulated, so `combineTotals` can fold it before it is
   * rounded; absent on a figure read off a response, which arrives rounded
   * once and folds as its `value`.
   */
  exact?: ExactSum;
}

/** The exact sum of a total's converted components, before it was rounded. */
export interface ExactSum {
  /** The components' sum, in `10^-scale` units. */
  units: bigint;
  /** The places `units` counts in: `places` plus the guard places and room for a small component's digits. */
  scale: number;
  /** The places `value` was rounded at. */
  places: number;
}

/**
 * True when every component was included, so `value` is a complete total.
 *
 * Both causes of exclusion count: a missing rate (named in `missingCurrencies`)
 * and a component with no rate to name (an unpriced holding, a non-finite amount)
 * which only shows up in `excludedCount`. Checking `missingCurrencies` alone
 * reported the second case as complete -- the same gap PartialTotal was fixed for.
 */
export function isComplete(total: ConvertedTotal): boolean {
  return total.missingCurrencies.length === 0 && total.excludedCount === 0;
}

/**
 * Convert and sum `items`, collecting the currencies that could not be converted.
 *
 * `convert` is `useExchangeRates().convertToDefault` or a bound `convert`: any
 * function returning `null` when the rate is unknown. It is handed the item
 * too, for a caller whose rate travels on the item (a server-stamped factor)
 * rather than in a table keyed by currency. `decimals` is the target
 * currency's money precision; a fiat's four unless the caller says otherwise.
 */
export function sumConverted<T>(
  items: readonly T[],
  amountOf: (item: T) => number,
  currencyOf: (item: T) => string,
  convert: (amount: number, fromCurrency: string, item: T) => number | null,
  decimals?: number,
): ConvertedTotal {
  const places = decimals ?? FIAT_MONEY_DECIMALS;
  const guarded = places + GUARD_DECIMALS;
  const accumulation = guarded + SMALL_COMPONENT_DECIMALS;
  let units = BigInt(0);
  const missing = new Set<string>();
  let excludedCount = 0;

  for (const item of items) {
    const amount = amountOf(item);
    // A non-finite component is not a zero either; it is an upstream value
    // failure with no currency to blame, so it is excluded by count -- naming its
    // currency would report a missing rate for a currency that may have one.
    if (!Number.isFinite(amount)) {
      excludedCount += 1;
      continue;
    }
    const value = convert(amount, currencyOf(item), item);
    // No rate for this pair: name the currency so the caller can say which.
    if (value === null) {
      missing.add(currencyOf(item));
      excludedCount += 1;
      continue;
    }
    // A finite amount that converted to a non-finite value is a value failure,
    // not a rate gap, so again it is excluded without naming a currency.
    if (!Number.isFinite(value)) {
      excludedCount += 1;
      continue;
    }
    units += accumulationUnits(value, guarded, accumulation);
  }

  return {
    value: roundMoney(fromMoneyUnits(units, accumulation), places),
    missingCurrencies: [...missing],
    excludedCount,
    exact: { units, scale: accumulation, places },
  };
}

/**
 * Merge totals that were accumulated separately -- assets and liabilities, say,
 * where a missing rate in either makes the net figure partial too.
 *
 * Each total enters with its sign in `signs` (`[1, -1]` for the first less the
 * second), and the result is the single rounding of the signed sum of the
 * totals' exact sums, never a sum or difference of their rounded values:
 * assets of 0.008 read 0.01 and liabilities of 0.004 read 0.00, so the
 * difference of the readings is 0.01 where the net, 0.004, reads 0.00
 * (`docs/specs/report-rounding-and-aggregation.md` rule 2). A total without
 * an exact sum (`reportTotal`, a server figure) folds as its value. The
 * result is rounded at `decimals`, else at the places its totals were read
 * at. Incompleteness is the union: a net worth built from a complete asset
 * total and a partial liability total is partial.
 */
export function combineTotals(
  totals: readonly ConvertedTotal[],
  signs: readonly (1 | -1)[],
  decimals?: number,
): ConvertedTotal {
  if (signs.length !== totals.length) {
    throw new Error('combineTotals: one sign per total');
  }
  const readAt = totals.flatMap((total) => (total.exact ? [total.exact.places] : []));
  const places =
    decimals ?? (readAt.length > 0 ? Math.max(...readAt) : FIAT_MONEY_DECIMALS);
  const scale = Math.max(
    places + GUARD_DECIMALS,
    ...totals.map((total) => total.exact?.scale ?? 0),
  );
  const missing = new Set<string>();
  let excludedCount = 0;
  let units = BigInt(0);
  totals.forEach((total, index) => {
    for (const currency of total.missingCurrencies) missing.add(currency);
    excludedCount += total.excludedCount;
    const exact = total.exact;
    const own = exact
      ? exact.units * BigInt(10) ** BigInt(scale - exact.scale)
      : toMoneyUnits(total.value, scale);
    units += signs[index] === -1 ? -own : own;
  });
  return {
    value: roundMoney(fromMoneyUnits(units, scale), places),
    missingCurrencies: [...missing],
    excludedCount,
    exact: { units, scale, places },
  };
}

/**
 * `total` as a magnitude: a liability side summed from negative balances and
 * reported as what is owed. Negated exactly, so a net built from it is still
 * the single rounding of its components.
 */
export function absoluteTotal(total: ConvertedTotal): ConvertedTotal {
  const negative = total.exact ? total.exact.units < BigInt(0) : total.value < 0;
  return negative ? combineTotals([total], [-1]) : total;
}

/**
 * The `ConvertedTotal` of a built-in report's headline figure.
 *
 * The server withholds a total (`null`) when a row could not be converted and
 * sends the part that did as a `known*` sibling. `value` is that known part;
 * the completeness comes from the response's own `missingCurrencies` and
 * `excludedCount`, so `PartialTotal` marks it exactly when something was left
 * out. A response that predates the fields reads as complete.
 */
export function reportTotal(
  value: number,
  report: { missingCurrencies?: readonly string[]; excludedCount?: number } | null | undefined,
): ConvertedTotal {
  return {
    value,
    missingCurrencies: [...(report?.missingCurrencies ?? [])],
    excludedCount: report?.excludedCount ?? 0,
  };
}
