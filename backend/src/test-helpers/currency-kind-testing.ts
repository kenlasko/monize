/**
 * The `currencies` table as INV-CRYPTO-001 reads it, for unit specs whose
 * mock `EntityManager.query` answers `assertAccountCurrencyKindIn`
 * (`backend/src/accounts/account-currency-kind.util.ts`): BTC is a coin, every
 * other code a fiat currency.
 */
export const CURRENCY_KIND_READ =
  /FROM currencies WHERE code = \$1 FOR KEY SHARE/;

/** Whether a mock `query` call is the kind read. */
export function isCurrencyKindRead(sql: unknown): boolean {
  return typeof sql === "string" && CURRENCY_KIND_READ.test(sql);
}

/**
 * The rows the kind read returns for `params[0]`, or `undefined` for any other
 * SQL so the caller's own default answers it.
 */
export function currencyKindRows(
  sql: unknown,
  params?: unknown[],
): Array<{ kind: "FIAT" | "CRYPTO" }> | undefined {
  if (!isCurrencyKindRead(sql)) return undefined;
  return [{ kind: params?.[0] === "BTC" ? "CRYPTO" : "FIAT" }];
}
