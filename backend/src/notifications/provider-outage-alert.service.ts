import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { I18nService } from "nestjs-i18n";
import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import { withSystemContext } from "../common/db/with-context";
import {
  EmailT,
  emailTranslator,
  englishEmailT,
} from "../i18n/email-translator";
import { SystemAlertService } from "../system-alerts/system-alert.service";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  AdminRecipient,
  queryAdminRecipients,
} from "../users/admin-recipients.util";
import { resolveUserEmailLocale } from "../i18n/resolve-user-email-locale";
import { MIN_OUTAGE_MS, providerLabel } from "../provider-health/providers";
import { EmailService } from "./email.service";
import {
  providerOutageTemplate,
  providerRecoveryTemplate,
} from "./email-templates";

/**
 * How long a provider must have been failing before anybody is emailed. Lives
 * beside the providers because `ProviderHealthService.recordDataFailure` has to
 * meet the same gate; re-exported here, where the claim reads it.
 */
export { MIN_OUTAGE_MS } from "../provider-health/providers";

/**
 * Floor between two alerts about the same provider, whatever happened in
 * between.
 *
 * This is the anti-spam guarantee, and it is deliberately the crudest of the
 * three: an outage that resolves and returns every twenty minutes for a day
 * produces at most one outage notice and one all-clear per six hours, because
 * `last_notified_at` is never cleared by a recovery -- only by time passing.
 */
export const ALERT_QUIET_PERIOD_MS = 6 * 60 * 60_000;

/** A `provider_health` row, as the driver returns it. */
interface HealthRow {
  provider: string;
  state: string;
  recent_failures: number | string;
  outage_started_at: Date | null;
  last_failure_at: Date | null;
  last_failure_reason: string | null;
  last_success_at: Date | null;
  outage_notified_at: Date | null;
}

/** One admin who is owed the notice, with the locale to render it in. */
interface Recipient {
  userId: string;
  email: string;
  firstName: string;
}

/** `2026-08-26 19:03 UTC` -- an operator's timestamp, not a user's. */
export function formatUtcMinute(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** "2 h 15 min" / "40 min", in the recipient's language. */
export function formatOutageDuration(ms: number, t: EmailT): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return t("emails.providerOutage.durationMinutes", `${minutes} min`, {
      minutes,
    });
  }
  return t(
    "emails.providerOutage.durationHoursMinutes",
    `${hours} h ${minutes} min`,
    { hours, minutes },
  );
}

/**
 * Tells the deployment's administrators when a market-data provider has stopped
 * answering, and when it comes back -- once per outage, not once per failure.
 *
 * Before this, a provider outage was something an operator discovered from the
 * application being unusable and then from a log of `TypeError: fetch failed`
 * repeated thousands of times (issue #1265). The alert is the other half of the
 * circuit breaker: the breaker stops the flood, and the flood was also the only
 * signal anybody had.
 *
 * Three separate mechanisms keep it off the "another monitoring email" pile, and
 * they are separate on purpose -- each one alone has a hole:
 *
 * 1. **A minimum outage** (`MIN_OUTAGE_MS`), read from durable state, so a blip
 *    or a restart never mails anybody.
 * 2. **One notice per episode**: `outage_notified_at` is claimed with a
 *    conditional UPDATE, so however many replicas fire this cron, one of them
 *    sends. The recovery notice clears the marker, which is what makes the pair
 *    at most one-and-one per episode.
 * 3. **A quiet period** (`ALERT_QUIET_PERIOD_MS`) on `last_notified_at`, which
 *    nothing clears, so a flapping provider cannot mail its way around (2).
 *
 * The claim is taken *before* the send, which makes the alert **at most once**:
 * a process killed between the UPDATE committing and SMTP accepting loses that
 * notice. That is the right way round for this particular email -- a duplicated
 * alert is the failure mode being designed against, the outage stays in the log
 * and in `provider_health`, and a still-broken provider becomes notifiable again
 * once the quiet period elapses. It is the opposite trade from
 * `BillReminderService`, which would rather send twice than miss a mortgage
 * renewal; `docs/external-side-effects.md` records both.
 */
@Injectable()
export class ProviderOutageAlertService {
  private readonly logger = new Logger(ProviderOutageAlertService.name);

