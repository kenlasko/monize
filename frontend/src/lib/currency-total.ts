import { sumMoney } from './format';

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
 * function returning `null` when the rate is unknown. `decimals` is the target
 * currency's money precision; a fiat's four unless the caller says otherwise.
 */
export function sumConverted<T>(
  items: readonly T[],
  amountOf: (item: T) => number,
  currencyOf: (item: T) => string,
  convert: (amount: number, fromCurrency: string) => number | null,
  decimals?: number,
): ConvertedTotal {
  const converted: number[] = [];
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
    const value = convert(amount, currencyOf(item));
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
    converted.push(value);
  }

  return {
    value: sumMoney(converted, decimals),
    missingCurrencies: [...missing],
    excludedCount,
  };
}

/**
 * Merge totals that were accumulated separately -- assets and liabilities, say,
 * where a missing rate in either makes the net figure partial too.
 *
 * `combine` gets the values in the order given, so a caller can subtract as well
 * as add. Incompleteness is the union: a net worth built from a complete asset
 * total and a partial liability total is partial.
 */
export function combineTotals(
  totals: readonly ConvertedTotal[],
  combine: (values: number[]) => number,
): ConvertedTotal {
  const missing = new Set<string>();
  let excludedCount = 0;
  for (const total of totals) {
    for (const currency of total.missingCurrencies) missing.add(currency);
    excludedCount += total.excludedCount;
  }
  return {
    value: combine(totals.map((total) => total.value)),
    missingCurrencies: [...missing],
    excludedCount,
  };
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
