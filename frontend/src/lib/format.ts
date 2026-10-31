/**
 * Get the narrow currency symbol for a given currency code (e.g., '$', '€', '£').
 * Uses Intl.NumberFormat so it works for any valid ISO 4217 currency code.
 */
export function getCurrencySymbol(currencyCode: string): string {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currencyCode,
      currencyDisplay: 'narrowSymbol',
    }).formatToParts(0).find(p => p.type === 'currency')?.value || '$';
  } catch {
    return '$';
  }
}

/**
 * Format a number as currency with the specified currency code.
 *
 * **Prefer `useNumberFormat()` for any user-facing render.** This pure
 * helper hardcodes the `en-US` locale and falls back to USD, so it ignores
 * the user's `numberFormat` / `defaultCurrency` preferences. Use it only
 * in non-React contexts (e.g., CSV exports, unit tests) where a hook is
 * unavailable.
 */
export function formatCurrency(amount: number, currencyCode: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    currencyDisplay: 'narrowSymbol',
  }).format(amount);
}

/**
 * Get the number of decimal places for a currency code using Intl.NumberFormat.
 * E.g., USD=2, JPY=0, BHD=3.
 */
export function getDecimalPlacesForCurrency(currencyCode: string): number {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currencyCode,
    }).resolvedOptions().minimumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * Scale a number by a power of ten using its string form, so the decimal
 * shift introduces no IEEE 754 multiplication error.
 *
 * `String(n)` is already in exponential notation for magnitudes below 1e-6
 * or at/above 1e21 (e.g. "6.25e-7"). Appending another "e<exp>" would build
 * a malformed literal like "6.25e-7e2" that `Number()` parses as NaN, which
 * is how a near-zero projected balance rendered as "$NaN". Splitting on the
 * existing exponent and adding to it keeps the shift valid across the whole
 * range.
 */
function shiftByPowerOfTen(value: number, exponent: number): number {
  if (value === 0) return 0;
  const [mantissa, exp] = value.toString().split('e');
  return Number(`${mantissa}e${exp ? Number(exp) + exponent : exponent}`);
}

/**
 * Round a number to the specified number of decimal places using
 * "round half away from zero" (standard financial rounding).
 *
 * Uses string-based decimal shifting instead of multiplication to avoid
 * IEEE 754 midpoint errors. JavaScript's number-to-string conversion
 * produces the shortest decimal that round-trips to the same double,
 * recovering the intended value (e.g., 159.735 not 159.73499...).
 *
 * An additional one-ULP nudge (Number.EPSILON * abs) is applied before
 * rounding to recover values that fell just below a midpoint due to
 * IEEE 754 multiplication error (e.g., 10 * 15.9735 = 159.73499... in
 * IEEE 754 but should round as 159.735 -> 159.74).
 */
export function roundToDecimals(value: number, decimalPlaces: number): number {
  if (!isFinite(value)) return value;
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const nudged = abs + Number.EPSILON * abs;
  const rounded = Math.round(shiftByPowerOfTen(nudged, decimalPlaces));
  const result = sign * shiftByPowerOfTen(rounded, -decimalPlaces);
  // sign * 0 produces -0 for tiny negative residuals; normalize to +0 so
  // callers and Object.is-based assertions see a plain zero.
  return result === 0 ? 0 : result;
}

/**
 * A formatted amount with its currency code appended, when that currency is not
 * the reader's own.
 *
 * A figure shown unconverted in an account's or a security's currency needs to
 * say so: a reader whose default is CAD has to be told that "$1,300" is not
 * their $1,300, and symbols do not carry that (`$` is four currencies and `kr`
 * is three). `formatted` comes from `useNumberFormat().formatCurrency`, so the
 * number itself still follows the reader's locale.
 */
export function withCurrencyCode(
  formatted: string,
  currencyCode: string,
  defaultCurrency: string,
): string {
  return currencyCode && currencyCode !== defaultCurrency
    ? `${formatted} ${currencyCode}`
    : formatted;
}

/**
 * Round a number to 2 decimal places (cents)
 */
export function roundToCents(value: number): number {
  return roundToDecimals(value, 2);
}

/**
 * Round a monetary value to its storage precision (4dp, `decimal(20,4)`), the
 * scale a total and a balance are stored at. Mirrors the backend `roundMoney`
 * (`backend/src/common/round.util.ts`), strategy included, so a figure the
 * client previews rounds on the boundary the way the server will commit it.
 */
export function roundMoney(value: number): number {
  return roundToDecimals(value, 4);
}

/**
 * Decimal places an exchange rate is *displayed* at.
 *
 * Rates are stored at ten (`NUMERIC(20,10)`), and every conversion multiplies
 * at that full precision. Six is what a bank statement quotes -- showing four
 * made a USD/CAD rate look rounder than the figure the conversion actually
 * used, and a four-figure amount reconciled a few cents off the statement.
 * Use this wherever a rate is rendered; never round the rate itself to it.
 */
