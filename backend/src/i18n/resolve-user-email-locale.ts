import { Repository } from "typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { isSupportedLocale } from "./config";
import { currentRequestLocale } from "./request-locale";

/**
 * Resolve the locale an email addressed to `userId` should be rendered in.
 *
 * Email copy must match the recipient's own language, not the request locale of
 * whoever triggered the send (an admin provisioning an account, a scheduler, or
 * an attacker tripping the failed-login lockout). Precedence:
 *
 * 1. the recipient's stored, concrete `user_preferences.language`;
 * 2. otherwise -- when the user has no row, no preference, or the "browser"
 *    follow-the-browser sentinel -- the current request/browser locale;
 * 3. otherwise the default locale (what {@link currentRequestLocale} returns
 *    outside an HTTP context, e.g. cron jobs and fire-and-forget sends).
 *
 * The "browser" sentinel and any unsupported value are treated as "no concrete
 * stored preference" so they fall through rather than being handed to the
 * translator verbatim.
 *
 * @param preferencesRepo repository for {@link UserPreference}
 * @param userId the recipient's user id, or null/undefined when the recipient
 *   is not a known Monize user (e.g. an emergency contact without an account)
 */
export async function resolveUserEmailLocale(
  preferencesRepo: Repository<UserPreference>,
  userId: string | null | undefined,
): Promise<string> {
  if (userId) {
    const prefs = await preferencesRepo.findOne({ where: { userId } });
    const stored = prefs?.language;
    if (stored && stored !== "browser" && isSupportedLocale(stored)) {
      return stored;
    }
  }
  return currentRequestLocale();
}
