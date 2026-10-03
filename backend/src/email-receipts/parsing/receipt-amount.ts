/**
 * The amount grammar of the email-receipt parser (spec section 2). Pure,
 * integer arithmetic only: the result is a count of 1/10000 units, never a
 * float, so a total read from an email is compared with a stored amount
 * exactly.
 */

const MAX_INTEGER_DIGITS = 12;
const UNITS_PER_ONE = 10000;
const MAX_QTY = 9999;

/** Step 1: what is not a digit, separator, minus, apostrophe or whitespace (NBSP included) goes. */
const NOT_KEPT = /[^0-9.,\-'\s]/g;
/** Thousand separators of step 3: whitespace (NBSP included) and apostrophes. */
const GROUPING = /[\s']/g;
/** A unicode minus, figure dash or en/em dash is a minus sign that step 1 would silently drop. */
const LOOKALIKE_MINUS = /[\u{2212}\u{2012}\u{2013}\u{2014}]/u;
const SEPARATOR = /[.,]/;

/**
 * Read the text of one `{amount}` or `{price}` capture as 1/10000 units, or
 * null when it is not a non-negative amount. A currency symbol or code is
 * ignored; a leading minus or a surrounding pair of parentheses is refused
 * (a receipt amount is a magnitude; a discount is its own field).
 *
 * The decimal separator is the last `.` or `,` when exactly one or two digits
 * follow it; every other separator is a thousand separator and must be
 * followed by exactly three digits. The result is also refused when it would
 * not be a safe integer.
 */
export function parseReceiptAmount(text: string): number | null {
  if (typeof text !== "string") return null;
  const raw = text.trim();
  if (/^\(.*\)$/.test(raw) || LOOKALIKE_MINUS.test(raw)) return null;

  const compact = raw.replace(NOT_KEPT, "").replace(GROUPING, "");
  if (compact.startsWith("-")) return null;
  // Anything but digits and separators left over (a stray minus) is refused.
  if (!/^[0-9.,]+$/.test(compact)) return null;

  const lastSeparator = Math.max(
    compact.lastIndexOf("."),
    compact.lastIndexOf(","),
  );
  const tail = compact.slice(lastSeparator + 1);
  const hasDecimals =
    lastSeparator !== -1 && (tail.length === 1 || tail.length === 2);
  const integerText = hasDecimals ? compact.slice(0, lastSeparator) : compact;
  const fraction = hasDecimals ? tail : "";

  const groups = integerText.split(SEPARATOR);
  // Every group after the first is a thousand group of exactly three digits.
  for (let i = 1; i < groups.length; i++) {
    if (!/^[0-9]{3}$/.test(groups[i])) return null;
  }
  // An empty first group is only a number when a decimal part follows (".50").
  if (groups[0] === "" && !(hasDecimals && groups.length === 1)) return null;

  const digits = groups.join("");
  if (digits.length > MAX_INTEGER_DIGITS) return null;
  const whole = digits === "" ? 0 : Number(digits);
  const units = whole * UNITS_PER_ONE + Number(fraction.padEnd(4, "0"));
  return Number.isSafeInteger(units) ? units : null;
}

/** Currency words and codes a receipt amount may carry (ISO codes and common local marks). */
const CURRENCY_WORDS =
  /(?<!\p{L})(?:pln|eur|usd|gbp|chf|czk|sek|nok|dkk|huf|ron|bgn|jpy|cad|aud|nzd|uah|rub|cny|try|z\u{142}|zl|kr|k\u{10d}|ft|lei)(?!\p{L})/giu;

/**
 * True when the text parses as an amount AND holds no words besides a currency
 * symbol or code. `parseReceiptAmount` drops every letter, so "cable 19.98"
 * parses; a caller choosing between two readings of a line uses this to tell an
 * amount from a name that happens to end in digits.
 */
export function isPlainReceiptAmount(text: string): boolean {
  return (
    parseReceiptAmount(text) !== null &&
    !/\p{L}/u.test(text.replace(CURRENCY_WORDS, ""))
  );
}

/**
 * Read the text of a `{qty}` capture: a positive integer from 1 to 9999
 * written with digits only, after a trailing `x` or `pcs` (any case) is
 * removed. Anything else is null, which makes the item line not match.
 */
export function parseReceiptQty(text: string): number | null {
  if (typeof text !== "string") return null;
  const stripped = text
    .trim()
    .toLowerCase()
    .replace(/\s*(x|pcs)$/, "");
  if (!/^[0-9]{1,4}$/.test(stripped)) return null;
  const qty = Number(stripped);
  return qty >= 1 && qty <= MAX_QTY ? qty : null;
}
