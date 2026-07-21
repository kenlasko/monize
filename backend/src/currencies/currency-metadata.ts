export interface CurrencyMetadata {
  name: string;
  symbol: string;
  decimalPlaces: number;
}

// Known currency metadata (Yahoo Finance doesn't return symbol/name directly).
// Shared by the lookup, the onboarding catalog, on-demand currency creation,
// and the backup-restore fallback so all of them set a proper symbol/name.
export const CURRENCY_METADATA: Record<string, CurrencyMetadata> = {
  USD: { name: "US Dollar", symbol: "$", decimalPlaces: 2 },
  EUR: { name: "Euro", symbol: "€", decimalPlaces: 2 },
  JPY: { name: "Japanese Yen", symbol: "¥", decimalPlaces: 0 },
  GBP: { name: "British Pound", symbol: "£", decimalPlaces: 2 },
  AUD: { name: "Australian Dollar", symbol: "A$", decimalPlaces: 2 },
  CAD: { name: "Canadian Dollar", symbol: "CA$", decimalPlaces: 2 },
  CHF: { name: "Swiss Franc", symbol: "CHF", decimalPlaces: 2 },
  CNY: { name: "Chinese Yuan", symbol: "¥", decimalPlaces: 2 },
  HKD: { name: "Hong Kong Dollar", symbol: "HK$", decimalPlaces: 2 },
  NZD: { name: "New Zealand Dollar", symbol: "NZ$", decimalPlaces: 2 },
  SEK: { name: "Swedish Krona", symbol: "kr", decimalPlaces: 2 },
  KRW: { name: "South Korean Won", symbol: "₩", decimalPlaces: 0 },
  SGD: { name: "Singapore Dollar", symbol: "S$", decimalPlaces: 2 },
  NOK: { name: "Norwegian Krone", symbol: "kr", decimalPlaces: 2 },
  MXN: { name: "Mexican Peso", symbol: "MX$", decimalPlaces: 2 },
  INR: { name: "Indian Rupee", symbol: "₹", decimalPlaces: 2 },
  RUB: { name: "Russian Ruble", symbol: "₽", decimalPlaces: 2 },
  ZAR: { name: "South African Rand", symbol: "R", decimalPlaces: 2 },
  TRY: { name: "Turkish Lira", symbol: "₺", decimalPlaces: 2 },
  BRL: { name: "Brazilian Real", symbol: "R$", decimalPlaces: 2 },
  TWD: { name: "New Taiwan Dollar", symbol: "NT$", decimalPlaces: 2 },
  DKK: { name: "Danish Krone", symbol: "kr", decimalPlaces: 2 },
  PLN: { name: "Polish Zloty", symbol: "zł", decimalPlaces: 2 },
  THB: { name: "Thai Baht", symbol: "฿", decimalPlaces: 2 },
  IDR: { name: "Indonesian Rupiah", symbol: "Rp", decimalPlaces: 0 },
  HUF: { name: "Hungarian Forint", symbol: "Ft", decimalPlaces: 2 },
  CZK: { name: "Czech Koruna", symbol: "Kč", decimalPlaces: 2 },
  ILS: { name: "Israeli Shekel", symbol: "₪", decimalPlaces: 2 },
  CLP: { name: "Chilean Peso", symbol: "CL$", decimalPlaces: 0 },
  PHP: { name: "Philippine Peso", symbol: "₱", decimalPlaces: 2 },
  SAR: { name: "Saudi Riyal", symbol: "﷼", decimalPlaces: 2 },
  AED: { name: "UAE Dirham", symbol: "AED", decimalPlaces: 2 },
  COP: { name: "Colombian Peso", symbol: "COL$", decimalPlaces: 2 },
  MYR: { name: "Malaysian Ringgit", symbol: "RM", decimalPlaces: 2 },
  PEN: { name: "Peruvian Sol", symbol: "S/", decimalPlaces: 2 },
  ARS: { name: "Argentine Peso", symbol: "AR$", decimalPlaces: 2 },
  NGN: { name: "Nigerian Naira", symbol: "₦", decimalPlaces: 2 },
  EGP: { name: "Egyptian Pound", symbol: "E£", decimalPlaces: 2 },
  VND: { name: "Vietnamese Dong", symbol: "₫", decimalPlaces: 0 },
  PKR: { name: "Pakistani Rupee", symbol: "₨", decimalPlaces: 2 },
  BDT: { name: "Bangladeshi Taka", symbol: "৳", decimalPlaces: 2 },
  KWD: { name: "Kuwaiti Dinar", symbol: "KWD", decimalPlaces: 3 },
  BHD: { name: "Bahraini Dinar", symbol: "BHD", decimalPlaces: 3 },
  OMR: { name: "Omani Rial", symbol: "OMR", decimalPlaces: 3 },
};

/**
 * Resolve display metadata (name, symbol, decimal places) for a currency code.
 * Prefers the curated table above; for codes outside it, derives a proper
 * symbol and decimal count from `Intl` where possible so we set a real symbol
 * "where possible" rather than falling back to the bare code. Only a genuinely
 * unknown/invalid code ends up with the code itself as the symbol.
 */
export function resolveCurrencyMetadata(code: string): CurrencyMetadata {
  const upper = code.toUpperCase();
  const known = CURRENCY_METADATA[upper];
  if (known) return { ...known };

  let symbol = upper;
  let decimalPlaces = 2;
  try {
    const parts = new Intl.NumberFormat("en", {
      style: "currency",
      currency: upper,
      currencyDisplay: "narrowSymbol",
    }).formatToParts(0);
    const currencyPart = parts.find((p) => p.type === "currency");
    if (currencyPart?.value) symbol = currencyPart.value;

    const resolved = new Intl.NumberFormat("en", {
      style: "currency",
      currency: upper,
    }).resolvedOptions();
    if (typeof resolved.minimumFractionDigits === "number") {
      decimalPlaces = resolved.minimumFractionDigits;
    }
  } catch {
    // Invalid ISO code: keep the code as the symbol and default 2 decimals.
  }

  return { name: upper, symbol, decimalPlaces };
}

/**
 * The full catalog of curated currencies (code + display metadata), sorted by
 * code. Used to populate the onboarding currency picker without pre-seeding
 * every currency into the database.
 */
export function getCurrencyCatalog(): Array<
  { code: string } & CurrencyMetadata
> {
  return Object.entries(CURRENCY_METADATA)
    .map(([code, meta]) => ({ code, ...meta }))
    .sort((a, b) => a.code.localeCompare(b.code));
}
