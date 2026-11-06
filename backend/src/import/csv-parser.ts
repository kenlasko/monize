/**
 * CSV Parser for transaction import
 *
 * Parses CSV files into the same QifParseResult format used by the QIF parser,
 * allowing the import pipeline to handle both formats uniformly.
 *
 * Supports RFC 4180 compliant CSV parsing including quoted fields with
 * embedded delimiters, newlines, and escaped double-quotes.
 */

import type { QifTransaction, QifParseResult } from "./qif-parser";
import { escapeRegExp } from "../common/escape-regexp.util";
import { roundToDecimals } from "../common/round.util";
import { normalizeAmountSeparators } from "./amount-separators.util";
import { isCalendarDate } from "../common/validators/is-calendar-date.validator";
import { monthFromName } from "./csv-month-names";

export interface CsvHeadersResult {
  headers: string[];
  sampleRows: string[][];
  rowCount: number;
  /**
   * Per column, the date format that reads the most of its values over the
   * whole file (`detectCsvDateFormat`), or null where none reads any.
   */
  columnDateFormats: (string | null)[];
}

/**
 * Canonical investment actions the CSV importer can classify a row into.
 * The parser emits the QIF action code for each (CANONICAL_TO_QIF_ACTION) so
 * ImportInvestmentProcessorService handles CSV rows exactly like QIF rows.
 * cashIn/cashOut are pure cash movements booked on the linked cash account.
 */
export type CanonicalInvestmentAction =
  | "buy"
  | "sell"
  | "dividend"
  | "interest"
  | "capitalGain"
  | "reinvest"
  | "split"
  | "transferIn"
  | "transferOut"
  | "addShares"
  | "removeShares"
  | "cashIn"
  | "cashOut";

export type CsvActionKeywords = Partial<
  Record<CanonicalInvestmentAction, string[]>
>;

export interface CsvColumnMappingConfig {
  date: number;
  amount?: number;
  debit?: number;
  credit?: number;
  payee?: number;
  category?: number;
  subcategory?: number;
  memo?: number;
  referenceNumber?: number;
  tags?: number;
  reconciliationStatus?: number;
  dateFormat: string;
  reverseSign?: boolean;
  hasHeader: boolean;
  delimiter: string;
  amountTypeColumn?: number;
  incomeValues?: string[];
  expenseValues?: string[];
  transferOutValues?: string[];
  transferInValues?: string[];
  transferAccountColumn?: number;
  investmentMode?: boolean;
  actionColumn?: number;
  securityColumn?: number;
  quantityColumn?: number;
  priceColumn?: number;
  commissionColumn?: number;
  actionKeywords?: CsvActionKeywords;
}

export interface CsvTransferRule {
  type: "payee" | "category";
  pattern: string;
  accountName: string;
}

/**
 * A row of the file whose date the mapping's date format cannot read (or that
 * has none), so the parse left it out. The preview counts them and the import
 * result lists them among its skipped rows, by the line of the file.
 */
export interface CsvUnreadableDateRow {
  /** The line of the file the row starts on, 1-based, the header included. */
  rowNumber: number;
  /** The date field as the file gave it, empty when the row has none. */
  rawDate: string;
  amount: number;
  payee: string;
}

/**
 * An investment-mode row the parse left out because its action needs data the
 * row does not carry (`buildInvestmentRow`). The preview counts them per
 * reason in `investmentSummary.rejectedRows`; the import result lists each
 * among its skipped rows.
 */
export interface CsvRejectedInvestmentRow {
  /** The line of the file the row starts on, 1-based, the header included. */
  rowNumber: number;
  /** The row's date, YYYY-MM-DD. */
  date: string;
  amount: number;
  payee: string;
  reason: InvestmentRejectReason;
}

/** Longest raw date text an unreadable-date row carries back. */
const RAW_DATE_LIMIT = 50;

/** Per-canonical-action row counts and skip reporting for the preview step. */
export interface CsvInvestmentSummary {
  actionCounts: Partial<Record<CanonicalInvestmentAction, number>>;
  /** Distinct unmatched action values imported as cash transactions */
  cashFallbackValues: string[];
  /** Buy/reinvest rows downgraded to addshares because no cost was derivable */
  uncostedShareRows: number;
  rejectedRows: { reason: string; count: number }[];
}

// Iteration order doubles as match priority when a keyword appears in more
// than one action's list.
const CANONICAL_INVESTMENT_ACTIONS: CanonicalInvestmentAction[] = [
  "buy",
  "sell",
  "dividend",
  "interest",
  "capitalGain",
  "reinvest",
  "split",
  "transferIn",
  "transferOut",
  "addShares",
  "removeShares",
  "cashIn",
  "cashOut",
];

/**
 * Built-in action keyword lists, compared with exact match after trim +
 * lowercase. Exact only -- substring matching over financial verbs is how
 * "sell" would claim "sell to cover taxes withheld" and misfile the row.
 * A user-supplied list in `actionKeywords` replaces the default list for
 * that action (same semantics as incomeValues/expenseValues).
 */
export const DEFAULT_INVESTMENT_ACTION_KEYWORDS: Record<
  CanonicalInvestmentAction,
  string[]
> = {
  buy: ["buy", "bought", "purchase", "buy to open", "you bought"],
  sell: ["sell", "sold", "sale", "sell to close", "you sold"],
  dividend: [
    "div",
    "dividend",
    "cash dividend",
    "qualified dividend",
    "ordinary dividend",
  ],
  interest: ["int", "interest", "interest income", "credit interest"],
  capitalGain: [
    "capital gain",
    "cap gain",
    "lt cap gain",
    "st cap gain",
    "capital gains distribution",
  ],
  reinvest: [
    "reinvest",
    "reinvestment",
    "drip",
    "reinvest dividend",
    "dividend reinvestment",
    "reinvest shares",
  ],
  split: ["split", "stock split"],
  transferIn: ["transfer in", "shares in", "securities in", "receive"],
  transferOut: ["transfer out", "shares out", "securities out", "deliver"],
  addShares: ["add", "add shares", "adjust up"],
  removeShares: ["remove", "remove shares", "adjust down"],
  cashIn: ["deposit", "contribution", "cash in", "credit", "funds received"],
  cashOut: [
    "withdrawal",
    "withdraw",
    "cash out",
    "fee",
    "management fee",
    "debit",
    "tax withheld",
  ],
};

