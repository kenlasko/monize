/**
 * Interprets the Transactions "Search" box query as an amount and/or a date,
 * expressed in the user's own locale conventions.
 *
 * This is a pure helper (no I/O). It powers the "smart" part of the search:
 * on top of the existing substring match, callers additionally match on an
 * exact amount (absolute value) and/or an exact transaction date when the
 * typed term parses as one. When the term parses as neither, both fields are
 * `null` and the caller falls back to the plain substring behaviour.
 *
 * Amount parsing respects the user's `numberFormat` (a locale such as
 * "en-US" or "de-DE"): the decimal separator is resolved from the locale,
 * with a lenient fallback to the other convention so a pasted statement
 * amount is found regardless of which separator style was used. Equality is
 * exact (rounded to 4 decimals, the storage precision), so "12,3" (12.3)
 * never matches "112,30" (112.30).
 *
 * Date parsing respects the user's `dateFormat` (e.g. "DD/MM/YYYY"), with ISO
 * "YYYY-MM-DD" always accepted as a universal fallback. Partial dates
 * (month-only, year-only) do not parse -- a complete day/month/year is
 * required.
 */

export interface SearchTermPreferences {
  /** User's number-format locale, e.g. "en-US", "de-DE". */
  numberFormat?: string | null;
  /** User's date-format pattern, e.g. "YYYY-MM-DD", "DD/MM/YYYY", "browser". */
  dateFormat?: string | null;
}

export interface ParsedSearchTerm {
  /** Exact amount (signed, rounded to 4 decimals) or null when not a number. */
  amount: number | null;
  /** ISO date "yyyy-MM-dd" or null when the term is not a complete date. */
  date: string | null;
}

// Whitespace / apostrophe characters that some locales use as thousands
// separators (regular space, no-break, narrow no-break, thin space, Swiss
// apostrophe).
const GROUP_SPACE_CHARS = [" ", " ", " ", " ", "'"];

const MONTH_ABBREVS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Determines the decimal separator ("." or ",") the given locale uses. Falls
 * back to "." when the locale is unknown to the runtime's Intl data.
 */
function decimalSeparatorForLocale(numberFormat: string): "." | "," {
  try {
    const parts = new Intl.NumberFormat(numberFormat).formatToParts(1.1);
    const dec = parts.find((part) => part.type === "decimal")?.value;
    return dec === "," ? "," : ".";
  } catch {
    return ".";
  }
}

/**
 * Attempts to parse `raw` as a number using a specific decimal separator.
 * Every other recognised separator character is treated as a thousands
 * (group) separator. Group structure is validated (leading group 1-3 digits,
 * following groups exactly 3 digits) so ambiguous inputs like "12,3" are
 * rejected under the thousands interpretation and fall through to the decimal
 * interpretation. Returns a number rounded to 4 decimals, or null.
 */
function parseAmountWithConvention(
  raw: string,
  decimalSep: "." | ",",
): number | null {
  let s = raw.trim();
  if (s === "") return null;

  let sign = 1;
  if (s[0] === "+") {
    s = s.slice(1);
  } else if (s[0] === "-") {
    sign = -1;
    s = s.slice(1);
  }
  s = s.trim();
  if (s === "") return null;

  const groupChars = new Set<string>(GROUP_SPACE_CHARS);
  groupChars.add(decimalSep === "." ? "," : ".");

  // Only digits, the decimal separator, and group characters are allowed.
  for (const ch of s) {
    if (ch < "0" || ch > "9") {
      if (ch !== decimalSep && !groupChars.has(ch)) return null;
    }
  }

  // At most one decimal separator.
  const decCount = s.split(decimalSep).length - 1;
  if (decCount > 1) return null;

  let intPart = s;
  let fracPart: string | null = null;
  if (decCount === 1) {
    const idx = s.indexOf(decimalSep);
    intPart = s.slice(0, idx);
    fracPart = s.slice(idx + 1);
    if (!/^\d+$/.test(fracPart)) return null;
  }

  if (intPart === "") {
    if (fracPart === null) return null;
    intPart = "0";
  }

  const groupClass = [...groupChars].map(escapeRegex).join("");
  const segments = intPart.split(new RegExp(`[${groupClass}]`));
  if (segments.some((seg) => !/^\d+$/.test(seg))) return null;
  if (segments.length > 1) {
    if (segments[0].length < 1 || segments[0].length > 3) return null;
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].length !== 3) return null;
    }
  }

  const digits = segments.join("");
  const numStr = fracPart !== null ? `${digits}.${fracPart}` : digits;
  const value = sign * Number(numStr);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 10000) / 10000;
}

