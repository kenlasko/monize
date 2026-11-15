import type { Logger } from "@nestjs/common";

export type BoundsLogger = Pick<Logger, "warn" | "error">;

// The three column widths the door truncates on. Each is checked against
// `database/schema.sql` by `notification-category.spec.ts`: a bound that is too
// low silently shortens copy the column would have taken, and one that is too
// high hands PostgreSQL a value it refuses with 22001 -- inside a producer's
// never-throws catch, which is the failure the truncation exists to prevent.

/** Matches notifications.title. */
export const TITLE_MAX_LENGTH = 255;

/** Matches notifications.dedupe_key. */
export const DEDUPE_KEY_MAX_LENGTH = 120;

/** Matches notifications.target. */
export const TARGET_MAX_LENGTH = 255;

/**
 * Dedupe-key prefixes of the state-keyed notifications: the bond ones (item 4,
 * redemption not booked; item 6, data missing) and the GEM signal change
 * (`gem:<strategy>:<period>:<kind>`, whose period can outlast the window by
 * months, A26-L24). The dedupe row is the only memory that such an event was
 * raised, so `NotificationService.purgeOld` keeps these rows past the retention
 * window and forgets one only when it was dismissed more than
 * `STATE_KEYED_FORGET_DAYS` ago. The first two must match
 * `bondDedupeKeys.unbooked` and `bondDedupeKeys.missing`
 * (`bond-notification-events.ts`, which builds its keys from these by
 * position, so a new prefix goes at the end). `relay:cred:<id>` is the memory
 * that a relay credential was already announced as first-use.
 */
export const RELAY_CREDENTIAL_DEDUPE_PREFIX = "relay:cred:";

export const STATE_KEYED_DEDUPE_PREFIXES: readonly string[] = [
  "bond:unbooked:",
  "bond:missing:",
  "gem:",
  RELAY_CREDENTIAL_DEDUPE_PREFIX,
];

/**
 * A dismissed state-keyed notification older than this is forgotten by the
 * purge, except a `relay:cred:` row: that row is the only memory that the
 * credential was announced, so forgetting it re-sends a false "new connection".
 */
export const STATE_KEYED_FORGET_DAYS = 365;

/**
 * A title the `title VARCHAR(255)` column will accept.
 *
 * Producers interpolate names they do not control -- a scheduled
 * transaction's, an account's -- and an over-long one makes PostgreSQL raise
 * 22001, which a producer's never-throws contract then swallows: the
 * notification silently never exists, and for SCHEDULED_POST_FAILED that
 * means the user is never told their money did not move. Truncating is the
 * honest failure, and it happens once, here, rather than at each producer.
 */
export function boundedTitle(
  type: string,
  title: string,
  logger: BoundsLogger,
): string {
  if (title.length <= TITLE_MAX_LENGTH) return title;
  logger.warn(
    `Title for ${type} exceeds ${TITLE_MAX_LENGTH} chars and was truncated`,
  );
  return `${title.slice(0, TITLE_MAX_LENGTH - 1)}…`;
}

/**
 * Keys are bounded by construction (type + UUID + date is well under the
 * column); a longer one is a producer bug, reported and truncated
 * deterministically rather than thrown, because the notification still
 * deduping -- slightly too coarsely -- beats the sweep that raised it dying
 * here.
 */
export function boundedDedupeKey(
  type: string,
  dedupeKey: string | null | undefined,
  logger: BoundsLogger,
): string | null {
  if (dedupeKey === null || dedupeKey === undefined) return null;
  if (dedupeKey.length <= DEDUPE_KEY_MAX_LENGTH) return dedupeKey;
  logger.error(
    `Dedupe key for ${type} exceeds ${DEDUPE_KEY_MAX_LENGTH} chars ` +
      `and was truncated: ${dedupeKey.slice(0, 60)}...`,
  );
  return dedupeKey.slice(0, DEDUPE_KEY_MAX_LENGTH);
}

/**
 * A truncated path points somewhere else, so an over-long target is dropped
 * rather than cut: a notification with no link is worse than one with the
 * right link and better than one that navigates to the wrong page.
 */
export function boundedTarget(
  type: string,
  target: string | null | undefined,
  logger: BoundsLogger,
): string | null {
  if (target === null || target === undefined) return null;
  if (target.length <= TARGET_MAX_LENGTH) return target;
  logger.error(
    `Target for ${type} exceeds ${TARGET_MAX_LENGTH} chars and was dropped`,
  );
  return null;
}
