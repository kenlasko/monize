/**
 * The currency the client reports totals in when the reader has stated no
 * preference.
 *
 * It has to be the same value the server falls back to
 * (`FALLBACK_DEFAULT_CURRENCY` in
 * `backend/src/common/default-currency.util.ts`), because both answer the same
 * question about the same user and their answers appear side by side. They were
 * `'CAD'` here and `USD` there: a preference-less user's bills page converted
 * every schedule into CAD and labelled the net CAD, while asking the assistant
 * the same question in the same session returned `totalsCurrency: "USD"` -- two
 * figures, two currencies, no conversion between them, and nothing on either
 * screen saying so.
 *
 * `src/lib/default-currency.contract.test.ts` checks this against the backend
 * constant and scans `src/` for a second literal, so the two cannot drift back
 * apart quietly.
 */
export const FALLBACK_DEFAULT_CURRENCY = 'USD';

/**
 * The reporting currency for a loaded preferences object.
 *
 * `defaultCurrency` is optional on the store and can hold the empty string (a
 * cleared select), and neither is a currency -- so the test is truthiness, not
 * `??`, which would hand `''` to `Intl.NumberFormat` and to every rate lookup.
 */
export function preferredCurrency(
  defaultCurrency: string | null | undefined,
): string {
  return defaultCurrency || FALLBACK_DEFAULT_CURRENCY;
}

/**
 * A picker option's label with its currency in brackets, unless that currency
 * is the reader's default: "Chequing" and "US Savings (USD)" for a CAD reader.
 *
 * The one rule every account and security picker follows. A code on every row
 * said nothing and hid the rows that are in another currency. Components reach
 * it through `useForeignCurrencyLabel`, which supplies the default.
 */
export function labelWithForeignCurrency(
  label: string,
  currencyCode: string,
  defaultCurrency: string | undefined,
): string {
  return !currencyCode || currencyCode === defaultCurrency
    ? label
    : `${label} (${currencyCode})`;
}
