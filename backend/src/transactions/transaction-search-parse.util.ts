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

import { MONEY_SCALE, roundMoney } from "../common/round.util";

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

/**
 * Splits `input` on any of the given separator characters. Used instead of a
 * character-class regex so no regular expression is built from runtime data.
 * Adjacent/leading/trailing separators yield empty segments, exactly as a
 * regex split would -- callers reject those via the digit check.
 */
function splitOnChars(input: string, separators: Set<string>): string[] {
  const segments: string[] = [];
  let current = "";
  for (const ch of input) {
    if (separators.has(ch)) {
      segments.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments;
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

  const segments = splitOnChars(intPart, groupChars);
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
  // At the column scale: a search for a coin amount (0.00002500) must still
  // match its row, and a fiat term (at most four places) reads the same.
  return roundMoney(value, MONEY_SCALE);
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

type DateToken =
  | { kind: "literal"; text: string }
  | { kind: "field"; field: "Y" | "M" | "D" | "m" };

/**
 * Splits a date pattern into ordered literal and field tokens. `YYYY`, `MMM`,
 * `MM` and `DD` are fields (longer tokens tested first so `MMM` wins over
 * `MM`); every other run of characters is a literal separator.
 */
function tokenizeDatePattern(pattern: string): DateToken[] {
  const tokens: DateToken[] = [];
  let literal = "";
  const flushLiteral = () => {
    if (literal !== "") {
      tokens.push({ kind: "literal", text: literal });
      literal = "";
    }
  };

  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith("YYYY", i)) {
      flushLiteral();
      tokens.push({ kind: "field", field: "Y" });
      i += 4;
    } else if (pattern.startsWith("MMM", i)) {
      flushLiteral();
      tokens.push({ kind: "field", field: "m" });
      i += 3;
    } else if (pattern.startsWith("MM", i)) {
      flushLiteral();
      tokens.push({ kind: "field", field: "M" });
      i += 2;
    } else if (pattern.startsWith("DD", i)) {
      flushLiteral();
      tokens.push({ kind: "field", field: "D" });
      i += 2;
    } else {
      literal += pattern[i];
      i += 1;
    }
  }
  flushLiteral();
  return tokens;
}

/** Consumes between `min` and `max` consecutive digits from `input` at `pos`. */
function takeDigits(
  input: string,
  pos: number,
  min: number,
  max: number,
): string | null {
  let end = pos;
  while (end < input.length && end - pos < max) {
    const ch = input[end];
    if (ch < "0" || ch > "9") break;
    end += 1;
  }
  return end - pos >= min ? input.slice(pos, end) : null;
}

function isAlpha(input: string): boolean {
  for (const ch of input) {
    const lower = ch.toLowerCase();
    if (lower < "a" || lower > "z") return false;
  }
  return true;
}

/**
 * Parses `input` against a token-based date pattern (YYYY / MM / DD / MMM with
 * arbitrary literal separators). Returns ISO "yyyy-MM-dd" or null. Walks the
 * pattern and input in lockstep -- no regex is built from the pattern, so a
 * user-supplied date format can never inject a pathological expression.
 */
function parseDateWithPattern(input: string, pattern: string): string | null {
  const tokens = tokenizeDatePattern(pattern);
  if (!tokens.some((token) => token.kind === "field")) return null;

  let pos = 0;
  let year = "";
  let month = "";
  let day = "";

  for (const token of tokens) {
    if (token.kind === "literal") {
      if (input.slice(pos, pos + token.text.length) !== token.text) return null;
      pos += token.text.length;
      continue;
    }

    if (token.field === "Y") {
      const value = takeDigits(input, pos, 4, 4);
      if (value === null) return null;
      year = value;
      pos += value.length;
    } else if (token.field === "m") {
      const abbrev = input.slice(pos, pos + 3);
      if (abbrev.length !== 3 || !isAlpha(abbrev)) return null;
      const idx = MONTH_ABBREVS.indexOf(abbrev.toLowerCase());
      if (idx === -1) return null;
      month = String(idx + 1);
      pos += 3;
    } else {
      const value = takeDigits(input, pos, 1, 2);
      if (value === null) return null;
      if (token.field === "M") month = value;
      else day = value;
      pos += value.length;
    }
  }

  if (pos !== input.length) return null;
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
