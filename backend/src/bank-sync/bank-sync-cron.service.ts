import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { returnedRows } from "../common/db/query-result";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import {
  JobClaimService,
  JobClaimType,
} from "../common/jobs/job-claim.service";
import type { BankSyncNotifySuccessMode } from "./bank-sync.constants";
import { BankSyncService } from "./bank-sync.service";
import {
  SYNC_RUNNING_CODE,
  describeSyncFailure,
  isSyncFailureEntry,
} from "./bank-sync-errors";
import {
  BankSyncOutcomeNotifier,
  CONSENT_GONE_CODE,
} from "./bank-sync-outcome-notifier.service";
import type { BankSyncConnectionOutcome } from "./bank-sync-outcome-notifier.service";
import { notificationAccountLabel } from "./bank-sync-notifications";
import { bankAccountNeedsPreview } from "./bank-sync-views";

/**
 * The daily bank sync (docs/specs/bank-sync.md section 8), once a day at 05:17
 * UTC.
 *
 * Every replica fires every cron, so what stops a second replica syncing the
 * same user is the claim: `claimOnce(BankSyncDaily, userId, <UTC date>)`, a
 * permanent `INSERT ... ON CONFLICT DO NOTHING RETURNING` row that one replica
 * wins per user per day. It is deliberately not handed back on failure: a
 * retry the same day would spend the bank's unattended-access allowance
 * (PSD2 allows about four reads a day), and the next day's window re-reads a
 * week, so a missed day is caught up.
 *
 * The shape is the ordinary out-of-request one: `withSystemContext` for the
 * cross-user fan-out, `withUserContext(userId)` around each user's whole body
 * -- the claim included, because a job claim is database access too -- and a
 * failure of one account or one user is logged and the loop continues.
 *
 * **Nothing imports a bank account that still needs its preview** (spec section
 * 7a): such an account is skipped and logged, never read from the bank, until
 * the person has confirmed its first import. Each connection's outcome is then
 * reported through `BankSyncOutcomeNotifier` (docs/specs/bank-sync-
 * notifications.md section 5): the day's result is written after the connection's
 * accounts have all been tried, and a connection whose consent the bank ended
 * stops being read for the rest of the run.
 */
@Injectable()
export class BankSyncCronService {
  private readonly logger = new Logger(BankSyncCronService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly jobClaims: JobClaimService,
    private readonly bankSync: BankSyncService,
    private readonly notifier: BankSyncOutcomeNotifier,
  ) {}

  @Cron("17 5 * * *", { timeZone: "UTC" })
  async handleDailySync(): Promise<void> {
    // The UTC day, read once: a run that crosses midnight keys every user alike.
    const day = new Date().toISOString().slice(0, 10);

    let userIds: string[];
    try {
      userIds = await withSystemContext(() => this.usersToSync());
    } catch (error) {
      this.logger.error(
        `Daily bank sync could not list its users: ${describeSyncFailure(error)}`,
      );
      return;
    }

    let synced = 0;
    for (const userId of userIds) {
      try {
        const ran = await withUserContext(userId, () =>
          this.syncUser(userId, day),
        );
        if (ran) synced += 1;
      } catch (error) {
        this.logger.error(
          `Daily bank sync failed for user ${userId}: ${describeSyncFailure(error)}`,
        );
      }
    }
    if (userIds.length > 0) {
      this.logger.log(
        `Daily bank sync: ${synced} of ${userIds.length} user(s) synced by this replica`,
      );
    }
  }

  /**
   * The users with at least one `active`, `auto_sync` connection that has a
   * linked bank account. Cross-user by construction, so it runs under the
   * system context and returns ids only.
   */
  private async usersToSync(): Promise<string[]> {
    return withScopedDb(this.dataSource, async (m) => {
      const rows = returnedRows<{ user_id: string }>(
        await m.query(
          `SELECT DISTINCT c.user_id
             FROM bank_sync_connections c
             JOIN bank_sync_accounts a ON a.connection_id = c.id
            WHERE c.status = 'active'
              AND c.auto_sync = true
              AND a.account_id IS NOT NULL
            ORDER BY c.user_id`,
        ),
      );
      return rows.map((row) => row.user_id);
    });
  }

