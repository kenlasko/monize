/**
 * The decimal places of the reader's currencies, as the Currencies page stores
 * them, for the formatters to consult before `Intl`.
 *
 * `Intl` knows the minor unit of every ISO 4217 currency and nothing else: a
 * code it has never heard of (a coin such as `BTC`, which the Currencies page
 * can hold with eight places) formats at two, so `0.0125` BTC read as `0.01`.
 * The currency rows carry their own `decimalPlaces`; this registry holds them
 * so `useNumberFormat().formatCurrency`, `formatCurrencyPrecise` and
 * `getDecimalPlacesForCurrency` can answer from the row first.
 *
 * Only a code `Intl` does not know is held (`isKnownIsoCurrency` false). For an
 * ISO currency `Intl` already knows the minor unit, and a stored
 * `decimal_places` that disagrees with it must never change how an existing
 * fiat balance renders, so an ISO row is not registered at all.
 *
 * The row's `symbol` is held beside its places. `Intl` writes an unknown code
 * as the code itself ("BTC 0.0070"), so the formatters put the stored symbol
 * in its place ("₿0.0070"); a row without a usable symbol (blank, or the code
 * itself) keeps `Intl`'s code.
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

/**
 * The widest precision a currency row may carry: `CreateCurrencyDto` caps it at
 * 8, the money column scale (`MONEY_SCALE` in `lib/format.ts`).
 */
const MAX_DECIMAL_PLACES = 8;

interface RegisteredCurrency {
  decimalPlaces: number;
  /** The stored symbol, or `undefined` when the row has none worth showing. */
  symbol: string | undefined;
}

const currenciesByCode = new Map<string, RegisteredCurrency>();
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

/** A stored symbol worth showing in place of the code: non-blank, and not the code itself. */
function usableSymbol(symbol: unknown, code: string): string | undefined {
  if (typeof symbol !== 'string') return undefined;
  const trimmed = symbol.trim();
  return trimmed && trimmed.toUpperCase() !== code ? trimmed : undefined;
}

/**
 * Record the decimal places and symbol of each currency `Intl` does not know.
 * A later entry for a code replaces an earlier one; an ISO code, and a row
 * whose `decimalPlaces` is not a whole number from 0 to 8, are skipped, leaving
 * that code to `Intl`.
 */
export function registerCurrencyDecimals(
  currencies: readonly { code: string; decimalPlaces: number; symbol?: string | null }[],
): void {
  let changed = false;
  for (const currency of currencies) {
    const code = currency?.code?.trim().toUpperCase();
    if (!code || isKnownIsoCurrency(code) || !isUsableDecimalPlaces(currency.decimalPlaces)) continue;
    const symbol = usableSymbol(currency.symbol, code);
    const held = currenciesByCode.get(code);
    if (held?.decimalPlaces !== currency.decimalPlaces || held.symbol !== symbol) {
      currenciesByCode.set(code, { decimalPlaces: currency.decimalPlaces, symbol });
      changed = true;
    }
  }
  if (changed) notify();
}

/** The registered decimal places of `code`, or `undefined` when the registry does not hold it. */
export function decimalPlacesForCurrency(code: string | null | undefined): number | undefined {
  if (!code) return undefined;
  return currenciesByCode.get(code.trim().toUpperCase())?.decimalPlaces;
}

/**
 * The registered symbol of `code` (`₿` for a BTC row that stores one), or
 * `undefined` when the registry does not hold the code or its row has no usable
 * symbol: the formatters then keep the code `Intl` writes.
 */
export function symbolForCurrency(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  return currenciesByCode.get(code.trim().toUpperCase())?.symbol;
}

/**
 * The symbol to show for `code`, wherever the app shows one (an input's prefix,
 * a figure composed from a symbol and a number): the registered symbol of a
 * non-ISO currency first (`₿`), else `Intl`'s narrow symbol (`$`, `€`, and the
 * code itself for a currency `Intl` does not know), else `unknownFallback`
 * when `Intl` rejects the code outright, which defaults to the code.
 *
 * The one derivation: `getCurrencySymbol` (`lib/format.ts`) is this with the
 * `$` fallback it has always had. An ISO code is never registered, so its
 * symbol is exactly `Intl`'s.
 */
export function currencySymbolFor(code: string, unknownFallback: string = code): string {
  const registered = symbolForCurrency(code);
  if (registered) return registered;
  try {
    return (
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency: code,
        currencyDisplay: 'narrowSymbol',
      })
        .formatToParts(0)
        .find((part) => part.type === 'currency')?.value || unknownFallback
    );
  } catch {
    return unknownFallback;
  }
}

/** Empty the registry: on sign-out, and between tests. */
export function clearCurrencyDecimals(): void {
  if (currenciesByCode.size === 0) return;
  currenciesByCode.clear();
  notify();
}

/** Subscribe to changes, in the shape `useSyncExternalStore` takes. */
export const subscribeCurrencyDecimals = listeners.subscribe;

/** A number that changes whenever the registry does, for `useSyncExternalStore`. */
export function currencyDecimalsVersion(): number {
  return version;
}
