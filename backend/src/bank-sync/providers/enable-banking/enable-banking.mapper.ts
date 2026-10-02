import { boundedAccountIdentifier } from "../../bank-account-identifier";
import {
  BANK_OPERATION_MAX_LENGTH,
  remittanceOperationCode,
  type BankOperation,
} from "../../bank-operation";
import { BankSyncProviderError } from "../bank-sync-provider.errors";
import type {
  BankAccountDescriptor,
  BankBalance,
  BankInstitution,
  BankTransaction,
} from "../bank-sync-provider.interface";

/**
 * Enable Banking's wire JSON, turned into the provider-neutral shapes.
 *
 * Pure functions, and the only place this provider's field names appear
 * (docs/future-plans/bank-sync.md, assumption 3: the names were checked against
 * the provider's API reference, its OpenAPI file and its FAQ in task BS10).
 * Two rules run through all of them:
 *
 * - **A field that is absent or of the wrong type is null, and a row that is
 *   not an object is skipped. Nothing here throws for a malformed row.**
 * - **A response whose top-level shape is wrong raises `invalid_response`**,
 *   because reading garbage as "the bank has nothing new" would report a broken
 *   integration as an answer.
 *
 * Every string is trimmed, stripped of control characters and bounded, so a
 * hostile or broken bank cannot put an unbounded value in a row or a message.
 */

const MAX_NAME_LENGTH = 255;
const MAX_REFERENCE_LENGTH = 255;
const MAX_URL_LENGTH = 1000;
const MAX_DATE_TEXT_LENGTH = 32;
const MAX_TIMESTAMP_TEXT_LENGTH = 48;
const MAX_TYPE_LENGTH = 32;
/** The transaction description's own cap; the planner applies the exact one. */
const MAX_REMITTANCE_LINE_LENGTH = 750;
const MAX_REMITTANCE_LINES = 20;
const MAX_PSU_TYPES = 10;
const MAX_REDIRECT_URLS = 50;

/** The last characters of an identifier that are shown; the rest is masked. */
const MASK_VISIBLE_CHARACTERS = 4;
/** Below this length nothing is shown: the last four would be most of it. */
const MASK_MIN_LENGTH = 8;

/** A decimal as the providers send it: digits, an optional fraction, no exponent. */
const SIGNED_DECIMAL = /^-?\d{1,16}(\.\d{1,8})?$/;

/**
 * Enable Banking's balance types (`BalanceStatus`) in the order they answer
 * "what is the balance": the booked balance, then the available ones.
 */
const BALANCE_TYPE_PREFERENCE = [
  "CLBD",
  "ITBD",
  "ITAV",
  "CLAV",
  "XPCD",
] as const;

/**
 * Balance types that are not the balance now: the start of a period
 * (`OPBD`, `OPAV`), the end of the previous one (`PRCD`) and a balance on a
 * later date (`FWAV`). They are never shown as the bank's balance, and a bank
 * that reports only these has reported none.
 */
const NOT_CURRENT_BALANCE_TYPES: ReadonlySet<string> = new Set([
  "OPBD",
  "OPAV",
  "PRCD",
  "FWAV",
]);

/**
 * ISO 4217 "no currency": Enable Banking sends it for a multi-currency account
 * or when the bank states none. It is not a currency to compare with.
 */
const UNKNOWN_CURRENCY = "XXX";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trimmed, control-character-free, bounded; null when nothing is left. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (cleaned === "") return null;
  return cleaned.slice(0, max);
}

/** A decimal string as sent, or null. A finite number is accepted as its text. */
function decimalText(value: unknown): string | null {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : null;
  return raw !== null && SIGNED_DECIMAL.test(raw) ? raw : null;
}

/**
 * A code of exactly `letters` letters, upper-cased, or null. The whole value is
 * checked before anything is cut: truncating first would read "EURO" as "EUR".
 */
function letterCode(value: unknown, letters: number): string | null {
  const code = text(value, MAX_TYPE_LENGTH);
  return code !== null && new RegExp(`^[A-Za-z]{${letters}}$`).test(code)
    ? code.toUpperCase()
    : null;
}

function currency(value: unknown): string | null {
  return letterCode(value, 3);
}

