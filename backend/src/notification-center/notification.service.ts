import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource, EntityManager, In, IsNull, Not } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { affectedRowCount, returnedRows } from "../common/db/query-result";
import { tr } from "../i18n/translate";
import {
  Notification,
  NotificationCategory,
  NotificationSeverity,
  NotificationType,
  SYSTEM_NOTIFICATION_TYPES,
  notificationCategoryOf,
} from "./entities/notification.entity";
import { DismissNotificationsQueryDto } from "./dto/dismiss-notifications-query.dto";

import {
  RELAY_CREDENTIAL_DEDUPE_PREFIX,
  STATE_KEYED_DEDUPE_PREFIXES,
  STATE_KEYED_FORGET_DAYS,
  boundedTitle,
  boundedDedupeKey,
  boundedTarget,
} from "./notification-bounds";
export {
  TITLE_MAX_LENGTH,
  DEDUPE_KEY_MAX_LENGTH,
  TARGET_MAX_LENGTH,
} from "./notification-bounds";

/** How long a dismissed or read notification is kept before the purge. */
export const RETENTION_DAYS = 30;

/** The newest notifications one list read returns. */
export const LIST_PAGE_SIZE = 50;

/**
 * One notification to write. Every producer builds this; nothing else reaches
 * the table.
 */
export interface CreateNotificationInput {
  type: NotificationType;
  severity: NotificationSeverity;
  /**
   * Stored English fallback, for a reader with no client to render the row
   * (the email digest, an API consumer). The UI composes its own copy from
   * `type` and `data` in the reader's language.
   */
  title: string;
  /** Stored English fallback, as `title`. */
  message: string;
  /**
   * Facts for client-side localization. Never a value that goes stale while
   * the row lives -- "due in 3 days" was true when it was written.
   */
  data?: Record<string, unknown>;
  /**
   * Where the bell sends the reader, as a same-origin path (`/budgets/<id>`),
   * never a URL. The service worker resolves it against the app's own origin
   * and discards anything that leaves it.
   */
  target?: string | null;
  /** The date the notification is about. Defaults to today. */
  periodStart?: string;
  budgetId?: string | null;
  budgetCategoryId?: string | null;
  /**
   * Explicit fingerprint for a notification the fingerprint index cannot
   * arbitrate -- one with `budgetId` null, where NULL never equals NULL.
   * Unique per `(user_id, dedupe_key)`.
   */
  dedupeKey?: string | null;
}

/**
 * A notification as a reader sees it: the row, plus the category derived from
 * its type. There is no `category` column -- see `notificationCategoryOf`.
 */
export type NotificationView = Notification & {
  category: NotificationCategory;
};

function withCategory(row: Notification): NotificationView {
  return { ...row, category: notificationCategoryOf(row.type) };
}

