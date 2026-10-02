import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import type { CreateNotificationInput } from "../notification-center/notification.service";
import type { BankSyncNotifySuccessMode } from "./bank-sync.constants";

/**
 * The notifications bank sync raises, as pure functions of the facts they
 * report (docs/specs/bank-sync-notifications.md). Nothing here reads a clock or
 * a database: the reminder service and the daily sync read the facts and pass
 * them in, so the threshold choice, the dedupe keys and the success-mode truth
 * table are testable without either.
 *
 * `data` holds facts (a calendar date, the threshold, counts, codes), never
 * "in 3 days" text: a row outlives the day it was written, so the client
 * renders it in the reader's language and the email composes it at delivery.
 * `title` and `message` are the English fallbacks for a reader with no client.
 *
 * Every row's `target` is the literal `/settings/bank-sync`, written inline in
 * each builder: the frontend's `notification-target.contract.test.ts` reads a
 * producer's target out of the source and checks that it is a real page, and a
 * target held in a constant is one it cannot verify.
 */

/**
 * The days-left marks a consent reminder fires at (spec section 4). `0` is the
 * last day; a consent that has ended is the expired notification, not a mark.
 */
export const CONSENT_REMINDER_THRESHOLDS = [30, 14, 7, 3, 2, 1, 0] as const;
export type ConsentReminderThreshold =
  (typeof CONSENT_REMINDER_THRESHOLDS)[number];

/**
 * The reminder a consent with `daysLeft` whole days remaining is owed: the
 * smallest threshold `t` with `daysLeft <= t`. 5 days left is the 7-day
 * reminder, 2 is the 2-day one, and 31 or more is none. A missed run only moves
 * a later one to a smaller threshold, so the skipped marks are never fired as a
 * burst. `null` for a consent that has ended (`daysLeft < 0`), for one more than
 * 30 days away, and for a count that is not a whole number: unknown is not a
 * reminder.
 */
export function consentReminderThreshold(
  daysLeft: number,
): ConsentReminderThreshold | null {
  if (!Number.isInteger(daysLeft) || daysLeft < 0) return null;
  const ascending = [...CONSENT_REMINDER_THRESHOLDS].reverse();
  return ascending.find((threshold) => daysLeft <= threshold) ?? null;
}

/** Spec section 2: info at 30 and 14 days, warning from 7 to 1, critical on the last day. */
export function consentReminderSeverity(
  threshold: ConsentReminderThreshold,
): NotificationSeverity {
  if (threshold === 0) return NotificationSeverity.CRITICAL;
  return threshold >= 14
    ? NotificationSeverity.INFO
    : NotificationSeverity.WARNING;
}

/**
 * Whole calendar days from `from` to `to`, both `YYYY-MM-DD`. UTC arithmetic on
 * purpose: neither string carries a zone, so a local-time difference would be
 * off by one either side of a DST change.
 */
export function daysBetweenYMD(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000,
  );
}

/**
 * The UTC calendar date of a consent's end, the part of a dedupe key that names
 * the consent period. UTC and not the reader's zone, so a user who changes
 * timezone mid-period does not mint new keys and hear every reminder again; a
 * renewal changes `valid_until`, which is what starts the next period. `none`
 * for a connection whose provider reported no end.
 */
export function consentPeriodKey(validUntil: Date | null): string {
  return validUntil === null ? "none" : validUntil.toISOString().slice(0, 10);
}

/** The dedupe key of one consent reminder (spec section 4). */
export function consentExpiringDedupeKey(
  connectionId: string,
  validUntil: Date,
  threshold: ConsentReminderThreshold,
): string {
  return `bsc:exp:${connectionId}:${consentPeriodKey(validUntil)}:${threshold}`;
}

/**
 * The dedupe key of the one expiry notice of a consent period. The reminder
 * service and the daily sync (a `session_expired` failure) both write it, so
 * whichever path sees the end first, the user hears it once.
 */
export function consentExpiredDedupeKey(
  connectionId: string,
  validUntil: Date | null,
): string {
  return `bsc:expd:${connectionId}:${consentPeriodKey(validUntil)}`;
}

/** The facts of the connection a notification is about. */
export interface BankConnectionFacts {
  connectionId: string;
  institutionName: string;
}

export function buildConsentExpiringNotification(
  connection: BankConnectionFacts & { validUntil: Date },
  threshold: ConsentReminderThreshold,
  /** The end of the consent as a calendar date in the reader's timezone. */
  localValidUntil: string,
  /** Today in the reader's timezone. */
  localToday: string,
): CreateNotificationInput {
  const { institutionName } = connection;
  const within =
    threshold === 0
      ? "today"
      : threshold === 1
        ? "within 1 day"
        : `within ${threshold} days`;
  return {
    type: NotificationType.BANK_SYNC_CONSENT_EXPIRING,
    severity: consentReminderSeverity(threshold),
    title: `${institutionName}: bank access ends ${within}`,
    message:
      `Your consent for Monize to read ${institutionName} ends on ` +
      `${localValidUntil}. Renew the connection in Monize to keep syncing.`,
    data: {
      connectionId: connection.connectionId,
      institutionName,
      validUntil: localValidUntil,
      threshold,
    },
    target: "/settings/bank-sync",
    periodStart: localToday,
    dedupeKey: consentExpiringDedupeKey(
      connection.connectionId,
      connection.validUntil,
      threshold,
    ),
  };
}

