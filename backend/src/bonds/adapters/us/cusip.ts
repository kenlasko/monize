import { SeriesFetchError } from "../../bond-adapter";
import { isValidYMD } from "../../domain/calendar-date";

const CUSIP_PATTERN = /^[0-9A-Z*@#]{8}[0-9]$/;
const CODE_PATTERN = /^([0-9A-Z*@#]{8}[0-9])(\d{6})?$/;

/** The CUSIP prefix of every bill the adapter names by a 15-character code. */
export const BILL_CUSIP_PREFIX = "912797";

const CODE_POINT_0 = 48;
const CODE_POINT_A = 65;

/** A CUSIP character's value: digits 0-9, letters 10-35, `*` 36, `@` 37, `#` 38. */
function charValue(char: string): number {
  const point = char.charCodeAt(0);
  if (point >= CODE_POINT_0 && point <= CODE_POINT_0 + 9) {
    return point - CODE_POINT_0;
  }
  if (point >= CODE_POINT_A && point <= CODE_POINT_A + 25) {
    return point - CODE_POINT_A + 10;
  }
  return char === "*" ? 36 : char === "@" ? 37 : 38;
}

/**
 * The CUSIP check digit of the first eight characters (the CUSIP Global
 * Services "double add double": the value of each character at an even
 * 1-based position is doubled, the digits of every value are added, the check
 * digit is what brings the sum to a multiple of ten).
 */
export function cusipCheckDigit(base: string): number {
  let sum = 0;
  for (let i = 0; i < 8; i += 1) {
    const value = charValue(base[i]) * (i % 2 === 1 ? 2 : 1);
    sum += Math.floor(value / 10) + (value % 10);
  }
  return (10 - (sum % 10)) % 10;
}

/** True for nine characters of the CUSIP alphabet whose last is the check digit. */
export function isValidCusip(value: string): boolean {
  return (
    CUSIP_PATTERN.test(value) &&
    cusipCheckDigit(value) === value.charCodeAt(8) - CODE_POINT_0
  );
}

export interface ParsedSeriesCode {
  /** Upper case: the CUSIP, or the CUSIP followed by `YYMMDD`. */
  readonly code: string;
  readonly cusip: string;
  /** The bill's issue date (`YYYY-MM-DD`) of a 15-character code, else null. */
  readonly issueDate: string | null;
}

/** A code echoed back in an error: letters and digits only, never free text. */
function safeEcho(raw: unknown): string {
  return typeof raw === "string" && /^[A-Za-z0-9]{1,16}$/.test(raw) ? raw : "";
}

/**
 * The series code grammar (docs/specs/us-treasury-securities.md section 2): nine
 * characters, a CUSIP with a valid check digit, for a coupon security; fifteen,
 * a CUSIP and the issue date as `YYMMDD`, for a bill. The code is upper-cased.
 * Nothing is requested before it passes.
 */
export function parseSeriesCode(raw: unknown): ParsedSeriesCode {
  const invalid = () =>
    new SeriesFetchError("SERIES_CODE_INVALID", { seriesCode: safeEcho(raw) });
  if (typeof raw !== "string" || raw.length > 16) throw invalid();
  const code = raw.trim().toUpperCase();
  const match = CODE_PATTERN.exec(code);
  if (!match || !isValidCusip(match[1])) throw invalid();
  if (match[2] === undefined) {
    return { code, cusip: match[1], issueDate: null };
  }
  const issueDate = `20${match[2].slice(0, 2)}-${match[2].slice(2, 4)}-${match[2].slice(4, 6)}`;
  if (!isValidYMD(issueDate)) throw invalid();
  return { code, cusip: match[1], issueDate };
}

/** `BILL` for a 15-character code whose CUSIP starts `912797`, else null. */
export function programOf(raw: string): "BILL" | null {
  try {
    const parsed = parseSeriesCode(raw);
    return parsed.issueDate !== null &&
      parsed.cusip.startsWith(BILL_CUSIP_PREFIX)
      ? "BILL"
      : null;
  } catch {
    return null;
  }
}