/**
 * QIF action-code vocabulary accepted as a final fallback so Quicken-style
 * CSV exports classify with no keyword configuration. Only codes with an
 * unambiguous canonical meaning are listed; the rest stay unknown rather
 * than guessing.
 */
const QIF_ACTION_CODE_TO_CANONICAL: Record<string, CanonicalInvestmentAction> =
  {
    buy: "buy",
    sell: "sell",
    div: "dividend",
    intinc: "interest",
    cglong: "capitalGain",
    cgshort: "capitalGain",
    cgmid: "capitalGain",
    stksplit: "split",
    shrsin: "transferIn",
    shrsout: "transferOut",
    reinvdiv: "reinvest",
    reinvint: "reinvest",
    reinvlg: "reinvest",
    reinvsh: "reinvest",
    reinvmd: "reinvest",
    xin: "cashIn",
    xout: "cashOut",
  };

/**
 * QIF action code the parser emits per canonical action. The investment
 * processor's actionMap is the other half of this contract -- the parser
 * must never emit a code that map does not resolve, because its fallback
 * for unknown codes is BUY.
 */
export const CANONICAL_TO_QIF_ACTION: Record<
  CanonicalInvestmentAction,
  string
> = {
  buy: "buy",
  sell: "sell",
  dividend: "div",
  interest: "intinc",
  capitalGain: "cglong",
  reinvest: "reinvdiv",
  split: "stksplit",
  transferIn: "shrsin",
  transferOut: "shrsout",
  addShares: "addshares",
  removeShares: "removeshares",
  cashIn: "xin",
  cashOut: "xout",
};

/**
 * Classify a raw action-column value into a canonical investment action.
 * Priority: user keyword lists, then built-in defaults (skipped for actions
 * the user overrode), then the QIF action-code vocabulary. Returns null for
 * an unmatched value -- the caller decides the cash fallback, never BUY.
 */
export function normalizeCsvAction(
  raw: string | undefined | null,
  config: CsvColumnMappingConfig,
): CanonicalInvestmentAction | null {
  const key = (raw ?? "").trim().toLowerCase();
  if (!key) {
    return null;
  }
  const overrides = config.actionKeywords || {};
  const matches = (list: string[] | undefined): boolean =>
    (list || []).some((k) => k.trim().toLowerCase() === key);

  for (const action of CANONICAL_INVESTMENT_ACTIONS) {
    if (matches(overrides[action])) {
      return action;
    }
  }
  for (const action of CANONICAL_INVESTMENT_ACTIONS) {
    if (overrides[action] === undefined) {
      if (matches(DEFAULT_INVESTMENT_ACTION_KEYWORDS[action])) {
        return action;
      }
    }
  }
  return QIF_ACTION_CODE_TO_CANONICAL[key] ?? null;
}

// Field length limits matching database column constraints (same as qif-parser)
const FIELD_LIMITS = {
  PAYEE: 255,
  MEMO: 5000,
  REFERENCE_NUMBER: 100,
  CATEGORY: 255,
  TAG: 100,
  SECURITY: 255,
} as const;

/**
 * Candidate separators for multi-tag CSV columns. Dash and forward slash are
 * deliberately excluded because they are routinely embedded inside tag names
 * (e.g. "2026/taxes", "work-travel").
 */
const TAG_SEPARATOR_CANDIDATES = ["|", ";", ","] as const;

/**
 * Inspect all non-empty tag values from the column and pick the separator
 * that appears in the most rows. Returns null when no candidate appears,
 * in which case each field is treated as a single tag.
 *
 * Tie-breaks favour "|" over ";" over "," (iteration order of
 * TAG_SEPARATOR_CANDIDATES) because users who pick an unusual separator
 * almost always mean it intentionally.
 */
export function detectTagSeparator(values: string[]): string | null {
  const nonEmpty = values
    .map((v) => (v ?? "").trim())
    .filter((v) => v.length > 0);
  if (nonEmpty.length === 0) return null;

  let bestSeparator: string | null = null;
  let bestCount = 0;
  for (const sep of TAG_SEPARATOR_CANDIDATES) {
    const count = nonEmpty.reduce(
      (acc, v) => (v.includes(sep) ? acc + 1 : acc),
      0,
    );
    if (count > bestCount) {
      bestCount = count;
      bestSeparator = sep;
    }
  }

  return bestCount > 0 ? bestSeparator : null;
}

/**
 * Split a single row's tag field into individual tag names using the
 * pre-detected separator. Returns trimmed, truncated, de-duplicated names
 * (case-insensitive) in the order they appear.
 */
