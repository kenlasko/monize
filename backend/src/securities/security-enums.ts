/**
 * Canonical security `exchange` and `securityType` values.
 *
 * Both columns are free-text on the entity, but the user-facing pickers offer a
 * fixed list (frontend `EXCHANGE_OPTIONS` in `lib/constants.ts` and
 * `SECURITY_TYPE_OPTIONS` in `app/import/import-utils.ts`). The AI Assistant and
 * MCP `create_security` tools constrain their `exchange`/`securityType`
 * arguments to these same lists so the model picks from known values instead of
 * inventing one. Keep these in sync with the frontend lists
 * (`frontend/src/lib/constants.test.ts` holds the exchange list to it).
 */

export const SECURITY_EXCHANGES = [
  // North America
  "NYSE",
  "NASDAQ",
  "AMEX",
  "ARCA",
  "BATS",
  "TSX",
  "TSX-V",
  "CSE",
  "NEO",
  // Europe
  "LSE",
  "XETRA",
  "Frankfurt",
  "Paris",
  "AMS",
  "MIL",
  "STO",
  // Asia-Pacific
  "Tokyo",
  "HKEX",
  "SHA",
  "SHE",
  "ASX",
  "KRX",
  "TAI",
  "SGX",
  "BSE",
  "NSE",
  // Cryptocurrency: a Yahoo `<COIN>-<FIAT>` pair, which trades on no exchange
  // and has no country (so it is absent from `EXCHANGE_TO_COUNTRY`).
  "CRYPTO",
] as const;

export type SecurityExchange = (typeof SECURITY_EXCHANGES)[number];

export const SECURITY_TYPES = [
  "STOCK",
  "ETF",
  "MUTUAL_FUND",
  "BOND",
  "OPTION",
  "GIC",
  "CRYPTO",
  "CASH",
  "OTHER",
] as const;

export type SecurityType = (typeof SECURITY_TYPES)[number];

/**
 * Canonical country names for manual ETF/fund country allocations.
 *
 * Yahoo/MSN don't expose underlying country exposure for funds, so users (and
 * the AI Assistant / MCP tools) enter it by hand. Picking from a fixed list
 * keeps names from drifting into near-duplicates ("USA" vs "United States").
 * The frontend `COUNTRY_OPTIONS` in `lib/constants.ts` offers the same list;
 * keep the two in sync. Custom values are still allowed (combobox / free-text),
 * but `normalizeCountryName` snaps common aliases and casing back to canonical.
 */
export const COUNTRY_OPTIONS = [
  "United States",
  "Canada",
  "United Kingdom",
  "Germany",
  "France",
  "Switzerland",
  "Netherlands",
  "Italy",
  "Spain",
  "Sweden",
  "Norway",
  "Denmark",
  "Finland",
  "Belgium",
  "Austria",
  "Ireland",
  "Portugal",
  "Luxembourg",
  "Poland",
  "Greece",
  "Czech Republic",
  "Hungary",
  "Russia",
  "Turkey",
  "Japan",
  "China",
  "Hong Kong",
  "Taiwan",
  "South Korea",
  "India",
  "Australia",
  "New Zealand",
  "Singapore",
  "Malaysia",
  "Indonesia",
  "Thailand",
  "Philippines",
  "Vietnam",
  "Pakistan",
  "Israel",
  "Saudi Arabia",
  "United Arab Emirates",
  "Qatar",
  "Kuwait",
  "South Africa",
  "Egypt",
  "Nigeria",
  "Kenya",
  "Morocco",
  "Brazil",
  "Mexico",
  "Argentina",
  "Chile",
  "Colombia",
  "Peru",
] as const;

export type CountryOption = (typeof COUNTRY_OPTIONS)[number];

/**
 * Common aliases / abbreviations mapped to their canonical `COUNTRY_OPTIONS`
 * name. Keys are lower-cased. Extends the exact-match snapping done in
 * `normalizeCountryName`.
 */
const COUNTRY_ALIASES: Record<string, string> = {
  usa: "United States",
  us: "United States",
  "u.s.": "United States",
  "u.s.a.": "United States",
  america: "United States",
  "united states of america": "United States",
  uk: "United Kingdom",
  "u.k.": "United Kingdom",
  britain: "United Kingdom",
  "great britain": "United Kingdom",
  england: "United Kingdom",
  uae: "United Arab Emirates",
  "south korea": "South Korea",
  korea: "South Korea",
  "republic of korea": "South Korea",
  czechia: "Czech Republic",
  "russian federation": "Russia",
};

