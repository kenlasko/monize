import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource, EntityManager } from "typeorm";
import { I18nService } from "nestjs-i18n";

import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import { emailTranslator } from "../i18n/email-translator";
import { resolveUserEmailFormats } from "../i18n/resolve-user-email-locale";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  CreateNotificationInput,
  NotificationService,
} from "../notification-center/notification.service";
import {
  Notification,
  NotificationCategory,
  NotificationType,
  notificationCategoryOf,
  severitiesAtOrAbove,
  typesForCategory,
} from "../notification-center/entities/notification.entity";
import { NotificationPreferenceService } from "../notification-center/notification-preference.service";
import { PushSubscriptionService } from "../push/push-subscription.service";
import { priceChartRequest } from "../push/push-price-chart.service";
import { PushPayload } from "../push/web-push-sender.service";
import { PushTransport } from "../push/entities/push-subscription.entity";
import { EmailService } from "./email.service";
import { notificationImmediateTemplate } from "./email-templates";
import { notificationEmailCopy } from "./notification-email-copy";

/**
 * The per-category push copy, as English fallbacks; the catalogue key is
 * `push.notification.<category>` (lower-cased). One entry per category is
 * enforced by the type, and `notification-dispatch.service.spec.ts` holds the
 * `en` catalogue equal to these so the fallback and the catalogue cannot drift.
 */
export const PUSH_CATEGORY_COPY: Readonly<
  Record<NotificationCategory, { title: string; body: string }>
> = {
  [NotificationCategory.PAYMENTS]: {
    title: "Payment reminder",
    body: "A bill or scheduled payment needs your attention. Open Monize for the details.",
  },
  [NotificationCategory.BUDGETS]: {
    title: "Budget alert",
    body: "One of your budgets needs your attention. Open Monize for the details.",
  },
  [NotificationCategory.SYSTEM]: {
    title: "System notice",
    body: "Monize has a system notice for you. Open the app for the details.",
  },
  [NotificationCategory.BALANCES]: {
    title: "Balance alert",
    body: "An account balance crossed a threshold you set. Open Monize for the details.",
  },
  [NotificationCategory.INVESTMENTS]: {
    title: "Investment movement",
    body: "Your investments moved today. Open Monize for the details.",
  },
  [NotificationCategory.STRATEGIES]: {
    title: "Strategy signal",
    body: "One of your strategies changed its recommendation. Open Monize for the details.",
  },
  [NotificationCategory.BANK_SYNC]: {
    title: "Bank connection",
    body: "A bank connection needs your attention. Open Monize for the details.",
  },
  [NotificationCategory.BANK_SYNC_ACTIVITY]: {
    title: "Bank sync",
    body: "Your bank sync has news. Open Monize for the details.",
  },
};

export interface NotifyOptions {
  /**
   * What the push COLLAPSES onto, when the producer knows better than the row:
   * the admin fan-out raises one row per affected user per admin for a single
   * cause (a full disk), and shares one email through `emailDedupeKey`; without
   * the same key here the device stacks sixty pushes for that one cause. Defaults
   * to the row's dedupe key or id. An id or a cause key, never a name or amount.
   */
  collapseKey?: string;
  /**
   * A same-transaction follow-up write, run right after the row is written and
   * before the transaction commits -- never when `create` returned `null`. The
   * reminder cron uses it to stop a one-shot in the transaction that writes its
   * follow-up, so the delivery and the stop cannot disagree. Keep it to writes
   * that must share the row's fate; the fan-out itself runs after the commit.
   */
  onWritten?: (manager: EntityManager, row: Notification) => Promise<void>;
  /**
   * `"await"` (the default) resolves after push and email were attempted --
   * right for a cron, which may wait for its deliveries. `"detached"` resolves
   * as soon as the row is committed and lets the fan-out run behind the caller:
   * for a producer on a request's READ path (bill reminders materialize on
   * `GET /notifications`), a stalled push endpoint -- up to
   * `PUSH_REQUEST_DEADLINE_MS` per device -- must not hold the reader past the
   * client's own timeout. Either way the fan-out never throws out of `notify`,
   * and a detached failure is logged exactly as an awaited one is.
   */
  fanOut?: "await" | "detached";
}