export function splitTagValue(
  value: string,
  separator: string | null,
): string[] {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return [];
  const parts = separator ? trimmed.split(separator) : [trimmed];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of parts) {
    const name = truncate(part.trim(), FIELD_LIMITS.TAG);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

export type NormalizedReconciliationStatus =
  "UNRECONCILED" | "CLEARED" | "RECONCILED" | "VOID";

// Lookup for the most common reconciliation status keywords seen across
// financial exports (banks, QIF-derived CSVs, spreadsheets, etc.). Values are
// compared case-insensitively after trimming.
const RECONCILIATION_STATUS_KEYWORDS: Record<
  string,
  NormalizedReconciliationStatus
> = {
  // Reconciled
  reconciled: "RECONCILED",
  reconcile: "RECONCILED",
  rec: "RECONCILED",
  r: "RECONCILED",
  matched: "RECONCILED",
  match: "RECONCILED",
  final: "RECONCILED",
  finalized: "RECONCILED",
  x: "RECONCILED",
  // Cleared
  cleared: "CLEARED",
  clear: "CLEARED",
  clr: "CLEARED",
  c: "CLEARED",
  posted: "CLEARED",
  post: "CLEARED",
  verified: "CLEARED",
  confirm: "CLEARED",
  confirmed: "CLEARED",
  "*": "CLEARED",
  "✓": "CLEARED", // check mark
  // Void
  void: "VOID",
  voided: "VOID",
  v: "VOID",
  cancel: "VOID",
  cancelled: "VOID",
  canceled: "VOID",
  deleted: "VOID",
  removed: "VOID",
  // Unreconciled / explicit "not yet"
  unreconciled: "UNRECONCILED",
  unreconcile: "UNRECONCILED",
  uncleared: "UNRECONCILED",
  unclear: "UNRECONCILED",
  pending: "UNRECONCILED",
  open: "UNRECONCILED",
  none: "UNRECONCILED",
  new: "UNRECONCILED",
  unposted: "UNRECONCILED",
  u: "UNRECONCILED",
  n: "UNRECONCILED",
  "-": "UNRECONCILED",
};

/**
 * Normalize a free-text reconciliation status string from a CSV row into the
 * TransactionStatus enum value that Monize understands. Uses a generous
 * keyword map to handle variations across bank/spreadsheet exports. Empty
 * values and unrecognized tokens fall back to UNRECONCILED.
 */
export function normalizeReconciliationStatus(
  raw: string | undefined | null,
): NormalizedReconciliationStatus {
  if (raw == null) return "UNRECONCILED";
  const trimmed = String(raw).trim();
  if (!trimmed) return "UNRECONCILED";
  const key = trimmed.toLowerCase();
  if (key in RECONCILIATION_STATUS_KEYWORDS) {
    return RECONCILIATION_STATUS_KEYWORDS[key];
  }
  // Substring fallbacks: many banks include the status inside a longer
  // sentence (e.g. "Transaction posted", "Payment reconciled on 2026-01-15").
  // Check in priority order so VOID wins over CLEARED, and RECONCILED over
  // CLEARED (since a reconciled transaction has also been cleared).
  if (
    key.includes("void") ||
    key.includes("cancel") ||
    key.includes("delete")
  ) {
    return "VOID";
  }
  if (key.includes("reconcil") || key.includes("match")) {
    return "RECONCILED";
  }
  if (
    key.includes("clear") ||
    key.includes("post") ||
    key.includes("verif") ||
    key.includes("confirm")
  ) {
    return "CLEARED";
  }
  if (
    key.includes("pending") ||
    key.includes("unreconcil") ||
    key.includes("unclear") ||
    key.includes("open")
  ) {
    return "UNRECONCILED";
  }
  return "UNRECONCILED";
}

// Strip HTML angle brackets to prevent stored XSS from CSV content.
function stripHtml(value: string): string {
  return value.replace(/[<>]/g, "");
}

// Truncate a string to a maximum length to match database column limits.
function truncate(value: string, maxLength: number): string {
  const sanitized = stripHtml(value);
  return sanitized.length > maxLength
    ? sanitized.substring(0, maxLength)
    : sanitized;
}

/**
 * Check if a string is all uppercase (ignoring non-letter characters).
 * Returns false for strings with no letters or mixed case.
 */
function isAllCaps(value: string): boolean {
  const letters = value.replace(/[^a-zA-Z]/g, "");
  return letters.length > 0 && letters === letters.toUpperCase();
}

/**
 * Convert an all-caps string to Proper Case (capitalize first letter of
 * each word, lowercase the rest). Preserves non-letter characters.
 */
function toProperCase(value: string): string {
  return value.toLowerCase().replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

/**
 * Auto-detect the delimiter used in a CSV file by examining the first
 * few lines. Checks for tabs and semicolons before falling back to comma.
 */
function detectDelimiter(content: string): string {
  // Defensive: ensure we received a real string. An attacker could submit a
  // JSON body where `content` is an object like {length: 1e100}; iterating on
  // `.length` without this check is a CWE-834 loop-bound injection.
  if (typeof content !== "string") {
    return ",";
  }
  // Take the first few lines (up to 5) for detection
  const sampleLines = content.split(/\r?\n/, 5).filter((l) => l.trim());

  if (sampleLines.length === 0) {
    return ",";
  }

  // Count occurrences of each candidate delimiter across sample lines
  const candidates: Array<{ char: string; counts: number[] }> = [
    { char: "\t", counts: [] },
    { char: ";", counts: [] },
    { char: ",", counts: [] },
  ];

  for (const line of sampleLines) {
    for (const candidate of candidates) {
      // Count occurrences outside of quoted fields
      let count = 0;
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') {
          inQuotes = !inQuotes;
        } else if (!inQuotes && line[i] === candidate.char) {
          count++;
        }
      }
      candidate.counts.push(count);
    }
  }

  // Pick the delimiter that has consistent non-zero counts across lines
  for (const candidate of candidates) {
    const nonZero = candidate.counts.filter((c) => c > 0);
    if (nonZero.length === sampleLines.length) {
      // All sample lines have this delimiter
      const first = nonZero[0];
      const consistent = nonZero.every((c) => c === first);
      if (consistent) {
        return candidate.char;
      }
    }
  }

  // If no consistent delimiter found, pick the one with most total occurrences
  // among those that appear in all lines
  for (const candidate of candidates) {
    const nonZero = candidate.counts.filter((c) => c > 0);
    if (nonZero.length === sampleLines.length) {
      return candidate.char;
    }
  }

  return ",";
}

/**
 * Parse CSV content into rows of fields, following RFC 4180 rules:
 * - Fields may be wrapped in double quotes
 * - Quoted fields can contain delimiters, newlines, and escaped quotes ("")
 * - Empty rows are skipped
 *
 * Exported for an importer whose columns a format fixes rather than a person
 * maps (the warranty CSV, `warranty-csv.ts`), so the codebase keeps one reader.
 */
export function parseCsvRows(content: string, delimiter: string): string[][] {
  return readCsvRecords(content, delimiter).map((record) => record.fields);
}

/** One record of the file and the line of the file it starts on (1-based). */
interface CsvRecord {
  fields: string[];
  line: number;
}

/**
 * `parseCsvRows` with each record's starting line, so a row the import leaves
 * out can be named by the line a person finds it on in the file, which a
 * quoted newline or a skipped blank line moves away from its index.
 */
