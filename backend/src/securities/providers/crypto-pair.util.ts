import { isKnownIsoCurrency } from "../../currencies/currency-metadata";

/**
 * The canonical `exchange` of a cryptocurrency security. Yahoo reports every coin's
 * venue as `CCC`, a code of its own that names no exchange a person picks from
 * the security form's list; the lookup stores this value instead. It has no country,
 * so it is deliberately absent from `EXCHANGE_TO_COUNTRY` and a holding lands
 * in the geographic rollup's Other bucket.
 */
export const CRYPTO_EXCHANGE = "CRYPTO";

/** Yahoo's own venue code for every coin, which a security created before the lookup named `CRYPTO` still carries. */
const YAHOO_CRYPTO_EXCHANGE = "CCC";

/** Whether a security's `exchange` names a coin's venue: `CRYPTO`, or Yahoo's legacy `CCC`. */
export function isCryptoExchange(exchange: string | null | undefined): boolean {
  const normalized = exchange?.trim().toUpperCase();
  return normalized === CRYPTO_EXCHANGE || normalized === YAHOO_CRYPTO_EXCHANGE;
}

/** Yahoo's `<COIN>-<FIAT>` convention: the fiat is three letters after the last hyphen. */
const CRYPTO_PAIR = /^[A-Z0-9][A-Z0-9-]*-([A-Z]{3})$/i;

/**
 * The fiat leg of a Yahoo crypto symbol (`BTC-EUR` -> `EUR`), or null when the
 * symbol does not follow the `<COIN>-<FIAT>` convention or its last leg is not a
 * known ISO 4217 code. The fiat is the currency every price for the symbol is
 * quoted in, so it is the security's currency; null means unknown, never USD.
 */
export function cryptoPairFiat(symbol: string): string | null {
  const match = CRYPTO_PAIR.exec(symbol.trim());
  if (!match) return null;
  const fiat = match[1].toUpperCase();
  return isKnownIsoCurrency(fiat) ? fiat : null;
}

/** The exchange and currency of a lookup result its provider typed `CRYPTO`. */
export interface CryptoLookupFields {
  readonly exchange: typeof CRYPTO_EXCHANGE;
  readonly currencyCode: string | null;
}

/**
 * What a lookup result its provider typed `CRYPTO` carries, for every provider
 * alike: the canonical exchange, and the currency the provider reported, else
 * the fiat leg of the symbol (`cryptoPairFiat`), else null. Never an exchange
 * or country guess, which reads a dotless symbol as USD -- a EUR pair saved as
 * USD then has every price refused by `verifyProviderCurrency` (issue #379).
 */
export function cryptoLookupFields(
  symbol: string,
  reportedCurrency?: string | null,
): CryptoLookupFields {
  return {
    exchange: CRYPTO_EXCHANGE,
    currencyCode: reportedCurrency || cryptoPairFiat(symbol),
  };
}