/** Today as the DATE the NOT NULL period_start column requires. */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The notification table's one door, in both directions: every producer writes
 * through `create`, and every reader -- the bell, the list, the dismiss-all --
 * reads through the methods below.
 *
 * **Why one creation door.** Before this there were three inserts with three
 * different opinions: a raw `INSERT` for budget alerts, an entity `save` for
 * bill reminders, and a second raw `INSERT` for system alerts -- so the column
 * bounds were enforced on one path, the conflict handling on another, and the
 * `period_start` default on a third. A producer decides *what* to say; the
 * shape of the row it lands in is not its decision to make.
 * `notification-write-door.spec.ts` fails on a second writer.
 *
 * **What a conflict means.** The insert is `ON CONFLICT DO NOTHING`, covering
 * both unique indexes at once: the fingerprint (a budget notification the
 * period already holds) and the dedupe key (a system notification another
 * replica already raised). `null` therefore means *somebody else holds this
 * notification*, which is what every caller needs to know -- notably, that it
 * is not theirs to email about. It is deliberately not an error: every replica
 * runs every cron, so losing the race is the normal case.
 *
 * **Context.** `withScopedDb` throws without an ambient identity, and every
 * producer here is a cron body, a post-claim hook or a bootstrap hook with no
 * request behind it -- so callers seed their own (`withUserContext` for the
 * affected user, `withSystemContext` for an admin fan-out) and this service
 * inherits it. `create` joins an ambient transaction if there is one, which is
 * why producers must call it OUTSIDE the transaction whose failure they are
 * reporting: a notification that rolls back with the work it describes is a
 * notification nobody gets.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Write one notification, or report that somebody already holds it.
   *
   * Returns the stored row -- read back inside the same transaction as the
   * insert, so what the caller emails about is what the database has -- or
   * `null` when a unique index refused it.
   */
  async create(
    userId: string,
    input: CreateNotificationInput,
  ): Promise<Notification | null> {
    return withScopedDb(this.dataSource, async (manager) => {
      const rows = returnedRows<{ id: string }>(
        await manager.query(
          `INSERT INTO notifications
             (user_id, budget_id, budget_category_id, alert_type, severity,
              title, message, data, target, period_start, dedupe_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            userId,
            input.budgetId ?? null,
            input.budgetCategoryId ?? null,
            input.type,
            input.severity,
            boundedTitle(input.type, input.title, this.logger),
            input.message,
            JSON.stringify(input.data ?? {}),
            boundedTarget(input.type, input.target, this.logger),
            input.periodStart ?? todayIsoDate(),
            boundedDedupeKey(input.type, input.dedupeKey, this.logger),
          ],
        ),
      );
      const id = rows[0]?.id;
      if (id === undefined) return null;

      // An `ON CONFLICT DO NOTHING` that wrote a row still has to be read back
      // as authoritative state rather than assembled from the input: the
      // defaults, the trigger-stamped timestamps and the truncations above all
      // live in the database.
      return (
        (await manager
          .getRepository(Notification)
          .findOne({ where: { id } })) ?? null
      );
    });
  }

  /**
   * Record that this notification's email went out.
   *
   * Here rather than at the producer so the table has one writer: a producer
   * that loaded the row and saved it back would be a second place deciding what
   * a notification row looks like, and the guard scan could no longer tell a
   * flag update from a create.
   *
   * The owner is a parameter and is in the `WHERE`, like every other write on
   * this service. At `RLS_MODE=off` -- the documented default -- `withScopedDb`
   * emits no identity GUCs, so an id-only `UPDATE` is scoped by nothing but the
   * caller happening to pass an id it created; that is an invariant living in
   * the call sites rather than in the statement.
   */
  async markEmailSent(userId: string, notificationId: string): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `UPDATE notifications SET is_email_sent = true
           WHERE id = $1 AND user_id = $2`,
        [notificationId, userId],
      ),
    );
  }

  /** The reader's live notifications, newest first. */
  async list(
    userId: string,
    options: { unreadOnly?: boolean } = {},
  ): Promise<NotificationView[]> {
    const where: Record<string, unknown> = { userId, dismissedAt: IsNull() };
    if (options.unreadOnly) {
      where.isRead = false;
    }

    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(Notification).find({
        where,
        order: { createdAt: "DESC" },
        take: LIST_PAGE_SIZE,
      }),
    );

    return rows.map(withCategory);
  }

  async markRead(
    userId: string,
    notificationId: string,
  ): Promise<NotificationView> {
    return withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(Notification);
      const row = await this.requireLive(manager, userId, notificationId);
      row.isRead = true;
      return withCategory(await repo.save(row));
    });
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const result = await withScopedDb(this.dataSource, (manager) =>
      manager
        .getRepository(Notification)
        .update(
          { userId, isRead: false, dismissedAt: IsNull() },
          { isRead: true },
        ),
    );
    return { updated: result.affected || 0 };
  }

  async dismiss(userId: string, notificationId: string): Promise<void> {
    await withScopedDb(this.dataSource, async (manager) => {
      const row = await this.requireLive(manager, userId, notificationId);
      row.dismissedAt = new Date();
      await manager.getRepository(Notification).save(row);
    });
  }

  /**
   * Soft-dismiss every live notification matching the caller's filter, in one
   * UPDATE. The filter arrives explicitly on the command (severity and/or
   * system-vs-financial category) rather than as a list of on-screen ids, so
   * it also reaches notifications beyond the list endpoint's window.
   * Financial is defined as NOT IN `SYSTEM_NOTIFICATION_TYPES` -- the one
   * place the partition is written.
   */
  async dismissAll(
    userId: string,
    filters: DismissNotificationsQueryDto = {},
  ): Promise<{ dismissed: number }> {
    const where: Record<string, unknown> = { userId, dismissedAt: IsNull() };
    if (filters.severity) {
      where.severity = filters.severity;
    }
    if (filters.category === "system") {
      where.type = In([...SYSTEM_NOTIFICATION_TYPES]);
    } else if (filters.category === "financial") {
      where.type = Not(In([...SYSTEM_NOTIFICATION_TYPES]));
    }

    const result = await withScopedDb(this.dataSource, (manager) =>
      manager
        .getRepository(Notification)
        .update(where, { dismissedAt: new Date() }),
    );
    return { dismissed: result.affected || 0 };
  }

  /**
   * Dismiss every live row an earlier fire of the same reminder wrote, except
   * the one just written: a repeat nag supersedes its predecessor, so the bell
   * holds one live nag per reminder and `purgeOld` can retire the rest. Without
   * it a month of un-opened five-minute repeats was eight thousand unread rows
   * that nothing ever dismissed, crowding every other notification out of the
   * bell window. Joins the caller's transaction (the reminder cron calls it
   * from `notify`'s same-transaction hook), and ownership is in the WHERE.
   * Lives here because this file is the notifications table's one writer.
   */
  async dismissSupersededReminderRows(
    userId: string,
    reminderId: string,
    keepNotificationId: string,
  ): Promise<number> {
    return withScopedDb(this.dataSource, async (manager) =>
      affectedRowCount(
        await manager.query(
          `UPDATE notifications
              SET dismissed_at = CURRENT_TIMESTAMP
            WHERE user_id = $1
              AND dismissed_at IS NULL
              AND id <> $2
              AND data->>'reminderId' = $3`,
          [userId, keepNotificationId, reminderId],
        ),
      ),
    );
  }

  /**
   * Drop notifications the reader is done with: dismissed a while ago, or read
   * and left alone. An unread one is never purged -- it is the only record the
   * user has that something happened.
   */
  @Cron("0 3 * * *")
  async purgeOld(): Promise<void> {
    this.logger.log("Purging old notifications...");
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
      // A state-keyed bond row is the only memory that its event was raised, so
      // it outlives the window and goes only once dismissed and this old. A
      // relay credential row is never forgotten (the memory it was announced).
      const forgetCutoff = new Date();
      forgetCutoff.setDate(forgetCutoff.getDate() - STATE_KEYED_FORGET_DAYS);
      // Matched with starts_with, not LIKE: a prefix is literal text, and a
      // LIKE pattern would read its `_` as a wildcard.
      const stateKeyed = [...STATE_KEYED_DEDUPE_PREFIXES];

      // Cross-user bulk purge, so it runs under a system context (task C2).
      const { dismissed, read } = await withSystemContext(async () => {
        const dismissedResult = await withScopedDb(this.dataSource, (manager) =>
          manager.query(
            `DELETE FROM notifications
              WHERE (dismissed_at < $1
                     AND NOT EXISTS (SELECT 1 FROM unnest($2::text[]) AS p(prefix)
                                     WHERE starts_with(COALESCE(dedupe_key, ''), p.prefix)))
                 OR (dismissed_at < $3
                     AND NOT starts_with(COALESCE(dedupe_key, ''), $4))`,
            [cutoff, stateKeyed, forgetCutoff, RELAY_CREDENTIAL_DEDUPE_PREFIX],
          ),
        );
        // A read-but-not-dismissed row that an ACTIVE reminder nags about is
        // kept: the FK is ON DELETE SET NULL and the reminder cron's sweep
        // stops an orphaned reminder, so purging the source would silently end
        // a schedule the user set up on day 31 with nothing telling them. A
        // dismissed source is different -- dismissing it already stopped the
        // reminder (the sweep), so the first DELETE needs no such guard.
        const readResult = await withScopedDb(this.dataSource, (manager) =>
          manager.query(
            `DELETE FROM notifications n
              WHERE n.is_read = true
                AND n.dismissed_at IS NULL
                AND n.created_at < $1
                AND NOT EXISTS (SELECT 1 FROM unnest($2::text[]) AS p(prefix)
                                 WHERE starts_with(COALESCE(n.dedupe_key, ''), p.prefix))
                AND NOT EXISTS (
                  SELECT 1 FROM notification_reminders r
                   WHERE r.source_notification_id = n.id
                     AND r.stopped_at IS NULL
                )`,
            [cutoff, stateKeyed],
          ),
        );
        return {
          dismissed: affectedRowCount(dismissedResult),
          read: affectedRowCount(readResult),
        };
      });

      if (dismissed + read > 0) {
        this.logger.log(
          `Purged ${dismissed} dismissed and ${read} old read notifications`,
        );
      }
    } catch (error) {
      this.logger.error(
        "Failed to purge old notifications",
        error instanceof Error ? error.stack : error,
      );
    }
  }

  /**
   * The caller's own live notification, or a 404. "Not theirs" and "already
   * dismissed" are deliberately the same answer: both mean there is nothing
   * here for this reader to act on, and distinguishing them would say whether
   * an id exists.
   */
  private async requireLive(
    manager: EntityManager,
    userId: string,
    notificationId: string,
  ): Promise<Notification> {
    const row = await manager.getRepository(Notification).findOne({
      where: { id: notificationId, userId, dismissedAt: IsNull() },
    });
    if (!row) {
      throw new NotFoundException(
        tr(
          "errors.notifications.notFound",
          `Notification with ID ${notificationId} not found`,
          { id: notificationId },
        ),
      );
    }
    return row;
  }
}
