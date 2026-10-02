/**
 * Bank sync (Open Banking) API shapes. They mirror `docs/specs/bank-sync.md`
 * section 9 exactly. Money the API sends is a decimal STRING (`decimal(20,4)`
 * crosses the wire as text), so a balance is typed `string` here and is made a
 * number at the point of display, never earlier.
 */

import type {
  ImportPreviewLabels,
  ImportPreviewPayee,
  ImportPreviewPayeeVia,
  ImportPreviewRule,
} from '@/types/import-preview';

/** The connection lifecycle. Mirrors the column's CHECK. */
export type BankSyncConnectionStatus =
  | 'pending'
  | 'active'
  | 'expired'
  | 'revoked'
  | 'failed';

/** The outcome of the last sync of one bank account. */
export type BankSyncAccountSyncStatus = 'succeeded' | 'failed';

/**
 * When the daily sync of a connection reports a successful run
 * (`docs/specs/bank-sync-notifications.md` section 3): after every run, only
 * when transactions were imported, or never. Failures and consent reminders do
 * not depend on it. Mirrors the column's CHECK.
 */
export const BANK_SYNC_NOTIFY_SUCCESS_MODES = ['always', 'when_imported', 'never'] as const;
export type BankSyncNotifySuccessMode = (typeof BANK_SYNC_NOTIFY_SUCCESS_MODES)[number];

/** Whose account the consent is for. */
export type BankSyncPsuType = 'personal' | 'business';

/** The provider application this user registered. Never carries the key. */
export interface BankSyncCredentialsView {
  provider: string;
  applicationId: string;
  /** True when a private key is stored. The key itself never leaves the server. */
  privateKeySet: boolean;
}

export interface BankSyncStatus {
  /** False when the server holds no ENCRYPTION_KEY, so no key can be stored. */
  encryptionAvailable: boolean;
  providers: string[];
  credentials: BankSyncCredentialsView | null;
  /** The exact URL to register in the provider's control panel. */
  redirectUrl: string;
}

export interface SaveBankSyncCredentials {
  applicationId: string;
  /** A new PEM key; omit to keep the stored one (required when none is stored). */
  privateKey?: string;
}

export interface BankSyncCredentialsTestResult {
  ok: boolean;
  applicationName: string;
  redirectUrls: string[];
}

export interface BankInstitution {
  name: string;
  country: string;
  logoUrl: string | null;
  psuTypes: string[];
  maximumConsentValidityDays: number | null;
}

export interface BankSyncAccount {
  id: string;
  connectionId: string;
  displayName: string | null;
  identifierMasked: string | null;
  /**
   * The bank's full account identifier (IBAN or number), normalized. It is the
   * owner's own data with the sensitivity of a Monize account number, and is
   * here only to prefill a new account's number; lists show `identifierMasked`.
   */
  accountIdentifier: string | null;
  /**
   * The bank's account type (`CACC` current, `CARD`, `SVGS` savings, `LOAN`, or
   * another code), or null when the bank stated none.
   */
  cashAccountType: string | null;
  currencyCode: string | null;
  /** The Monize account this bank account is mapped to, or null when unlinked. */
  accountId: string | null;
  syncFromDate: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: BankSyncAccountSyncStatus | null;
  lastSyncError: string | null;
  lastImportedCount: number | null;
  lastSkippedCount: number | null;
  lastRefusedCount: number | null;
  /** What the bank reported (decimal string), or null when it reported none. */
  bankBalance: string | null;
  bankBalanceCurrency: string | null;
  bankBalanceDate: string | null;
  /**
   * True while the account is linked and no sync has succeeded since the link
   * (or since its account or start date changed): the first import is confirmed
   * from the preview (spec section 7a).
   */
  needsPreview: boolean;
}

export interface BankSyncConnection {
  id: string;
  provider: string;
  institutionName: string;
  institutionCountry: string;
  status: BankSyncConnectionStatus;
  validUntil: string | null;
  autoSync: boolean;
  /** When the daily sync reports a successful run. */
  notifySuccess: BankSyncNotifySuccessMode;
  /** Whether a synced transaction is tagged with the bank's operation type (spec section 7b). */
  tagOperationType: boolean;
  lastError: string | null;
  createdAt: string;
  accounts: BankSyncAccount[];
}

export interface CreateBankSyncConnection {
  institutionName: string;
  country: string;
  psuType: BankSyncPsuType;
}

/** Where to send the user to authorize at their bank. */
export interface BankSyncAuthorizationStart {
  connectionId: string;
  authorizationUrl: string;
}

export interface BankSyncCallbackPayload {
  state: string;
  code?: string;
  error?: string;
  errorDescription?: string;
}

/** Send only the setting that changed; the server leaves the other as it is. */
export interface UpdateBankSyncConnection {
  autoSync?: boolean;
  notifySuccess?: BankSyncNotifySuccessMode;
  tagOperationType?: boolean;
}

export interface UpdateBankSyncAccount {
  /** `null` unlinks. */
  accountId: string | null;
  /** Sent only when the user chose a date; omitted lets the server default it. */
  syncFromDate?: string;
}

/** A bank account the server linked to the Monize account its number names. */
export interface BankSyncLinkedMatch {
  bankAccountId: string;
  accountId: string;
}

/** A bank account two or more Monize accounts could be; nothing was linked. */
export interface BankSyncMatchSuggestion {
  bankAccountId: string;
  accountIds: string[];
}

