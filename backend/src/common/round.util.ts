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
 * Examples:
 *   roundToDecimals(159.735, 2)       => 159.74   (not 159.73)
 *   roundToDecimals(10 * 15.9735, 2)  => 159.74   (not 159.73)
 *   roundToDecimals(-159.735, 2)      => -159.74  (not -159.73)
 *   roundToDecimals(1.005, 2)         => 1.01     (not 1.00)
 */
export function roundToDecimals(
  value: number,
  decimalPlaces: number,
): number {
  if (!isFinite(value)) return value;
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const nudged = abs + Number.EPSILON * abs;
  return (
    sign *
    Number(
      Math.round(Number(nudged + 'e' + decimalPlaces)) +
        'e-' +
        decimalPlaces,
    )
  );
}
