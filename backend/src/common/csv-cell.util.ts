const NUMERIC_CSV_VALUE =
  /^[+-]?[\p{Nd}\p{Sc}\s.,'’]*\p{Nd}[\p{Nd}\p{Sc}\s.,'’]*%?$/u;

/** Shared spreadsheet-safe CSV text cell. Amounts remain ordinary numbers. */
export function escapeCsvCell(value: string): string {
  // Guard against CSV formula injection: prefix with single quote if the
  // value starts with a character that spreadsheets interpret as a formula.
  // Coerce to string defensively: this method receives values that may
  // originate from HTTP query params where duplicated keys parse to arrays
  // (CWE-843); String() normalizes any non-string into a safe scalar before
  // applying string-only sanitization.
  let safe = typeof value === "string" ? value : String(value);
  if (/^[=+\-@\t\r]/.test(safe) && !NUMERIC_CSV_VALUE.test(safe)) {
    safe = `'${safe}`;
  }

  if (
    safe.includes(",") ||
    safe.includes('"') ||
    safe.includes("\n") ||
    safe.includes("\r")
  ) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}
