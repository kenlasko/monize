/**
 * An account number or identifier as two sources spell it: the bank's IBAN, BBAN
 * or other scheme's number, and the free text a person typed into
 * `accounts.account_number`. Both are compared in this one form (spec section 5a):
 * whitespace, control characters and dashes removed, upper case.
 *
 * Pure, and provider-neutral: the Enable Banking mapper stores the bank's side
 * of the comparison through it, and the matcher reads the Monize side through it,
 * so the two can never normalize differently.
 */

/** The width of `bank_sync_accounts.account_identifier`. */
export const ACCOUNT_IDENTIFIER_MAX_LENGTH = 64;

/** The country prefix of an IBAN: two letters in front of the national number. */
const COUNTRY_PREFIX = /^[A-Z]{2}/;

/** Null when `value` is not text or nothing is left of it. */
export function normalizeAccountNumber(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\s\u0000-\u001f\u007f-]+/g, "")
    .toUpperCase();
  return cleaned === "" ? null : cleaned;
}

/**
 * The identifier to store: normalized, and null when it exceeds
 * `ACCOUNT_IDENTIFIER_MAX_LENGTH`. The whole value is checked before anything is
 * cut, so a value over the bound is no identifier rather than a wrong one.
 */
export function boundedAccountIdentifier(value: unknown): string | null {
  const normalized = normalizeAccountNumber(value);
  return normalized !== null &&
    normalized.length <= ACCOUNT_IDENTIFIER_MAX_LENGTH
    ? normalized
    : null;
}

/**
 * Whether a Monize account number names the bank's identifier: equal once
 * normalized, or equal to the identifier without its two-letter country prefix
 * (a Polish NRB is the IBAN without `PL`). Either side missing is no match.
 */
export function accountNumberMatchesIdentifier(
  accountNumber: unknown,
  identifier: unknown,
): boolean {
  const number = normalizeAccountNumber(accountNumber);
  const bank = normalizeAccountNumber(identifier);
  if (number === null || bank === null) return false;
  if (number === bank) return true;
  return (
    COUNTRY_PREFIX.test(bank) && bank.length > 2 && number === bank.slice(2)
  );
}
