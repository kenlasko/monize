// `supportedValuesOf` is in every current browser and in Node 18+, but not in
// this project's TypeScript `lib`, so its one signature is declared here (the
// backend's `currency-metadata.ts` does the same).
type IntlWithSupportedValues = {
  supportedValuesOf?: (key: 'currency') => string[];
};

let isoCurrencyCodes: ReadonlySet<string> | null | undefined;

function loadIsoCurrencyCodes(): ReadonlySet<string> | null {
  if (isoCurrencyCodes !== undefined) return isoCurrencyCodes;
  try {
    const supported = (Intl as unknown as IntlWithSupportedValues).supportedValuesOf;
    isoCurrencyCodes = supported ? new Set(supported.call(Intl, 'currency')) : null;
  } catch {
    isoCurrencyCodes = null;
  }
  return isoCurrencyCodes;
}

/**
 * Whether `code` is a known ISO 4217 currency code, the way the backend decides
 * it (`isKnownIsoCurrency` in `backend/src/currencies/currency-metadata.ts`).
 * The backend's curated table is a subset of what `Intl` reports, so `Intl`
 * alone gives the same answer. A runtime without `Intl.supportedValuesOf` cannot
 * tell, and answers `true` so the caller never claims a real code is unknown.
 */
export function isKnownIsoCurrency(code: string): boolean {
  const codes = loadIsoCurrencyCodes();
  if (!codes) return true;
  return codes.has(code.trim().toUpperCase());
}