export function buildConsentExpiredNotification(
  connection: BankConnectionFacts & { validUntil: Date | null },
  periodStart: string,
): CreateNotificationInput {
  const { institutionName } = connection;
  return {
    type: NotificationType.BANK_SYNC_CONSENT_EXPIRED,
    severity: NotificationSeverity.CRITICAL,
    title: `${institutionName}: bank access has ended`,
    message:
      `Your consent for Monize to read ${institutionName} has ended. ` +
      "Renew the connection in Monize to resume syncing.",
    data: {
      connectionId: connection.connectionId,
      institutionName,
      // The UTC date that names the consent period (its dedupe key's date), or
      // null when the provider reported none. Whichever path writes this first,
      // the daily sync or the reminder service, the row says the same.
      validUntil:
        connection.validUntil === null
          ? null
          : consentPeriodKey(connection.validUntil),
    },
    target: "/settings/bank-sync",
    periodStart,
    dedupeKey: consentExpiredDedupeKey(
      connection.connectionId,
      connection.validUntil,
    ),
  };
}

/**
 * Spec section 3's truth table: whether a daily sync that imported `imported`
 * rows is reported as a success. `always` reports even a run that found
 * nothing, `when_imported` only a run that imported, `never` nothing.
 */
export function shouldNotifyImported(
  mode: BankSyncNotifySuccessMode,
  imported: number,
): boolean {
  switch (mode) {
    case "always":
      return true;
    case "when_imported":
      return imported > 0;
    case "never":
      return false;
  }
}

/** What the daily sync of one connection's accounts read and wrote, added up. */
export interface BankSyncImportedFacts extends BankConnectionFacts {
  imported: number;
  skipped: number;
  /** How many bank accounts of the connection synced. */
  accounts: number;
}

export function buildSyncImportedNotification(
  facts: BankSyncImportedFacts,
  day: string,
): CreateNotificationInput {
  const { institutionName, imported } = facts;
  return {
    type: NotificationType.BANK_SYNC_IMPORTED,
    severity: NotificationSeverity.SUCCESS,
    title:
      imported > 0
        ? `${institutionName}: new transactions imported`
        : `${institutionName}: no new transactions`,
    message:
      imported > 0
        ? `The daily sync imported ${imported} transaction${imported === 1 ? "" : "s"} from ${institutionName}.`
        : `The daily sync of ${institutionName} found no new transactions.`,
    data: {
      connectionId: facts.connectionId,
      institutionName,
      imported,
      skipped: facts.skipped,
      accounts: facts.accounts,
    },
    target: "/settings/bank-sync",
    periodStart: day,
    dedupeKey: `bsc:imp:${facts.connectionId}:${day}`,
  };
}

/**
 * One bank account the daily sync could not read. `label` is the bank's name
 * for the account, else its masked identifier, never a full number; null when
 * the bank gave neither.
 */
export interface BankSyncFailureFact {
  bankAccountId: string;
  label: string | null;
  code: string;
}

/**
 * Eight or more digits, with spaces or dashes between them: the shape of an
 * account number, which a notification must never carry in full.
 */
const ACCOUNT_NUMBER_SHAPE = /\d(?:[\s-]?\d){7,}/;

/**
 * What a failed bank account is called in a notification: the bank's own label
 * for it, else its masked identifier, else nothing (the copy then says "an
 * account"). A label that looks like an account number (some banks put the IBAN
 * in the account's details) is not used, so the number never reaches a row, an
 * email or a push.
 */
export function notificationAccountLabel(
  displayName: string | null,
  identifierMasked: string | null,
): string | null {
  const name = displayName?.trim() ?? "";
  if (name !== "" && !ACCOUNT_NUMBER_SHAPE.test(name)) return name;
  const masked = identifierMasked?.trim() ?? "";
  return masked === "" ? null : masked;
}

/**
 * The failure code a notification carries. A provider that rejects the
 * application credentials (`unauthorized`) and credentials Monize cannot read
 * (`credentials`) are one repair for the reader, so they are one code.
 */
export function notificationFailureCode(code: string): string {
  return code === "unauthorized" ? "credentials" : code;
}

export function buildSyncFailedNotification(
  connection: BankConnectionFacts,
  failures: readonly BankSyncFailureFact[],
  day: string,
): CreateNotificationInput {
  const { institutionName } = connection;
  const labels = failures
    .map((failure) => failure.label)
    .filter((label): label is string => label !== null);
  return {
    type: NotificationType.BANK_SYNC_FAILED,
    severity: NotificationSeverity.WARNING,
    title: `${institutionName}: sync failed`,
    message:
      `The daily sync of ${institutionName} failed` +
      (labels.length > 0 ? ` for: ${labels.join(", ")}.` : ".") +
      " Open bank sync settings to see why.",
    data: {
      connectionId: connection.connectionId,
      institutionName,
      failures: failures.map((failure) => ({
        bankAccountId: failure.bankAccountId,
        label: failure.label,
        code: notificationFailureCode(failure.code),
      })),
    },
    target: "/settings/bank-sync",
    periodStart: day,
    dedupeKey: `bsc:fail:${connection.connectionId}:${day}`,
  };
}
