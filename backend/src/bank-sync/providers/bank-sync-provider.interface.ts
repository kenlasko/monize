import type { BankSyncProviderName } from "../bank-sync.constants";
import type { BankOperation } from "../bank-operation";

export type { BankSyncProviderName } from "../bank-sync.constants";

/**
 * Provider-neutral types for bank sync. Nothing outside
 * `providers/<provider>/` knows a provider's wire format: an adapter turns its
 * JSON into these shapes and the rest of the feature reads only these
 * (docs/specs/bank-sync.md section 1).
 */

/** The provider application a user registered, decrypted for one call. */
export interface BankSyncCredentials {
  applicationId: string;
  /** PEM. Never logged, never returned, never put in an error message. */
  privateKeyPem: string;
}

/** A bank the provider can connect to. */
export interface BankInstitution {
  name: string;
  /** ISO 3166-1 alpha-2, upper case. */
  country: string;
  logoUrl: string | null;
  psuTypes: string[];
  maximumConsentValiditySeconds: number | null;
}

/** One account a session can read. */
export interface BankAccountDescriptor {
  /** The provider's id for the account; what every read is addressed by. */
  externalAccountId: string;
  /** Stable across sessions; what re-authorization matches accounts on. */
  identificationHash: string | null;
  displayName: string | null;
  /** An IBAN or number reduced to its last four characters, e.g. "**** 1234". */
  identifierMasked: string | null;
  /**
   * The full identifier (IBAN, else another scheme's number), normalized: spaces
   * and dashes removed, upper case, at most 64 characters. What a Monize account
   * is matched on (spec section 5a); null when the bank gave none.
   */
  accountIdentifier: string | null;
  /** The bank's cash account type (`CACC`, `CARD`, `SVGS`, ...), upper case; null when unstated. */
  cashAccountType: string | null;
  currencyCode: string | null;
}

/** One transaction as the provider reported it, before any Monize rule. */
export interface BankTransaction {
  /** Unique and immutable across sessions: the duplicate key's first choice. */
  entryReference: string | null;
  /**
   * A handle for fetching details only; the provider may change it between two
   * list fetches, so it never takes part in the duplicate key.
   */
  transactionId: string | null;
  /** The bank's own reference (`reference_number`); display data only. */
  bankReference: string | null;
  /** The absolute decimal string as sent; the sign is `direction`. */
  amount: string | null;
  currencyCode: string | null;
  direction: "credit" | "debit" | null;
  /** True only for a booked row; a pending row changes identity when it books. */
  booked: boolean;
  bookingDate: string | null;
  valueDate: string | null;
  transactionDate: string | null;
  /** Already chosen by direction: the creditor for a debit, the debtor for a credit. */
  counterpartyName: string | null;
  remittance: string[];
  /**
   * The bank's operation type, read beside the description and never out of it
   * (the description is part of the duplicate key; spec section 7b).
   */
  operation: BankOperation;
}

/** One balance of one account, signed as the bank reported it. */
export interface BankBalance {
  amount: string;
  currencyCode: string;
  referenceDate: string | null;
  balanceType: string | null;
}

/**
 * Who is at the keyboard, passed on a user-present sync so the bank does not
 * count the read against the unattended-access limit (PSD2 allows about four
 * unattended reads a day). Null for the daily cron.
 */
export interface PsuContext {
  ipAddress: string;
  userAgent: string;
}

export interface StartAuthorizationInput {
  institutionName: string;
  country: string;
  redirectUrl: string;
  /** The one-time state the callback will carry back. */
  state: string;
  validUntil: Date;
  psuType: "personal" | "business";
}

export interface BankSyncProvider {
  readonly name: BankSyncProviderName;

  /** Proves the credentials are accepted; names the application and its redirect URLs. */
  testCredentials(
    credentials: BankSyncCredentials,
  ): Promise<{ applicationName: string | null; redirectUrls: string[] }>;

  listInstitutions(
    credentials: BankSyncCredentials,
    country: string,
  ): Promise<BankInstitution[]>;

  /** The URL to send the user to, to authorize access at their bank. */
  startAuthorization(
    credentials: BankSyncCredentials,
    input: StartAuthorizationInput,
  ): Promise<{ url: string }>;

  /** Exchanges the redirect's `code` for a session and lists its accounts. */
  completeAuthorization(
    credentials: BankSyncCredentials,
    code: string,
  ): Promise<{
    sessionId: string;
    validUntil: Date | null;
    accounts: BankAccountDescriptor[];
  }>;

  /**
   * Every booked transaction in the window (whole days, inclusive), across all
   * pages. Throws rather than return a partial list.
   */
  fetchTransactions(
    credentials: BankSyncCredentials,
    externalAccountId: string,
    window: { dateFrom: string; dateTo: string },
    psu: PsuContext | null,
  ): Promise<BankTransaction[]>;

  /**
   * One account's details as the session listed them (identifier, type,
   * currency, label), for a bank account stored before the identifier was kept.
   * A user-present read passes the PSU context like the other reads.
   */
  fetchAccountDetails(
    credentials: BankSyncCredentials,
    externalAccountId: string,
    psu: PsuContext | null,
  ): Promise<BankAccountDescriptor>;

  /** The balance to show beside Monize's, or null when the bank reported none. */
  fetchBalance(
    credentials: BankSyncCredentials,
    externalAccountId: string,
    psu: PsuContext | null,
  ): Promise<BankBalance | null>;

  revokeSession(
    credentials: BankSyncCredentials,
    sessionId: string,
  ): Promise<void>;
}
