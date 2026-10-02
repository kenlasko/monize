/**
 * The opt-in diagnostic log of what Enable Banking answered (`BANK_SYNC_LOG_RAW`).
 *
 * The preview deliberately does not show the provider's own fields; when a bank
 * sends something Monize reads wrongly, the only way to see it is the raw JSON,
 * so the adapter can write each answer to the debug log. That log holds bank
 * data (counterparty names, remittance text, amounts), so:
 *
 * - it is off unless the operator sets the flag, and `.env.example` says to turn
 *   it off again after diagnosing;
 * - every account identifier is masked first, wherever it sits: under a key that
 *   names one (`iban`, `bban`, `identification`, `account_number`), and inside
 *   any string that looks like an IBAN or a Polish NRB (a remittance line often
 *   repeats the counterparty's account);
 * - the session id, the account handle (`uid`) and the identification hash are
 *   cut to their last four characters, and a signed JWT is removed wherever it
 *   appears (the request headers are never part of what is logged anyway);
 * - one log line is bounded, and a larger answer is written as several lines,
 *   each tagged with the account and the page.
 *
 * Pure: nothing here logs.
 */

/** The longest part of one log line's JSON, in characters: 16,000 characters is at most 64 KB. */
export const RAW_LOG_CHUNK_CHARS = 16_000;

/** Keys whose string value is an account identifier: country code and last four kept. */
const ACCOUNT_NUMBER_KEYS: ReadonlySet<string> = new Set([
  "iban",
  "bban",
  "identification",
  "account_number",
  "accountnumber",
  "msisdn",
]);

/** Keys whose string value is cut to its last four characters. */
const LAST_FOUR_KEYS: ReadonlySet<string> = new Set([
  "session_id",
  "uid",
  "identification_hash",
]);

/** A signed token: every JWT this client signs begins `eyJ`, with up to three segments. */
const JWT_SHAPE = /eyJ[\w-]*(?:\.[\w-]*){0,2}/g;

/**
 * An IBAN or a Polish NRB inside free text. An IBAN is two letters, two check
 * digits and the rest either run together or in groups of four split by single
 * spaces; after the first group a group must hold a digit, so the words that
 * follow an account number are not taken for part of it. An NRB is 26 digits,
 * run together or grouped as 2 + 6 x 4. A pattern that errs, errs towards
 * masking: the cost is a diagnostic line with a few characters hidden.
 */
const ACCOUNT_IN_TEXT = new RegExp(
  [
    String.raw`\b[A-Za-z]{2}\d{2}[A-Za-z0-9]{11,30}\b`,
    String.raw`\b[A-Za-z]{2}\d{2} [A-Za-z0-9]{4}(?: (?=[A-Za-z0-9]{0,3}\d)[A-Za-z0-9]{4}){1,6}(?: \d{1,3})?\b`,
    String.raw`\b\d{2}(?: \d{4}){6}\b`,
    String.raw`\b\d{26}\b`,
  ].join("|"),
  "g",
);

/** The last four characters, the rest `*`; a value of four or fewer is wholly masked. */
export function lastFour(value: string): string {
  return value.length <= 4
    ? "*".repeat(value.length)
    : `${"*".repeat(value.length - 4)}${value.slice(-4)}`;
}

/**
 * An account identifier with the country code (two leading letters) and the
 * last four characters kept and the rest replaced by `*`. Spaces and dashes are
 * dropped first, so the masked value says nothing of how it was grouped.
 */
export function maskAccountNumber(value: string): string {
  const compact = value.replace(/[\s-]+/g, "");
  const country = /^[A-Za-z]{2}/.test(compact) ? compact.slice(0, 2) : "";
  const rest = compact.slice(country.length);
  if (rest.length <= 4) return `${country}${"*".repeat(rest.length)}`;
  return `${country}${"*".repeat(rest.length - 4)}${rest.slice(-4)}`;
}

/** A free-text value with every IBAN or NRB in it masked and every token removed. */
function scrubText(value: string): string {
  return value
    .replace(JWT_SHAPE, "[redacted]")
    .replace(ACCOUNT_IN_TEXT, (match) => maskAccountNumber(match));
}

/** `payload` as plain JSON with the identifiers masked; never mutates it. */
export function maskRawPayload(payload: unknown, key = ""): unknown {
  if (typeof payload === "string") {
    const name = key.toLowerCase();
    if (ACCOUNT_NUMBER_KEYS.has(name)) return maskAccountNumber(payload);
    if (LAST_FOUR_KEYS.has(name)) return lastFour(payload);
    return scrubText(payload);
  }
  if (
    typeof payload === "number" &&
    ACCOUNT_NUMBER_KEYS.has(key.toLowerCase())
  ) {
    return maskAccountNumber(String(payload));
  }
  if (Array.isArray(payload)) {
    // An array under an identifier key (`remittance_information` is not one) keeps
    // its key, so a list of identifiers is masked item by item.
    return payload.map((item) => maskRawPayload(item, key));
  }
  if (typeof payload === "object" && payload !== null) {
    return Object.fromEntries(
      Object.entries(payload as Record<string, unknown>).map(
        ([name, value]) => [name, maskRawPayload(value, name)],
      ),
    );
  }
  return payload;
}

/**
 * The log lines of one answer: the masked JSON in parts of at most
 * `RAW_LOG_CHUNK_CHARS`, each tagged with what was read, the account (the last
 * four characters of its handle) and the page. A part never ends inside a
 * surrogate pair.
 */
export function rawLogLines(input: {
  /** What was read: `transactions`, `balances`, `account details`, `session`. */
  label: string;
  /** The provider's account handle; only its last four characters are logged. */
  accountUid: string | null;
  /** The page of a paged answer, from 1. */
  page?: number;
  payload: unknown;
  chunkChars?: number;
}): string[] {
  const text = JSON.stringify(maskRawPayload(input.payload)) ?? "null";
  const size = Math.max(2, input.chunkChars ?? RAW_LOG_CHUNK_CHARS);
  const parts: string[] = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + size);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    parts.push(text.slice(start, end));
    start = end;
  }
  if (parts.length === 0) parts.push(text);

  const account =
    input.accountUid === null
      ? ""
      : ` account ...${input.accountUid.slice(-4)}`;
  const page = input.page === undefined ? "" : ` page ${input.page}`;
  return parts.map(
    (part, index) =>
      `Enable Banking raw ${input.label}${account}${page} part ${index + 1}/${parts.length}: ${part}`,
  );
}