function readCsvRecords(content: string, delimiter: string): CsvRecord[] {
  // Defensive: ensure we received a real string. An attacker could submit a
  // JSON body where `content` is an object like {length: 1e100}; iterating on
  // `.length` without this check is a CWE-834 loop-bound injection.
  if (typeof content !== "string") {
    return [];
  }
  const rows: CsvRecord[] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let i = 0;
  let line = 1;
  let rowStartLine = 1;

  while (i < content.length) {
    const char = content[i];

    if (inQuotes) {
      if (char === "\n") {
        line++;
      }
      if (char === '"') {
        // Check for escaped quote (doubled "")
        if (i + 1 < content.length && content[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        }
        // End of quoted field
        inQuotes = false;
        i++;
        continue;
      }
      currentField += char;
      i++;
      continue;
    }

    // Not in quotes
    if (char === '"' && currentField === "") {
      // Start of quoted field (only at beginning of field)
      inQuotes = true;
      i++;
      continue;
    }

    if (char === delimiter) {
      currentRow.push(currentField.trim());
      currentField = "";
      i++;
      continue;
    }

    if (char === "\r") {
      // Handle \r\n or standalone \r
      if (i + 1 < content.length && content[i + 1] === "\n") {
        i++;
      }
      // End of row
      currentRow.push(currentField.trim());
      currentField = "";
      if (currentRow.some((f) => f !== "")) {
        rows.push({ fields: currentRow, line: rowStartLine });
      }
      currentRow = [];
      i++;
      line++;
      rowStartLine = line;
      continue;
    }

    if (char === "\n") {
      // End of row
      currentRow.push(currentField.trim());
      currentField = "";
      if (currentRow.some((f) => f !== "")) {
        rows.push({ fields: currentRow, line: rowStartLine });
      }
      currentRow = [];
      i++;
      line++;
      rowStartLine = line;
      continue;
    }

    currentField += char;
    i++;
  }

  // Handle last field/row if file doesn't end with newline
  if (currentField !== "" || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some((f) => f !== "")) {
      rows.push({ fields: currentRow, line: rowStartLine });
    }
  }

  return rows;
}

// Well-known date format strings (used by the built-in format picker)
const KNOWN_FORMATS = new Set([
  "MM/DD/YYYY",
  "DD/MM/YYYY",
  "YYYY-MM-DD",
  "YYYY-DD-MM",
  "DD-MMM-YYYY",
  "MMM DD, YYYY",
]);

/** A month written as a word (`monthFromName` reads it), Unicode letters. */
const MONTH_NAME_PATTERN = "[\\p{L}\\p{M}]+";

// Built-in month-name formats accept any of - / . , and whitespace between
// the parts, and an abbreviation mark after the month: "15-Jan-2026",
// "15 janv. 2026", "15.Mär.2026"; "Jan 15, 2026", "January 15 2026".
const DAY_MONTH_NAME_YEAR =
  /^(\d{1,2})[-/.,\s]*([\p{L}\p{M}]+)[-/.,\s\u0970]*(\d{2,4})$/u;
const MONTH_NAME_DAY_YEAR =
  /^([\p{L}\p{M}]+)[-/.,\s\u0970]*(\d{1,2})[-/.,\s]+(\d{2,4})$/u;

/**
 * Validate that year, month, day values name a day that exists, in a
 * reasonable year range. Returns the YYYY-MM-DD string or null if invalid:
 * 30 February is refused here, where the row can still be reported as an
 * unreadable date, rather than at the database.
 */
function validateAndFormat(
  year: string,
  month: string,
  day: string,
): string | null {
  const y = parseInt(year);
  if (y < 1900 || y > 2100) {
    return null;
  }
  const m = parseInt(month);
  const d = parseInt(day);
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) {
    return null;
  }
  const formatted = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  // Every month has a 28th; only a later day needs the calendar, which keeps
  // date detection over a whole file cheap.
  return d <= 28 || isCalendarDate(formatted) ? formatted : null;
}

/**
 * Resolve a 2-digit year to a 4-digit year.
 * Years > 50 map to 19xx, others to 20xx.
 */
function resolveYear(raw: string): string {
  if (raw.length === 4) return raw;
  const n = parseInt(raw);
  return n > 50 ? `19${raw}` : `20${raw}`;
}

/**
 * Parse a date using a custom format pattern.
 * Supported tokens: YYYY, YY, MMM (or MMMM: a month's name or abbreviation in
 * any app language, `monthFromName`), MM, DD (case-sensitive).
 * Any other characters in the pattern are treated as literal separators.
 */
function parseDateCustom(dateStr: string, format: string): string | null {
  // Build a regex from the format pattern
  let regex = "^";
  const groups: string[] = [];
  let i = 0;
  while (i < format.length) {
    if (format.substring(i, i + 4) === "YYYY") {
      regex += "(\\d{4})";
      groups.push("year4");
      i += 4;
    } else if (format.substring(i, i + 2) === "YY") {
      regex += "(\\d{2})";
      groups.push("year2");
      i += 2;
    } else if (format.substring(i, i + 3) === "MMM") {
      // An optional abbreviation mark ("janv.", "जन॰") belongs to the name.
      regex += `(${MONTH_NAME_PATTERN}[.\\u0970]?)`;
      groups.push("monthName");
      i += format.substring(i, i + 4) === "MMMM" ? 4 : 3;
    } else if (format.substring(i, i + 2) === "MM") {
      regex += "(\\d{1,2})";
      groups.push("month");
      i += 2;
    } else if (format.substring(i, i + 2) === "DD") {
      regex += "(\\d{1,2})";
      groups.push("day");
      i += 2;
    } else {
      // Escape regex special chars for literal separator
      regex += escapeRegExp(format[i]);
      i += 1;
    }
  }
  regex += "$";

  const match = dateStr.match(new RegExp(regex, "u"));
  if (!match) return null;

  let year = "";
  let month = "";
  let day = "";
  for (let g = 0; g < groups.length; g++) {
    const val = match[g + 1];
    switch (groups[g]) {
      case "year4":
        year = val;
        break;
      case "year2":
        year = resolveYear(val);
        break;
      case "month":
        month = val;
        break;
      case "monthName": {
        const named = monthFromName(val);
        if (named === null) return null;
        month = String(named);
        break;
      }
      case "day":
        day = val;
        break;
    }
  }

  if (!year || !month || !day) return null;
  return validateAndFormat(year, month, day);
}

/**
 * Strip trailing time components from a date string.
 * Handles formats like "01/15/2026 14:30:00", "2026-01-15T12:00:00Z",
 * "01/15/2026 2:30 PM", etc.
 */
function stripTime(dateStr: string): string {
  // Remove ISO 8601 time portion (T between a digit and a digit), so the T of
  // "OCT" or "AUGUST" stays part of the month's name
  const isoMatch = dateStr.match(/^(.*?\d)T\d/);
  if (isoMatch) {
    return isoMatch[1];
  }
  // Remove time after space (e.g., "01/15/2026 14:30:00", "01/15/2026 2:30 PM"
  // or "Jan 15, 2026 2:30 PM")
  const spaceMatch = dateStr.match(/^(.+?)\s+\d{1,2}:\d{2}/);
  if (spaceMatch) {
    return spaceMatch[1];
  }
  return dateStr;
}