/**
 * The answer to the callback and to `POST /bank-sync/connections/:id/match`
 * (spec section 5a): the connection as it now stands, what was linked and what
 * is ambiguous.
 */
export interface BankSyncMatchedConnection {
  connection: BankSyncConnection;
  linked: BankSyncLinkedMatch[];
  suggestions: BankSyncMatchSuggestion[];
}

/** `GET /bank-sync/accounts/:id/link-defaults` (spec section 7). */
export interface BankSyncLinkDefaults {
  /** The date of the newest transaction in the account; null for an empty account. */
  newestTransactionDate: string | null;
  /** The start date a link made without a chosen date gets. */
  defaultSyncFromDate: string;
}

/** What the preview says about one bank row (spec sections 7a and 7b). */
export type BankSyncPreviewOutcome =
  | 'new'
  | 'duplicate'
  /** An exception: added from the preview, so no sync imports it. */
  | 'excluded'
  | 'refused'
  | 'pending'
  | 'before_cutoff';

/** How a row's payee resolves (the neutral import preview's shape; see `types/import-preview.ts`). */
export type BankSyncPayeeVia = ImportPreviewPayeeVia;
export type BankSyncPreviewPayee = ImportPreviewPayee;
/** One import rule that matched a row, with what it changed (ids named by `labels`). */
export type BankSyncPreviewRule = ImportPreviewRule;
/** Names for the ids the rows' rule traces mention, so no raw id reaches the screen. */
export type BankSyncPreviewLabels = ImportPreviewLabels;

export interface BankSyncPreviewRow {
  outcome: BankSyncPreviewOutcome;
  /**
   * The duplicate key of a planned row (new, already imported or an exception),
   * which a selection names; null for a row that was not planned.
   */
  externalKey: string | null;
  /** Set when the outcome is `refused`. */
  refusalReason: string | null;
  transactionDate: string | null;
  /** Signed money as a decimal string; null when the bank's amount was unreadable. */
  amount: string | null;
  currencyCode: string | null;
  payeeText: string | null;
  description: string | null;
  referenceNumber: string | null;
  /** What the payee lookup and the import rules would give; set for a `new` row. */
  payeeName: string | null;
  categoryName: string | null;
  tagNames: string[];
  /** How the payee resolves; null unless the row is `new`. */
  payee: BankSyncPreviewPayee | null;
  /** The import rules that matched, in order; empty unless the row is `new`. */
  rules: BankSyncPreviewRule[];
  /** The operation-type tag the sync would add; null when there is none. */
  operationTag: string | null;
}

export interface BankSyncPreviewSummary {
  new: number;
  duplicate: number;
  /** Exceptions among the rows. */
  excluded: number;
  refused: number;
  refusedByReason: Record<string, number>;
  pending: number;
  beforeCutoff: number;
}

/** `POST /bank-sync/accounts/:id/preview`: nothing in it has been written. */
export interface BankSyncPreview {
  bankAccountId: string;
  /** The Monize account's currency; every figure below is in it. */
  currencyCode: string;
  rows: BankSyncPreviewRow[];
  labels: BankSyncPreviewLabels;
  summary: BankSyncPreviewSummary;
  /** Decimal strings. */
  monizeBalance: string;
  balanceAfter: string;
  /** What the bank reported, or null when it reported none. */
  bankBalance: {
    amount: string;
    currencyCode: string;
    referenceDate: string | null;
  } | null;
  /** The bank's balance minus `balanceAfter`; null unless both are known in one currency. */
  difference: string | null;
  /** Sent back with the sync so it imports exactly these rows. */
  planFingerprint: string;
}

/** The outcome of syncing one bank account (spec section 7). */
export interface BankSyncResult {
  bankAccountId: string;
  /** Rows written. Above zero is what makes the client drop its balance caches. */
  imported: number;
  /** Rows already imported before (the ledger says so). */
  skipped: number;
  /** Rows this sync added to the exceptions; absent from a server older than this client. */
  excluded?: number;
  /** Refused rows by reason (`currency_mismatch`, `invalid_amount`, ...). */
  refused: Record<string, number>;
  /** Rows the bank has not booked yet; counted, not an error. */
  pending: number;
  /** Rows booked before the account's cut-off date. */
  beforeCutoff: number;
  bankBalance: {
    amount: string;
    currencyCode: string;
    referenceDate: string | null;
  } | null;
}

/**
 * What the person chose in the preview: the keys to import and the keys to add
 * to the exceptions. Every other new row stays as it was and is shown again.
 */
export interface BankSyncSelection {
  importKeys: string[];
  excludeKeys: string[];
}

/** `POST /bank-sync/accounts/:id/exceptions/remove`. */
export interface BankSyncRemovedExceptions {
  /** How many exceptions were deleted. */
  removed: number;
}

/**
 * One linked bank account that could not be synced, inside the answer to "sync
 * every account of a connection". `error.code` is a stable machine code (the
 * provider's error kind, `credentials`, `refused` or `unexpected`, or
 * `needs_preview` for an account the sync skipped because its first import has
 * not been confirmed from the preview); `error.message` is the server's
 * translated, safe-to-show sentence.
 */
export interface BankSyncFailure {
  bankAccountId: string;
  error: { code: string; message: string };
}

/**
 * One entry per linked account of a connection sync: a result, or a failure.
 * Tell them apart with `isBankSyncFailure` (`lib/bank-sync-summary.ts`); only a
 * failure carries `error`.
 */
export type BankSyncConnectionEntry = BankSyncResult | BankSyncFailure;
