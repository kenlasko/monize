import type {
  BankSyncConnectionStatus,
  BankSyncNotifySuccessMode,
  BankSyncLastSyncStatus,
  BankSyncProviderName,
  BankSyncPsuType,
} from "./bank-sync.constants";
import type {
  ImportPreviewLabels,
  ImportPreviewPayeeVia,
  ImportPreviewPayeeView,
  ImportPreviewRuleChanges,
  ImportPreviewRuleView,
} from "../import-preview/import-preview.types";
import type { RefusalReason } from "./bank-transaction-planner";

/**
 * What the bank-sync API returns. None of these carries key material
 * (INV-BANKSYNC-002): the credentials view says whether a key is stored, and
 * the connection view has no provider session id. Money crosses the wire as a
 * decimal string, like the rest of the API's `decimal(20,4)` values read raw.
 */

export interface BankSyncCredentialsView {
  provider: BankSyncProviderName;
  applicationId: string;
  /** True when a private key is stored. The key itself is never returned. */
  privateKeySet: boolean;
}

export interface BankSyncStatusView {
  /** False when the server holds no `ENCRYPTION_KEY`, so no key can be stored. */
  encryptionAvailable: boolean;
  providers: string[];
  credentials: BankSyncCredentialsView | null;
  /** The exact URL to register in the provider's control panel. */
  redirectUrl: string;
}

export interface BankSyncCredentialsTestView {
  ok: boolean;
  applicationName: string;
  redirectUrls: string[];
}

export interface BankInstitutionView {
  name: string;
  country: string;
  logoUrl: string | null;
  psuTypes: string[];
  maximumConsentValidityDays: number | null;
}

export interface BankSyncAccountView {
  id: string;
  connectionId: string;
  displayName: string | null;
  identifierMasked: string | null;
  /**
   * The full identifier, normalized (spec section 5a). It is the owner's own
   * data with the sensitivity of `accounts.account_number`, which the accounts
   * API already returns; the client uses it only to prefill the number of an
   * account created from this bank account, and lists show `identifierMasked`.
   * Null when the bank gave none or the account predates the column.
   */
  accountIdentifier: string | null;
  /**
   * The bank's account type (`CACC`, `CARD`, `SVGS`, `LOAN`, ...), upper case;
   * null when the bank stated none or the account predates the column.
   */
  cashAccountType: string | null;
  currencyCode: string | null;
  /** The Monize account this bank account feeds; null while unlinked. */
  accountId: string | null;
  syncFromDate: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: BankSyncLastSyncStatus | null;
  lastSyncError: string | null;
  lastImportedCount: number;
  lastSkippedCount: number;
  lastRefusedCount: number;
  /** What the bank reported (decimal string); null means "not reported", never 0. */
  bankBalance: string | null;
  bankBalanceCurrency: string | null;
  bankBalanceDate: string | null;
  /**
   * True while the bank account is linked and its link has no successful sync
   * yet: the first sync after a link, or after its account or cut-off date
   * changed, is confirmed from the preview (spec section 7a).
   */
  needsPreview: boolean;
}

export interface BankSyncConnectionView {
  id: string;
  provider: BankSyncProviderName;
  institutionName: string;
  institutionCountry: string;
  psuType: BankSyncPsuType;
  status: BankSyncConnectionStatus;
  validUntil: string | null;
  autoSync: boolean;
  /** How the daily sync reports a successful run. */
  notifySuccess: BankSyncNotifySuccessMode;
  /** Whether a synced transaction is tagged with the bank's operation type (spec section 7b). */
  tagOperationType: boolean;
  lastError: string | null;
  createdAt: string;
  accounts: BankSyncAccountView[];
}

export interface BankSyncAuthorizationStartView {
  connectionId: string;
  authorizationUrl: string;
}

/** The outcome of syncing one bank account (spec section 7). */
export interface BankSyncResult {
  bankAccountId: string;
  /** Rows written. Above zero is what makes a client drop its balance caches. */
  imported: number;
  /** Rows the ledger says were imported before. */
  skipped: number;
  /** Rows this sync added to the exceptions (spec section 7b); zero without a selection. */
  excluded: number;
  refused: Record<RefusalReason, number>;
  /** Rows the bank has not booked yet; counted, not an error. */
  pending: number;
  /** Rows booked before the account's cut-off date. */
  beforeCutoff: number;
  /** The balance this sync fetched; null when the bank reported none. */
  bankBalance: {
    amount: string;
    currencyCode: string;
    referenceDate: string | null;
  } | null;
}

/**
 * One linked bank account that could not be synced, inside the answer to "sync
 * every account of a connection". `error.code` is a stable machine code (the
 * provider's error kind, `refused` or `unexpected`); `error.message` is
 * translated and safe to show.
 */
