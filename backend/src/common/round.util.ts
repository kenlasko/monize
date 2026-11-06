/**
 * The largest one-ULP nudge, in units of the last place, that `roundToDecimals`
 * applies. A nudge recovers a midpoint lost to IEEE 754 multiplication, but a
 * value whose true digits sit just under a midpoint rounds high once the nudge
 * is a sizeable fraction of a unit (at 8 places, between about 1e6 and 4.5e6 a
 * 0.05 to 0.1 unit nudge carried `3422512.090132934` to `...94`). A hundredth
 * of a unit is far below any digit a stored amount carries past its last
 * place, so the nudge is only ever a tiebreak; past it the exact string path
 * takes over.
 */
const NUDGE_LIMIT_UNITS = 0.01;

/**
 * Round a number to the specified decimal places using "round half away
 * from zero" (standard financial rounding).
 *
 * Uses string-based decimal shifting instead of multiplication to avoid
 * IEEE 754 midpoint errors. JavaScript's number-to-string conversion
 * produces the shortest decimal that round-trips to the same double,
 * recovering the intended value (e.g., 159.735 not 159.73499...).
 * Shifting via string concatenation ('e+N') sidesteps the floating-point
 * error that direct multiplication would introduce.
 *
 * An additional one-ULP nudge (Number.EPSILON * abs) is applied before
 * rounding to recover values that fell just below a midpoint due to
 * IEEE 754 multiplication error (e.g., 10 * 15.9735 = 159.73499... in
 * IEEE 754 but should round as 159.735 -> 159.74). The nudge is smaller
 * than any legitimate distance from a midpoint in financial arithmetic.
 *
 * The shift is performed via `toExponential()` (which always yields a
 * `d.ddde±N` form, parseable and exponent-shiftable) rather than `toString()`
 * concatenation. `toString()` switches to exponential notation for magnitudes
 * below 1e-6, producing un-parseable strings like "1e-7e4" that evaluate to
 * NaN; decomposing the exponential form avoids that for any decimalPlaces
 * (e.g. share quantities rounded at 8dp).
 *
 * Examples:
 *   roundToDecimals(159.735, 2)       => 159.74   (not 159.73)
 *   roundToDecimals(10 * 15.9735, 2)  => 159.74   (not 159.73)
 *   roundToDecimals(-159.735, 2)      => -159.74  (not -159.73)
 *   roundToDecimals(1.005, 2)         => 1.01     (not 1.00)
 *   roundToDecimals(1e-7, 8)          => 1e-7     (not NaN)
 *   roundToDecimals(21000000, 8)      => 21000000 (not 21000000.00000001)
 */
export function roundToDecimals(value: number, decimalPlaces: number): number {
  if (!isFinite(value)) return value;
  if (value === 0) return 0;
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  // Past this magnitude one ULP is a sizeable fraction of a unit at
  // `decimalPlaces` (at 8 places, from about 450 thousand): the nudge below
  // would push an exact value to the next unit (21000000 at 8 places came back
  // 21000000.00000001), round a value just under a midpoint high, and the
  // float shift no longer lands on an integer. Round the shortest decimal
  // string exactly instead; no fiat amount at 4 places reaches it below 4.5
  // billion, so those keep the path below.
  if (abs * 10 ** decimalPlaces * Number.EPSILON >= NUDGE_LIMIT_UNITS) {
    return Number(`${toScaledUnits(value, decimalPlaces)}e-${decimalPlaces}`);
  }
  const nudged = abs + Number.EPSILON * abs;
  // Decompose into mantissa/exponent so the decimal-point shift works
  // regardless of whether the value would stringify in exponential notation.
  const [mantissa, exp] = nudged.toExponential().split("e");
  const shiftedExp = Number(exp) + decimalPlaces;
  const rounded = Math.round(Number(mantissa + "e" + shiftedExp));
  return sign * Number(rounded + "e-" + decimalPlaces);
}

/**
 * The scale money columns are stored at in PostgreSQL (`NUMERIC(24,8)`; the
 * fiat-only shared-expense tables keep `NUMERIC(20,4)`), and so the most places any currency's money precision can be: a currency's
 * `decimal_places` is capped here (`docs/specs/money-precision.md` decision 2).
 */
export const MONEY_SCALE = 8;

/**
 * The places a fiat amount is rounded and summed at: four, more than any fiat
 * currency subdivides, so the sub-cent result of an FX conversion survives.
 * Every fiat path rounds here exactly as it did when the columns were
 * `NUMERIC(20,4)`; only a currency with more than four places of its own (a
 * coin) rounds finer, through `moneyDecimalsFor`.
 */
export const FIAT_MONEY_DECIMALS = 4;

