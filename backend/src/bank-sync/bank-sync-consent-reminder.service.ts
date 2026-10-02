import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { todayInTimezone } from "../common/date-utils";
import { returnedRows } from "../common/db/query-result";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { getUsersByEffectiveTimezone } from "../common/users-by-timezone.util";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import type { BankSyncConnectionStatus } from "./bank-sync.constants";
import { describeSyncFailure } from "./bank-sync-errors";
import {
  buildConsentExpiredNotification,
  buildConsentExpiringNotification,
  consentReminderThreshold,
  daysBetweenYMD,
} from "./bank-sync-notifications";

/**
 * How far back an ended consent is still looked at (spec section 4), and how
 * far ahead a connection is read as a CANDIDATE for a reminder.
 *
 * The ahead bound is not the 30 of the last mark. Days left are whole calendar
 * days in the user's zone, so a consent ending at 10:00 UTC on the 30th day
 * from now is "30 days left" for a run at 06:23 UTC, while its instant lies 30
 * days and 3 hours ahead; a bound of exactly 30 days would skip it until the
 * next day's run (the example in spec section 4: renewed to 2027-09-21 10:00,
 * the 30-day mark is due on 2027-08-22). Zones reach 14 hours either way, so 32
 * days reads every connection that could be at 30 days left, and the day count
 * (`consentReminderThreshold`) alone decides whether one is owed.
 */
const LOOK_BACK_DAYS = 7;
const LOOK_AHEAD_DAYS = 32;
const DAY_MS = 86_400_000;

/** A connection whose consent the reminder run has to judge. */
interface ConsentCandidate {
  id: string;
  userId: string;
  institutionName: string;
  status: BankSyncConnectionStatus;
  validUntil: Date;
}

/** What one evaluation did, for the log line. */
export interface ConsentReminderTally {
  /** Notification rows this replica wrote. */
  written: number;
  /** Connections moved from `active` to `expired` by this replica. */
  expired: number;
}

/**
 * Consent reminders (docs/specs/bank-sync-notifications.md section 4), once a
 * day at 06:23 UTC. A bank connection's consent ends at `valid_until`; the user
 * hears about it when 30, 14, 7, 3, 2, 1 and 0 days remain and once when it has
 * ended.
 *
 * **A reminder fires on reaching a threshold, once per consent period, never on
 * mere observation.** The threshold owed is the smallest mark the days left are
 * at or under (`consentReminderThreshold`), so a run that was missed moves the
 * next one to a smaller mark instead of firing the skipped ones in a burst.
 *
 * **Every replica fires every cron, so the dedupe key is the claim.** A
 * notification's `dedupeKey` names the connection, the consent period (the date
 * of `valid_until`) and the mark; `NotificationService.create` is an
 * `INSERT ... ON CONFLICT DO NOTHING` over `idx_notifications_dedupe`, so one
 * replica wins each reminder and the other gets `null` and sends nothing. A
 * renewal changes `valid_until`, so the next period starts new keys. The
 * `active` -> `expired` move is a conditional `UPDATE`, which a second replica
 * finds already applied.
 *
 * The shape is the ordinary out-of-request one: `withSystemContext` for the
 * cross-user read, `withUserContext(userId)` around each user's whole body, a
 * failure of one connection or one user logged and the loop continues. Days
 * left are counted in the user's effective timezone, so "ends today" is the
 * user's today; a user with no resolvable timezone counts in UTC.
 */
