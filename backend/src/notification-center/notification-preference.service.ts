import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import { UserPreference } from "../users/entities/user-preference.entity";
import { NotificationCategory } from "./entities/notification.entity";
import { NotificationPreference } from "./entities/notification-preference.entity";
import { THROTTLE_MAX_MINUTES } from "./notification-preference.constants";

export { THROTTLE_MAX_MINUTES };

/**
 * The categories the preference matrix exposes.
 *
 * Deliberately NOT every {@link NotificationCategory}, and each row exposes only
 * the channels a producer actually reads (see {@link NOTIFICATION_CATEGORY_CHANNELS}),
 * so no cell is a control that changes nothing. PAYMENTS and BUDGETS each have a
 * dispatching producer for their interrupting channels (budget alerts for
 * BUDGETS; the SCHEDULED_POST_FAILED alert and bill-due reminders for PAYMENTS).
 * SYSTEM is the admin infra alerts (backup, provider, SMTP): a per-user PUSH
 * control (its rows fan out through the dispatch seam), while its email stays a
 * severity-driven admin fan-out that is not user-gated -- so SYSTEM exposes push
 * only. See `docs/specs/notification-preferences.md`.
 */
export const NOTIFICATION_PREFERENCE_CATEGORIES: readonly NotificationCategory[] =
  [
    NotificationCategory.PAYMENTS,
    NotificationCategory.BUDGETS,
    NotificationCategory.SYSTEM,
    NotificationCategory.BALANCES,
    NotificationCategory.INVESTMENTS,
    NotificationCategory.STRATEGIES,
    NotificationCategory.BANK_SYNC,
    NotificationCategory.BANK_SYNC_ACTIVITY,
  ];

/**
 * The matrix categories one account can see and write. Every SYSTEM type is
 * raised to administrators only (`SystemAlertService.raiseAdminAlert` is its one
 * producer), so for anyone else the SYSTEM row would be a control that changes
 * nothing -- the thing this file's rule forbids -- and it is neither listed nor
 * writable for them. Derived from the one category list, never a second one.
 */
export function configurableCategoriesFor(
  isAdmin: boolean,
): readonly NotificationCategory[] {
  return isAdmin
    ? NOTIFICATION_PREFERENCE_CATEGORIES
    : NOTIFICATION_PREFERENCE_CATEGORIES.filter(
        (category) => category !== NotificationCategory.SYSTEM,
      );
}

/** Which channels a matrix category delivers on, as live per-user controls. */
export interface CategoryChannelSupport {
  /** REPORT-mode email (digest), gated by `resolveEmail`. */
  email: boolean;
  /** NOTIFICATION-mode immediate email, fanned out by the dispatch seam. */
  emailNotification: boolean;
  /** Web push, fanned out by the dispatch seam. */
  push: boolean;
  /**
   * UnifiedPush/ntfy: the same encrypted Web Push wire as `push`, to a
   * distributor endpoint (spec section 15). A separate control because a user
   * chooses the two transports independently.
   */
  unifiedpush: boolean;
}

/**
 * The channels each matrix category exposes as a live control -- the machine-
 * readable form of "the matrix shows a cell only where a producer reads it".
 * A cell whose channel is unsupported here renders as "not applicable" and its
 * resolved delivery is forced off ({@link resolveNotificationDelivery}), so a
 * stored value on it can never become a delivery nobody asked for. SYSTEM's
 * email is the admin fan-out's own severity-driven path, not a user toggle, so
 * only its push is a control. This map is mirrored on the client and held equal
 * by `notification-preferences.contract.test.ts`.
 */
export const NOTIFICATION_CATEGORY_CHANNELS: Record<
  NotificationCategory,
  CategoryChannelSupport
