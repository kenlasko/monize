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

/**
 * Filter input string to allow calculator expressions
 * Allows: digits, decimal point, minus, plus, multiply, divide, parentheses
 */
export function filterCalculatorInput(input: string): string {
  // Strip commas and filter to valid calculator characters
  return input.replace(/,/g, '').replace(/[^0-9.+\-*/()x×÷ ]/gi, '')
    // Normalize multiplication symbols
    .replace(/[x×]/gi, '*')
    // Normalize division symbol
    .replace(/÷/g, '/');
}

/**
 * Check if a string contains calculator operators
 */
export function hasCalculatorOperators(input: string): boolean {
  // Check for operators (excluding leading minus for negative numbers)
  const withoutLeadingMinus = input.replace(/^-/, '');
  return /[+\-*/()]/.test(withoutLeadingMinus);
}

/**
 * Safely evaluate a mathematical expression
 * Only allows basic arithmetic: +, -, *, /, and parentheses
 * Returns undefined if the expression is invalid
 */
export function evaluateExpression(input: string): number | undefined {
  // Normalize and clean the input
  const cleaned = input
    .replace(/,/g, '')
    .replace(/[x×]/gi, '*')
    .replace(/÷/g, '/')
    .replace(/\s+/g, '')
    .trim();

  if (!cleaned) return undefined;

  // Validate: only allow digits, operators, decimal points, and parentheses
  if (!/^[-+]?[\d.+\-*/()]+$/.test(cleaned)) {
    return undefined;
  }

  // Check for balanced parentheses
  let parenCount = 0;
  for (const char of cleaned) {
    if (char === '(') parenCount++;
    if (char === ')') parenCount--;
    if (parenCount < 0) return undefined;
  }
  if (parenCount !== 0) return undefined;

  // Check for invalid patterns
  if (/[+\-*/]{2,}/.test(cleaned.replace(/\(-/g, '(0-'))) {
    // Allow negative after open paren, but not consecutive operators
    return undefined;
  }

  try {
    // Use Function constructor for safe evaluation (no access to global scope)
    // This is safer than eval() as it creates an isolated scope
    const result = new Function(`"use strict"; return (${cleaned})`)();

    if (typeof result !== 'number' || !isFinite(result)) {
      return undefined;
    }

    return roundToCents(result);
  } catch {
    return undefined;
  }
}