/** An array of records at `key`, or `invalid_response` when it is not an array. */
function requireArray(payload: UnknownRecord, key: string): unknown[] {
  const value = payload[key];
  if (!Array.isArray(value)) {
    throw new BankSyncProviderError(
      "invalid_response",
      `Enable Banking returned an unreadable response: "${key}" is missing.`,
    );
  }
  return value;
}

function requireObject(payload: unknown): UnknownRecord {
  if (!isRecord(payload)) {
    throw new BankSyncProviderError(
      "invalid_response",
      "Enable Banking returned an unreadable response.",
    );
  }
  return payload;
}

/**
 * An identifier reduced to its last four characters: `"**** 1234"`. Whitespace
 * is ignored, and an identifier too short to hide anything shows nothing.
 */
export function maskIdentifier(value: unknown): string | null {
  const cleaned = text(value, 64)?.replace(/\s+/g, "") ?? null;
  if (cleaned === null) return null;
  if (cleaned.length < MASK_MIN_LENGTH) return "****";
  return `**** ${cleaned.slice(-MASK_VISIBLE_CHARACTERS)}`;
}

/** `GET /application`: the application's name and the redirect URLs it registered. */
export function mapApplication(payload: unknown): {
  applicationName: string | null;
  redirectUrls: string[];
} {
  const body = requireObject(payload);
  const urls = Array.isArray(body.redirect_urls) ? body.redirect_urls : [];
  return {
    applicationName: text(body.name, MAX_NAME_LENGTH),
    redirectUrls: urls
      .slice(0, MAX_REDIRECT_URLS)
      .map((url) => text(url, MAX_URL_LENGTH))
      .filter((url): url is string => url !== null),
  };
}

/** `GET /aspsps`: the banks the provider can connect to. */
export function mapInstitutions(payload: unknown): BankInstitution[] {
  const body = requireObject(payload);
  const institutions: BankInstitution[] = [];
  for (const row of requireArray(body, "aspsps")) {
    if (!isRecord(row)) continue;
    const name = text(row.name, MAX_NAME_LENGTH);
    const country = letterCode(row.country, 2);
    if (name === null || country === null) continue;
    const logo = text(row.logo, MAX_URL_LENGTH);
    const validity = row.maximum_consent_validity;
    institutions.push({
      name,
      country,
      // A logo is rendered as an image source, so only an https URL is kept.
      logoUrl: logo !== null && /^https:\/\//i.test(logo) ? logo : null,
      psuTypes: (Array.isArray(row.psu_types) ? row.psu_types : [])
        .slice(0, MAX_PSU_TYPES)
        .map((type) => text(type, MAX_TYPE_LENGTH))
        .filter((type): type is string => type !== null),
      maximumConsentValiditySeconds:
        typeof validity === "number" &&
        Number.isFinite(validity) &&
        validity > 0
          ? Math.floor(validity)
          : null,
    });
  }
  return institutions;
}

/** `POST /auth`: the URL to send the user to. Only an https URL is accepted. */
export function mapAuthorizationUrl(payload: unknown): string {
  const body = requireObject(payload);
  const url = text(body.url, 2000);
  if (url !== null) {
    try {
      if (new URL(url).protocol === "https:") return url;
    } catch {
      // Falls through to the refusal below.
    }
  }
  throw new BankSyncProviderError(
    "invalid_response",
    "Enable Banking returned no usable authorization URL.",
  );
}

/** The longest cash account type kept (`bank_sync_accounts.cash_account_type`). */
const MAX_CASH_ACCOUNT_TYPE_LENGTH = 10;

/**
 * The identifier of an account row: `account_id.iban`, else
 * `account_id.other.identification`, else the first entry of `all_account_ids`
 * that carries one. The first candidate that is a usable identifier wins, so an
 * empty `iban` does not hide the number beside it.
 */
function accountIdentifierOf(row: UnknownRecord): string | null {
  const accountId = isRecord(row.account_id) ? row.account_id : {};
  const other = isRecord(accountId.other) ? accountId.other : {};
  const ids = Array.isArray(row.all_account_ids) ? row.all_account_ids : [];
  const candidates = [
    accountId.iban,
    other.identification,
    ...ids.map((id) => (isRecord(id) ? id.identification : null)),
  ];
  for (const candidate of candidates) {
    const identifier = boundedAccountIdentifier(candidate);
    if (identifier !== null) return identifier;
  }
  return null;
}

