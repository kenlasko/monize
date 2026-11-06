import { roundToDecimals } from "./round.util";

/**
 * Deterministic `en-US` money formatting, for output read by a MACHINE.
 *
 * "Machine" means: an LLM prompt, and the English `description` an
 * action-history row stores as its fallback for a reader whose client cannot
 * localize it. Those are documented fixed-locale contracts -- a prompt wants
 * one stable representation, and a stored English sentence cannot be
 * translated after the fact.
 *
 * **Anything addressed to a person goes through `number-locale.util.ts`**
 * instead, built from that recipient's `numberFormat` / `language`. Forcing
 * `en-US` into a translated email put `zl18,812.71` inside Polish copy
 * (issue #1316); `backend/src/common/number-locale.guard.spec.ts` fails on a
 * new caller of the two helpers below outside the classified set.
 */

/**
 * Format a number as currency with the correct decimal places for the given currency code.
 * Uses Intl.NumberFormat so JPY gets 0 decimals, USD/EUR get 2, BHD gets 3, etc.
 * Pre-rounds to the currency's native decimal places to avoid IEEE 754 midpoint errors
 * (e.g., 159.735 stored as 159.73499... rounding to 159.73 instead of 159.74).
 *
 * @returns Formatted string with currency symbol (e.g., "$1,234.56", "¥1,235")
 */
export function formatCurrency(
  amount: number,
  currencyCode: string,
  locale = "en-US",
): string {
  try {
    const formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currencyCode,
      currencyDisplay: "narrowSymbol",
    });
    const decimals = formatter.resolvedOptions().minimumFractionDigits ?? 2;
    return formatter.format(roundToDecimals(amount, decimals));
  } catch {
    return `${amount.toFixed(2)}`;
  }
}

/**
 * Format a number with currency-aware decimal places but no currency symbol.
 * Useful for contexts where the symbol is shown separately.
 *
 * @returns Formatted string without symbol (e.g., "1,234.56", "1,235")
 */
export function formatCurrencyAmount(
  amount: number,
  currencyCode: string,
  /**
   * The places to print; defaults to the ISO minor unit. Pass
   * `decimalPlacesFor(code, currencies)` for a code that may not be ISO (a
   * coin), which `Intl` would print at 2.
   */
  decimals: number = getDecimalPlacesForCurrency(currencyCode),
): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);
}

// `supportedValuesOf` is in the runtime (Node 18+) but not in this project's
// TypeScript `lib`, so its one signature is declared here.
const ISO_CURRENCY_CODES: ReadonlySet<string> = new Set(
  (
    Intl as unknown as { supportedValuesOf(key: "currency"): string[] }
  ).supportedValuesOf("currency"),
);

/**
 * The decimal places a figure in `code` is printed at: the ISO minor unit for
 * an ISO 4217 code, else the currency row's `decimal_places` (`currencies`
 * maps a code to it), else 2.
 *
 * `Intl` answers 2 for any three letters it does not know, so a coin `BTC`
 * stored at four places would print `0.0125` as `0.01`, which is about 1,700
 * CAD of the balance gone from the text a model reads. A non-ISO code is the
 * reader's own currency, and its row says how precise it is.
 */
/** Whether `code` is an ISO 4217 code the runtime's `Intl` data lists. */
export function isIsoCurrencyCode(code: string): boolean {
  return ISO_CURRENCY_CODES.has(code.toUpperCase());
}

export function decimalPlacesFor(
  code: string,
  currencies: ReadonlyMap<string, number>,
): number {
  const upper = code.toUpperCase();
  if (isIsoCurrencyCode(upper)) return getDecimalPlacesForCurrency(upper);
  const places = currencies.get(upper);
  return typeof places === "number" && Number.isInteger(places) && places >= 0
    ? places
    : 2;
}

/**
 * Get the number of decimal places for a currency code using Intl.NumberFormat.
 * E.g., USD=2, JPY=0, BHD=3.
 */
export function getDecimalPlacesForCurrency(currencyCode: string): number {
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency: currencyCode,
      }).resolvedOptions().minimumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}
