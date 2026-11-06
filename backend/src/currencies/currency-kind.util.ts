import { cryptoPairFiat } from "../securities/providers/crypto-pair.util";
import { CurrencyKind } from "./entities/currency.entity";

/**
 * Why a currency's price symbol is refused, as the `errors.currencies.*` key
 * that says so (`docs/specs/crypto-accounts.md`, section 5), or `null` when the
 * pair of kind and symbol may be stored:
 *
 * - a symbol on a FIAT currency is `quoteSymbolRequiresCrypto` (the CHECK
 *   `currencies_quote_symbol_crypto_only` holds the same rule in the database);
 * - a symbol with no `<COIN>-<FIAT>` fiat leg is `quoteSymbolNotAPair`, because
 *   the crypto exchange rate provider prices a coin against the fiat that leg
 *   names (`cryptoPairFiat`);
 * - a CRYPTO currency without a symbol is allowed: a coin no provider quotes,
 *   whose balances are unknown in every converted total (INV-FX-001).
 */
export type QuoteSymbolRefusal =
  "quoteSymbolRequiresCrypto" | "quoteSymbolNotAPair";

export function quoteSymbolRefusal(
  kind: CurrencyKind,
  quoteSymbol: string | null,
): QuoteSymbolRefusal | null {
  if (quoteSymbol === null) return null;
  if (kind !== "CRYPTO") return "quoteSymbolRequiresCrypto";
  if (cryptoPairFiat(quoteSymbol) === null) return "quoteSymbolNotAPair";
  return null;
}

/**
 * The Yahoo coin ticker of a `<COIN>-<FIAT>` symbol: everything before the
 * last hyphen (`BTC-EUR` -> `BTC`, `USDT-X-CAD` -> `USDT-X`). The ticker need
 * not equal the three-letter Monize code (`DOG` priced from `DOGE-USD`,
 * decision 3). `null` when the symbol is not a pair.
 */
export function quoteSymbolCoinTicker(quoteSymbol: string): string | null {
  if (cryptoPairFiat(quoteSymbol) === null) return null;
  const symbol = quoteSymbol.trim().toUpperCase();
  return symbol.slice(0, symbol.lastIndexOf("-"));
}
