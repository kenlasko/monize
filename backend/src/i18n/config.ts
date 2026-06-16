/**
 * Backend mirror of `frontend/src/i18n/config.ts`. Keep the two lists in sync.
 *
 * Locale codes are ISO 639-1 (e.g. 'en', 'fr') or BCP 47 tags (e.g. 'pt-BR')
 * and must match folder names under `backend/src/i18n/locales/`.
 */

export const DEFAULT_LOCALE = "en";

// 'en' ships in every environment. The other entries (except 'xx') are full
// translations: German, Spanish, French, Hindi, Indonesian, Italian,
// Japanese, Korean, Dutch, Polish, European Portuguese, Brazilian Portuguese,
// Russian, Turkish, Ukrainian, Vietnamese, Simplified Chinese, and Traditional
// Chinese. 'xx' is the pseudo-locale used for translation QA: it wraps every
// catalog string in `[XX-...-XX]` markers so untranslated backend strings
// (those not routed through `tr()`) stand out when the request locale is `xx`.
// Mirrors the frontend's `xx` devOnly locale (see frontend/src/i18n/config.ts),
// which hides it from the language picker in production.
export const SUPPORTED_LOCALE_CODES: readonly string[] = [
  "de",
  "en",
  "en-US",
  "en-CA",
  "en-GB",
  "es",
  "fr",
  "hi",
  "id",
  "it",
  "ja",
  "ko",
  "nl",
  "pl",
  "pt",
  "pt-BR",
  "ru",
  "tr",
  "uk",
  "vi",
  "zh-CN",
  "zh-TW",
  "xx",
];

/**
 * Regional variants and the base locale they inherit from. A variant catalog
 * holds only the keys that differ from its base; nestjs-i18n falls back to
 * `fallbackLanguage` ('en') for the rest. Mirrors the frontend `base` field in
 * `frontend/src/i18n/config.ts`. Used by the parity test to apply subset
 * (rather than full-mirror) checks to variant locales.
 */
export const LOCALE_BASES: Readonly<Record<string, string>> = {
  "en-US": "en",
  "en-CA": "en",
  "en-GB": "en",
};

export function localeBase(
  code: string | undefined | null,
): string | undefined {
  if (!code) return undefined;
  return LOCALE_BASES[code];
}

export function isSupportedLocale(code: string | undefined | null): boolean {
  if (!code) return false;
  return SUPPORTED_LOCALE_CODES.includes(code);
}