export const FX_RATE_DISPLAY_DECIMALS = 6;

/**
 * Storage precision for an exchange rate: `NUMERIC(20,10)`.
 *
 * Deliberately not the money precision. `roundMoney(1 / 1.3652)` stored 0.7325,
 * which inverts back to 1.3661 -- cents off on a four-figure amount. And
 * deliberately not `FX_RATE_DISPLAY_DECIMALS` either: six is what a field shows,
 * so rounding a stored rate to it makes the persisted value disagree with the
 * quote it came from. Mirrors the backend `roundFxRate`.
 */
export const FX_RATE_DECIMALS = 10;

/** Round an exchange rate to its storage precision. Never `roundMoney` a rate. */
export function roundFxRate(rate: number): number {
  return roundToDecimals(rate, FX_RATE_DECIMALS);
}

/**
 * Sum money values without IEEE 754 accumulation drift by accumulating in
 * integer ten-thousandths (matching the backend `roundMoney` / decimal(20,4)
 * precision) and dividing back once at the end. Mirrors the backend `sumMoney`
 * helper so client-side totals reconcile to the same cents as the server.
 */
export function sumMoney(values: number[]): number {
  const totalUnits = values.reduce(
    (sum, value) => sum + Math.round(value * 10000),
    0,
  );
  return totalUnits / 10000;
}

/**
 * Pick how many fraction digits to show so a tiny non-zero value doesn't
 * collapse to "0.00". When the value already shows a non-zero figure at the
 * currency's natural precision (baseDigits), baseDigits is returned unchanged.
 * Otherwise the precision is expanded to reveal `significantDigits` significant
 * figures (e.g. 0.000342 -> 6 digits), capped at maxDigits.
 *
 * Used for sub-penny securities (e.g. LSE pennies quoted around 0.000318 GBP)
 * where rounding the price or daily change to 2 places would read as zero.
 */
export function adaptiveFractionDigits(
  value: number,
  baseDigits = 2,
  maxDigits = 6,
  significantDigits = 3,
): number {
  if (!isFinite(value) || value === 0) return baseDigits;
  const abs = Math.abs(value);
  // Already non-zero at the natural precision: leave it alone.
  if (roundToDecimals(abs, baseDigits) !== 0) return baseDigits;
  // floor(log10(abs)) is the exponent of the first significant digit
  // (negative for sub-1 values), e.g. 0.000342 -> -4.
  const firstSignificantExp = Math.floor(Math.log10(abs));
  const digits = -firstSignificantExp + (significantDigits - 1);
  // Cap at maxDigits, but never return fewer than the requested base precision
  // (guards a caller passing baseDigits > maxDigits).
  return Math.max(baseDigits, Math.min(maxDigits, digits));
}

interface FormatSignedPercentOptions {
  /** Number of decimal places to show (default 2). */
  decimals?: number;
  /**
   * When true the value is already a percentage (e.g. 12.5 = 12.5%) and is
   * used as-is. When false the value is a fraction (e.g. 0.125 = 12.5%) and is
   * multiplied by 100. Defaults to true since most call sites already work in
   * percentage units.
   */
  alreadyPercent?: boolean;
}

/**
 * Format a percentage with an explicit leading sign (e.g. "+12.50%",
 * "-3.40%", "0.00%"). Replaces the repeated
 * `${v >= 0 ? '+' : ''}${v.toFixed(n)}%` idiom across the report components.
 *
 * The magnitude is rendered with the user-locale-agnostic `en-US` grouping so
 * it matches the surrounding `toFixed` output it replaces. A leading "+" is
 * added for values >= 0; negatives keep their intrinsic minus sign. NaN and
 * non-finite inputs render as a sign-less "0.00%" so a broken datum never
 * shows "NaN%".
 */
export function formatSignedPercent(
  value: number,
  options: FormatSignedPercentOptions = {},
): string {
  const { decimals = 2, alreadyPercent = true } = options;
  const pct = alreadyPercent ? value : value * 100;
  if (!isFinite(pct)) {
    return `${(0).toFixed(decimals)}%`;
  }
  const rounded = roundToDecimals(pct, decimals);
  const sign = rounded >= 0 ? '+' : '';
  return `${sign}${rounded.toFixed(decimals)}%`;
}

/**
 * Tailwind text-colour classes for a gain/loss value: green when >= 0, red
 * when negative. Replaces the repeated
 * `value >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'`
 * ternary across the investment/report components.
 */
export function gainLossColor(value: number): string {
  return value >= 0
    ? 'text-green-600 dark:text-green-400'
    : 'text-red-600 dark:text-red-400';
}

