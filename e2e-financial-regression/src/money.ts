// Normalization of the text a financial value renders as, and the one
// distinction this whole harness turns on: a KNOWN ZERO ("$0.00") is not the
// same as an UNKNOWN value ("--", "N/A", "Unknown"). The "unknown is not zero"
// change is precisely about moving incomplete-data cases from the former to
// the latter, so the capture must record which of the three states a cell is
// in and never collapse "unknown" into 0.
//
// See docs/financial-calculation-contract.md and frontend/src/lib/format.ts
// (values render via Intl.NumberFormat with a narrow currency symbol, in the
// logged-in user's number-format locale).

export type ValueStatus =
  | 'value' // a known, parsed figure (including a known 0)
  | 'unknown' // the UI explicitly says the figure is not known
  | 'missing'; // the element was not found on the page at all

export type ValueKind = 'money' | 'percent' | 'count' | 'text';

export interface NormalizedValue {
  /** The trimmed text exactly as the user sees it, or null when missing. */
  rawText: string | null;
  /** The parsed number, or null when unknown/missing/unparseable. */
  numeric: number | null;
  status: ValueStatus;
}

// Tokens the app uses to say "this figure is not known" rather than "zero".
// Kept deliberately broad: an em/en dash, an ASCII placeholder, or an explicit
// word. Anchored so a real number containing none of these is never mistaken
// for unknown. `\p{Dash}` catches the several dash characters Intl and the app
// may emit; the flag `u` is required for it.
const UNKNOWN_MARKERS = [
  /^[\s–—−-]+$/u, // only dashes / minus / whitespace: "--", "—"
  /^n\/?a$/iu, // N/A, NA, n/a
  /^unknown$/iu,
  /^unavailable$/iu,
  /^not\s+available$/iu,
  /^no\s+data$/iu,
  /^\?+$/u, // "?" / "???"
];

/** True when the cell text means "we do not know this value" (not zero). */
export function isUnknownText(text: string): boolean {
  const t = text.trim();
  if (t === '') return false; // empty string is "missing", handled by caller
  return UNKNOWN_MARKERS.some((re) => re.test(t));
}

/**
 * Parse the numeric part out of a money/percent string that may carry a
 * currency symbol, grouping separators, a percent sign, parentheses for
 * negatives, or a trailing/leading minus -- across the number-format locales
 * the app supports. Returns null when no number can be extracted.
 *
 * Locale ambiguity ("1.234" vs "1,234") is resolved by treating the LAST
 * group of a comma/period/space/thin-space run as the decimal separator only
 * when it is followed by 1-2 digits at the very end; every other separator is
 * grouping and stripped. This matches how the same figure renders identically
 * under one user's fixed preference, which is all the comparison needs.
 */
export function parseNumeric(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;

  const negative = /^\(.*\)$/.test(t) || /-/.test(t);

  // Keep only digits and the separators that could be decimal/grouping.
  const cleaned = t.replace(/[^0-9.,    ]/g, '');
  const digitsOnly = cleaned.replace(/[.,    ]/g, '');
  if (digitsOnly === '') return null;

  // Find a decimal separator: the last '.' or ',' followed by exactly 1-3
  // trailing digits (currencies use 0-3 fraction digits).
  const decimalMatch = cleaned.match(/[.,](\d{1,3})$/);
  let normalized: string;
  if (decimalMatch) {
    const intPart = cleaned
      .slice(0, cleaned.length - decimalMatch[0].length)
      .replace(/[.,    ]/g, '');
    normalized = `${intPart || '0'}.${decimalMatch[1]}`;
  } else {
    normalized = digitsOnly;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return negative && value !== 0 ? -value : value;
}

/**
 * Turn raw cell text into a {rawText, numeric, status} triple. `present`
 * distinguishes "element not on page" (missing) from "element present but
 * empty".
 */
export function normalize(
  present: boolean,
  rawText: string | null,
  kind: ValueKind,
): NormalizedValue {
  if (!present || rawText === null) {
    return { rawText: null, numeric: null, status: 'missing' };
  }
  const trimmed = rawText.trim();
  if (trimmed === '') {
    return { rawText: '', numeric: null, status: 'missing' };
  }
  if (isUnknownText(trimmed)) {
    return { rawText: trimmed, numeric: null, status: 'unknown' };
  }
  if (kind === 'text') {
    return { rawText: trimmed, numeric: null, status: 'value' };
  }
  const numeric = parseNumeric(trimmed);
  if (numeric === null) {
    // A money/percent/count cell whose text has no parseable number: treat as
    // unknown rather than silently 0. This is the whole point of the harness.
    return { rawText: trimmed, numeric: null, status: 'unknown' };
  }
  return { rawText: trimmed, numeric, status: 'value' };
}

export const money = { normalize, parseNumeric, isUnknownText };