/**
 * Snap a free-text country name to its canonical `COUNTRY_OPTIONS` value when
 * possible: trims, resolves known aliases, then matches case-insensitively
 * against the canonical list. Unknown values are returned trimmed (custom
 * countries are allowed). Empty / blank input returns "".
 */
export function normalizeCountryName(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (COUNTRY_ALIASES[lower]) return COUNTRY_ALIASES[lower];
  const match = COUNTRY_OPTIONS.find((c) => c.toLowerCase() === lower);
  return match ?? trimmed;
}

/**
 * The asset classes the look-through rollup knows by name, written once. The
 * frontend translates each key; its copy is checked against this list by
 * `frontend/src/lib/asset-classes.contract.test.ts`.
 */
export const ASSET_CLASS_KEYS = [
  "equity",
  "fixedIncome",
  "cash",
  "preferred",
  "convertible",
  "crypto",
] as const;

export type AssetClassKey = (typeof ASSET_CLASS_KEYS)[number];

/**
 * The English name of each canonical class, returned beside the key for the
 * surfaces that do not translate it (the AI assistant and MCP tools).
 */
export const ASSET_CLASS_LABELS: Record<AssetClassKey, string> = {
  equity: "Equities",
  fixedIncome: "Fixed Income",
  cash: "Cash",
  preferred: "Preferred Shares",
  convertible: "Convertibles",
  crypto: "Crypto",
};

/**
 * Every name this codebase or its provider writes for a canonical class, plus
 * the plain English variants a user types for the same thing. Keys are
 * normalised by `canonicalAssetClassKey` (lower case, "&" read as "and",
 * punctuation and runs of whitespace collapsed to one space).
 *
 * Yahoo's fund breakdown (`parseAssetPositions`) writes "Stocks", "Bonds",
 * "Cash", "Preferred", "Convertible"; the security-type defaults below are keys
 * already. A name not listed here is the user's own and stays as typed.
 */
const ASSET_CLASS_ALIASES: Record<string, AssetClassKey> = {
  equity: "equity",
  equities: "equity",
  stock: "equity",
  stocks: "equity",
  "fixed income": "fixedIncome",
  bond: "fixedIncome",
  bonds: "fixedIncome",
  cash: "cash",
  "cash equivalents": "cash",
  "cash and equivalents": "cash",
  "cash and cash equivalents": "cash",
  preferred: "preferred",
  preferreds: "preferred",
  "preferred shares": "preferred",
  "preferred stock": "preferred",
  "preferred stocks": "preferred",
  convertible: "convertible",
  convertibles: "convertible",
  "convertible securities": "convertible",
  crypto: "crypto",
  cryptocurrency: "crypto",
  cryptocurrencies: "crypto",
};

/** The aliases plus each key itself, so a key reads back as its own class. */
const ASSET_CLASS_LOOKUP = new Map<string, AssetClassKey>([
  ...ASSET_CLASS_KEYS.map((key): [string, AssetClassKey] => [
    key.toLowerCase(),
    key,
  ]),
  ...Object.entries(ASSET_CLASS_ALIASES),
]);

/**
 * The canonical class a free-text asset-class name stands for, or null when it
 * names none of them (a class the user invented, such as "Real Estate").
 */
