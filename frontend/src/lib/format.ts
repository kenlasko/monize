import { currencySymbolFor, decimalPlacesForCurrency } from './currency-decimals';
import { isKnownIsoCurrency } from './iso-currency';

/**
 * Get the narrow currency symbol for a given currency code (e.g., '$', '€', '£').
 * `currencySymbolFor` (`lib/currency-decimals.ts`): a registered non-ISO
 * currency's stored symbol (`₿`), else Intl's narrow symbol, which works for any
 * valid ISO 4217 code; '$' for a code Intl rejects.
 */
export function getCurrencySymbol(currencyCode: string): string {
  return currencySymbolFor(currencyCode, '$');
}

/**
 * Resolve the currency symbol to display for a currency row. Prefers an
 * explicit stored symbol when it holds a real value, and falls back to the
 * Intl-derived symbol for the code when the stored value is blank/whitespace
 * (or missing entirely). This keeps the currencies table consistent with the
 * rest of the app, which always derives symbols from the code, so the Symbol
 * column never renders empty.
 */
export function resolveCurrencySymbol(
  storedSymbol: string | null | undefined,
  currencyCode: string,
): string {
  const trimmed = storedSymbol?.trim();
  return trimmed || getCurrencySymbol(currencyCode);
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
 * The number of decimal places for a currency code: for a code Intl does not
 * know, the reader's own currency row (`lib/currency-decimals.ts`, so a coin
 * stored with eight places gets eight); otherwise Intl.NumberFormat (USD=2,
 * JPY=0, BHD=3); then 2.
 */
export function getDecimalPlacesForCurrency(currencyCode: string): number {
  const registered = decimalPlacesForCurrency(currencyCode);
  if (registered !== undefined) return registered;
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
 * The largest one-ULP nudge, in units of the last place, `roundToDecimals`
 * applies: below a hundredth of a unit it can recover a midpoint lost to IEEE
 * 754 multiplication but never carry an exact value, or one just under a
 * midpoint, into the next unit. Mirrors the backend's `NUDGE_LIMIT_UNITS`.
 */
const NUDGE_LIMIT_UNITS = 0.01;

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
  // Past this magnitude one ULP is a sizeable fraction of a unit at
  // `decimalPlaces` (at eight places, from about 450 thousand): the nudge below
  // would push an exact value into the next unit (21000000 at eight places came
  // back 21000000.00000001). Round the shortest decimal string exactly instead,
  // as the backend `roundToDecimals` does; no fiat amount at four places
  // reaches it below 4.5 billion, so those keep the path below.
  if (
    Number.isInteger(decimalPlaces) &&
    decimalPlaces >= 0 &&
    abs * 10 ** decimalPlaces * Number.EPSILON >= NUDGE_LIMIT_UNITS
  ) {
    return fromMoneyUnits(toMoneyUnits(value, decimalPlaces), decimalPlaces);
  }
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
  if (!currencyCode || currencyCode === defaultCurrency) return formatted;
  // `Intl` writes a code it does not know (a coin with no registered symbol)
  // as the code itself, "BTC 0.01"; appending it again read "BTC 0.01 BTC".
  // Limited to non-ISO codes so no fiat figure changes.
  if (!isKnownIsoCurrency(currencyCode) && containsCodeToken(formatted, currencyCode)) {
    return formatted;
  }
  return `${formatted} ${currencyCode}`;
}

/**
 * Whether `text` holds `code` as a whole token: not inside a longer run of
 * letters, so "BTC 0.01" and "0,01 BTC" hold BTC and "WBTC 1" does not.
 */