/** The cash account type: letters only, bounded, upper case; null otherwise. */
function cashAccountType(value: unknown): string | null {
  const code = text(value, MAX_TYPE_LENGTH);
  return code !== null &&
    code.length <= MAX_CASH_ACCOUNT_TYPE_LENGTH &&
    /^[A-Za-z]+$/.test(code)
    ? code.toUpperCase()
    : null;
}

/**
 * One account of a session. `uid` is optional on the wire (absent for an
 * account that cannot be read, e.g. blocked or closed), and such an account is
 * skipped. `name` is the account HOLDER's name, not the account's: the label is
 * the account's own `details`, then the bank's `product`, and the holder's name
 * only when the bank sent neither.
 */
function mapAccount(
  row: unknown,
  fallbackUid: string | null = null,
): BankAccountDescriptor | null {
  if (!isRecord(row)) return null;
  const externalAccountId = text(row.uid, MAX_REFERENCE_LENGTH) ?? fallbackUid;
  if (externalAccountId === null) return null;
  const identifier = accountIdentifierOf(row);
  const code = currency(row.currency);
  return {
    externalAccountId,
    identificationHash: text(row.identification_hash, MAX_REFERENCE_LENGTH),
    displayName:
      text(row.details, MAX_NAME_LENGTH) ??
      text(row.product, MAX_NAME_LENGTH) ??
      text(row.name, MAX_NAME_LENGTH),
    identifierMasked: maskIdentifier(identifier),
    accountIdentifier: identifier,
    cashAccountType: cashAccountType(row.cash_account_type),
    currencyCode: code === UNKNOWN_CURRENCY ? null : code,
  };
}

/**
 * `GET /accounts/{uid}/details`: the same `AccountResource` a session lists. The
 * account is the one asked for, so a response without a `uid` still names it.
 */
export function mapAccountDetails(
  payload: unknown,
  externalAccountId: string,
): BankAccountDescriptor {
  const descriptor = mapAccount(requireObject(payload), externalAccountId);
  // `requireObject` has already refused a non-object, and the fallback uid
  // makes the row mappable, so this is only the type's own guard.
  if (descriptor === null) {
    throw new BankSyncProviderError(
      "invalid_response",
      "Enable Banking returned an unreadable response.",
    );
  }
  return { ...descriptor, externalAccountId };
}

/** `POST /sessions`: the session and the accounts it can read. */
export function mapSession(payload: unknown): {
  sessionId: string;
  validUntil: Date | null;
  accounts: BankAccountDescriptor[];
} {
  const body = requireObject(payload);
  const sessionId = text(body.session_id, MAX_REFERENCE_LENGTH);
  if (sessionId === null) {
    throw new BankSyncProviderError(
      "invalid_response",
      "Enable Banking returned a session without an id.",
    );
  }
  const accounts = requireArray(body, "accounts")
    .map((row) => mapAccount(row))
    .filter((account): account is BankAccountDescriptor => account !== null);
  const access = isRecord(body.access) ? body.access : {};
  const validUntilText = text(access.valid_until, MAX_TIMESTAMP_TEXT_LENGTH);
  const validUntil = validUntilText === null ? null : new Date(validUntilText);
  return {
    sessionId,
    validUntil:
      validUntil !== null && !Number.isNaN(validUntil.getTime())
        ? validUntil
        : null,
    accounts,
  };
}

function nameOf(party: unknown): string | null {
  return isRecord(party) ? text(party.name, MAX_NAME_LENGTH) : null;
}

function remittanceLines(value: unknown): string[] {
  const lines =
    typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return lines
    .slice(0, MAX_REMITTANCE_LINES)
    .map((line) => text(line, MAX_REMITTANCE_LINE_LENGTH))
    .filter((line): line is string => line !== null);
}

/**
 * The bank's operation type: `bank_transaction_code` (`description`, `code`,
 * `sub_code`, each bounded) and the code in a remittance line. Read beside the
 * remittance lines and never out of them: the planner builds the description
 * and the `hash:` duplicate key from the lines as the bank sent them.
 */
function operationOf(row: UnknownRecord, remittance: string[]): BankOperation {
  const transactionCode = isRecord(row.bank_transaction_code)
    ? row.bank_transaction_code
    : {};
  return {
    code: text(transactionCode.code, BANK_OPERATION_MAX_LENGTH),
    subCode: text(transactionCode.sub_code, BANK_OPERATION_MAX_LENGTH),
    description: text(transactionCode.description, BANK_OPERATION_MAX_LENGTH),
    remittanceCode: remittanceOperationCode(remittance),
  };
}

