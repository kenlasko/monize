import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "./db/scoped-db";
import { isValidIanaTimezone } from "./date-utils";

/**
 * Group all users by their effective IANA timezone so cron jobs that operate
 * on "today" can compute the local date per bucket rather than against the
 * container's UTC clock. Without this, e.g., an EST user sees their
 * scheduled transactions auto-post at 21:00 the previous local day (when
 * 02:00 UTC ticks over to the new UTC date).
 *
 * Resolution order per user:
 *   1. `user_preferences.timezone`, when it is a real IANA name (the user
 *      explicitly picked one in Settings).
 *   2. `user_preferences.last_client_timezone` -- the most recent
 *      `X-Client-Timezone` header observed by `RequestContextInterceptor`.
 *      Covers the common case where the stored timezone is still the
 *      default `"browser"` sentinel.
 *   3. `"UTC"`, only as a last resort.
 *
 * Returns an empty map when no users exist.
 *
 * RLS: this reads every user's row, so each caller is a cron handler already
 * inside `withSystemContext` (task C2). It goes through `withScopedDb` like all
 * other data access; there is no ambient identity of its own to establish.
 */
export async function getUsersByEffectiveTimezone(
  dataSource: DataSource,
): Promise<Map<string, string[]>> {
  const rows: {
    user_id: string;
    timezone: string | null;
    last_client_timezone: string | null;
  }[] = await withScopedDb(dataSource, (manager) =>
    manager.query(
      `SELECT u.id as user_id, p.timezone, p.last_client_timezone
       FROM users u
       LEFT JOIN user_preferences p ON p.user_id = u.id`,
    ),
  );

  const userIdsByTz = new Map<string, string[]>();
  for (const { user_id, timezone, last_client_timezone } of rows) {
    const tz = resolveEffectiveTimezone(timezone, last_client_timezone);
    const list = userIdsByTz.get(tz) ?? [];
    list.push(user_id);
    userIdsByTz.set(tz, list);
  }
  return userIdsByTz;
}

async function queryTimezoneColumns(
  m: EntityManager,
  userId: string,
): Promise<[string | null | undefined, string | null | undefined]> {
  const rows: {
    timezone: string | null;
    last_client_timezone: string | null;
  }[] = await m.query(
    `SELECT timezone, last_client_timezone
       FROM user_preferences
      WHERE user_id = $1`,
    [userId],
  );
  return [rows[0]?.timezone, rows[0]?.last_client_timezone];
}

/**
 * The effective IANA timezone of one user, by the rule `getUsersByEffectiveTimezone`
 * applies to everyone: the explicit preference, else the last client timezone
 * seen, else UTC. Runs on the caller's transaction.
 */
export async function getEffectiveTimezoneOfUser(
  m: EntityManager,
  userId: string,
): Promise<string> {
  return resolveEffectiveTimezone(...(await queryTimezoneColumns(m, userId)));
}

/**
 * The user's own stored or cached timezone, or `undefined` when neither is a
 * real zone (no UTC default), for a request that must leave the zone unset as
 * REST does. Runs on the caller's transaction.
 */
export async function getStoredTimezoneOfUser(
  m: EntityManager,
  userId: string,
): Promise<string | undefined> {
  return resolveStoredTimezone(...(await queryTimezoneColumns(m, userId)));
}

/** The first value that is a valid IANA zone; "browser" and blank are skipped. */
export function resolveStoredTimezone(
  timezone: string | null | undefined,
  lastClientTimezone: string | null | undefined,
): string | undefined {
  return [timezone, lastClientTimezone]
    .map((z) => z?.trim())
    .find((z): z is string => isValidIanaTimezone(z));
}

function resolveEffectiveTimezone(
  timezone: string | null | undefined,
  lastClientTimezone: string | null | undefined,
): string {
  return resolveStoredTimezone(timezone, lastClientTimezone) ?? "UTC";
}
