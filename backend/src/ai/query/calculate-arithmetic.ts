/**
 * Exact decimal arithmetic for the `calculate` tool (Discussion #2136).
 *
 * The tool answers with the number itself, not a display of it: a model reuses
 * `result` in the next call, so rounding it (it was once cut to 2 places, after
 * `sumMoney` had already cut every input to 4) changed the answer of a later
 * step. `formattedResult` is where display rounding belongs.
 *
 * Each input is read as the decimal its shortest round-trip string spells
 * (`0.1` is one tenth, not the binary double nearest it) and held as a `BigInt`
 * count of `10^-scale` units, so a sum or a difference is exact and becomes a
 * double once, at the end: `0.1 + 0.2` is `0.3`, and `0.00246 + 0.00246` is
 * `0.00492`, the same as `0.00492 - 0`. A quotient (ratio, percentage,
 * average) does not terminate in general; it is worked out to
 * `QUOTIENT_DIGITS` significant digits, more than a double holds, and parsed
 * once, so `0.07 / 0.1` is `0.7` and not the `0.7000000000000001` a float
 * division answers.
 */

/** Significant digits a quotient is carried to before it becomes a double. */
const QUOTIENT_DIGITS = 21;

/** `units * 10^-scale`, exactly. */
interface ExactDecimal {
  units: bigint;
  scale: number;
}

/** The decimal `value`'s shortest round-trip string spells, exactly. */
function toExactDecimal(value: number): ExactDecimal {
  const [mantissa, exponent] = value.toExponential().split("e");
  const negative = mantissa.startsWith("-");
  const [whole, fraction = ""] = (
    negative ? mantissa.slice(1) : mantissa
  ).split(".");
  const shift = Number(exponent) - fraction.length;
  const digits = BigInt(whole + fraction);
  const units = shift >= 0 ? digits * 10n ** BigInt(shift) : digits;
  return { units: negative ? -units : units, scale: Math.max(0, -shift) };
}

/** `decimal`'s units at a finer `scale` (never coarser). */
function rescale(decimal: ExactDecimal, scale: number): bigint {
  return decimal.units * 10n ** BigInt(scale - decimal.scale);
}

/** One double from `units * 10^-scale`; never `-0`. */
function toNumber(units: bigint, scale: number): number {
  if (units === 0n) return 0;
  return Number(`${units}e-${scale}`);
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** The exact sum of `decimals`, at the finest scale among them. */
function sumOf(decimals: readonly ExactDecimal[]): ExactDecimal {
  const scale = Math.max(0, ...decimals.map((d) => d.scale));
  const units = decimals.reduce((acc, d) => acc + rescale(d, scale), 0n);
  return { units, scale };
}

/**
 * `n / d * m` to `QUOTIENT_DIGITS` significant digits, as one double:
 * `(n.units * m.units * 10^d.scale) / (d.units * 10^(n.scale + m.scale))`.
 * The caller refuses a zero denominator first.
 */
function quotientOf(n: ExactDecimal, d: ExactDecimal, m: ExactDecimal): number {
  const top = n.units * m.units * 10n ** BigInt(d.scale);
  if (top === 0n) return 0;
  const negative = top < 0n !== d.units < 0n;
  const absTop = absBigInt(top);
  const absBottom = absBigInt(d.units);
  // Extra places so the truncated integer quotient keeps QUOTIENT_DIGITS
  // significant digits whatever the operands' magnitudes.
  const extra = Math.max(
    0,
    QUOTIENT_DIGITS + absBottom.toString().length - absTop.toString().length,
  );
  const quotient = (absTop * 10n ** BigInt(extra)) / absBottom;
  return toNumber(negative ? -quotient : quotient, n.scale + m.scale + extra);
}

/** The exact sum of `values`, as one double. */
export function exactSum(values: readonly number[]): number {
  const { units, scale } = sumOf(values.map(toExactDecimal));
  return toNumber(units, scale);
}

/** `a - b`, exactly, as one double. */
export function exactDifference(a: number, b: number): number {
  return exactSum([a, -b]);
}

/** `numerator / denominator * multiplier`; the caller refuses a zero divisor. */
export function exactQuotient(
  numerator: number,
  denominator: number,
  multiplier = 1,
): number {
  return quotientOf(
    toExactDecimal(numerator),
    toExactDecimal(denominator),
    toExactDecimal(multiplier),
  );
}

/** The arithmetic mean of `values`, from their exact (unconverted) sum. */
export function exactAverage(values: readonly number[]): number {
  return quotientOf(
    sumOf(values.map(toExactDecimal)),
    { units: BigInt(values.length), scale: 0 },
    { units: 1n, scale: 0 },
  );
}
