/**
 * Format a number as currency with the specified currency code
 */
export function formatCurrency(amount: number, currencyCode: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Round a number to 2 decimal places (cents)
 * Uses multiply-round-divide to avoid floating point errors
 */
export function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Format a number to exactly 2 decimal places for display in inputs
 */
export function formatAmount(value: number | undefined | null): string {
  if (value === undefined || value === null || isNaN(value)) {
    return '';
  }
  return roundToCents(value).toFixed(2);
}

/**
 * Format a number to exactly 2 decimal places with comma thousands separators
 * Used for display when input is not focused
 */
export function formatAmountWithCommas(value: number | undefined | null): string {
  if (value === undefined || value === null || isNaN(value)) {
    return '';
  }
  const rounded = roundToCents(value);
  // Use Intl.NumberFormat for proper comma formatting
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rounded);
}

/**
 * Parse a string input value to a number, filtering out non-numeric characters
 * Allows: digits, decimal point, minus sign
 * Returns undefined if the result is not a valid number
 */
export function parseAmount(input: string): number | undefined {
  // Filter to only valid characters
  const filtered = input.replace(/[^0-9.-]/g, '');
  if (filtered === '' || filtered === '-' || filtered === '.') {
    return undefined;
  }
  const parsed = parseFloat(filtered);
  if (isNaN(parsed)) {
    return undefined;
  }
  return roundToCents(parsed);
}

/**
 * Filter input string to only allow valid currency input characters
 * Preserves the user's typing while removing invalid characters
 * Strips commas (they're only for display, not editing)
 */
export function filterCurrencyInput(input: string): string {
  // First strip commas, then filter to valid characters
  return input.replace(/,/g, '').replace(/[^0-9.-]/g, '');
}