export interface BankSyncAccountFailure {
  bankAccountId: string;
  error: { code: string; message: string };
}

/** One entry per linked account: its result, or why it has none. */
export type BankSyncConnectionSyncEntry =
  | BankSyncResult
  | BankSyncAccountFailure;

/** `POST /bank-sync/accounts/:id/exceptions/remove` (spec section 7b). */
export interface BankSyncRemovedExceptionsView {
  /** How many exceptions were deleted; a key that is not an exception is not counted. */
  removed: number;
}

/** A bank account linked to a Monize account by `POST .../match` or the callback. */
export interface BankSyncLinkedMatch {
  bankAccountId: string;
  accountId: string;
}

/** A bank account with two or more Monize accounts that could be it; nothing is linked. */
export interface BankSyncMatchSuggestion {
  bankAccountId: string;
  accountIds: string[];
}

/** What matching bank accounts to Monize accounts did (spec section 5a). */
export interface BankSyncMatchResult {
  linked: BankSyncLinkedMatch[];
  suggestions: BankSyncMatchSuggestion[];
}

/** The answer to the callback and to `POST /bank-sync/connections/:id/match`. */
export interface BankSyncMatchedConnectionView extends BankSyncMatchResult {
  connection: BankSyncConnectionView;
}

/** `GET /bank-sync/accounts/:id/link-defaults?accountId=` (spec section 7). */
export interface BankSyncLinkDefaultsView {
  newestTransactionDate: string | null;
  defaultSyncFromDate: string;
}

export type BankSyncPreviewOutcome =
  | "new"
  | "duplicate"
  /** An exception: the person added it to the exceptions; no sync imports it. */
  | "excluded"
  | "refused"
  | "pending"
  | "before_cutoff";

/**
 * How a row's payee resolves, and which import rules matched it (spec section
 * 7b). The shapes are the source-neutral import preview's
 * (`src/import-preview/import-preview.types.ts`): nothing in them is a bank's.
 */
export type BankSyncPayeeVia = ImportPreviewPayeeVia;
export type BankSyncPreviewPayeeView = ImportPreviewPayeeView;
export type BankSyncPreviewRuleChanges = ImportPreviewRuleChanges;
export type BankSyncPreviewRuleView = ImportPreviewRuleView;
export type BankSyncPreviewLabels = ImportPreviewLabels;

/** One provider row as the preview lists it (spec section 7a). */
export interface BankSyncPreviewRowView {
  outcome: BankSyncPreviewOutcome;
  /**
   * The duplicate key of a planned row (a `new`, `duplicate` or `excluded` one),
   * which is what a selection names; null for a row that was not planned.
   */
  externalKey: string | null;
  /** Set when `outcome` is `refused`. */
  refusalReason: RefusalReason | null;
  transactionDate: string | null;
  /** Signed money as a decimal string at four decimals; null when unreadable. */
  amount: string | null;
  currencyCode: string | null;
  payeeText: string | null;
  description: string | null;
  referenceNumber: string | null;
  /** What the payee lookup and the import rules would give; only for a `new` row. */
  payeeName: string | null;
  categoryName: string | null;
  tagNames: string[];
  /** How the payee resolves; null unless the row is `new`. */
  payee: BankSyncPreviewPayeeView | null;
  /** The import rules that matched, in order; empty unless the row is `new`. */
  rules: BankSyncPreviewRuleView[];
  /**
   * The operation-type tag the sync would add (already in `tagNames`); null when
   * the connection does not tag, the bank named no operation, or the row is not `new`.
   */
  operationTag: string | null;
}

/** `POST /bank-sync/accounts/:id/preview`: nothing in it was written. */
export interface BankSyncPreviewView {
  bankAccountId: string;
  /** The Monize account's currency: every amount of a new row is in it. */
  currencyCode: string;
  rows: BankSyncPreviewRowView[];
  /** Names for the ids in the rows' rule traces, so no raw id reaches the screen. */
  labels: BankSyncPreviewLabels;
  summary: {
    new: number;
    duplicate: number;
    /** Exceptions among the rows (spec section 7b). */
    excluded: number;
    refused: number;
    refusedByReason: Record<RefusalReason, number>;
    pending: number;
    beforeCutoff: number;
  };
  /** The Monize account's current balance, a decimal string. */
  monizeBalance: string;
  /** The balance after the new rows: the current balance plus their sum. */
  balanceAfter: string;
  /** What the bank reported; null when it reported none. */
  bankBalance: {
    amount: string;
    currencyCode: string;
    referenceDate: string | null;
  } | null;
  /**
   * The bank's balance minus `balanceAfter`; null unless the bank reported one
   * in the account's currency. Zero means the import would reconcile.
   */
  difference: string | null;
  /** Pass it to the sync to import exactly these rows. */
  planFingerprint: string;
}