@Injectable()
export class BankSyncConsentReminderService {
  private readonly logger = new Logger(BankSyncConsentReminderService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  @Cron("23 6 * * *", { timeZone: "UTC" })
  async handleDailyReminders(): Promise<void> {
    try {
      const tally = await this.evaluate(new Date());
      if (tally.written > 0 || tally.expired > 0) {
        this.logger.log(
          `Bank consent reminders: ${tally.written} written, ${tally.expired} connection(s) marked expired by this replica`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Bank consent reminders could not run: ${describeSyncFailure(error)}`,
      );
    }
  }

  /**
   * Judge every connection whose consent ends between a week ago and about a
   * month ahead (see {@link LOOK_AHEAD_DAYS}), as of `now`. Public so a test can pin the clock; the cron passes the
   * real one. Safe to run twice at once: see the class comment.
   */
  async evaluate(now: Date): Promise<ConsentReminderTally> {
    const { candidates, timezoneOf } = await withSystemContext(async () => ({
      candidates: await this.candidates(now),
      timezoneOf: await this.timezones(),
    }));

    const byUser = new Map<string, ConsentCandidate[]>();
    for (const candidate of candidates) {
      const list = byUser.get(candidate.userId) ?? [];
      list.push(candidate);
      byUser.set(candidate.userId, list);
    }

    const tally: ConsentReminderTally = { written: 0, expired: 0 };
    for (const [userId, connections] of byUser) {
      try {
        const timezone = timezoneOf.get(userId) ?? "UTC";
        await withUserContext(userId, async () => {
          for (const connection of connections) {
            try {
              await this.evaluateConnection(connection, timezone, now, tally);
            } catch (error) {
              this.logger.error(
                `Consent reminder for connection ${connection.id} failed: ${describeSyncFailure(error)}`,
              );
            }
          }
        });
      } catch (error) {
        this.logger.error(
          `Consent reminders failed for user ${userId}: ${describeSyncFailure(error)}`,
        );
      }
    }
    return tally;
  }

  /** `active` and `expired` connections ending in the window; ids and names only, across users. */
  private async candidates(now: Date): Promise<ConsentCandidate[]> {
    const from = new Date(now.getTime() - LOOK_BACK_DAYS * DAY_MS);
    const to = new Date(now.getTime() + LOOK_AHEAD_DAYS * DAY_MS);
    return withScopedDb(this.dataSource, async (m) => {
      const rows = returnedRows<{
        id: string;
        user_id: string;
        institution_name: string;
        status: BankSyncConnectionStatus;
        valid_until: Date;
      }>(
        await m.query(
          `SELECT id, user_id, institution_name, status, valid_until
             FROM bank_sync_connections
            WHERE status IN ('active', 'expired')
              AND valid_until BETWEEN $1 AND $2
            ORDER BY user_id, created_at, id`,
          [from, to],
        ),
      );
      return rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        institutionName: row.institution_name,
        status: row.status,
        validUntil: row.valid_until,
      }));
    });
  }

  /** Every user's effective timezone, read once under the system context. */
  private async timezones(): Promise<Map<string, string>> {
    const byZone = await getUsersByEffectiveTimezone(this.dataSource);
    const byUser = new Map<string, string>();
    for (const [timezone, userIds] of byZone) {
      for (const userId of userIds) byUser.set(userId, timezone);
    }
    return byUser;
  }

  /** One connection of one user, inside that user's identity. */
  private async evaluateConnection(
    connection: ConsentCandidate,
    timezone: string,
    now: Date,
    tally: ConsentReminderTally,
  ): Promise<void> {
    // A zone that does not resolve counts in UTC, never skips the reminder.
    const zone = todayInTimezone(timezone, now) === null ? "UTC" : timezone;
    const today = todayInTimezone(zone, now) as string;
    const facts = {
      connectionId: connection.id,
      institutionName: connection.institutionName,
    };

    // The consent has ended: the connection says so, or its end has passed. The
    // instant decides, not the calendar day, so a consent that ended at 03:00
    // today is not reminded of as ending "today" at 06:23.
    if (
      connection.status === "expired" ||
      connection.validUntil.getTime() <= now.getTime()
    ) {
      if (connection.status === "active") {
        tally.expired += await this.markExpired(connection);
      }
      const written = await this.dispatch.notify(
        connection.userId,
        buildConsentExpiredNotification(
          { ...facts, validUntil: connection.validUntil },
          today,
        ),
      );
      if (written) tally.written += 1;
      return;
    }

    const localEnd = todayInTimezone(zone, connection.validUntil) as string;
    const threshold = consentReminderThreshold(daysBetweenYMD(today, localEnd));
    if (threshold === null) return;
    const written = await this.dispatch.notify(
      connection.userId,
      buildConsentExpiringNotification(
        { ...facts, validUntil: connection.validUntil },
        threshold,
        localEnd,
        today,
      ),
    );
    if (written) tally.written += 1;
  }

  /**
   * `active` -> `expired` for a consent whose end has passed. Conditional on
   * both, so a re-authorization that renewed the connection meanwhile (a later
   * `valid_until`) or a replica that got here first leaves nothing to do; the
   * database's own clock decides "passed". Returns how many rows this call moved.
   */
  private async markExpired(connection: ConsentCandidate): Promise<number> {
    return withScopedDb(this.dataSource, async (m) => {
      const rows = returnedRows<{ id: string }>(
        await m.query(
          `UPDATE bank_sync_connections
              SET status = 'expired'
            WHERE id = $1 AND user_id = $2
              AND status = 'active' AND valid_until < now()
        RETURNING id`,
          [connection.id, connection.userId],
        ),
      );
      return rows.length;
    });
  }
}