/**
 * @deprecated The fiat precision under its old name, kept so untouched fiat
 * callers compile unchanged. A new caller on an account-currency path passes
 * `moneyDecimalsFor(currency.decimalPlaces)`; a fiat-only or
 * reporting-currency caller names `FIAT_MONEY_DECIMALS`.
 */
export const MONEY_DECIMALS = FIAT_MONEY_DECIMALS;

/**
 * The money precision of a currency with `decimalPlaces` places: never fewer
 * than `FIAT_MONEY_DECIMALS` (a fiat currency keeps the four it has always been
 * stored at), never more than `MONEY_SCALE` (the column scale). A missing value
 * reads as the column default, 2. This is the one spelling of the rule
 * (`docs/specs/money-precision.md` decision 2); nothing re-spells the `max`.
 */
export function moneyDecimalsFor(
  decimalPlaces: number | null | undefined,
): number {
  return Math.max(
    FIAT_MONEY_DECIMALS,
    Math.min(MONEY_SCALE, decimalPlaces ?? 2),
  );
}

/**
 * Round a monetary value to `decimals` places, four by default (the fiat
 * precision). An account-currency caller passes
 * `moneyDecimalsFor(currency.decimalPlaces)`.
 *
 * This is the single helper every service should use for money rounding,
 * replacing the various ad-hoc `Math.round(x * 100) / 100` (2dp) and
 * `Math.round(x * 10000) / 10000` (4dp) snippets that previously diverged
 * across the codebase. Built on `roundToDecimals`, so it also fixes the
 * IEEE 754 midpoint errors those naive snippets had.
 */
export function roundMoney(
  value: number,
  decimals: number = FIAT_MONEY_DECIMALS,
): number {
  return roundToDecimals(value, decimals);
}

/**
 * Parse a money value coming from a money-column SQL aggregate (a string,
 * number, null, or undefined) into a number rounded at `decimals` places, four
 * by default. Standardizes the mix of `parseFloat(row.x) || 0` and
 * `Number(row.x)` across report aggregation code: `Number` rejects trailing
 * garbage that `parseFloat` would silently accept, the `|| 0` equivalent maps
 * null/NaN to 0. A stored value already at that precision is unchanged
 * numerically (`5420.50000000` reads as `5420.5`).
 */
export function toMoneyNumber(
  value: unknown,
  decimals: number = FIAT_MONEY_DECIMALS,
): number {
  const n = Number(value);
  return isFinite(n) ? roundMoney(n, decimals) : 0;
}

/**
 * `value` rounded at `decimals` places (half away from zero), as an exact
 * integer count of `10^-decimals` units. The shift and the rounding are done on
 * the shortest decimal string that round-trips to the double (its
 * `toExponential()` form, which never switches notation), never by a float
 * multiply: `20999999.99999999 * 1e8` is not an integer in doubles, and
 * `roundToDecimals`' one-ULP nudge is larger than a unit at eight places once
 * a value passes about 90 million.
 */
function toScaledUnits(value: number, decimals: number): bigint {
  if (value === 0) return 0n;
  const [mantissa, exponent] = value.toExponential().split("e");
  const negative = mantissa.startsWith("-");
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const [whole, fraction = ""] = unsigned.split(".");
  const shift = Number(exponent) - fraction.length + decimals;
  let units = BigInt(whole + fraction);
  if (shift >= 0) {
    units *= 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    units = (units * 2n + divisor) / (divisor * 2n);
  }
  return negative ? -units : units;
}

/**
 * Sum an array of monetary values exactly at `decimals` places (four by
 * default, the fiat precision): each value is rounded at that precision (half
 * away from zero, on its shortest decimal string) and accumulated as a
 * `BigInt` count of `10^-decimals` units, then divided once.
 *
 * Integer units in doubles overflow 2^53 at eight places for totals above
 * about 90 million, so the accumulator is a `BigInt`, never a number
 * (`docs/specs/money-precision.md` decision 4). Prefer this over
 * `values.reduce((s, v) => s + v, 0)` for money: naive float accumulation lets
 * sub-cent errors compound across many rows. Non-finite entries
 * (NaN/Infinity) contribute 0.
 *
 * Examples:
 *   sumMoney([0.1, 0.2])                              => 0.3
 *   sumMoney([10.0001, 20.0002])                      => 30.0003
 *   sumMoney([20999999.99999999, 0.00000001], 8)      => 21000000
 */
export function sumMoney(
  values: number[],
  decimals: number = FIAT_MONEY_DECIMALS,
): number {
  let totalUnits = 0n;
  for (const value of values) {
    if (!isFinite(value)) continue;
    totalUnits += toScaledUnits(value, decimals);
  }
  return Number(`${totalUnits}e-${decimals}`);
}
