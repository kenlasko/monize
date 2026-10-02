/**
 * The countries a bank can be picked from: the European Economic Area, which is
 * where PSD2 open banking applies. ISO 3166-1 alpha-2, the form the provider's
 * institution listing takes as `country`.
 */
export const BANK_SYNC_COUNTRY_CODES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IS', 'IE', 'IT', 'LV', 'LI', 'LT', 'LU',
  'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
] as const;

export interface BankSyncCountryOption {
  value: string;
  label: string;
}

/**
 * The country list as select options, named in the reader's own language and
 * sorted by those names. `Intl.DisplayNames` rather than a catalog of thirty
 * country names per locale: the runtime already knows them all, and a country
 * it cannot name (or a locale it rejects) falls back to the bare code rather
 * than to a blank option.
 */
export function buildBankSyncCountryOptions(
  locale: string | undefined,
): BankSyncCountryOption[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(locale ? [locale] : undefined, {
      type: 'region',
    });
  } catch {
    names = null;
  }

  const label = (code: string): string => {
    try {
      return names?.of(code) || code;
    } catch {
      return code;
    }
  };

  let collator: Intl.Collator;
  try {
    collator = new Intl.Collator(locale);
  } catch {
    collator = new Intl.Collator();
  }

  return BANK_SYNC_COUNTRY_CODES.map((code) => ({
    value: code,
    label: label(code),
  })).sort((a, b) => collator.compare(a.label, b.label));
}