function parseAmount(term: string, numberFormat: string): number | null {
  const primary = decimalSeparatorForLocale(numberFormat);
  const other = primary === "." ? "," : ".";
  const parsed = parseAmountWithConvention(term, primary);
  if (parsed !== null) return parsed;
  return parseAmountWithConvention(term, other);
}

function buildIsoDate(year: string, month: string, day: string): string | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return null;
  }
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Reject impossible calendar dates (e.g. Feb 30).
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  const pad = (n: number, len: number) => String(n).padStart(len, "0");
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/**
 * Parses `input` against a token-based date pattern (YYYY / MM / DD / MMM with
 * arbitrary literal separators). Returns ISO "yyyy-MM-dd" or null.
 */
function parseDateWithPattern(input: string, pattern: string): string | null {
  const tokenRe = /YYYY|MMM|MM|DD/g;
  let regexStr = "^";
  const order: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(pattern)) !== null) {
    regexStr += escapeRegex(pattern.slice(lastIndex, match.index));
    const token = match[0];
    if (token === "YYYY") {
      regexStr += "(\\d{4})";
      order.push("Y");
    } else if (token === "MMM") {
      regexStr += "([A-Za-z]{3})";
      order.push("m");
    } else if (token === "MM") {
      regexStr += "(\\d{1,2})";
      order.push("M");
    } else {
      regexStr += "(\\d{1,2})";
      order.push("D");
    }
    lastIndex = match.index + token.length;
  }
  regexStr += escapeRegex(pattern.slice(lastIndex)) + "$";

  if (order.length === 0) return null;

  const m = input.match(new RegExp(regexStr));
  if (!m) return null;

  let year = "";
  let month = "";
  let day = "";
  order.forEach((key, i) => {
    const value = m[i + 1];
    if (key === "Y") {
      year = value;
    } else if (key === "M") {
      month = value;
    } else if (key === "D") {
      day = value;
    } else {
      const idx = MONTH_ABBREVS.indexOf(value.toLowerCase());
      if (idx !== -1) month = String(idx + 1);
    }
  });

  if (!year || !month || !day) return null;
  return buildIsoDate(year, month, day);
}

/**
 * Derives a token pattern (e.g. "DD.MM.YYYY") from the numeric date parts a
 * locale renders, so the "browser" date-format preference can still be parsed.
 */
function patternFromLocale(locale: string): string {
  try {
    const parts = new Intl.DateTimeFormat(locale || "en-US").formatToParts(
      new Date(Date.UTC(2024, 11, 31)),
    );
    let out = "";
    for (const part of parts) {
      if (part.type === "year") out += "YYYY";
      else if (part.type === "month") out += "MM";
      else if (part.type === "day") out += "DD";
      else if (part.type === "literal") out += part.value;
    }
    return out || "YYYY-MM-DD";
  } catch {
    return "YYYY-MM-DD";
  }
}

function parseDate(
  term: string,
  dateFormat: string,
  numberFormat: string,
): string | null {
  const pattern =
    !dateFormat || dateFormat === "browser"
      ? patternFromLocale(numberFormat)
      : dateFormat;

  const fromPattern = parseDateWithPattern(term, pattern);
  if (fromPattern) return fromPattern;

  // Universal ISO fallback, regardless of the user's preferred format.
  const iso = term.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return buildIsoDate(iso[1], iso[2], iso[3]);

  return null;
}

/**
 * Interprets a search term as an amount and/or date in the user's format.
 * Returns `{ amount: null, date: null }` when the term parses as neither.
 */
export function parseSearchTerm(
  term: string,
  prefs: SearchTermPreferences = {},
): ParsedSearchTerm {
  const trimmed = (term ?? "").trim();
  if (trimmed === "") return { amount: null, date: null };

  const numberFormat = prefs.numberFormat || "en-US";
  const dateFormat = prefs.dateFormat || "YYYY-MM-DD";

  return {
    amount: parseAmount(trimmed, numberFormat),
    date: parseDate(trimmed, dateFormat, numberFormat),
  };
}
