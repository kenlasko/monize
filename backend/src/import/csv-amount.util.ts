import { normalizeAmountSeparators } from "./amount-separators.util";

/**
 * Characters a bank writes for a minus sign besides the ASCII hyphen: the
 * Unicode minus sign (U+2212), the figure dash and the en dash, and the small
 * and full-width hyphen-minus forms.
 */
const MINUS_SIGNS = /[−‒–﹣－]/g;

/** A field of nothing but dashes is how some exports write "no amount". */
const DASHES_ONLY = /^[-‐-―−﹣－]+$/;

/** Grouping marks stripped with the whitespace: the Swiss "1'234.56". */
const GROUPING_MARKS = /[\s'’]/g;

/**
 * A currency written beside the number: a run of currency symbols and letters
 * ("$", "CHF", "kr", "R$", "US$", "zł"), with the period that ends an
 * abbreviation when it has letters ("Fr. 12.34", "Rs.12.50", "12,34 kr.").
 */
const LEADING_CURRENCY = /^[\p{L}\p{Sc}]+(?:(?<=\p{L})\.)?/u;
const TRAILING_CURRENCY = /[\p{L}\p{Sc}]+(?:(?<=\p{L})\.)?$/u;
const MAX_CURRENCY_LETTERS = 3;

/**
 * Currency abbreviations written in lower or mixed case. Any other word is a
 * currency only when it carries a currency symbol or is all capitals (an ISO
 * code), so "Tax 5" or "abc 12" is unreadable rather than read as 5 or 12.
 */
const MIXED_CASE_CURRENCIES = new Set([
  "kr",
  "zł",
  "fr",
  "sfr",
  "rs",
  "rp",
  "ft",
  "kč",
  "lei",
  "лв",
  "руб",
  "грн",
]);

/**
 * A separator at either end of the number alongside another one (".12.50",
 * "12.50.") is what a stray abbreviation period leaves; it is unreadable, never
 * grouping.
 */
const STRAY_SEPARATOR = /^[.,].*[.,]|[.,].*[.,]$/;

/** The number left once the sign, currency and grouping are stripped. */
const PLAIN_NUMBER = /^(?:\d+\.?\d*|\.\d+)$/;

/**
 * True when a CSV amount field holds no amount: empty, whitespace, or only
 * dashes. A debit/credit pair leaves one side blank on every row, and a blank
 * amount reads as 0; anything else that does not parse is unreadable.
 */
export function isBlankCsvAmount(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "" || DASHES_ONLY.test(trimmed);
}

/**
 * Parse an amount string from a CSV field, or null when it is blank
 * (`isBlankCsvAmount`) or cannot be read. The whole field has to read, so a
 * value with text the parser does not know is null, never the number its
 * first digits make.
 *
 * Reads: a leading or trailing sign, the ASCII minus or the Unicode minus
 * forms ("-12.34", "12.34-", "−12.34"); parentheses as negative
 * ("(12.34)"); a "DR" (debit, negative) or "CR" (credit, positive) marker
 * before or after the number; a currency symbol or code before or after it
 * ("$12.34", "CHF 12.34", "12.34 kr", "Fr. 12.34"), which is a symbol, an
 * all-capitals code or a known abbreviation (`isCurrencyWord`); whitespace and apostrophe grouping; and
 * both US (1,234.56) and European (1.234,56 / 18,36) grouping and decimal
 * styles (`normalizeAmountSeparators`). Two signs, or a sign with a DR/CR
 * marker, contradict each other and are unreadable.
 */
export function parseCsvAmount(value: string): number | null {
  if (isBlankCsvAmount(value)) {
    return null;
  }
  let rest = value.trim().replace(MINUS_SIGNS, "-");
  let negative = false;
  let signs = 0;
  let marker: "DR" | "CR" | null = null;
  const currencySides = new Set<"leading" | "trailing">();
  // One DR/CR marker in all, and one currency on each side of the number.
  const takeWord = (word: string, side: "leading" | "trailing"): boolean => {
    if (/^(?:dr|cr)\.?$/i.test(word)) {
      if (marker) return false;
      marker = word.slice(0, 2).toUpperCase() as "DR" | "CR";
      return true;
    }
    if (currencySides.has(side) || !isCurrencyWord(word)) return false;
    currencySides.add(side);
    return true;
  };

  for (let changed = true; changed && rest;) {
    changed = false;
    const inParens = rest.match(/^\((.*)\)$/s);
    if (inParens) {
      rest = inParens[1].trim();
      negative = true;
      signs++;
      changed = true;
      continue;
    }
    const sign = rest.match(/^[-+]|[-+]$/);
    if (sign) {
      negative = sign[0] === "-";
      signs++;
      rest = sign.index === 0 ? rest.slice(1).trim() : rest.slice(0, -1).trim();
      changed = true;
      continue;
    }
    const leading = rest.match(LEADING_CURRENCY);
    if (leading) {
      if (!takeWord(leading[0], "leading")) return null;
      rest = rest.slice(leading[0].length).trim();
      changed = true;
      continue;
    }
    const trailing = rest.match(TRAILING_CURRENCY);
    if (trailing) {
      if (!takeWord(trailing[0], "trailing")) return null;
      rest = rest.slice(0, -trailing[0].length).trim();
      changed = true;
    }
  }

  if (signs > 1 || (marker && signs > 0)) {
    return null;
  }
  const digits = rest.replace(GROUPING_MARKS, "");
  if (STRAY_SEPARATOR.test(digits)) {
    return null;
  }
  const number = normalizeAmountSeparators(digits);
  if (!PLAIN_NUMBER.test(number)) {
    return null;
  }
  const amount = Number(number);
  // A zero has no sign: "-0.00" reads as 0, not -0.
  return amount !== 0 && (negative || marker === "DR") ? -amount : amount;
}

function isCurrencyWord(word: string): boolean {
  const letters = word.replace(/[^\p{L}]/gu, "");
  if (letters.length > MAX_CURRENCY_LETTERS) return false;
  if (letters === "" || /\p{Sc}/u.test(word)) return true;
  return (
    letters === letters.toUpperCase() ||
    MIXED_CASE_CURRENCIES.has(letters.toLowerCase())
  );
}