export function canonicalAssetClassKey(
  name: string | null | undefined,
): AssetClassKey | null {
  const normalized = (name ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return ASSET_CLASS_LOOKUP.get(normalized) ?? null;
}

/**
 * Default asset class for a security that carries no manual asset breakdown of
 * its own, by security type -- the asset-class counterpart of
 * `EXCHANGE_TO_COUNTRY`. A held stock is equity exposure whether or not the
 * user has spelled that out, and the same goes for a bond or a crypto holding.
 *
 * Types whose asset mix genuinely cannot be inferred (ETF/MUTUAL_FUND without a
 * manual breakdown, OPTION, GIC, OTHER) are intentionally absent: their value
 * falls into the look-through's unclassified "Other" bucket instead of being
 * guessed at. The values are canonical keys, so a type default and a fund's
 * "Stocks" slice land in the same bucket.
 */
export const SECURITY_TYPE_TO_ASSET_CLASS: Record<string, AssetClassKey> = {
  STOCK: "equity",
  Equity: "equity",
  BOND: "fixedIncome",
  CRYPTO: "crypto",
  CASH: "cash",
};

/**
 * The default asset class for a security type, or null when the type says
 * nothing definite about the underlying asset mix.
 */
export function assetClassForSecurityType(
  securityType: string | null | undefined,
): AssetClassKey | null {
  if (!securityType) return null;
  return SECURITY_TYPE_TO_ASSET_CLASS[securityType] ?? null;
}

/**
 * Tidy a free-text allocation name (asset classes) without snapping it to any
 * canonical list: trims and collapses runs of internal whitespace so "Fixed
 * Income" and "Fixed  Income" are the same value. Empty / blank input returns
 * "". Unlike countries, a stored asset-class name is kept as typed -- the
 * picker offers whatever the user has already saved; the rollup reads it
 * through `canonicalAssetClassKey` when it merges buckets.
 */
export function normalizeAssetName(input: string): string {
  return (input ?? "").trim().replace(/\s+/g, " ");
}

/**
 * True when an allocation slice name is the catch-all "Other" bucket (which
 * providers often include in their breakdowns). Such slices must NOT be stored
 * or rendered as a country -- their weight is folded into the single computed
 * "Other" remainder instead. Matches the literal name case-insensitively.
 */
export function isOtherAllocationName(name: string): boolean {
  return (name ?? "").trim().toLowerCase() === "other";
}

/**
 * Maps an ISO 4217 currency code to the canonical `COUNTRY_OPTIONS` country it
 * is the primary currency of. Used to float the user's base-currency country to
 * the top of the manual country-allocation picker. Currencies without a single
 * country (notably the Euro, shared across the Eurozone) are intentionally
 * omitted -- those users get a plain alphabetical list.
 */
export const CURRENCY_TO_COUNTRY: Record<string, string> = {
  USD: "United States",
  CAD: "Canada",
  GBP: "United Kingdom",
  CHF: "Switzerland",
  SEK: "Sweden",
  NOK: "Norway",
  DKK: "Denmark",
  PLN: "Poland",
  CZK: "Czech Republic",
  HUF: "Hungary",
  RUB: "Russia",
  TRY: "Turkey",
  JPY: "Japan",
  CNY: "China",
  HKD: "Hong Kong",
  TWD: "Taiwan",
  KRW: "South Korea",
  INR: "India",
  AUD: "Australia",
  NZD: "New Zealand",
  SGD: "Singapore",
  MYR: "Malaysia",
  IDR: "Indonesia",
  THB: "Thailand",
  PHP: "Philippines",
  VND: "Vietnam",
  PKR: "Pakistan",
  ILS: "Israel",
  SAR: "Saudi Arabia",
  AED: "United Arab Emirates",
  QAR: "Qatar",
  KWD: "Kuwait",
  ZAR: "South Africa",
  EGP: "Egypt",
  NGN: "Nigeria",
  KES: "Kenya",
  MAD: "Morocco",
  BRL: "Brazil",
  MXN: "Mexico",
  ARS: "Argentina",
  CLP: "Chile",
  COP: "Colombia",
  PEN: "Peru",
};

/**
 * The canonical country a currency code belongs to, or null when the currency
 * is not tied to a single `COUNTRY_OPTIONS` country (e.g. the Euro).
 */
export function countryForCurrency(
  code: string | null | undefined,
): string | null {
  if (!code) return null;
  return CURRENCY_TO_COUNTRY[code.trim().toUpperCase()] ?? null;
}

/**
 * Maps a canonical `SECURITY_EXCHANGES` code to the country its listings trade
 * in. Used by the country-weightings rollup to place individual stocks (which
 * have no manual breakdown) into a country by their listing exchange.
 */
export const EXCHANGE_TO_COUNTRY: Record<string, string> = {
  NYSE: "United States",
  NASDAQ: "United States",
  AMEX: "United States",
  ARCA: "United States",
  BATS: "United States",
  TSX: "Canada",
  "TSX-V": "Canada",
  CSE: "Canada",
  NEO: "Canada",
  LSE: "United Kingdom",
  XETRA: "Germany",
  Frankfurt: "Germany",
  Paris: "France",
  AMS: "Netherlands",
  MIL: "Italy",
  STO: "Sweden",
  Tokyo: "Japan",
  HKEX: "Hong Kong",
  SHA: "China",
  SHE: "China",
  ASX: "Australia",
  KRX: "South Korea",
  TAI: "Taiwan",
  SGX: "Singapore",
  BSE: "India",
  NSE: "India",
};