/**
 * Parse a date string using the specified format and return YYYY-MM-DD.
 * Accepts the well-known formats (the numeric four with any of - / . as
 * separator, the month-name two as DAY_MONTH_NAME_YEAR / MONTH_NAME_DAY_YEAR
 * describe) or a custom pattern string using YYYY/YY, MMM, MM, DD tokens.
 * Returns null if the date cannot be parsed or is invalid.
 */
function parseCsvDate(dateStr: string, format: string): string | null {
  const trimmed = stripTime(dateStr.trim());
  if (!trimmed) {
    return null;
  }
  return parseStrippedCsvDate(trimmed, format);
}

/** `parseCsvDate` of a value already trimmed and stripped of its time. */
function parseStrippedCsvDate(trimmed: string, format: string): string | null {
  // For custom (non-built-in) format patterns, use the generic parser
  if (!KNOWN_FORMATS.has(format)) {
    return parseDateCustom(trimmed, format);
  }

  let year: string;
  let month: string;
  let day: string;

  if (format === "DD-MMM-YYYY" || format === "MMM DD, YYYY") {
    const dayFirst = format === "DD-MMM-YYYY";
    const match = trimmed.match(
      dayFirst ? DAY_MONTH_NAME_YEAR : MONTH_NAME_DAY_YEAR,
    );
    if (!match) {
      return null;
    }
    const named = monthFromName(dayFirst ? match[2] : match[1]);
    if (named === null) {
      return null;
    }
    year = resolveYear(match[3]);
    month = String(named);
    day = dayFirst ? match[1] : match[2];
  } else if (format === "YYYY-MM-DD" || format === "YYYY-DD-MM") {
    const match = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (!match) {
      return null;
    }
    year = match[1];
    if (format === "YYYY-DD-MM") {
      day = match[2].padStart(2, "0");
      month = match[3].padStart(2, "0");
    } else {
      month = match[2].padStart(2, "0");
      day = match[3].padStart(2, "0");
    }
  } else {
    // MM/DD/YYYY or DD/MM/YYYY
    const match = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
    if (!match) {
      return null;
    }
    year = resolveYear(match[3]);

    if (format === "DD/MM/YYYY") {
      day = match[1].padStart(2, "0");
      month = match[2].padStart(2, "0");
    } else {
      // MM/DD/YYYY
      month = match[1].padStart(2, "0");
      day = match[2].padStart(2, "0");
    }
  }

  return validateAndFormat(year, month, day);
}

/**
 * Parse an amount string from a CSV field.
 * Handles currency symbols, spaces, parentheses-as-negative notation, and
 * both US (1,234.56) and European (1.234,56 / 18,36) grouping/decimal styles
 * (`normalizeAmountSeparators`).
 */
function parseCsvAmount(value: string): number | null {
  let cleaned = value.trim();
  if (!cleaned) {
    return null;
  }

  // Handle parentheses as negative: (50.00) -> -50.00
  const parenMatch = cleaned.match(/^\((.+)\)$/);
  if (parenMatch) {
    cleaned = "-" + parenMatch[1];
  }

  // Strip currency symbols and whitespace
  cleaned = cleaned.replace(/[$£€¥₹\s]/g, "");

  cleaned = normalizeAmountSeparators(cleaned);

  const amount = parseFloat(cleaned);
  return isNaN(amount) ? null : amount;
}

/**
 * Get the value at a column index from a row, returning empty string
 * if the index is out of bounds.
 */
function getField(row: string[], index: number | undefined): string {
  if (index === undefined || index === null || index < 0) {
    return "";
  }
  return index < row.length ? row[index] : "";
}

// Stable rejection-reason keys surfaced through investmentSummary.rejectedRows;
// the frontend translates them for the Review step.
export type InvestmentRejectReason =
  | "missingSecurity"
  | "missingQuantity"
  | "missingAmount"
  | "missingProceeds"
  | "missingSplitRatio";

const SECURITY_REQUIRED_ACTIONS: ReadonlySet<CanonicalInvestmentAction> =
  new Set([
    "buy",
    "sell",
    "reinvest",
    "split",
    "transferIn",
    "transferOut",
    "addShares",
    "removeShares",
  ]);

interface InvestmentRowOutcome {
  transaction?: QifTransaction;
  /** Canonical action actually emitted (post-fallback/downgrade) */
  emittedAction?: CanonicalInvestmentAction;
  rejectReason?: InvestmentRejectReason;
  /** Raw action value of a row imported via the unknown-action cash fallback */
  cashFallbackValue?: string;
  /** True when a buy/reinvest was downgraded to addshares (no derivable cost) */
  uncosted?: boolean;
}

/**
 * Classify one CSV row in investment mode per the truth table in
 * docs/import-csv-investment-spec.md. Quantity, price and commission carry no
 * direction (abs); the action does. Missing money data is never defaulted --
 * a row whose cost or proceeds cannot be established is rejected, and a
 * missing price is left at 0 so the processor persists NULL, not 0.
 */
