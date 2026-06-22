/**
 * Canonical security `exchange` and `securityType` values.
 *
 * Both columns are free-text on the entity, but the user-facing pickers offer a
 * fixed list (frontend `EXCHANGE_OPTIONS` in `lib/constants.ts` and
 * `SECURITY_TYPE_OPTIONS` in `app/import/import-utils.ts`). The AI Assistant and
 * MCP `create_security` tools constrain their `exchange`/`securityType`
 * arguments to these same lists so the model picks from known values instead of
 * inventing one. Keep these in sync with the frontend lists.
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
