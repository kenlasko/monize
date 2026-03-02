/**
 * Format a number as currency with the correct decimal places for the given currency code.
 * Uses Intl.NumberFormat so JPY gets 0 decimals, USD/EUR get 2, BHD gets 3, etc.
 *
 * @returns Formatted string with currency symbol (e.g., "$1,234.56", "¥1,235")
 */
export function formatCurrency(
  amount: number,
  currencyCode: string,
): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
      currencyDisplay: "narrowSymbol",
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)}`;
  }
}

/**
 * Format a number with currency-aware decimal places but no currency symbol.
 * Useful for contexts where the symbol is shown separately.
 *
 * @returns Formatted string without symbol (e.g., "1,234.56", "1,235")
 */
export function formatCurrencyAmount(
  amount: number,
  currencyCode: string,
): string {
  const decimals = getDecimalPlacesForCurrency(currencyCode);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);
}

/**
 * Get the number of decimal places for a currency code using Intl.NumberFormat.
 * E.g., USD=2, JPY=0, BHD=3.
 */
export function getDecimalPlacesForCurrency(currencyCode: string): number {
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency: currencyCode,
      }).resolvedOptions().minimumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}
