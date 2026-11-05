import { isKnownIsoCurrency } from './iso-currency';

/**
 * Yahoo's `<COIN>-<FIAT>` convention for a coin's price symbol: the fiat is the
 * three letters after the last hyphen. The same pattern as the backend's
 * `cryptoPairFiat` (`backend/src/securities/providers/crypto-pair.util.ts`),
 * which the server applies to a currency's `quoteSymbol` before saving it.
 */
export const QUOTE_SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9-]*-([A-Z]{3})$/i;

/** The longest `quoteSymbol` the server stores (`currencies.quote_symbol VARCHAR(20)`). */
export const QUOTE_SYMBOL_MAX_LENGTH = 20;

/**
 * The fiat leg of a coin's price symbol (`BTC-EUR` -> `EUR`), or null when the
 * symbol is not a `<COIN>-<FIAT>` pair or its last leg is no ISO 4217 code.
 */
export function quoteSymbolFiat(symbol: string | null | undefined): string | null {
  const match = QUOTE_SYMBOL_PATTERN.exec((symbol ?? '').trim());
  if (!match) return null;
  const fiat = match[1].toUpperCase();
  return isKnownIsoCurrency(fiat) ? fiat : null;
}
