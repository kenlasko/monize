import { I18nContext } from "nestjs-i18n";
import { DEFAULT_LOCALE, isSupportedLocale } from "./config";

/**
 * Resolve the locale nestjs-i18n picked for the active request, suitable for
 * persisting as a new user's `language` preference.
 *
 * The locale comes from the same resolver chain used for translations: the
 * `x-locale` header set by the frontend proxy (which derives it from the
 * `NEXT_LOCALE` cookie, itself seeded from `Accept-Language` on first visit),
 * the `NEXT_LOCALE` cookie directly, or `Accept-Language`. This is how a brand
 * new account captures the browser-detected UI language at creation time so it
 * survives later logins instead of reverting to English.
 *
 * Returns `DEFAULT_LOCALE` outside an HTTP context (background jobs, schedulers,
 * unit tests) and never returns the `xx` pseudo-locale -- that is a translation
 * QA tool, not a language a real user should be permanently stored into.
 */
export function currentRequestLocale(): string {
  const lang = I18nContext.current()?.lang;
  if (lang && lang !== "xx" && isSupportedLocale(lang)) {
    return lang;
  }
  return DEFAULT_LOCALE;
}