function containsCodeToken(text: string, code: string): boolean {
  const upper = code.trim().toUpperCase();
  let from = 0;
  for (;;) {
    const at = text.indexOf(upper, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : text[at - 1];
    const after = text[at + upper.length] ?? '';
    if (!/\p{L}/u.test(before) && !/\p{L}/u.test(after)) return true;
    from = at + 1;
  }
}

/**
 * Round a number to 2 decimal places (cents)
 */
export function roundToCents(value: number): number {
  return roundToDecimals(value, 2);
}

/**
 * The places an amount in `currencyCode` is entered and rounded in: a
 * registered non-ISO currency's stored places (`lib/currency-decimals.ts`,
 * eight for a BTC row); a non-ISO code the registry does not hold yet
 * (`awaitsRegisteredPlaces`: `GET /currencies` has not answered, or failed) at
 * the column scale (`MONEY_SCALE`, eight), so a coin typed before the list
 * arrives loses nothing; otherwise two, so every fiat surface keeps the cents
 * it has always used. Unlike `getDecimalPlacesForCurrency` it does not ask
 * `Intl`, so a JPY or BHD amount is not re-rounded by this.
 */
export function entryDecimalPlaces(currencyCode: string | null | undefined): number {
  const registered = decimalPlacesForCurrency(currencyCode);
  if (registered !== undefined) return registered;
  return awaitsRegisteredPlaces(currencyCode) ? MONEY_SCALE : 2;
}

/**
 * The money precision of an amount in `currencyCode`:
 * `moneyDecimalsFor(entryDecimalPlaces(currencyCode))`. Four for every fiat
 * code (the stored four it has always rounded at), a registered coin's own
 * places from four to eight, and eight for a coin the registry does not hold
 * yet. The precision to pass `roundMoney` and `sumMoney` on an amount in an
 * account's currency.
 */
export function moneyDecimalsForCurrency(currencyCode: string | null | undefined): number {
  return moneyDecimalsFor(entryDecimalPlaces(currencyCode));
}

/**
 * Round an amount in `currencyCode` to the places it is entered in
 * (`entryDecimalPlaces`): a BTC amount of 0.0051 stays 0.0051 where cents
 * posted 0.01, and a fiat amount rounds exactly as `roundToCents` did.
 * `roundToCents` is for a figure that can only be fiat; an amount in an
 * account's currency goes through this with that account's code.
 */
export function roundToEntryPlaces(
  value: number,
  currencyCode: string | null | undefined,
): number {
  return roundToDecimals(value, entryDecimalPlaces(currencyCode));
}

/**
 * Whether `currencyCode` is a non-ISO code (a coin) whose places the currency
 * decimals registry does not hold yet: `GET /currencies` has not answered, so
 * neither the registry nor `Intl` knows them and two would be a guess.
 */
export function awaitsRegisteredPlaces(currencyCode: string | null | undefined): boolean {
  return (
    !!currencyCode &&
    decimalPlacesForCurrency(currencyCode) === undefined &&
    !isKnownIsoCurrency(currencyCode)
  );
}

/**
 * A stored amount as a form or dialog loads it into its field: at its
 * currency's entry places (`roundToEntryPlaces`), cents for a fiat code and a
 * coin's registered places. A coin the registry does not hold yet
 * (`awaitsRegisteredPlaces`) is kept at the column scale (`MONEY_SCALE`, eight)
 * rather than rounded at an assumed two, so an unedited save sends back the
 * stored 0.00002500, not 0.00; the input redraws it at the coin's places once
 * the registry fills, and `CurrencyInput` does not report its display back as
 * an edit.
 */
export function loadedEntryAmount(
  value: number,
  currencyCode: string | null | undefined,
): number {
  return awaitsRegisteredPlaces(currencyCode)
    ? roundMoney(value, MONEY_SCALE)
    : roundToEntryPlaces(value, currencyCode);
}

/**
 * The scale every money column is stored at: `NUMERIC(24,8)`. The widest
 * precision a currency's money may use (`moneyDecimalsFor` never exceeds it),
 * and the precision a coin the registry does not hold yet is entered at.
 */
export const MONEY_SCALE = 8;

/**
 * The precision fiat money is rounded at: four places, as it has always been
 * stored (sub-cent FX results included), whatever the currency's own minor
 * unit. The default of `roundMoney` and `sumMoney`, and the precision of every
 * figure whose currency is fiat by construction (a reporting-currency total, a
 * loan, a budget, an investment figure).
 */
export const FIAT_MONEY_DECIMALS = 4;

/**
 * @deprecated The fiat precision under its old name; use `FIAT_MONEY_DECIMALS`
 * for a fiat-only figure and `moneyDecimalsFor` / `moneyDecimalsForCurrency`
 * for an amount in an account's currency. Kept so untouched fiat callers
 * compile unchanged.
 */
export const MONEY_DECIMALS = FIAT_MONEY_DECIMALS;

/**
 * The money precision of a currency with `decimalPlaces` places:
 * `max(FIAT_MONEY_DECIMALS, min(MONEY_SCALE, decimalPlaces ?? 2))`. Every fiat
 * currency (0 to 3 places) keeps four; a coin with eight is rounded at eight,
 * one with six at six. Mirrors the backend `moneyDecimalsFor`
 * (`backend/src/common/round.util.ts`); nothing re-spells the `max`.
 */
export function moneyDecimalsFor(decimalPlaces: number | null | undefined): number {
  return Math.max(FIAT_MONEY_DECIMALS, Math.min(MONEY_SCALE, decimalPlaces ?? 2));
}

/**
 * Round a monetary value to its money precision: `decimals` places, four
 * (`FIAT_MONEY_DECIMALS`) by default, the scale a fiat total and balance are
 * rounded at. An amount in an account's currency passes that currency's
 * precision (`moneyDecimalsForCurrency(code)`), so a coin keeps its eight.
 * Mirrors the backend `roundMoney` (`backend/src/common/round.util.ts`),
 * strategy included, so a figure the client previews rounds on the boundary
 * the way the server will commit it.
 */
export function roundMoney(value: number, decimals: number = FIAT_MONEY_DECIMALS): number {
  return roundToDecimals(value, decimals);
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
 * A finite number as an integer count of `10^-decimals` units, rounded half
 * away from zero. The shift is decimal, on the shortest string that
 * round-trips to the double (`String(value)`, exponent form included), never a
 * float multiply: `Math.round(v * 1e8)` is inexact for amounts above about 90
 * million, where the product passes 2^53.
 */
export function toMoneyUnits(value: number, decimals: number): bigint {
  const text = String(value);
  const negative = text.startsWith('-');
  const [mantissa, exponentText] = (negative ? text.slice(1) : text).split('e');
  const [intDigits, fracDigits = ''] = mantissa.split('.');
  const digits = intDigits + fracDigits;
  // Where the decimal point falls in `digits` once shifted left by `decimals`.
  const point = intDigits.length + Number(exponentText ?? 0) + decimals;
  let whole: string;
  let rest: string;
  if (point <= 0) {
    whole = '0';
    rest = '0'.repeat(-point) + digits;
  } else if (point >= digits.length) {
    whole = digits + '0'.repeat(point - digits.length);
    rest = '';
  } else {
    whole = digits.slice(0, point);
    rest = digits.slice(point);
  }
  const units = BigInt(whole) + (rest !== '' && rest[0] >= '5' ? BigInt(1) : BigInt(0));
  return negative ? -units : units;
}

/**
 * An integer count of `10^-decimals` units back as a number, divided once.
 * With `toMoneyUnits`, the pair a running total (a register's balance walk)
 * accumulates in, so it is exact at a coin's eight places as `sumMoney` is.
 */
export function fromMoneyUnits(units: bigint, decimals: number): number {
  const negative = units < BigInt(0);
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0');
  const point = digits.length - decimals;
  const result = Number(
    `${negative ? '-' : ''}${digits.slice(0, point)}${decimals > 0 ? `.${digits.slice(point)}` : ''}`,
  );
  return result === 0 ? 0 : result;
}

/**
 * Sum money values exactly at `decimals` places, four (`FIAT_MONEY_DECIMALS`)
 * by default: each value is rounded to an integer count of units from its
 * decimal string and the counts are summed in `BigInt`, then divided back once.
 * No IEEE 754 accumulation drift, and no overflow of 2^53 at eight places
 * (`sumMoney([20999999.99999999, 0.00000001], 8)` is exactly 21000000). An
 * amount in an account's currency passes that currency's precision
 * (`moneyDecimalsForCurrency(code)`). Mirrors the backend `sumMoney` so
 * client-side totals reconcile to the same units as the server. A non-finite
 * value makes the sum non-finite (NaN, or the infinity), as a float sum would.
 */
export function sumMoney(
  values: readonly number[],
  decimals: number = FIAT_MONEY_DECIMALS,
): number {
  let total = BigInt(0);
  let nonFinite: number | undefined;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      nonFinite = (nonFinite ?? 0) + value;
      continue;
    }
    total += toMoneyUnits(value, decimals);
  }
  return nonFinite !== undefined ? nonFinite : fromMoneyUnits(total, decimals);
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
