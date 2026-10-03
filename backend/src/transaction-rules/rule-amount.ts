/**
 * Parses a money amount as it is written in a bank statement line, Polish
 * format first (spec 3.5). Returns the MAGNITUDE in 1/10000 units as a safe
 * integer, or null; the sign of a split part is the parent row's. No floats:
 * the digits are read as text and scaled by string.
 *
 * - Whitespace (space, U+00A0, U+202F, U+2009) is removed: "1 234,56".
 * - The rest is digits with an optional `,` or `.` decimal separator and 1..4
 *   decimals: "1200,50", "1200.50", "450".
 * - "1.234,56" (dots as thousands separators) only in the strict
 *   `\d{1,3}(\.\d{3})+,\d{1,4}` shape.
 * - A sign, a currency, letters or anything else is null.
 */

const SPACES = new RegExp("[ \\u00A0\\u202F\\u2009]", "g");
const PLAIN = /^(\d+)(?:[.,](\d{1,4}))?$/;
const GROUPED = /^(\d{1,3}(?:\.\d{3})+),(\d{1,4})$/;
const SCALE_DIGITS = 4;

export function parseRuleAmount(text: string): number | null {
  if (typeof text !== "string") return null;
  const compact = text.replace(SPACES, "");
  const grouped = GROUPED.exec(compact);
  const plain = grouped ? null : PLAIN.exec(compact);
  const parts = grouped
    ? { whole: grouped[1].replace(/\./g, ""), fraction: grouped[2] }
    : plain
      ? { whole: plain[1], fraction: plain[2] ?? "" }
      : null;
  if (parts === null) return null;
  const scaled = Number(
    `${parts.whole}${parts.fraction.padEnd(SCALE_DIGITS, "0")}`,
  );
  return Number.isSafeInteger(scaled) ? scaled : null;
}