/**
 * The dispatch seam (spec section 14.1): a layer ABOVE the write door that adds
 * the notification-mode fan-out (immediate email + push) after a notification is
 * written. A producer that wants fan-out calls `notify(...)` instead of
 * `NotificationService.create(...)`; a producer that only wants the bell row
 * keeps calling `create` directly. `create` stays the sole writer -- this never
 * writes a notification row -- and the in-app row is always written regardless of
 * the matrix or the throttle (Section 3).
 *
 * Lives in `NotificationsModule`, which imports `NotificationCenterModule` and
 * `PushModule` (both leaves) and holds `EmailService`, so the seam needs no
 * `forwardRef` and no require cycle (`module-graph.spec.ts`, INV-MODULE).
 */
/** The reminder a re-emitted row belongs to (`data.reminderId`, set by the reminder cron), else null. */
function reminderIdOf(row: Notification): string | null {
  return reminderIdOfData(row.data);
}

function reminderIdOfData(data: unknown): string | null {
  const value = (data as Record<string, unknown> | null | undefined)
    ?.reminderId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationService,
    private readonly preferences: NotificationPreferenceService,
    private readonly push: PushSubscriptionService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    private readonly i18n: I18nService,
  ) {}

  /**
   * Write the notification (through the one write door) and fan it out.
   *
   * Returns the stored row, or `null` when `create` lost the ON CONFLICT race --
   * another replica holds this notification, so it is that replica's to fan out,
   * not ours (the same "null means not yours to email about" the write door
   * already gives). The fan-out is best-effort and never throws out of `notify`:
   * a failed push or email must not roll back the notification it is about, and
   * the row is already committed by `create` before any of it runs.
   *
   * Call it OUTSIDE any transaction whose failure it would report, exactly like
   * `create` -- it runs in the producer's ambient RLS context and seeds none of
   * its own. A detached fan-out ({@link NotifyOptions.fanOut}) keeps that
   * ambient identity and opens its own short `withScopedDb` transactions for
   * every read it makes; nothing of it joins the caller's response.
   */
  async notify(
    userId: string,
    input: CreateNotificationInput,
    options: NotifyOptions = {},
  ): Promise<Notification | null> {
    const category = notificationCategoryOf(input.type);
    const delivery = await this.preferences.resolveNotificationDelivery(
      userId,
      category,
    );
    const interrupting =
      delivery.push || delivery.unifiedpush || delivery.emailNotification;
    // The cooldown governs producers' interruptions. A reminder's re-emit is
    // the user's own schedule (an interval they chose, five minutes or more), so
    // it sits OUTSIDE the cooldown: neither held by it -- a 15-minute reminder
    // under a 30-minute cooldown would otherwise never push, its source or its
    // own previous nag always a prior in the window, a control that changes
    // nothing -- nor counted as a prior for anything else (`priorInWindow`).
    const throttled =
      interrupting &&
      delivery.throttleMinutes > 0 &&
      reminderIdOfData(input.data) === null;

    // The row, the caller's follow-up write and the throttle decision share one
    // transaction, and when the throttle is active the (user, category) advisory
    // lock (D7) is taken BEFORE the row is written. Taken after the commit, as a
    // first version did, it serialised nothing: replica B could commit and
    // decide before A's row was visible, then A decided against B's later
    // created_at -- and both sent. Held across write and decision, the later
    // decider blocks until the earlier row is committed and sees it.
    const written = await withScopedDb(this.dataSource, async (manager) => {
      if (throttled) {
        await manager.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`notif-fanout:${userId}:${category}`],
        );
      }
      const row = await this.notifications.create(userId, input);
      if (!row) return null;
      // Decide BEFORE the caller's follow-up write, so the decision reads the
      // rows as they were when this one arrived, not as the hook leaves them.
      const suppressed =
        throttled &&
        (await this.priorInWindow(
          manager,
          userId,
          category,
          row,
          delivery.throttleMinutes,
        ));
      if (options.onWritten) await options.onWritten(manager, row);
      return { row, suppressed };
    });
    if (!written) return null;
    const { row, suppressed } = written;

    const fanOut = this.fanOut(
      userId,
      row,
      category,
      delivery,
      suppressed,
      options.collapseKey,
    ).catch((error: unknown) => {
      // Never let a delivery failure escape: the bell row stands regardless.
      this.logger.error(
        `Fan-out failed for notification ${row.id}`,
        error instanceof Error ? error.stack : error,
      );
    });
    if (options.fanOut !== "detached") await fanOut;
    return row;
  }

  /**
   * The notification-mode fan-out: the matrix decided the channels and the
   * throttle decision was taken under the lock, in the transaction that wrote
   * the row; this runs after that commit and only sends.
   */
  private async fanOut(
    userId: string,
    row: Notification,
    category: NotificationCategory,
    delivery: Awaited<
      ReturnType<NotificationPreferenceService["resolveNotificationDelivery"]>
    >,
    suppressed: boolean,
    collapseKey?: string,
  ): Promise<void> {
    if (
      !delivery.push &&
      !delivery.unifiedpush &&
      !delivery.emailNotification
    ) {
      return;
    }
    // The throttle gates BOTH interrupting channels; an escalation always goes
    // (`priorInWindow` carries the severity set). A window of 0 disables the
    // throttle for this category.
    if (suppressed) return;

    // The two push channels ride the same encrypted Web Push wire and differ
    // only by which devices they reach, so one fan-out with the enabled
    // transport set (webpush for `push`, unifiedpush for `unifiedpush`) --
    // gated independently, delivered once.
    const transports: PushTransport[] = [];
    if (delivery.push) transports.push("webpush");
    if (delivery.unifiedpush) transports.push("unifiedpush");

    // Both interrupting channels are composed here, outside any request, so the
    // recipient's stored locale is resolved once and shared: the push copy and
    // the email frame must not disagree about the reader's language.
    const recipient = await this.resolveRecipient(
      userId,
      delivery.emailNotification,
    );
    if (transports.length > 0) {
      await this.push.sendToUser(
        userId,
        this.toPushPayload(row, category, recipient.lang, collapseKey),
        transports,
        ...(row.type === NotificationType.SECURITY_PRICE_MOVEMENT
          ? [priceChartRequest(row.data)]
          : []),
      );
    }
    if (delivery.emailNotification) {
      await this.sendEmail(recipient, row);
    }
  }

  /**
   * The recipient's stored language and number format and, only when the email
   * channel is on, their address -- one tenant transaction either way. A
   * push-only fan-out (SYSTEM, or a category with notification email off) never
   * needs the users row, and the budget cron runs this once per new alert per
   * user.
   *
   * Both formats come from the same preferences read: a figure follows
   * `numberFormat`, which is independent of `language` (issue #1316), and
   * resolving them separately is how one email ends up with translated copy
   * around a figure the reader never sees on screen.
   */
  private async resolveRecipient(
    userId: string,
    withAddress: boolean,
  ): Promise<{
    email: string | null;
    lang: string;
    numberFormat: string | null;
  }> {
    return withScopedDb(this.dataSource, async (manager) => {
      const { lang, numberFormat } = await resolveUserEmailFormats(
        manager.getRepository(UserPreference),
        userId,
      );
      if (!withAddress) return { email: null, lang, numberFormat };
      const user = await manager
        .getRepository(User)
        .findOne({ where: { id: userId } });
      return { email: user?.email ?? null, lang, numberFormat };
    });
  }

  /**
   * Whether an interrupting delivery for this notification should be suppressed:
   * a same-category, non-dismissed notification created within the window
   * strictly BEFORE this one, whose severity is at least this one's (so a strict
   * escalation is never suppressed). "Same category" is a filter on the type set
   * the category maps to (the category is not stored).
   *
   * Runs on the manager that holds the (user, category) advisory lock and wrote
   * the row, so two same-group events racing across replicas cannot both read
   * "no prior": the later decider blocks on the lock until the earlier row is
   * committed, then sees it and suppresses. Taken on every throttled path, push
   * included, because distinct rows do not collapse on the device.
   *
   * "Prior" is every OTHER live row in the window, excluded by id and not by
   * `created_at < mine`: `created_at` is the transaction's BEGIN time, and the
   * later lock-holder can have begun earlier (BEGIN is its own round trip before
   * the lock statement), so ordering on it let both replicas send -- the first
   * decider saw nothing, the second saw a row "younger" than its own and
   * ignored it. The first decider never sees the second's row (not yet
   * written), so exactly one of the two sends.
   *
   * A reminder's re-emitted nag (`data.reminderId`) is never a prior: the user
   * asked for that cadence, and it must not silence the category's other
   * interruptions any more than it is silenced by them (see `notify`).
   */
  private async priorInWindow(
    manager: EntityManager,
    userId: string,
    category: NotificationCategory,
    row: Notification,
    throttleMinutes: number,
  ): Promise<boolean> {
    const windowStart = new Date(
      new Date(row.createdAt).getTime() - throttleMinutes * 60_000,
    );
    const rows = returnedRows<{ suppress: boolean }>(
      await manager.query(
        `SELECT EXISTS (
           SELECT 1 FROM notifications
            WHERE user_id = $1
              AND alert_type = ANY($2)
              AND dismissed_at IS NULL
              AND created_at > $3
              AND id <> $4
              AND severity = ANY($5)
              AND COALESCE(data->>'reminderId', '') = ''
         ) AS suppress`,
        [
          userId,
          typesForCategory(category),
          windowStart,
          row.id,
          severitiesAtOrAbove(row.severity),
        ],
      ),
    );
    return rows[0]?.suppress === true;
  }

  /**
   * The push payload for a notification. Its `title`/`body` are the CATEGORY's
   * generic copy in the recipient's stored locale, not the row's own title and
   * message. Two reasons, either sufficient. The row's copy is composed by its
   * producer in English -- a budget alert names the category and the amounts --
   * and a Web Push body is rendered outside any request, so it follows the
   * email rule: `emailTranslator` against `user_preferences.language` (`docs/backend/notifications-and-push.md`,
   * "Copy composed outside a request"). And the wire is encrypted end
   * to end (RFC 8291) but the lock screen is not, so the screen shows the
   * category and nothing of the money; the in-app row, one tap away through
   * `target`, carries the detail. The English fallbacks live in
   * {@link PUSH_CATEGORY_COPY} and the catalogue under `push.notification`.
   */
  private toPushPayload(
    row: Notification,
    category: NotificationCategory,
    lang: string,
    collapseKey?: string,
  ): PushPayload {
    const t = emailTranslator(this.i18n, lang);
    const copy = PUSH_CATEGORY_COPY[category];
    const key = `push.notification.${category.toLowerCase()}`;
    const reminderId = reminderIdOf(row);
    return {
      type: row.type,
      title: t(`${key}.title`, copy.title),
      body: t(`${key}.body`, copy.body),
      target: row.target ?? undefined,
      // The subject this collapses onto, in order: what the producer said (a
      // cause shared by many rows), the REMINDER a re-emitted nag belongs to
      // (its per-fire dedupe key differs every fire, and a phone left overnight
      // must show one nag, not a hundred stacked), a system row's dedupe key,
      // else the row's own id (unique, so two distinct alerts never hide one
      // another). An id or a cause key, never a name or amount.
      collapseKey:
        collapseKey ??
        (reminderId ? `rem:${reminderId}` : (row.dedupeKey ?? row.id)),
      // A nag carries its reminder and the Stop action the worker renders for
      // it (R4); the title is rendered here because the worker has no
      // translator. Nothing else carries actions.
      ...(reminderId
        ? {
            reminderId,
            actions: [
              {
                action: "stop-reminder" as const,
                title: t("push.actions.stopReminder", "Stop reminders"),
              },
            ],
          }
        : {}),
    };
  }

  /** Render and send the immediate email in the recipient's locale, best-effort. */
  private async sendEmail(
    recipient: {
      email: string | null;
      lang: string;
      numberFormat: string | null;
    },
    row: Notification,
  ): Promise<void> {
    if (!this.email.getStatus().configured) return;
    if (!recipient.email) return;

    const appUrl = this.config.get<string>(
      "PUBLIC_APP_URL",
      "http://localhost:3000",
    );
    const target = row.target && row.target.startsWith("/") ? row.target : "";
    const t = emailTranslator(this.i18n, recipient.lang);
    const html = notificationImmediateTemplate(
      {
        ...notificationEmailCopy(row, t, recipient.lang, {
          numberFormat: recipient.numberFormat,
        }),
        url: `${appUrl}${target}`,
        severity: row.severity,
      },
      t,
    );
    const subject = t(
      "emails.notificationImmediate.subject",
      "You have a new Monize notification",
    );
    await this.email.sendMail(recipient.email, subject, html);
  }
}
