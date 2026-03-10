/**
 * CSV Parser for transaction import
 *
 * Parses CSV files into the same QifParseResult format used by the QIF parser,
 * allowing the import pipeline to handle both formats uniformly.
 *
 * Supports RFC 4180 compliant CSV parsing including quoted fields with
 * embedded delimiters, newlines, and escaped double-quotes.
 */

import type { QifTransaction, QifParseResult, DateFormat } from "./qif-parser";

export interface CsvHeadersResult {
  headers: string[];
  sampleRows: string[][];
  rowCount: number;
}

export interface CsvColumnMappingConfig {
  date: number;
  amount?: number;
  debit?: number;
  credit?: number;
  payee?: number;
  category?: number;
  memo?: number;
  referenceNumber?: number;
  dateFormat: string;
  reverseSign?: boolean;
  hasHeader: boolean;
  delimiter: string;
}

export interface CsvTransferRule {
  type: "payee" | "category";
  pattern: string;
  accountName: string;
}

// Field length limits matching database column constraints (same as qif-parser)
const FIELD_LIMITS = {
  PAYEE: 255,
  MEMO: 5000,
  REFERENCE_NUMBER: 100,
  CATEGORY: 255,
} as const;

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
 */
function parseCsvRows(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];

    if (inQuotes) {
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
        rows.push(currentRow);
      }
      currentRow = [];
      i++;
      continue;
    }

    if (char === "\n") {
      // End of row
      currentRow.push(currentField.trim());
      currentField = "";
      if (currentRow.some((f) => f !== "")) {
        rows.push(currentRow);
      }
      currentRow = [];
      i++;
      continue;
    }

    currentField += char;
    i++;
  }

  // Handle last field/row if file doesn't end with newline
  if (currentField !== "" || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some((f) => f !== "")) {
      rows.push(currentRow);
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
]);

/**
 * Validate that year, month, day values are within reasonable ranges.
 * Returns the YYYY-MM-DD string or null if invalid.
 */
function validateAndFormat(
  year: string,
  month: string,
  day: string,
): string | null {
  const y = parseInt(year);
  const m = parseInt(month);
  const d = parseInt(day);
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) {
    return null;
  }
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
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
 * Supported tokens: YYYY, YY, MM, DD (case-sensitive).
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
      regex += format[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  regex += "$";

  const match = dateStr.match(new RegExp(regex));
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
      case "day":
        day = val;
        break;
    }
  }

  if (!year || !month || !day) return null;
  return validateAndFormat(year, month, day);
}

/**
 * Parse a date string using the specified format and return YYYY-MM-DD.
 * Accepts the 4 well-known formats (with any of - / . as separator)
 * or a custom pattern string using YYYY/YY, MM, DD tokens.
 * Returns null if the date cannot be parsed or is invalid.
 */
function parseCsvDate(dateStr: string, format: string): string | null {
  const trimmed = dateStr.trim();
  if (!trimmed) {
    return null;
  }

  // For custom (non-built-in) format patterns, use the generic parser
  if (!KNOWN_FORMATS.has(format)) {
    return parseDateCustom(trimmed, format);
  }

  let year: string;
  let month: string;
  let day: string;

  if (format === "YYYY-MM-DD" || format === "YYYY-DD-MM") {
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
 * Handles currency symbols, commas, spaces, and parentheses-as-negative notation.
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
  // Strip commas used as thousands separators
  cleaned = cleaned.replace(/,/g, "");

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
    return { headers: [], sampleRows: [], rowCount: 0 };
  }

  const headers = rows[0];
  const dataRows = rows.slice(1);
  const sampleRows = dataRows.slice(0, 5);

  return {
    headers,
    sampleRows,
    rowCount: dataRows.length,
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
  const rows = parseCsvRows(content, config.delimiter);

  if (rows.length === 0) {
    return {
      accountType: "CHEQUING",
      accountName: "",
      transactions: [],
      categories: [],
      transferAccounts: [],
      securities: [],
      detectedDateFormat: config.dateFormat,
      sampleDates: [],
      openingBalance: null,
      openingBalanceDate: null,
    };
  }

  // Determine data rows (skip header if configured)
  const dataRows = config.hasHeader ? rows.slice(1) : rows;

  const transactions: QifTransaction[] = [];
  const categoriesSet = new Set<string>();
  const transferAccountsSet = new Set<string>();
  const rawDates: string[] = [];
  const rules = transferRules || [];

  for (const row of dataRows) {
    // Extract and parse the date
    const rawDate = getField(row, config.date);
    if (!rawDate) {
      continue;
    }

    const parsedDate = parseCsvDate(rawDate, config.dateFormat);
    if (!parsedDate) {
      // Skip rows with unparseable dates
      continue;
    }

    rawDates.push(rawDate);

    // Extract and parse the amount
    let amount = 0;
    if (config.amount !== undefined) {
      amount = parseCsvAmount(getField(row, config.amount)) ?? 0;
      if (config.reverseSign) {
        amount = -amount;
      }
    } else if (config.debit !== undefined || config.credit !== undefined) {
      const creditVal =
        config.credit !== undefined
          ? (parseCsvAmount(getField(row, config.credit)) ?? 0)
          : 0;

      let debitVal =
        config.debit !== undefined
          ? (parseCsvAmount(getField(row, config.debit)) ?? 0)
          : 0;

      // Strip sign from debit and negate -- debit is always an outflow
      debitVal = -Math.abs(debitVal);

      amount = creditVal !== 0 ? Math.abs(creditVal) : debitVal;
    }

    // Extract text fields with sanitization
    const rawPayee = truncate(getField(row, config.payee), FIELD_LIMITS.PAYEE);
    const payee = isAllCaps(rawPayee) ? toProperCase(rawPayee) : rawPayee;
    let category = truncate(
      getField(row, config.category),
      FIELD_LIMITS.CATEGORY,
    );
    const memo = truncate(getField(row, config.memo), FIELD_LIMITS.MEMO);
    const referenceNumber = truncate(
      getField(row, config.referenceNumber),
      FIELD_LIMITS.REFERENCE_NUMBER,
    );

    // Transfer detection
    let isTransfer = false;
    let transferAccount = "";

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
      cleared: false,
      reconciled: false,
      category,
      isTransfer,
      transferAccount,
      splits: [],
      security: "",
      action: "",
      price: 0,
      quantity: 0,
      commission: 0,
    };

    transactions.push(transaction);
  }

  // Sample dates: first 3 unique raw date strings
  const sampleDates = [...new Set(rawDates)].slice(0, 3);

  return {
    accountType: "CHEQUING",
    accountName: "",
    transactions,
    categories: Array.from(categoriesSet).sort(),
    transferAccounts: Array.from(transferAccountsSet).sort(),
    securities: [],
    detectedDateFormat: config.dateFormat,
    sampleDates,
    openingBalance: null,
    openingBalanceDate: null,
  };
}