> = {
  [NotificationCategory.PAYMENTS]: {
    email: true,
    emailNotification: true,
    push: true,
    unifiedpush: true,
  },
  [NotificationCategory.BUDGETS]: {
    email: true,
    emailNotification: true,
    push: true,
    unifiedpush: true,
  },
  [NotificationCategory.SYSTEM]: {
    email: false,
    emailNotification: false,
    push: true,
    unifiedpush: true,
  },
  // Balance crossings, portfolio movement and GEM signal changes are all
  // user-facing financial news (like a bill), so every channel is a live
  // control. There is no report-mode digest for any of them yet, but the column
  // is a real control (an immediate email report could batch them later), so it
  // stays on rather than "not applicable".
  [NotificationCategory.BALANCES]: {
    email: true,
    emailNotification: true,
    push: true,
    unifiedpush: true,
  },
  [NotificationCategory.INVESTMENTS]: {
    email: true,
    emailNotification: true,
    push: true,
    unifiedpush: true,
  },
  [NotificationCategory.STRATEGIES]: {
    email: true,
    emailNotification: true,
    push: true,
    unifiedpush: true,
  },
  // Bank sync has no report-mode digest, so its report-email cell is not
  // applicable (like SYSTEM's); the immediate email and both push wires are
  // live controls, read by the dispatch for every bank sync notification.
  [NotificationCategory.BANK_SYNC]: {
    email: false,
    emailNotification: true,
    push: true,
    unifiedpush: true,
  },
  [NotificationCategory.BANK_SYNC_ACTIVITY]: {
    email: false,
    emailNotification: true,
    push: true,
    unifiedpush: true,
  },
};

/** A category's channel state when the user has stored no row for it. */
export interface CategoryChannelDefaults {
  email: boolean;
  emailNotification: boolean;
  push: boolean;
  unifiedpush: boolean;
}

/**
 * What a category delivers on until its user stores a matrix row. Read only
 * where no row exists (and as the first-write value of a channel a partial
 * update did not name): a stored row always wins. Total over the enum, so a new
 * category is a decision made here, never an inherited default.
 *
 * Every category before bank sync defaults to the global rule, report email on
 * and everything interrupting off (`docs/specs/notification-preferences.md`
 * section 3); `notification-preference.service.spec.ts` pins them unchanged.
 * Bank sync is "by importance" (`docs/specs/bank-sync-notifications.md`
 * section 2): what needs the user's action interrupts by immediate email and
 * push, what only reports stays in the bell. A push default needs a registered
 * device to mean anything, and UnifiedPush stays off for the same reason.
 */
const GLOBAL_DEFAULTS: CategoryChannelDefaults = {
  email: true,
  emailNotification: false,
  push: false,
  unifiedpush: false,
};

export const NOTIFICATION_CATEGORY_DEFAULTS: Readonly<
  Record<NotificationCategory, CategoryChannelDefaults>
> = {
  [NotificationCategory.PAYMENTS]: GLOBAL_DEFAULTS,
  [NotificationCategory.BUDGETS]: GLOBAL_DEFAULTS,
  [NotificationCategory.SYSTEM]: GLOBAL_DEFAULTS,
  [NotificationCategory.BALANCES]: GLOBAL_DEFAULTS,
  [NotificationCategory.INVESTMENTS]: GLOBAL_DEFAULTS,
  [NotificationCategory.STRATEGIES]: GLOBAL_DEFAULTS,
  [NotificationCategory.BANK_SYNC]: {
    email: true,
    emailNotification: true,
    push: true,
    unifiedpush: false,
  },
  [NotificationCategory.BANK_SYNC_ACTIVITY]: GLOBAL_DEFAULTS,
};

/**
 * One category's resolved channel state for the settings matrix.
 *
 * `email` is the REPORT-mode email (the batch/digest, live and unthrottled) --
 * the channel `resolveEmail` gates. `emailNotification` is the NOTIFICATION-mode
 * email (immediate, one per event) and `throttleMinutes` its cooldown; both are
 * stored now and consumed with the push dispatch in Phase 5 (see spec section 4).
 */
