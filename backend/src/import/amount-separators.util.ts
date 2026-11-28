/**
 * True when the text is nothing but a number once normalised: an optional
 * sign, digits and at most one decimal point ("1234.5", "-.5"). A QIF or OFX
 * amount that fails it is unreadable, never the number its first digits make.
 */
export function isPlainAmount(value: string): boolean {
  // The decimal part is one optional group so the digit runs cannot split
  // ambiguously (`\d+\.?\d*` backtracks polynomially on a long run of digits).
  return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value);
}

/**
 * Rewrite an imported amount's grouping and decimal separators to the
 * `parseFloat` form: grouping removed, decimal separator a dot. The input has
 * already had its currency symbols and whitespace stripped.
 *
 * The convention is inferred from the value itself, because neither the CSV
 * nor the QIF import is told which one the file uses:
 *
 *   - comma and dot both present: whichever appears last is the decimal
 *     separator ("1.234,56", "1,234.56");
 *   - only commas: one comma is a decimal comma ("18,36", "0,125") unless it
 *     groups a non-zero integer part into exactly three digits ("1,234"), and
 *     several commas are grouping ("1,234,567");
 *   - only dots: one dot is a decimal point ("1.234"), several are grouping
 *     ("1.234.567").
 *
 * The one ambiguous shape, a single separator followed by exactly three digits
 * on a non-zero integer part, keeps the US reading it had before the European
 * forms were recognised.
 */
export function normalizeAmountSeparators(value: string): string {
  const commaCount = countOf(value, ",");
  const dotCount = countOf(value, ".");

  if (commaCount > 0 && dotCount > 0) {
    const decimalIsComma = value.lastIndexOf(",") > value.lastIndexOf(".");
    const [integer, ...rest] = value.split(decimalIsComma ? "," : ".");
    // "1,2.3" or "1.2,3.4": a second decimal or a malformed group is no number.
    if (rest.length !== 1 || !isGrouped(integer, decimalIsComma ? "." : ",")) {
      return value;
    }
    return decimalIsComma
      ? value.replace(/\./g, "").replace(",", ".")
      : value.replace(/,/g, "");
  }
  if (commaCount === 1) {
    const commaAt = value.indexOf(",");
    const integerPart = value.slice(0, commaAt).replace(/^[-+]/, "");
    const digitsAfter = value.length - commaAt - 1;
    const isGrouping = digitsAfter === 3 && !/^0*$/.test(integerPart);
    return isGrouping ? value.replace(",", "") : value.replace(",", ".");
  }
  if (commaCount > 1) {
    return isGrouped(value, ",") ? value.replace(/,/g, "") : value;
  }
  if (dotCount > 1) {
    return isGrouped(value, ".") ? value.replace(/\./g, "") : value;
  }
  return value;
}

/**
 * Digit groups split by `separator` read as grouping only in the two shapes
 * people write: 1-3 digits then groups of 3 ("1,234,567"), or the lakh form,
 * 1-2 digits, groups of 2, a last group of 3 ("12,34,567"). "12.03.26" is a
 * date and "1,234,56" a typo, so both are left unread.
 */
function isGrouped(integer: string, separator: string): boolean {
  const [first, ...rest] = integer.replace(/^[-+]/, "").split(separator);
  const last = rest.pop();
  if (last === undefined || !/^\d{3}$/.test(last)) return false;
  return (
    (/^\d{1,3}$/.test(first) && rest.every((g) => /^\d{3}$/.test(g))) ||
    (/^\d{1,2}$/.test(first) && rest.every((g) => /^\d{2}$/.test(g)))
  );
}

function countOf(value: string, separator: string): number {
  return value.split(separator).length - 1;
}

/**
 * Read a QIF amount: a number with an optional currency marker before or after
 * it (any currency symbol, or a 1-4 letter token such as "zł", "kr", "Kč",
 * "CAD"), whitespace, and the grouping and decimal separators
 * `normalizeAmountSeparators` reads. Anything else ("abc", "1,2,3.4.5",
 * "12abc34") is null, never the number its first digits make. QIF takes fewer
 * forms than CSV: no trailing minus, parentheses or DR/CR markers.
 */
export function parseQifAmount(amountStr: string): number | null {
  const cleaned = normalizeAmountSeparators(
    amountStr
      .replace(/\p{Sc}|\s/gu, "")
      .replace(/^([-+]?)\p{L}{1,4}/u, "$1")
      .replace(/\p{L}{1,4}$/u, ""),
  );
  return isPlainAmount(cleaned) ? parseFloat(cleaned) : null;
}
