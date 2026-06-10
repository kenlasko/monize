import { DEFAULT_LOCALE } from "../i18n/config";
import { UserPreference } from "./entities/user-preference.entity";

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
  preferences.language = language;
  return preferences;
}
