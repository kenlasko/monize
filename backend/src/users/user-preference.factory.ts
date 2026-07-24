import { DEFAULT_LOCALE } from "../i18n/config";
import { UserPreference } from "./entities/user-preference.entity";

// A freshly materialized preferences row starts already caught up to the
// running version, so the "What's New" digest never auto-opens for a brand-new
// account -- a first-time user has nothing "new" to catch up on, and the popup
// must not cover the getting-started onboarding. Read from the backend
// package.json, matching how UpdatesService / ReleaseNotesService resolve it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const backendPkg = require("../../package.json") as { version: string };

/**
 * Build a new user's default preferences.
 *
 * Locale-dependent display settings (date/number format, timezone, theme) use
 * the `browser` / `system` sentinels so the frontend resolves them from the
 * client environment on every render. `language`, by contrast, is stored as a
 * concrete locale: the UI language is an explicit, account-level choice that
 * must follow the user across devices and sessions rather than being
 * re-detected each time.
 *
 * Shared by every path that first materializes a preferences row -- eager
 * creation at account registration / first OIDC login (`AuthService`), lazy
 * creation on first access (`UsersService.getPreferences`), and the
 * update-dismissal fallback (`UpdatesService`) -- so all new accounts start
 * from one consistent baseline. Columns not set here fall back to the entity's
 * own database defaults.
 */
export function buildDefaultPreferences(
  userId: string,
  language: string = DEFAULT_LOCALE,
): UserPreference {
  const preferences = new UserPreference();
  preferences.userId = userId;
  preferences.defaultCurrency = "USD";
  preferences.dateFormat = "browser";
  preferences.numberFormat = "browser";
  preferences.theme = "system";
  preferences.timezone = "browser";
  preferences.notificationEmail = true;
  preferences.notificationBrowser = true;
  preferences.twoFactorEnabled = false;
  preferences.gettingStartedDismissed = false;
  preferences.favouriteReportIds = [];
  preferences.showWhatsNew = true;
  preferences.tourProgress = {};
  preferences.lastSeenVersion = backendPkg.version;
  preferences.language = language;
  return preferences;
}