function buildInvestmentRow(params: {
  row: string[];
  config: CsvColumnMappingConfig;
  parsedDate: string;
  payee: string;
  memo: string;
  referenceNumber: string;
  tagNames: string[];
  normalizedStatus: NormalizedReconciliationStatus | null;
}): InvestmentRowOutcome {
  const { row, config, parsedDate, normalizedStatus } = params;

  // Row total from the amount column or debit/credit pair. Zero is treated as
  // unknown: a $0.00 cell carries no information a money movement can use.
  let parsedAmount: number | null = null;
  if (config.amount !== undefined) {
    parsedAmount = parseCsvAmount(getField(row, config.amount));
  } else if (config.debit !== undefined || config.credit !== undefined) {
    const creditVal =
      config.credit !== undefined
        ? parseCsvAmount(getField(row, config.credit))
        : null;
    const debitVal =
      config.debit !== undefined
        ? parseCsvAmount(getField(row, config.debit))
        : null;
    if (creditVal !== null && creditVal !== 0) {
      parsedAmount = Math.abs(creditVal);
    } else if (debitVal !== null && debitVal !== 0) {
      parsedAmount = -Math.abs(debitVal);
    }
  }
  const amountKnown = parsedAmount !== null && parsedAmount !== 0;
  const absAmount = amountKnown ? Math.abs(parsedAmount!) : 0;

  const rawAction = getField(row, config.actionColumn).trim();
  let canonical = normalizeCsvAction(rawAction, config);
  let cashFallbackValue: string | undefined;
  if (canonical === null) {
    // Unknown action: import as a cash movement by amount sign (user
    // decision). With no amount there is nothing truthful to book.
    if (!amountKnown) {
      return { rejectReason: "missingAmount" };
    }
    cashFallbackValue = rawAction;
    canonical = parsedAmount! > 0 ? "cashIn" : "cashOut";
  }

  const quantityRaw =
    config.quantityColumn !== undefined
      ? parseCsvAmount(getField(row, config.quantityColumn))
      : null;
  const quantity = quantityRaw !== null ? Math.abs(quantityRaw) : 0;
  const quantityKnown = quantity > 0;
  const priceRaw =
    config.priceColumn !== undefined
      ? parseCsvAmount(getField(row, config.priceColumn))
      : null;
  const priceFromColumn =
    priceRaw !== null && Math.abs(priceRaw) > 0 ? Math.abs(priceRaw) : null;
  const commissionRaw =
    config.commissionColumn !== undefined
      ? parseCsvAmount(getField(row, config.commissionColumn))
      : null;
  const commission = commissionRaw !== null ? Math.abs(commissionRaw) : 0;
  const security = truncate(
    getField(row, config.securityColumn),
    FIELD_LIMITS.SECURITY,
  );

  if (SECURITY_REQUIRED_ACTIONS.has(canonical) && !security) {
    return { rejectReason: "missingSecurity" };
  }

  const emit = (
    fields: Partial<QifTransaction> & { amount: number },
    emittedAction: CanonicalInvestmentAction,
    extra: Pick<InvestmentRowOutcome, "cashFallbackValue" | "uncosted"> = {},
  ): InvestmentRowOutcome => ({
    transaction: {
      date: parsedDate,
      payee: params.payee,
      memo: params.memo,
      number: params.referenceNumber,
      cleared: normalizedStatus === "CLEARED",
      reconciled: normalizedStatus === "RECONCILED",
      void: normalizedStatus === "VOID",
      category: "",
      isTransfer: false,
      transferAccount: "",
      splits: [],
      security: "",
      action: CANONICAL_TO_QIF_ACTION[emittedAction],
      price: 0,
      quantity: 0,
      commission: 0,
      tagNames: params.tagNames,
      ...fields,
    },
    emittedAction,
    ...extra,
  });

  switch (canonical) {
    case "buy":
    case "reinvest": {
      if (!quantityKnown) {
        return { rejectReason: "missingQuantity" };
      }
      let price = priceFromColumn;
      if (price === null && amountKnown) {
        const derived = roundToDecimals(
          (absAmount - commission) / quantity,
          10,
        );
        if (derived > 0) {
          price = derived;
        }
      }
      if (price === null) {
        // No cost is derivable: uncosted shares enter as addshares with the
        // price left unknown rather than invented as 0.
        return emit({ amount: 0, security, quantity }, "addShares", {
          uncosted: true,
        });
      }
      return emit(
        { amount: absAmount, security, quantity, price, commission },
        canonical,
      );
    }
    case "sell": {
      if (!quantityKnown) {
        return { rejectReason: "missingQuantity" };
      }
      let price = priceFromColumn;
      if (price === null && amountKnown) {
        price = roundToDecimals((absAmount + commission) / quantity, 10);
      }
      if (price === null || price <= 0) {
        // Downgrading to removeshares would silently drop the cash proceeds.
        return { rejectReason: "missingProceeds" };
      }
      return emit(
        { amount: absAmount, security, quantity, price, commission },
        canonical,
      );
    }
    case "dividend":
    case "interest":
    case "capitalGain": {
      if (!amountKnown) {
        return { rejectReason: "missingAmount" };
      }
      return emit(
        {
          amount: absAmount,
          security,
          quantity: quantityKnown ? quantity : 0,
          price: priceFromColumn ?? 0,
        },
        canonical,
      );
    }
    case "split": {
      if (!quantityKnown) {
        return { rejectReason: "missingSplitRatio" };
      }
      return emit({ amount: 0, security, quantity }, canonical);
    }
    case "transferIn":
    case "transferOut":
    case "addShares":
    case "removeShares": {
      if (!quantityKnown) {
        return { rejectReason: "missingQuantity" };
      }
      return emit(
        {
          amount: absAmount,
          security,
          quantity,
          price: priceFromColumn ?? 0,
        },
        canonical,
      );
    }
    case "cashIn":
    case "cashOut": {
      if (!amountKnown) {
        return { rejectReason: "missingAmount" };
      }
      // Explicit keyword rows force the direction; fallback rows already
      // chose the action from the sign, so both land signed correctly.
      const amount = canonical === "cashIn" ? absAmount : -absAmount;
      return emit({ amount }, canonical, { cashFallbackValue });
    }
  }
}

/**
 * Validate that CSV content is non-empty and has at least 2 lines
 * (either header + data, or 2 data rows).
 */
export function validateCsvContent(content: string): {
  valid: boolean;
  error?: string;
} {
  if (!content || !content.trim()) {
    return { valid: false, error: "File is empty" };
  }

  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

  if (lines.length < 2) {
    return {
      valid: false,
      error:
        "CSV file must have at least 2 rows (header and data, or 2 data rows)",
    };
  }

  return { valid: true };
}

/**
 * A row's amount before any type column or transfer rule adjusts its sign:
 * the amount column (negated under `reverseSign`), or the credit column as an
 * inflow and the debit column as an outflow. `rawAmount` is the amount
 * column's value before `reverseSign`.
 */
function readRowAmount(
  row: string[],
  config: CsvColumnMappingConfig,
): { amount: number; rawAmount: number } {
  if (config.amount !== undefined) {
    const rawAmount = parseCsvAmount(getField(row, config.amount)) ?? 0;
    return {
      amount: config.reverseSign ? -rawAmount : rawAmount,
      rawAmount,
    };
  }
  if (config.debit !== undefined || config.credit !== undefined) {
    const creditVal =
      config.credit !== undefined
        ? (parseCsvAmount(getField(row, config.credit)) ?? 0)
        : 0;
    const debitVal =
      config.debit !== undefined
        ? (parseCsvAmount(getField(row, config.debit)) ?? 0)
        : 0;
    // Strip sign from debit and negate -- debit is always an outflow
    return {
      amount: creditVal !== 0 ? Math.abs(creditVal) : -Math.abs(debitVal),
      rawAmount: 0,
    };
  }
  return { amount: 0, rawAmount: 0 };
}