  /** One user's day: claim it, then every linked account in turn. */
  private async syncUser(userId: string, day: string): Promise<boolean> {
    const won = await this.jobClaims.claimOnce(
      JobClaimType.BankSyncDaily,
      userId,
      day,
    );
    if (!won) return false;

    const accounts = await this.linkedAccounts(userId);

    // One outcome per connection, in the order the connections first appear.
    const outcomes = new Map<string, BankSyncConnectionOutcome>();
    for (const account of accounts) {
      let outcome = outcomes.get(account.connectionId);
      if (!outcome) {
        outcome = {
          connectionId: account.connectionId,
          institutionName: account.institutionName,
          notifySuccess: account.notifySuccess,
          validUntil: account.validUntil,
          synced: [],
          failures: [],
        };
        outcomes.set(account.connectionId, outcome);
      }

      // The bank ended this connection's session: its other accounts would be
      // refused for the same reason, and the expiry notice already says it.
      if (outcome.failures.some((f) => f.code === CONSENT_GONE_CODE)) continue;

      if (bankAccountNeedsPreview(account)) {
        this.logger.log(
          `Daily sync skipped bank account ${account.id}: its first import is not confirmed yet`,
        );
        continue;
      }

      // No PSU context: nobody is at the keyboard, so the bank counts it as an
      // unattended read. The sync records its own failure on the bank account.
      const entry = await this.bankSync.syncAccountEntry(
        userId,
        account.id,
        null,
      );
      if (isSyncFailureEntry(entry) && entry.error.code === SYNC_RUNNING_CODE) {
        // A sync the person started holds the account's lease. That is not a
        // failure of the account: nothing was recorded on it, and its own
        // result is that sync's to report, so the daily run says nothing.
        this.logger.log(
          `Daily sync skipped bank account ${account.id}: another sync of it is running`,
        );
        continue;
      }
      if (isSyncFailureEntry(entry)) {
        outcome.failures.push({
          bankAccountId: account.id,
          label: notificationAccountLabel(
            account.displayName,
            account.identifierMasked,
          ),
          code: entry.error.code,
        });
      } else {
        outcome.synced.push({
          imported: entry.imported,
          skipped: entry.skipped,
        });
      }
    }

    for (const outcome of outcomes.values()) {
      await this.notifier.report(userId, outcome, day);
    }
    return true;
  }

  /** The user's linked bank accounts of active auto-sync connections, oldest first. */
  private async linkedAccounts(userId: string): Promise<LinkedBankAccount[]> {
    return withScopedDb(this.dataSource, async (m) => {
      const rows = returnedRows<{
        id: string;
        connection_id: string;
        account_id: string;
        last_success_at: Date | null;
        display_name: string | null;
        identifier_masked: string | null;
        institution_name: string;
        notify_success: BankSyncNotifySuccessMode;
        valid_until: Date | null;
      }>(
        await m.query(
          `SELECT a.id, a.connection_id, a.account_id, a.last_success_at,
                  a.display_name, a.identifier_masked,
                  c.institution_name, c.notify_success, c.valid_until
             FROM bank_sync_accounts a
             JOIN bank_sync_connections c ON c.id = a.connection_id
            WHERE a.user_id = $1
              AND a.account_id IS NOT NULL
              AND c.status = 'active'
              AND c.auto_sync = true
            ORDER BY a.created_at, a.id`,
          [userId],
        ),
      );
      return rows.map((row) => ({
        id: row.id,
        connectionId: row.connection_id,
        accountId: row.account_id,
        lastSuccessAt: row.last_success_at,
        displayName: row.display_name,
        identifierMasked: row.identifier_masked,
        institutionName: row.institution_name,
        notifySuccess: row.notify_success,
        validUntil: row.valid_until,
      }));
    });
  }
}

/** A linked bank account with the connection facts its notification needs. */
interface LinkedBankAccount {
  id: string;
  connectionId: string;
  accountId: string;
  lastSuccessAt: Date | null;
  displayName: string | null;
  identifierMasked: string | null;
  institutionName: string;
  notifySuccess: BankSyncNotifySuccessMode;
  validUntil: Date | null;
}
