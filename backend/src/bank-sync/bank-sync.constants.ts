/**
 * The closed sets of the bank-sync feature, each written once.
 *
 * Every list here is also a database CHECK (`database/schema.sql`), and
 * `bank-sync-constants.guard.spec.ts` fails when a constant and its CHECK
 * disagree in either direction. Adding a provider or a status is one entry here
 * plus the paired migration, never a second hand-written list.
 */

/** The aggregators Monize can talk to; `enable_banking` is the first. */
export const BANK_SYNC_PROVIDERS = ["enable_banking"] as const;
export type BankSyncProviderName = (typeof BANK_SYNC_PROVIDERS)[number];

/**
 * Where a connection is in its life: `pending` until the bank's redirect comes
 * back, `active` while the consent holds, `expired` once `valid_until` passes
 * or the provider says the session is gone, `revoked` when the user withdrew it
 * at the bank, `failed` when the authorization ended in an error.
 */
export const BANK_SYNC_CONNECTION_STATUSES = [
  "pending",
  "active",
  "expired",
  "revoked",
  "failed",
] as const;
export type BankSyncConnectionStatus =
  (typeof BANK_SYNC_CONNECTION_STATUSES)[number];

/** The kind of access asked for at the bank. */
export const BANK_SYNC_PSU_TYPES = ["personal", "business"] as const;
export type BankSyncPsuType = (typeof BANK_SYNC_PSU_TYPES)[number];

/** The outcome of the last sync of one bank account; null means never synced. */
export const BANK_SYNC_LAST_SYNC_STATUSES = ["succeeded", "failed"] as const;
export type BankSyncLastSyncStatus =
  (typeof BANK_SYNC_LAST_SYNC_STATUSES)[number];

/**
 * How the daily sync reports a successful run on a connection (docs/specs/
 * bank-sync-notifications.md section 3): `always` after every run, even one that
 * imported nothing; `when_imported` only when rows were imported; `never` not at
 * all. Failures and consent reminders do not depend on it.
 */
export const BANK_SYNC_NOTIFY_SUCCESS_MODES = [
  "always",
  "when_imported",
  "never",
] as const;
export type BankSyncNotifySuccessMode =
  (typeof BANK_SYNC_NOTIFY_SUCCESS_MODES)[number];
export const BANK_SYNC_DEFAULT_NOTIFY_SUCCESS: BankSyncNotifySuccessMode =
  "when_imported";

/**
 * Whether a synced transaction is tagged with the bank's operation type on a
 * connection that did not choose (docs/specs/bank-sync.md section 7b). The
 * column's DEFAULT in `database/schema.sql` and the migration, held equal to it
 * by `bank-sync-constants.guard.spec.ts`.
 */
export const BANK_SYNC_DEFAULT_TAG_OPERATION_TYPE = true;

/**
 * The provider a connection is made through when the request does not name one.
 * The API takes no provider parameter in the first release: one provider, so
 * one credentials row per user (docs/specs/bank-sync.md section 4).
 */
export const BANK_SYNC_DEFAULT_PROVIDER: BankSyncProviderName =
  BANK_SYNC_PROVIDERS[0];

/** Where the provider sends the user back to; appended to `PUBLIC_APP_URL`. */
export const BANK_SYNC_CALLBACK_PATH = "/settings/bank-sync/callback";

/**
 * How long an authorization state stays claimable (spec section 5). The
 * callback's conditional `UPDATE` compares `auth_started_at` against the
 * database's clock, so no process clock decides it.
 */
export const AUTH_STATE_TTL_MS = 30 * 60 * 1000;

/** The longest consent Monize asks a bank for, whatever the bank would allow. */
export const MAX_CONSENT_VALIDITY_DAYS = 180;

/** A consent length as the provider states it: seconds. */
export const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * How long one bank-account sync holds its lease (spec section 7 step 2). It
 * outlasts the worst case of a sync: up to 100 pages of transactions at the
 * client's 15 second timeout each (25 minutes), then the balances, so 30
 * minutes. A lease shorter than a slow sync would let a second sync start
 * while the first still holds the bank; a replica killed mid-sync stops
 * blocking the account once the lease lapses.
 */
export const SYNC_LEASE_TTL_MS = 30 * 60 * 1000;

/**
 * The re-read overlap, in days: a window starts this far before the last
 * success so a row the bank booked late is not missed. The ledger makes the
 * re-read free (spec section 7).
 */
export const SYNC_OVERLAP_DAYS = 7;

/**
 * The cut-off default for a bank account linked to an empty Monize account.
 * One day inside the 90 days many banks serve after the first hour of a
 * consent (Enable Banking FAQ), so the first sync does not ask for a day the
 * bank refuses with WRONG_TRANSACTIONS_PERIOD.
 */
export const DEFAULT_CUTOFF_LOOKBACK_DAYS = 89;

/** The width of `last_error` / `last_sync_error`; a stored message is cut to it. */
export const BANK_SYNC_STORED_MESSAGE_MAX_LENGTH = 500;

/** Bounds for the PSU headers a user-present sync forwards to the bank. */
export const PSU_IP_MAX_LENGTH = 64;
export const PSU_USER_AGENT_MAX_LENGTH = 256;

/** How many rules-applier ids go through one `applyToNew` call. */
export const RULES_BATCH_SIZE = 500;
