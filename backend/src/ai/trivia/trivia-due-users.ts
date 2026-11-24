import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { getUsersByEffectiveTimezone } from "../../common/users-by-timezone.util";
import { zonedWallClock } from "../../securities/providers/market-session.util";

/**
 * The first local hours of a day (00:00 to 03:59) in which a reader's list is
 * built. The job ticks hourly, so a reader is reached on four ticks and the
 * list exists before their morning; the day's claim lets only the first of
 * them build it.
 */
export const TRIVIA_BUILD_HOURS = 4;

/**
 * The Trivia widget's id in `dashboardWidgets`, the frontend's `'trivia'` in
 * `widget-registry.tsx`. It is not in the default layout, so only a layout
 * that lists it shows the facts.
 */
export const TRIVIA_WIDGET_ID = "trivia";

/** A reader the tick may build for, with the zone their day is counted in. */
export interface DueTriviaUser {
  userId: string;
  timezone: string;
}

/**
 * The active readers whose local time is within the first
 * {@link TRIVIA_BUILD_HOURS} hours of their day at `now`. Users are bucketed
 * by `getUsersByEffectiveTimezone` like every other per-zone cron, and a zone
 * the runtime cannot resolve counts in UTC. The active-user read happens only
 * when some bucket is in its window. Call inside `withSystemContext`: both
 * reads span users.
 *
 * A reader the job would do nothing for is left out here, before the per-user
 * claim and preference read: one who neither shows the Trivia widget with the
 * trivia switched on nor has a stored row. A reader with a row is kept even
 * with the widget hidden, so `generateForUser` still deletes it.
 */
export async function dueTriviaUsers(
  dataSource: DataSource,
  now: Date,
): Promise<DueTriviaUser[]> {
  const byZone = await getUsersByEffectiveTimezone(dataSource);
  const inWindow: DueTriviaUser[] = [];
  for (const [timezone, userIds] of byZone) {
    const clock = zonedWallClock(now, timezone) ?? zonedWallClock(now, "UTC");
    if (!clock || Number(clock.time.slice(0, 2)) >= TRIVIA_BUILD_HOURS) {
      continue;
    }
    for (const userId of userIds) inWindow.push({ userId, timezone });
  }
  if (inWindow.length === 0) return [];
  const active = await activeUserIds(dataSource);
  return inWindow.filter((user) => active.has(user.userId));
}

async function activeUserIds(dataSource: DataSource): Promise<Set<string>> {
  const rows = await withScopedDb(dataSource, (manager) =>
    manager
      .createQueryBuilder()
      .select("u.id", "userId")
      .from("users", "u")
      .where(
        `u.is_active = true AND (
           EXISTS (SELECT 1 FROM dashboard_trivia d WHERE d.user_id = u.id)
           OR EXISTS (
             SELECT 1 FROM user_preferences p
              WHERE p.user_id = u.id
                AND p.ai_trivia_enabled IS NOT FALSE
                AND :widget = ANY(p.dashboard_widgets)
           )
         )`,
        { widget: TRIVIA_WIDGET_ID },
      )
      .getRawMany<{ userId: string }>(),
  );
  return new Set(rows.map((r) => r.userId));
}
