import { BadRequestException } from "@nestjs/common";
import { tr } from "../i18n/translate";
import { occurrenceFollowsEstimate } from "./scheduled-amount-estimate.service";

/** The schedule columns that decide whether its occurrences auto-post. */
export interface AutoPostSchedule {
  isActive: boolean;
  autoPost: boolean;
  amountIsEstimated?: boolean | null;
}

/** The override columns that decide whether one occurrence auto-posts. */
export interface AutoPostOverride {
  autoPost?: boolean | null;
  amount?: number | string | null;
  isSplit?: boolean | null;
}

/**
 * Whether the auto-post cron posts this occurrence once it is due
 * (INV-OCCURRENCE-004). The override's own choice wins over the schedule's: a
 * `false` keeps one occurrence of an auto-posting schedule for a person to post,
 * a `true` posts one occurrence of a schedule that does not auto-post. An
 * estimated schedule's occurrence auto-posts only when its override opts in AND
 * states the amount: an occurrence that still follows the estimate is a
 * forecast, which a person confirms by posting.
 *
 * `OCCURRENCE_AUTO_POSTS_SQL` is the same predicate for the cron's queries;
 * `occurrence-auto-post.spec.ts` pins this one and
 * `test/integration/scheduled-occurrence-auto-post.integration.spec.ts` runs
 * the SQL one through the real cron over the same cases.
 */
export function occurrenceAutoPosts(
  schedule: AutoPostSchedule,
  override: AutoPostOverride | null | undefined,
): boolean {
  if (!schedule.isActive) return false;
  if (schedule.amountIsEstimated === true) {
    return (
      override?.autoPost === true &&
      !occurrenceFollowsEstimate(schedule, override)
    );
  }
  return override?.autoPost ?? schedule.autoPost;
}

/**
 * `occurrenceAutoPosts` over a schedule aliased `st` and its current
 * occurrence's override aliased `o` (NULL columns when there is none), in
 * TypeORM property names.
 */
export const OCCURRENCE_AUTO_POSTS_SQL = `(st.isActive = true AND (CASE
    WHEN st.amountIsEstimated = true
      THEN o.autoPost IS TRUE AND (o.amount IS NOT NULL OR o.isSplit IS TRUE)
    ELSE COALESCE(o.autoPost, st.autoPost)
  END))`;

/**
 * Refuse an override that opts an estimated schedule's occurrence into
 * auto-posting while it still follows the estimate: the cron would never post
 * it, so saving the choice would only mislead.
 */
export function assertOverrideAutoPostAllowed(
  schedule: { amountIsEstimated?: boolean | null },
  override: AutoPostOverride,
): void {
  if (
    override.autoPost === true &&
    occurrenceFollowsEstimate(schedule, override)
  ) {
    throw new BadRequestException(
      tr(
        "errors.scheduled.overrideAutoPostNeedsAmount",
        "An occurrence of a scheduled transaction with an estimated amount can be posted automatically only once its own amount is entered",
      ),
    );
  }
}
