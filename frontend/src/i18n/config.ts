/**
 * Single source of truth for the languages Monize supports in the UI.
 *
 * To add a new language, add an entry to SUPPORTED_LOCALES and create a
 * matching messages folder at `src/i18n/messages/{code}/` (copy from `en/`
 * and translate). The backend reads its own locale list from
 * `backend/src/i18n/config.ts` -- keep the two in sync.
 *
 * See `src/i18n/messages/README.md` for the contributor flow.
 */

export interface SupportedLocale {
  /** BCP 47 tag (lowercased region prefix, uppercase region). */
  code: string;
  /** Native-language label shown in the language picker. */
  label: string;
  /** Writing direction. */
  dir: "ltr" | "rtl";
  /**
   * If true, only available outside production. Used for the pseudo-locale
   * that wraps every string with markers so missing extractions are visible.
   */
  devOnly?: boolean;
  /**
   * Regional variant: the locale this one inherits from. Variant catalogs hold
   * only the keys that differ from the base; every other key falls back to the
   * base at load time (see `loadNamespace` in `messages.ts`). Unlike the full
   * translations, a variant folder may be partial or absent.
   */
  base?: string;
}

export const DEFAULT_LOCALE = "en";

const ALL_LOCALES: readonly SupportedLocale[] = [
  { code: "de", label: "Deutsch", dir: "ltr" },
  { code: "en", label: "English", dir: "ltr" },
  { code: "en-US", label: "English (US)", dir: "ltr", base: "en" },
  { code: "en-CA", label: "English (Canada)", dir: "ltr", base: "en" },
  { code: "en-GB", label: "English (UK)", dir: "ltr", base: "en" },
  { code: "es", label: "Español", dir: "ltr" },
  { code: "fr", label: "Français", dir: "ltr" },
  { code: "it", label: "Italiano", dir: "ltr" },
  { code: "nl", label: "Nederlands", dir: "ltr" },
  { code: "pl", label: "Polski", dir: "ltr" },
  { code: "pt", label: "Português", dir: "ltr" },
  { code: "pt-BR", label: "Português (Brasil)", dir: "ltr" },
  { code: "xx", label: "Pseudo (debug)", dir: "ltr", devOnly: true },
];

export const SUPPORTED_LOCALES: readonly SupportedLocale[] =
  process.env.NODE_ENV === "production"
    ? ALL_LOCALES.filter((l) => !l.devOnly)
    : ALL_LOCALES;

export const SUPPORTED_LOCALE_CODES: readonly string[] = SUPPORTED_LOCALES.map(
  (l) => l.code,
);

export function isSupportedLocale(code: string | undefined | null): boolean {
  if (!code) return false;
  return SUPPORTED_LOCALE_CODES.includes(code);
}

export function resolveLocale(candidate: string | undefined | null): string {
  return isSupportedLocale(candidate) ? (candidate as string) : DEFAULT_LOCALE;
}

export function getLocaleDir(code: string): "ltr" | "rtl" {
  const locale = SUPPORTED_LOCALES.find((l) => l.code === code);
  return locale?.dir ?? "ltr";
}

/**
 * The base locale a regional variant inherits from (e.g. `en` for `en-GB`), or
 * `undefined` for full locales. Used by the message loader to merge a variant's
 * partial overrides over its base, and by the parity test to apply subset
 * (rather than full-mirror) checks to variants.
 */
export function localeBase(code: string | undefined | null): string | undefined {
  if (!code) return undefined;
  return SUPPORTED_LOCALES.find((l) => l.code === code)?.base;
}

/** Best-effort match of an Accept-Language header against supported locales. */
export function matchAcceptLanguage(header: string | null | undefined): string {
  if (!header) return DEFAULT_LOCALE;
  const parts = header
    .split(",")
    .map((p) => p.trim().split(";")[0]?.trim())
    .filter(Boolean);
  for (const tag of parts) {
    if (isSupportedLocale(tag)) return tag;
    const primary = tag.split("-")[0];
    if (isSupportedLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}

/** Human-readable label (native name) for a locale code, or the code itself. */
export function getLocaleLabel(code: string): string {
  return SUPPORTED_LOCALES.find((l) => l.code === code)?.label ?? code;
}

/**
 * The supported locale that best matches the browser's configured languages.
 * Backs the "use browser locale" language preference. Falls back to
 * DEFAULT_LOCALE when called off the client (no `navigator`).
 */
export function detectBrowserLocale(): string {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const languages =
    navigator.languages && navigator.languages.length > 0
      ? navigator.languages.join(",")
      : navigator.language;
  return matchAcceptLanguage(languages);
}

export const LOCALE_COOKIE = "NEXT_LOCALE";
export const LOCALE_HEADER = "x-locale";