/**
 * Tailwind text-colour classes for an account balance: neutral (the body text
 * colour) when >= 0, red when negative. The sign is the whole story -- a
 * balance is coloured by what it is, never by the account's type. A credit card
 * carrying a credit (positive) is not in the red, and a chequing account that is
 * overdrawn (negative) is, so branching on liability-vs-asset gets both wrong.
 * Unlike `gainLossColor`, a non-negative balance is not a gain and does not go
 * green -- most accounts are in credit most of the time, and colouring that
 * spends the emphasis on the ordinary case.
 */
export function balanceColor(value: number): string {
  return value < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100';
}

/**
 * Format a number to the specified decimal places for display in inputs.
 * Defaults to 2 decimal places.
 */
export function formatAmount(value: number | undefined | null, decimalPlaces: number = 2): string {
  if (value === undefined || value === null || isNaN(value)) {
    return '';
  }
  return roundToDecimals(value, decimalPlaces).toFixed(decimalPlaces);
}

/**
 * Format a share quantity at full precision (up to 8 decimal places) with
 * trailing zeros trimmed. Unlike the rounded quantity formatter, this keeps
 * tiny residual positions visible (e.g. 0.0003), which is essential for
 * tracking down errant share counts.
 */
export function formatShareQuantity(value: number | undefined | null): string {
  if (value === undefined || value === null || isNaN(value)) {
    return '0';
  }
  const fixed = value.toFixed(8);
  // Trim trailing zeros and a dangling decimal point.
  const trimmed = fixed.replace(/\.?0+$/, '');
  // Map empty (all zeros) and negative zero (a tiny negative residue that
  // rounds to zero, e.g. -4e-15) to a clean "0".
  if (trimmed === '' || trimmed === '-0') {
    return '0';
  }
  return trimmed;
}

/**
 * Format a number with comma thousands separators and the specified decimal places.
 * Defaults to 2 decimal places. Used for display when input is not focused.
 */
export function formatAmountWithCommas(value: number | undefined | null, decimalPlaces: number = 2): string {
  if (value === undefined || value === null || isNaN(value)) {
    return '';
  }
  const rounded = roundToDecimals(value, decimalPlaces);
  // Use Intl.NumberFormat for proper comma formatting
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
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
 * Recursive-descent parser for basic arithmetic expressions.
 * Supports +, -, *, /, unary minus, and parentheses.
 * Eliminates the need for new Function() / eval().
 */
class ExpressionParser {
  private pos = 0;
  private readonly expr: string;

  constructor(expr: string) {
    this.expr = expr;
  }

  parse(): number | undefined {
    try {
      const result = this.parseAddSub();
      if (this.pos < this.expr.length) return undefined;
      if (!isFinite(result)) return undefined;
      return result;
    } catch {
      return undefined;
    }
  }

  private parseAddSub(): number {
    let left = this.parseMulDiv();
    while (this.pos < this.expr.length) {
      const ch = this.expr[this.pos];
      if (ch === '+') { this.pos++; left = left + this.parseMulDiv(); }
      else if (ch === '-') { this.pos++; left = left - this.parseMulDiv(); }
      else break;
    }
    return left;
  }

  private parseMulDiv(): number {
    let left = this.parseUnary();
    while (this.pos < this.expr.length) {
      const ch = this.expr[this.pos];
      if (ch === '*') { this.pos++; left = left * this.parseUnary(); }
      else if (ch === '/') {
        this.pos++;
        const right = this.parseUnary();
        if (right === 0) throw new Error('Division by zero');
        left = left / right;
      }
      else break;
    }
    return left;
  }

  private parseUnary(): number {
    if (this.pos < this.expr.length && this.expr[this.pos] === '-') {
      this.pos++;
      return -this.parseUnary();
    }
    if (this.pos < this.expr.length && this.expr[this.pos] === '+') {
      this.pos++;
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    if (this.pos < this.expr.length && this.expr[this.pos] === '(') {
      this.pos++; // skip '('
      const result = this.parseAddSub();
      if (this.pos >= this.expr.length || this.expr[this.pos] !== ')') {
        throw new Error('Unmatched parenthesis');
      }
      this.pos++; // skip ')'
      return result;
    }
    return this.parseNumber();
  }

  private parseNumber(): number {
    const start = this.pos;
    while (this.pos < this.expr.length && (this.expr[this.pos] >= '0' && this.expr[this.pos] <= '9' || this.expr[this.pos] === '.')) {
      this.pos++;
    }
    if (this.pos === start) throw new Error('Expected number');
    return parseFloat(this.expr.substring(start, this.pos));
  }
}

/**
 * Safely evaluate a mathematical expression using a recursive-descent parser.
 * Only allows basic arithmetic: +, -, *, /, and parentheses.
 * Returns undefined if the expression is invalid.
 */
export function evaluateExpression(input: string, decimalPlaces = 2): number | undefined {
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

  const parser = new ExpressionParser(cleaned);
  const result = parser.parse();
  if (result === undefined) return undefined;

  return roundToDecimals(result, decimalPlaces);
}