  /**
   * Providers already reported as having nobody to notify.
   *
   * The sweep runs every ten minutes; an install whose administrators have all
   * disabled email would otherwise log the same warning 144 times a day, which
   * is the noise this whole change exists to remove. Cleared as soon as a
   * recipient reappears, so the next occasion is reported again.
   */
  private readonly noRecipientsReported = new Set<string>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly emailService: EmailService,
    private readonly i18n: I18nService,
    @Inject(forwardRef(() => SystemAlertService))
    private readonly systemAlerts: SystemAlertService,
  ) {}

  /**
   * Cross-user work with no request behind it, so it seeds its own system
   * context. Every ten minutes: the gate is fifteen, so an outage is reported
   * between fifteen and twenty-five minutes in.
   *
   * Deliberately not gated on SMTP being configured: the claim also produces
   * the in-app PROVIDER_OUTAGE/PROVIDER_RECOVERED alert rows, which are the
   * delivery when email cannot be. The email leg skips inside `deliver`.
   */
  @Cron("*/10 * * * *")
  async sweepProviderHealth(): Promise<void> {
    await withSystemContext(() => this.sweepWithinContext());
  }

  private async sweepWithinContext(): Promise<void> {
    const rows = await this.pendingRows();
    if (rows.length === 0) return;

    for (const row of rows) {
      try {
        if (row.state === "down") {
          await this.notifyOutage(row);
        } else if (row.outage_notified_at !== null) {
          await this.notifyRecovery(row);
        }
      } catch (error) {
        this.logger.error(
          `Provider health alert for ${row.provider} failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * The rows that could produce an email: currently down, or up with an
   * unmatched outage notice. Everything healthy and quiet is filtered in SQL
   * rather than read and skipped.
   */
  private async pendingRows(): Promise<HealthRow[]> {
    return withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT provider, state, recent_failures, outage_started_at,
                last_failure_at, last_failure_reason, last_success_at,
                outage_notified_at
           FROM provider_health
          WHERE state = 'down' OR outage_notified_at IS NOT NULL`,
      ),
    ) as Promise<HealthRow[]>;
  }

  /**
   * Claim the outage notice for this episode, then send it.
   *
   * The whole decision is in the `WHERE`: down, long enough, not already
   * notified, and outside the quiet period. Reading those conditions in
   * TypeScript and then updating would let two replicas both pass the read --
   * the shape `BudgetAlertService` still has, and the reason it can double-send
   * (`docs/external-side-effects.md`).
   */
  private async notifyOutage(row: HealthRow): Promise<void> {
    // Recipients first, and the claim only if there are any: the claim is
    // consumed once and never retried, so taking it before knowing anybody can
    // be told would destroy the episode's only notice. "Anybody" means any
    // active administrator -- the in-app alert row reaches admins whose email
    // is off, so only a deployment with no admins at all stands down here.
    // The `WHERE` below is still the authority on whether the notice is owed
    // -- this is a local pre-filter, so a row that is merely already-notified
    // costs no query.
    if (!this.outageMightBeDue(row)) return;
    const admins = await this.activeAdmins();
    if (admins.length === 0) {
      this.reportNoRecipients(row.provider, "is down");
      return;
    }
    const recipients = emailableRecipients(admins);

    // `returnedRows`, not `result[0]`: TypeORM's postgres driver returns the
    // tuple `[rows, rowCount]` for an UPDATE -- with or without RETURNING -- so
    // reading position 0 hands back the *row list* and every field of the
    // "claimed row" is undefined. The send then threw inside the template with
    // the claim already committed, which is the worst failure this path has:
    // the episode is marked notified and nobody was told. Every unit test
    // passed, because a mocked manager returns the flat shape; the integration
    // spec against a real database is what found it.
    const claimed = returnedRows<HealthRow>(
      await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `UPDATE provider_health
            SET outage_notified_at = CURRENT_TIMESTAMP,
                last_notified_at = CURRENT_TIMESTAMP
          WHERE provider = $1
            AND state = 'down'
            AND outage_notified_at IS NULL
            AND outage_started_at IS NOT NULL
            AND outage_started_at <= CURRENT_TIMESTAMP - ($2::text || ' milliseconds')::interval
            AND last_failure_at IS NOT NULL
            AND last_failure_at >= outage_started_at + ($2::text || ' milliseconds')::interval
            AND (last_notified_at IS NULL
                 OR last_notified_at <= CURRENT_TIMESTAMP - ($3::text || ' milliseconds')::interval)
        RETURNING provider, state, recent_failures, outage_started_at,
                  last_failure_reason, last_success_at, outage_notified_at`,
          [row.provider, String(MIN_OUTAGE_MS), String(ALERT_QUIET_PERIOD_MS)],
        ),
      ),
    );
    const won = claimed[0];
    if (!won) return;

    const startedAt = won.outage_started_at
      ? new Date(won.outage_started_at)
      : new Date();
    const outageMs = Date.now() - startedAt.getTime();
    const label = providerLabel(won.provider);

    // The in-app companion rows, before the emails: they are the delivery
    // every admin gets (email off or SMTP unconfigured included). The claim
    // above is the arbiter, so `email: false` -- the bespoke email below
    // already carries this episode -- and the dedupe key names the episode so
    // a re-notification after the quiet period lands as a fresh row.
    await this.systemAlerts.raiseAdminAlert({
      type: NotificationType.PROVIDER_OUTAGE,
      severity: NotificationSeverity.WARNING,
      title: `${label} is not responding`,
      message:
        `The market data provider ${label} has been unreachable since ` +
        `${formatUtcMinute(startedAt)}. Prices and index data that depend on ` +
        "it may be missing or out of date until it answers again.",
      data: {
        system: true,
        provider: won.provider,
        providerLabel: label,
        since: startedAt.toISOString(),
        recentFailures: Number(won.recent_failures) || 0,
        lastFailureReason: won.last_failure_reason,
      },
      dedupeKey: `PROVIDER_OUTAGE:${won.provider}:${startedAt.toISOString()}`,
      email: false,
    });

    for (const recipient of recipients) {
      // The whole per-recipient body is isolated, not just the send: resolving
      // one administrator's locale is a database read, and letting it throw out
      // of the loop cost every administrator after them their notice -- with
      // the claim already committed and a six-hour floor behind it, so it was
      // never re-sent.
      await this.deliver(recipient, async () => {
        const t = await this.translatorFor(recipient.userId);
        const html = providerOutageTemplate(
          recipient.firstName,
          {
            provider: label,
            since: formatUtcMinute(startedAt),
            duration: formatOutageDuration(outageMs, t),
            recentFailures: Number(won.recent_failures) || 0,
            lastFailureReason: won.last_failure_reason,
            lastSuccessAt: won.last_success_at
              ? formatUtcMinute(new Date(won.last_success_at))
              : null,
            quietPeriodHours: ALERT_QUIET_PERIOD_MS / 3_600_000,
          },
          t,
        );
        return {
          subject: t(
            "emails.providerOutage.subject",
            `Monize: ${label} is not responding`,
            { provider: label },
          ),
          html,
        };
      });
    }
  }

  /** Clear the episode's notice and send the all-clear that pairs with it. */
  private async notifyRecovery(row: HealthRow): Promise<void> {
    // Same reason as the outage path, and it bit harder here: clearing
    // `outage_notified_at` with nobody to tell destroyed the all-clear *and*
    // the record that an outage notice was owed one, silently.
    const admins = await this.activeAdmins();
    if (admins.length === 0) {
      this.reportNoRecipients(row.provider, "is answering again");
      return;
    }
    const recipients = emailableRecipients(admins);

    // The same driver-shape trap as the outage claim above: an UPDATE's rows
    // arrive inside `[rows, rowCount]`.
    const claimed = returnedRows<HealthRow>(
      await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `UPDATE provider_health
            SET outage_notified_at = NULL,
                last_notified_at = CURRENT_TIMESTAMP
          WHERE provider = $1
            AND state = 'up'
            AND outage_notified_at IS NOT NULL
        RETURNING provider, state, recent_failures, outage_started_at,
                  last_failure_reason, last_success_at, outage_notified_at`,
          [row.provider],
        ),
      ),
    );
    const won = claimed[0];
    if (!won) return;

    const restoredAt = won.last_success_at
      ? new Date(won.last_success_at)
      : new Date();
    const startedAt = won.outage_started_at
      ? new Date(won.outage_started_at)
      : null;
    const label = providerLabel(won.provider);
    const durationMs = startedAt
      ? restoredAt.getTime() - startedAt.getTime()
      : 0;

    // The in-app all-clear that pairs with the outage row. Keyed on the same
    // episode identity (its start) so the pair shares a suffix; `restoredAt`
    // is the fallback for a row whose start the upsert lost.
    await this.systemAlerts.raiseAdminAlert({
      type: NotificationType.PROVIDER_RECOVERED,
      severity: NotificationSeverity.SUCCESS,
      title: `${label} is answering again`,
      message:
        `The market data provider ${label} answered again at ` +
        `${formatUtcMinute(restoredAt)}. The outage lasted ` +
        `${formatOutageDuration(durationMs, englishEmailT)}.`,
      data: {
        system: true,
        provider: won.provider,
        providerLabel: label,
        restoredAt: restoredAt.toISOString(),
        durationMs,
      },
      dedupeKey:
        `PROVIDER_RECOVERED:${won.provider}:` +
        (startedAt ?? restoredAt).toISOString(),
      email: false,
    });

    for (const recipient of recipients) {
      await this.deliver(recipient, async () => {
        const t = await this.translatorFor(recipient.userId);
        const html = providerRecoveryTemplate(
          recipient.firstName,
          {
            provider: label,
            restoredAt: formatUtcMinute(restoredAt),
            duration: formatOutageDuration(
              startedAt ? restoredAt.getTime() - startedAt.getTime() : 0,
              t,
            ),
          },
          t,
        );
        return {
          subject: t(
            "emails.providerRecovery.subject",
            `Monize: ${label} is answering again`,
            { provider: label },
          ),
          html,
        };
      });
    }
  }

  /**
   * Whether this row could possibly owe an outage notice, from what was read.
   *
   * A cheap local mirror of the claim's `WHERE`, and deliberately generous: it
   * exists only to avoid a recipient query for a row that is plainly not due,
   * and the claim -- which is atomic and re-reads the row -- decides.
   */
  private outageMightBeDue(row: HealthRow): boolean {
    if (row.state !== "down") return false;
    if (row.outage_notified_at !== null) return false;
    if (row.outage_started_at === null) return false;
    if (row.last_failure_at === null) return false;
    const startedMs = new Date(row.outage_started_at).getTime();
    return (
      Date.now() - startedMs >= MIN_OUTAGE_MS &&
      new Date(row.last_failure_at).getTime() - startedMs >= MIN_OUTAGE_MS
    );
  }

  /** Say once, per provider, that there is nobody to tell. */
  private reportNoRecipients(provider: string, what: string): void {
    if (this.noRecipientsReported.has(provider)) return;
    this.noRecipientsReported.add(provider);
    this.logger.warn(
      `${providerLabel(provider)} ${what}, and this deployment has no active ` +
        "administrator; nobody was told. The alert stays owed, so it is " +
        "raised once an administrator exists.",
    );
  }

  /**
   * Every active administrator -- the audience of the in-app alert rows. The
   * predicate lives in `queryAdminRecipients` (`users/admin-recipients.util.ts`),
   * shared with `SystemAlertService`; the email leg narrows this list through
   * `emailableRecipients` below.
   */
  private async activeAdmins(): Promise<AdminRecipient[]> {
    const admins = await withScopedDb(this.dataSource, (manager) =>
      queryAdminRecipients(manager),
    );
    if (admins.length > 0) this.noRecipientsReported.clear();
    return admins;
  }

  /** The recipient's own locale, never the locale of whoever noticed. */
  private async translatorFor(userId: string): Promise<EmailT> {
    const lang = await withScopedDb(this.dataSource, (manager) =>
      resolveUserEmailLocale(manager.getRepository(UserPreference), userId),
    );
    return emailTranslator(this.i18n, lang);
  }

  /**
   * One recipient's notice, isolated end to end.
   *
   * Rendering is inside the boundary as much as sending is: the locale comes
   * from a database read, and an SMTP rejection is only the most obvious way one
   * recipient can fail. Either must cost that recipient their notice and
   * nobody else theirs -- the claim is already committed, so there is no second
   * attempt for the ones further down the list.
   */
  private async deliver(
    recipient: Recipient,
    build: () => Promise<{ subject: string; html: string }>,
  ): Promise<void> {
    // The SMTP gate lives here, not at the top of the sweep: the claim must
    // still be consumed on an email-less deployment because it also produces
    // the in-app alert rows, which are the delivery in that case.
    if (!this.emailService.getStatus().configured) {
      this.logger.debug(
        `SMTP not configured; provider health email to ${recipient.userId} skipped`,
      );
      return;
    }
    try {
      const { subject, html } = await build();
      await this.emailService.sendMail(recipient.email, subject, html);
    } catch (error) {
      this.logger.error(
        `Could not email provider health alert to ${recipient.userId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** The subset of admins the email leg can reach, in `Recipient` shape. */
function emailableRecipients(admins: AdminRecipient[]): Recipient[] {
  return admins.flatMap((admin) =>
    admin.emailEnabled && admin.email !== null
      ? [
          {
            userId: admin.userId,
            email: admin.email,
            firstName: admin.firstName,
          },
        ]
      : [],
  );
}