/**
 * One wire transaction, or null when the row is not an object.
 *
 * `booked` is true for `status === "BOOK"`. A row with no readable status is
 * treated as booked only when it carries a `booking_date`: importing a pending
 * row is the one mistake that cannot be undone quietly (it changes amount and
 * identifier when it books, and would import twice), so the doubtful case
 * resolves to "not booked" unless the bank dated the booking.
 *
 * `entry_reference` is what Enable Banking documents as unique and immutable
 * for accounts with the same identification hashes, so across sessions of one
 * account it is the row's identity (`entryReference`). It is not unique across
 * accounts, it is absent for some banks, and its FAQ says some banks repeat a
 * value that should be unique: the planner treats a repeat with different
 * content as two transactions. `transaction_id` is documented as a handle for
 * fetching details that may change when the list is fetched again: it is
 * carried as `transactionId` for that use and never takes part in the duplicate
 * key.
 */
export function mapTransaction(row: unknown): BankTransaction | null {
  if (!isRecord(row)) return null;
  const indicator = text(row.credit_debit_indicator, 8)?.toUpperCase();
  const direction =
    indicator === "CRDT" ? "credit" : indicator === "DBIT" ? "debit" : null;
  const amount = isRecord(row.transaction_amount) ? row.transaction_amount : {};
  const status = text(row.status, MAX_TYPE_LENGTH);
  const bookingDate = text(row.booking_date, MAX_DATE_TEXT_LENGTH);
  const remittance = remittanceLines(row.remittance_information);
  return {
    entryReference: text(row.entry_reference, MAX_REFERENCE_LENGTH),
    transactionId: text(row.transaction_id, MAX_REFERENCE_LENGTH),
    bankReference: text(row.reference_number, MAX_REFERENCE_LENGTH),
    amount: decimalText(amount.amount),
    currencyCode: currency(amount.currency),
    direction,
    booked:
      status !== null ? status.toUpperCase() === "BOOK" : bookingDate !== null,
    bookingDate,
    valueDate: text(row.value_date, MAX_DATE_TEXT_LENGTH),
    transactionDate: text(row.transaction_date, MAX_DATE_TEXT_LENGTH),
    counterpartyName:
      direction === "debit"
        ? nameOf(row.creditor)
        : direction === "credit"
          ? nameOf(row.debtor)
          : null,
    remittance,
    operation: operationOf(row, remittance),
  };
}

/** One page of `GET /accounts/{uid}/transactions`. */
export function mapTransactionsPage(payload: unknown): {
  transactions: BankTransaction[];
  continuationKey: string | null;
} {
  const body = requireObject(payload);
  return {
    transactions: requireArray(body, "transactions")
      .map(mapTransaction)
      .filter((row): row is BankTransaction => row !== null),
    continuationKey: text(body.continuation_key, 2000),
  };
}

/**
 * `GET /accounts/{uid}/balances`: the balance to show, or null when the bank
 * reported none. Picked by type in the order `CLBD`, `ITBD`, `ITAV`, `CLAV`,
 * `XPCD`, then the first readable one that is not an opening, previous-period
 * or forward balance.
 */
export function mapBalance(payload: unknown): BankBalance | null {
  const body = requireObject(payload);
  const readable: BankBalance[] = [];
  for (const row of requireArray(body, "balances")) {
    if (!isRecord(row) || !isRecord(row.balance_amount)) continue;
    const amount = decimalText(row.balance_amount.amount);
    const currencyCode = currency(row.balance_amount.currency);
    if (amount === null || currencyCode === null) continue;
    readable.push({
      amount,
      currencyCode,
      referenceDate: text(row.reference_date, MAX_DATE_TEXT_LENGTH),
      balanceType:
        text(row.balance_type, MAX_TYPE_LENGTH)?.toUpperCase() ?? null,
    });
  }
  for (const type of BALANCE_TYPE_PREFERENCE) {
    const match = readable.find((balance) => balance.balanceType === type);
    if (match) return match;
  }
  return (
    readable.find(
      (balance) =>
        balance.balanceType === null ||
        !NOT_CURRENT_BALANCE_TYPES.has(balance.balanceType),
    ) ?? null
  );
}
