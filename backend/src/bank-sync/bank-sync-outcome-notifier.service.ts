import { Injectable, Logger } from "@nestjs/common";
import type { CreateNotificationInput } from "../notification-center/notification.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import type { BankSyncNotifySuccessMode } from "./bank-sync.constants";
import { describeSyncFailure } from "./bank-sync-errors";
import {
  buildConsentExpiredNotification,
  buildSyncFailedNotification,
  buildSyncImportedNotification,
  shouldNotifyImported,
} from "./bank-sync-notifications";
import type { BankSyncFailureFact } from "./bank-sync-notifications";

/** What the daily sync of one connection's linked bank accounts did. */
export interface BankSyncConnectionOutcome {
  connectionId: string;
  institutionName: string;
  notifySuccess: BankSyncNotifySuccessMode;
  validUntil: Date | null;
  /** The bank accounts that synced. */
  synced: { imported: number; skipped: number }[];
  /** The bank accounts that did not, with the machine code of each failure. */
  failures: BankSyncFailureFact[];
}

/** The code `describeFailureForClient` gives a provider that says the consent is gone. */
export const CONSENT_GONE_CODE = "session_expired";

/**
 * Writes the notifications the daily bank sync owes for one connection
 * (docs/specs/bank-sync-notifications.md section 5): the expiry notice when the
 * bank ended the consent, a failure notice for every other failed account, and
 * the success notice per the connection's mode.
 *
 * Only the daily sync calls it. A sync the user starts reports through its own
 * toast and writes no notification; `bank-sync-notification-sources.guard.spec.ts`
 * holds that by listing the only files that may reach the dispatch.
 *
 * It runs in the caller's per-user identity (the cron's `withUserContext`) and
 * seeds none. Each notification is written on its own and a failure to write
 * one is logged and does not stop the next: a notification is a report of a
 * sync that already happened, and must never fail it.
 */
@Injectable()
export class BankSyncOutcomeNotifier {
  private readonly logger = new Logger(BankSyncOutcomeNotifier.name);

  constructor(private readonly dispatch: NotificationDispatchService) {}

  /** `day` is the UTC date of the run, the date half of every dedupe key. */
  async report(
    userId: string,
    outcome: BankSyncConnectionOutcome,
    day: string,
  ): Promise<void> {
    const facts = {
      connectionId: outcome.connectionId,
      institutionName: outcome.institutionName,
    };
    const toNotify: CreateNotificationInput[] = [];

    // The bank ended the consent: one expiry notice, under the key the reminder
    // service uses for the same period, so it is heard once whichever sees it
    // first. It is not also a failure of the accounts that hit it.
    if (
      outcome.failures.some((failure) => failure.code === CONSENT_GONE_CODE)
    ) {
      toNotify.push(
        buildConsentExpiredNotification(
          { ...facts, validUntil: outcome.validUntil },
          day,
        ),
      );
    }

    const failed = outcome.failures.filter(
      (failure) => failure.code !== CONSENT_GONE_CODE,
    );
    if (failed.length > 0) {
      toNotify.push(buildSyncFailedNotification(facts, failed, day));
    }

    // A run in which no account synced did not "finish": nothing to report as a
    // success, even for `always`.
    if (outcome.synced.length > 0) {
      const imported = outcome.synced.reduce(
        (sum, result) => sum + result.imported,
        0,
      );
      if (shouldNotifyImported(outcome.notifySuccess, imported)) {
        toNotify.push(
          buildSyncImportedNotification(
            {
              ...facts,
              imported,
              skipped: outcome.synced.reduce(
                (sum, result) => sum + result.skipped,
                0,
              ),
              accounts: outcome.synced.length,
            },
            day,
          ),
        );
      }
    }

    for (const input of toNotify) {
      try {
        await this.dispatch.notify(userId, input);
      } catch (error) {
        this.logger.error(
          `Could not write the ${input.type} notification of connection ${outcome.connectionId}: ${describeSyncFailure(error)}`,
        );
      }
    }
  }
}