/**
 * The formats date detection chooses between, in the order a tie goes:
 * MM/DD/YYYY first, because a file whose every day is the 12th or earlier
 * reads either way and the import has always read it month first.
 */
const DETECTABLE_DATE_FORMATS = [
  "MM/DD/YYYY",
  "DD/MM/YYYY",
  "YYYY-MM-DD",
  "YYYY-DD-MM",
  "DD-MMM-YYYY",
  "MMM DD, YYYY",
] as const;

/**
 * A column none of whose first this-many values reads under any format is not
 * a date column, so the rest of it is not scanned. It decides only whether a
 * column holds dates; which order they are written in is decided by all of
 * them.
 */
const NOT_A_DATE_COLUMN_AFTER = 50;

/**
 * The date format that reads the most of `values`, every one of them, through
 * the same `parseCsvDate` the import uses; ties go to the earlier entry of
 * DETECTABLE_DATE_FORMATS. Null when no format reads any value. A day-first
 * statement whose first rows fall on the 1st to the 12th is still detected as
 * DD/MM/YYYY once any later row is dated after the 12th.
 */
export function detectCsvDateFormat(values: readonly string[]): string | null {
  const counts = DETECTABLE_DATE_FORMATS.map(() => 0);
  let scanned = 0;
  for (const value of values) {
    if (!value || !/\d/.test(value)) continue;
    const trimmed = stripTime(value.trim());
    DETECTABLE_DATE_FORMATS.forEach((format, i) => {
      if (parseStrippedCsvDate(trimmed, format) !== null) counts[i]++;
    });
    scanned++;
    if (
      scanned >= NOT_A_DATE_COLUMN_AFTER &&
      counts.every((count) => count === 0)
    ) {
      return null;
    }
  }
  let best = 0;
  counts.forEach((count, i) => {
    if (count > counts[best]) best = i;
  });
  return counts[best] > 0 ? DETECTABLE_DATE_FORMATS[best] : null;
}

/**
 * Parse CSV headers and return sample data for the column mapping UI.
 * Auto-detects delimiter if not provided.
 */
export function parseCsvHeaders(
  content: string,
  delimiter?: string,
): CsvHeadersResult {
  const resolvedDelimiter = delimiter || detectDelimiter(content);
  const rows = parseCsvRows(content, resolvedDelimiter);

  if (rows.length === 0) {
    return { headers: [], sampleRows: [], rowCount: 0, columnDateFormats: [] };
  }

  const headers = rows[0];
  const dataRows = rows.slice(1);
  const sampleRows = dataRows.slice(0, 5);
  // The first row is scanned too: whether it is a header is the mapping's
  // choice, and a header's text reads under no format.
  const columnDateFormats = headers.map((_, column) =>
    detectCsvDateFormat(rows.map((row) => getField(row, column))),
  );

  return {
    headers,
    sampleRows,
    rowCount: dataRows.length,
    columnDateFormats,
  };
}

/**
 * Parse a full CSV file into a QifParseResult using the provided column mapping.
 * Transfer rules are applied to detect inter-account transfers.
 */