export interface NotificationChannelPreference {
  category: NotificationCategory;
  email: boolean;
  emailNotification: boolean;
  push: boolean;
  unifiedpush: boolean;
  throttleMinutes: number;
  /**
   * Which channels this category exposes as live controls. Server-authoritative
   * so the client renders a cell as a toggle only where a producer reads it; an
   * unsupported cell shows "not applicable" (see NOTIFICATION_CATEGORY_CHANNELS).
   */
  supportedChannels: CategoryChannelSupport;
}

/** A partial update to one category's preferences. */
export interface NotificationPreferencePatch {
  email?: boolean;
  emailNotification?: boolean;
  push?: boolean;
  unifiedpush?: boolean;
  throttleMinutes?: number;
}

/**
 * Resolves and stores a user's per-category notification channel preferences.
 *
 * Backward compatibility is the load-bearing rule: an ABSENT row defaults the
 * report email ON, the notification email OFF and the throttle OFF (0), and the
 * global `user_preferences.notification_email` master switch still wins when
 * off. So an existing user keeps exactly today's delivery until they narrow a
 * category (spec section 10). Only the report email is live today; the
 * notification email and throttle are stored and rendered "coming soon" until
 * the Phase 5 push dispatch reads them.
 */
@Injectable()
export class NotificationPreferenceService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Whether REPORT-mode email should be delivered to this user for this
   * category, right now. The master switch off is a global kill; otherwise the
   * per-category row, defaulting on when absent. Safe to call inside a
   * producer's own `withUserContext` / `withSystemContext` -- the nested
   * `withScopedDb` joins the ambient transaction and reads under the ambient
   * identity.
   */
  async resolveEmail(
    userId: string,
    category: NotificationCategory,
  ): Promise<boolean> {
    // A channel this category does not expose is OFF whatever a row says -- the
    // same rule `resolveNotificationDelivery` applies to its three channels.
    // Without it the absent-row default of `true` below turned an unsupported
    // cell (SYSTEM has no report-mode email) into a delivery nobody could switch
    // off, because the matrix never shows the cell.
    if (!NOTIFICATION_CATEGORY_CHANNELS[category].email) return false;
    return withScopedDb(this.dataSource, async (manager) => {
      const master = await manager.getRepository(UserPreference).findOne({
        where: { userId },
      });
      // The master is a kill switch: a per-category "on" never widens it. Test
      // falsiness, not `=== false`: notification_email is a nullable column, and
      // the producers this replaced blocked on `!prefs.notificationEmail`, so a
      // NULL master stays "off" here rather than silently flipping to "send".
      if (master && !master.notificationEmail) return false;
      const row = await manager.getRepository(NotificationPreference).findOne({
        where: { userId, category },
      });
      return row ? row.email : true;
    });
  }

  /**
   * The notification-mode delivery decision for one category, in a single read:
   * whether the immediate email and push fan-outs are on, and the throttle
   * window that gates them. The one method the Phase 5 dispatch calls per
   * notification (spec section 14) -- combined so a fan-out costs one preference
   * read, not three.
   *
   * The email flag is killed by the `notification_email` master switch (it is
   * still email) and defaults OFF (opt-in, D9); push is NOT email-master-gated
   * (a different channel) and defaults OFF; the throttle defaults 0. A channel
   * this category does not expose ({@link NOTIFICATION_CATEGORY_CHANNELS}) is
   * forced OFF whatever the stored row says, so a value written to an unsupported
   * cell can never become a delivery. Feasibility -- SMTP configured, a live
   * device -- is the sender's call, not this one.
   */
  async resolveNotificationDelivery(
    userId: string,
    category: NotificationCategory,
  ): Promise<{
    emailNotification: boolean;
    push: boolean;
    unifiedpush: boolean;
    throttleMinutes: number;
  }> {
    const support = NOTIFICATION_CATEGORY_CHANNELS[category];
    const defaults = NOTIFICATION_CATEGORY_DEFAULTS[category];
    return withScopedDb(this.dataSource, async (manager) => {
      const master = await manager.getRepository(UserPreference).findOne({
        where: { userId },
      });
      const emailKilled = !!master && !master.notificationEmail;
      const row = await manager.getRepository(NotificationPreference).findOne({
        where: { userId, category },
      });
      return {
        emailNotification:
          support.emailNotification && !emailKilled
            ? row
              ? row.emailNotification
              : defaults.emailNotification
            : false,
        push: support.push ? (row ? row.push : defaults.push) : false,
        unifiedpush: support.unifiedpush
          ? row
            ? row.unifiedpush
            : defaults.unifiedpush
          : false,
        throttleMinutes: row ? this.clampThrottle(row.throttleMinutes) : 0,
      };
    });
  }

  /**
   * The per-category stored state for the given matrix categories (the
   * controller passes `configurableCategoriesFor(isAdmin)`), for the settings
   * UI. Deliberately NOT master-gated: the matrix shows the user's own
   * per-category choices, and the global email toggle is a separate control on
   * the same screen. Report email defaults on; notification email and throttle
   * default off.
   */
  async list(
    userId: string,
    categories: readonly NotificationCategory[],
  ): Promise<NotificationChannelPreference[]> {
    return withScopedDb(this.dataSource, async (manager) => {
      const rows = await manager.getRepository(NotificationPreference).find({
        where: { userId },
      });
      const byCategory = new Map(rows.map((row) => [row.category, row]));
      return categories.map((category) =>
        this.toChannelPreference(category, byCategory.get(category)),
      );
    });
  }

  /**
   * Update one category's preferences, creating the row if absent. Only the
   * fields present in `patch` are written; the rest keep their stored value (or
   * the column default on first insert).
   *
   * A single `INSERT ... ON CONFLICT (user_id, category) DO UPDATE` with
   * `COALESCE` rather than read-then-insert: two concurrent writes for the same
   * pair (a second tab or device, a retried request) would otherwise both miss
   * the row and the second INSERT would violate the primary key. `COALESCE($n,
   * <stored>)` is what makes it a partial upsert -- an omitted field passes NULL
   * and keeps the existing value. `updated_at` is bumped by the BEFORE UPDATE
   * trigger on the conflict path. The raw column names are checked against
   * `schema.sql` by `raw-sql-columns.spec.ts`.
   */
  async updatePreference(
    userId: string,
    category: NotificationCategory,
    patch: NotificationPreferencePatch,
  ): Promise<NotificationChannelPreference> {
    const email = patch.email === undefined ? null : patch.email;
    const emailNotification =
      patch.emailNotification === undefined ? null : patch.emailNotification;
    const push = patch.push === undefined ? null : patch.push;
    const unifiedpush =
      patch.unifiedpush === undefined ? null : patch.unifiedpush;
    const throttle =
      patch.throttleMinutes === undefined
        ? null
        : this.clampThrottle(patch.throttleMinutes);

    // The first write of a category stores the channels the patch did not name
    // at the category's own defaults, never at a hard-coded off: a user who
    // switches push off on a category that defaults push and email on must not
    // find the email gone with it.
    const defaults = NOTIFICATION_CATEGORY_DEFAULTS[category];

    return withScopedDb(this.dataSource, async (manager) => {
      await manager.query(
        `INSERT INTO notification_preferences
           (user_id, category, email, email_notification, throttle_minutes,
            push, unifiedpush)
         VALUES ($1, $2, COALESCE($3::boolean, $8::boolean),
                 COALESCE($4::boolean, $9::boolean), COALESCE($5, 0),
                 COALESCE($6::boolean, $10::boolean),
                 COALESCE($7::boolean, $11::boolean))
         ON CONFLICT (user_id, category) DO UPDATE SET
           email = COALESCE($3, notification_preferences.email),
           email_notification =
             COALESCE($4, notification_preferences.email_notification),
           throttle_minutes =
             COALESCE($5, notification_preferences.throttle_minutes),
           push = COALESCE($6, notification_preferences.push),
           unifiedpush = COALESCE($7, notification_preferences.unifiedpush)`,
        [
          userId,
          category,
          email,
          emailNotification,
          throttle,
          push,
          unifiedpush,
          defaults.email,
          defaults.emailNotification,
          defaults.push,
          defaults.unifiedpush,
        ],
      );
      const row = await manager.getRepository(NotificationPreference).findOne({
        where: { userId, category },
      });
      return this.toChannelPreference(category, row);
    });
  }

  /** One category's channel state from its stored row (or the defaults). */
  private toChannelPreference(
    category: NotificationCategory,
    row: NotificationPreference | null | undefined,
  ): NotificationChannelPreference {
    const defaults = NOTIFICATION_CATEGORY_DEFAULTS[category];
    return {
      category,
      email: row ? row.email : defaults.email,
      emailNotification: row
        ? row.emailNotification
        : defaults.emailNotification,
      push: row ? row.push : defaults.push,
      unifiedpush: row ? row.unifiedpush : defaults.unifiedpush,
      throttleMinutes: row ? this.clampThrottle(row.throttleMinutes) : 0,
      supportedChannels: NOTIFICATION_CATEGORY_CHANNELS[category],
    };
  }

  /** A stored or supplied window bounded to [0, THROTTLE_MAX_MINUTES]. */
  private clampThrottle(minutes: number): number {
    if (!Number.isFinite(minutes) || minutes <= 0) return 0;
    return Math.min(THROTTLE_MAX_MINUTES, Math.trunc(minutes));
  }

  /**
   * The user's daily portfolio-movement threshold, in percent, or `null` when
   * the alert is off (`docs/specs/portfolio-movement-notifications.md`). Stored
   * on `notification_portfolio_state` beside the producer's baseline.
   */
  async getPortfolioMovePercent(userId: string): Promise<number | null> {
    return withScopedDb(this.dataSource, async (manager) => {
      const rows = returnedRows<{ move_alert_percent: string | null }>(
        await manager.query(
          "SELECT move_alert_percent FROM notification_portfolio_state WHERE user_id = $1",
          [userId],
        ),
      );
      // A stored value at or below zero is "off" (the cron enumerates
      // `move_alert_percent > 0`), so the GET reports it as off too rather than
      // as an enabled 0% threshold the producer never acts on.
      const value = rows[0]?.move_alert_percent;
      if (value == null) return null;
      const num = Number(value);
      return num > 0 ? num : null;
    });
  }

  /**
   * Set (or clear, with `null`) the portfolio-movement threshold. Clearing the
   * threshold also clears the baseline, so re-enabling starts a fresh baseline
   * on the next complete run rather than comparing against a stale one.
   */
  async setPortfolioMovePercent(
    userId: string,
    percent: number | null,
  ): Promise<{ movePercent: number | null }> {
    await withScopedDb(this.dataSource, (manager) =>
      percent == null
        ? manager.query(
            `INSERT INTO notification_portfolio_state
               (user_id, move_alert_percent, baseline_value, baseline_currency,
                baseline_captured_on, baseline_positions)
             VALUES ($1, NULL, NULL, NULL, NULL, NULL)
             ON CONFLICT (user_id) DO UPDATE
               SET move_alert_percent = NULL,
                   baseline_value = NULL,
                   baseline_currency = NULL,
                   baseline_captured_on = NULL,
                   baseline_positions = NULL`,
            [userId],
          )
        : manager.query(
            `INSERT INTO notification_portfolio_state (user_id, move_alert_percent)
             VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET move_alert_percent = $2`,
            [userId, percent],
          ),
    );
    return { movePercent: percent };
  }
}
