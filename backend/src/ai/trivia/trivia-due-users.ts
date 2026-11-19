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
      .where("u.is_active = true")
      .getRawMany<{ userId: string }>(),
  );
  return new Set(rows.map((r) => r.userId));
}
