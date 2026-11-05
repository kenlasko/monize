/**
 * The decimal places of the reader's currencies, as the Currencies page stores
 * them, for the formatters to consult before `Intl`.
 *
 * `Intl` knows the minor unit of every ISO 4217 currency and nothing else: a
 * code it has never heard of (a coin such as `BTC`, which the Currencies page
 * can hold with four places) formats at two, so `0.0125` BTC read as `0.01`.
 * The currency rows carry their own `decimalPlaces`; this registry holds them
 * so `useNumberFormat().formatCurrency`, `formatCurrencyPrecise` and
 * `getDecimalPlacesForCurrency` can answer from the row first.
 *
 * Only a code `Intl` does not know is held (`isKnownIsoCurrency` false). For an
 * ISO currency `Intl` already knows the minor unit, and a stored
 * `decimal_places` that disagrees with it must never change how an existing
 * fiat balance renders, so an ISO row is not registered at all.
 *
 * Filled by `CurrencyRegistryLoader` once per signed-in session and by the
 * Currencies page after it loads or saves a currency; emptied on sign-out. A
 * code the registry does not hold falls back to `Intl`, so nothing throws
 * before the list arrives or when it fails to.
 *
 * Module state rather than a store: it is reference data the server owns, not
 * user input, and it must be readable from the pure helpers in `lib/format.ts`.
 * Components still re-render when it changes, because `useNumberFormat`
 * subscribes through `subscribeCurrencyDecimals`.
 */

import { createListenerSet } from './helpers/create-listener-set';
import { isKnownIsoCurrency } from './iso-currency';

/** The widest precision a currency row may carry (`CreateCurrencyDto` caps it at 4). */
const MAX_DECIMAL_PLACES = 4;

const decimalsByCode = new Map<string, number>();
const listeners = createListenerSet();
let version = 0;

function notify(): void {
  version += 1;
  listeners.notify();
}

function isUsableDecimalPlaces(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_DECIMAL_PLACES
  );
}

/**
 * Record the decimal places of each currency `Intl` does not know. A later
 * entry for a code replaces an earlier one; an ISO code, and a row whose
 * `decimalPlaces` is not a whole number from 0 to 4, are skipped, leaving that
 * code to `Intl`.
 */
export function registerCurrencyDecimals(
  currencies: readonly { code: string; decimalPlaces: number }[],
): void {
  let changed = false;
  for (const currency of currencies) {
    const code = currency?.code?.trim().toUpperCase();
    if (!code || isKnownIsoCurrency(code) || !isUsableDecimalPlaces(currency.decimalPlaces)) continue;
    if (decimalsByCode.get(code) !== currency.decimalPlaces) {
      decimalsByCode.set(code, currency.decimalPlaces);
      changed = true;
    }
  }
  if (changed) notify();
}

/** The registered decimal places of `code`, or `undefined` when the registry does not hold it. */
export function decimalPlacesForCurrency(code: string | null | undefined): number | undefined {
  if (!code) return undefined;
  return decimalsByCode.get(code.trim().toUpperCase());
}

/** Empty the registry: on sign-out, and between tests. */
export function clearCurrencyDecimals(): void {
  if (decimalsByCode.size === 0) return;
  decimalsByCode.clear();
  notify();
}

/** Subscribe to changes, in the shape `useSyncExternalStore` takes. */
export const subscribeCurrencyDecimals = listeners.subscribe;

/** A number that changes whenever the registry does, for `useSyncExternalStore`. */
export function currencyDecimalsVersion(): number {
  return version;
}