export function parseCsv(
  content: string,
  config: CsvColumnMappingConfig,
  transferRules?: CsvTransferRule[],
): QifParseResult {
  const records = readCsvRecords(content, config.delimiter);
  const investmentMode = config.investmentMode === true;

  if (records.length === 0) {
    return {
      accountType: investmentMode ? "INVESTMENT" : "CHEQUING",
      accountName: "",
      transactions: [],
      categories: [],
      transferAccounts: [],
      securities: [],
      detectedDateFormat: config.dateFormat,
      sampleDates: [],
      openingBalance: null,
      openingBalanceDate: null,
      unreadableDateRows: [],
      ...(investmentMode
        ? {
            rejectedInvestmentRows: [],
            investmentSummary: {
              actionCounts: {},
              cashFallbackValues: [],
              uncostedShareRows: 0,
              rejectedRows: [],
            },
          }
        : {}),
    };
  }

  // Determine data rows (skip header if configured)
  const dataRecords = config.hasHeader ? records.slice(1) : records;
  const dataRows = dataRecords.map((record) => record.fields);

  const transactions: QifTransaction[] = [];
  const categoriesSet = new Set<string>();
  const transferAccountsSet = new Set<string>();
  const securitiesSet = new Set<string>();
  const actionCounts: Partial<Record<CanonicalInvestmentAction, number>> = {};
  const cashFallbackValues = new Set<string>();
  const rejectedRowCounts = new Map<InvestmentRejectReason, number>();
  const rejectedInvestmentRows: CsvRejectedInvestmentRow[] = [];
  let uncostedShareRows = 0;
  const rawDates: string[] = [];
  const unreadableDateRows: CsvUnreadableDateRow[] = [];
  const rules = transferRules || [];

  // Tag separator is detected once per import by scanning every tag value in
  // the file, because a user's export style is consistent across rows. Doing
  // it per-row would produce incorrect results for a dataset like
  // ["Food, Groceries", "Home"] where only the first row contains a separator.
  const tagSeparator =
    config.tags !== undefined
      ? detectTagSeparator(dataRows.map((row) => getField(row, config.tags!)))
      : null;

  for (const { fields: row, line } of dataRecords) {
    // Extract and parse the date
    const rawDate = getField(row, config.date);
    const parsedDate = rawDate
      ? parseCsvDate(rawDate, config.dateFormat)
      : null;

    // Extract and parse the amount
    const { amount: rowAmount, rawAmount } = readRowAmount(row, config);
    let amount = rowAmount;

    // Extract text fields with sanitization
    const rawPayee = truncate(getField(row, config.payee), FIELD_LIMITS.PAYEE);
    const payee = isAllCaps(rawPayee) ? toProperCase(rawPayee) : rawPayee;

    if (!parsedDate) {
      // Never a silent drop: the row is named in the preview and the result.
      unreadableDateRows.push({
        rowNumber: line,
        rawDate: truncate(rawDate, RAW_DATE_LIMIT),
        amount,
        payee,
      });
      continue;
    }

    rawDates.push(rawDate);
    const categoryPart = truncate(
      getField(row, config.category),
      FIELD_LIMITS.CATEGORY,
    );
    const subcategoryPart = truncate(
      getField(row, config.subcategory),
      FIELD_LIMITS.CATEGORY,
    );
    // Combine category and subcategory with colon separator (matching QIF convention)
    let category =
      categoryPart && subcategoryPart
        ? `${categoryPart}:${subcategoryPart}`
        : categoryPart || subcategoryPart;
    // Truncate combined value to field limit
    if (category.length > FIELD_LIMITS.CATEGORY) {
      category = category.substring(0, FIELD_LIMITS.CATEGORY);
    }
    const memo = truncate(getField(row, config.memo), FIELD_LIMITS.MEMO);
    const referenceNumber = truncate(
      getField(row, config.referenceNumber),
      FIELD_LIMITS.REFERENCE_NUMBER,
    );
    const tagNames =
      config.tags !== undefined
        ? splitTagValue(getField(row, config.tags), tagSeparator)
        : [];
    const normalizedStatus =
      config.reconciliationStatus !== undefined
        ? normalizeReconciliationStatus(
            getField(row, config.reconciliationStatus),
          )
        : null;

    if (investmentMode) {
      // Investment rows classify by action; the sign/type-column machinery
      // and transfer rules below do not apply (the UI hides them).
      const outcome = buildInvestmentRow({
        row,
        config,
        parsedDate,
        payee,
        memo,
        referenceNumber,
        tagNames,
        normalizedStatus,
      });
      if (outcome.rejectReason) {
        rejectedRowCounts.set(
          outcome.rejectReason,
          (rejectedRowCounts.get(outcome.rejectReason) || 0) + 1,
        );
        rejectedInvestmentRows.push({
          rowNumber: line,
          date: parsedDate,
          amount,
          payee,
          reason: outcome.rejectReason,
        });
        continue;
      }
      const emitted = outcome.emittedAction!;
      actionCounts[emitted] = (actionCounts[emitted] || 0) + 1;
      if (outcome.uncosted) {
        uncostedShareRows++;
      }
      if (outcome.cashFallbackValue !== undefined) {
        cashFallbackValues.add(outcome.cashFallbackValue);
      }
      const investmentTx = outcome.transaction!;
      if (investmentTx.security) {
        securitiesSet.add(investmentTx.security);
      }
      transactions.push(investmentTx);
      continue;
    }

    // Transfer detection
    let isTransfer = false;
    let transferAccount = "";

    // Amount type column: determine sign and detect transfers from a type indicator column
    if (config.amountTypeColumn !== undefined) {
      const typeValue = getField(row, config.amountTypeColumn)
        .trim()
        .toLowerCase();
      if (typeValue) {
        const incomeVals = (config.incomeValues || []).map((v) =>
          v.trim().toLowerCase(),
        );
        const expenseVals = (config.expenseValues || []).map((v) =>
          v.trim().toLowerCase(),
        );
        const transferOutVals = (config.transferOutValues || []).map((v) =>
          v.trim().toLowerCase(),
        );
        const transferInVals = (config.transferInValues || []).map((v) =>
          v.trim().toLowerCase(),
        );

        // Resolve transfer account name: explicit column, or fall back to category
        const transferAcctName =
          config.transferAccountColumn !== undefined
            ? truncate(
                getField(row, config.transferAccountColumn),
                FIELD_LIMITS.CATEGORY,
              )
            : categoryPart;

        if (transferOutVals.includes(typeValue) && transferAcctName) {
          amount = -Math.abs(amount);
          isTransfer = true;
          transferAccount = transferAcctName;
          category = "";
        } else if (transferInVals.includes(typeValue) && transferAcctName) {
          amount = Math.abs(amount);
          isTransfer = true;
          transferAccount = transferAcctName;
          category = "";
        } else if (expenseVals.includes(typeValue)) {
          // Negate the amount: positive becomes negative (outflow),
          // already-negative becomes positive (refund/reversal).
          // This respects the original sign rather than forcing -Math.abs().
          amount = -Math.abs(amount);
          if (rawAmount < 0) {
            amount = Math.abs(amount);
          }
        } else if (incomeVals.includes(typeValue)) {
          // Positive stays positive (inflow). Negative stays negative
          // (the CSV already encodes a reversal / deduction).
          amount = Math.abs(amount);
          if (rawAmount < 0) {
            amount = -Math.abs(amount);
          }
        }
      }
    }

    // Transfer rules (skipped if transfer already detected via amount type column)
    if (!isTransfer) {
      for (const rule of rules) {
        const fieldValue = rule.type === "payee" ? payee : category;
        if (
          fieldValue &&
          fieldValue.toLowerCase().includes(rule.pattern.toLowerCase())
        ) {
          isTransfer = true;
          transferAccount = rule.accountName;
          category = "";
          break;
        }
      }
    }

    // Collect categories and transfer accounts
    if (isTransfer && transferAccount) {
      transferAccountsSet.add(transferAccount);
    } else if (category) {
      categoriesSet.add(category);
    }

    const transaction: QifTransaction = {
      date: parsedDate,
      amount,
      payee,
      memo,
      number: referenceNumber,
      cleared: normalizedStatus === "CLEARED",
      reconciled: normalizedStatus === "RECONCILED",
      void: normalizedStatus === "VOID",
      category,
      isTransfer,
      transferAccount,
      splits: [],
      security: "",
      action: "",
      price: 0,
      quantity: 0,
      commission: 0,
      tagNames,
    };

    transactions.push(transaction);
  }

  // Sample dates: first 3 unique raw date strings
  const sampleDates = [...new Set(rawDates)].slice(0, 3);

  return {
    accountType: investmentMode ? "INVESTMENT" : "CHEQUING",
    accountName: "",
    transactions,
    categories: Array.from(categoriesSet).sort(),
    transferAccounts: Array.from(transferAccountsSet).sort(),
    securities: Array.from(securitiesSet).sort(),
    detectedDateFormat: config.dateFormat,
    sampleDates,
    openingBalance: null,
    openingBalanceDate: null,
    unreadableDateRows,
    ...(investmentMode
      ? {
          rejectedInvestmentRows,
          investmentSummary: {
            actionCounts,
            cashFallbackValues: Array.from(cashFallbackValues).sort(),
            uncostedShareRows,
            rejectedRows: Array.from(rejectedRowCounts.entries()).map(
              ([reason, count]) => ({ reason, count }),
            ),
          },
        }
      : {}),
  };
}
