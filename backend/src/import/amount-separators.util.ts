/**
 * True when the text is nothing but a number once normalised: an optional
 * sign, digits and at most one decimal point ("1234.5", "-.5"). A QIF or OFX
 * amount that fails it is unreadable, never the number its first digits make.
 */
export function isPlainAmount(value: string): boolean {
  return /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(value);
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
    return value.lastIndexOf(",") > value.lastIndexOf(".")
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
    return value.replace(/,/g, "");
  }
  if (dotCount > 1) {
    return value.replace(/\./g, "");
  }
  return value;
}

function countOf(value: string, separator: string): number {
  return value.split(separator).length - 1;
}
