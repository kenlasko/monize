/**
 * What a currency is (`currencies.kind`, `docs/specs/crypto-accounts.md`
 * decision 1). The reader states it; nothing infers it from the code, because a
 * non-ISO code may be a fiat currency too.
 *
 * Its own module, beside `exchange-rates.ts` which re-exports it, so a test
 * that mocks the exchange-rate client still gets the list.
 */
export const CURRENCY_KINDS = ['FIAT', 'CRYPTO'] as const;

export type CurrencyKind = (typeof CURRENCY_KINDS)[number];
