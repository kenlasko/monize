import { KmyCorruptFileError } from "./kmy-errors";

/**
 * Exact rational arithmetic over `bigint` for KMyMoney amounts (reference 3.1).
 * KMyMoney stores every amount as an arbitrary-precision fraction whose
 * numerator and denominator can exceed 2^53, so nothing here touches a float
 * until `toNumber`, which goes through an exact decimal string.
 */

/** `den > 0n` and `gcd(|num|, den) = 1`; build one with `rational`. */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

/** AlkValue::RoundingMethod (reference 3.1). */
export enum KmyRounding {
  Never = 0,
  Floor = 1,
  Ceil = 2,
  Truncate = 3,
  Promote = 4,
  HalfDown = 5,
  HalfUp = 6,
  Round = 7,
}

export type ParsedKmyNumber =
  | { readonly kind: "value"; readonly value: Rational }
  | { readonly kind: "autoCalc" }
  | { readonly kind: "invalid" };

const AUTO_CALC_NUMERATOR = 9223372036854775807n;
const AUTO_CALC_DENOMINATOR = 100n;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

function babs(a: bigint): bigint {
  return a < 0n ? -a : a;
}

/** Canonicalises (lowest terms, positive denominator); `RangeError` on a zero denominator. */
export function rational(num: bigint, den: bigint = 1n): Rational {
  if (den === 0n) {
    throw new RangeError("Rational denominator must not be zero");
  }
  if (num === 0n) {
    return { num: 0n, den: 1n };
  }
  const sign = den < 0n ? -1n : 1n;
  const g = gcd(num, den);
  return { num: (num / g) * sign, den: babs(den) / g };
}

export const ZERO: Rational = { num: 0n, den: 1n };
export const ONE: Rational = { num: 1n, den: 1n };

const FRACTION_PATTERN = /^((\d+)\s+|-)?(\d+)\/(\d+)/;
const DECIMAL_PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Parses one amount attribute (spec 4.5). A zero denominator is a corrupt file
 * (`KmyCorruptFileError`); text that is neither a fraction nor a plain decimal
 * is `invalid` and the reader turns it into 0 with a warning.
 */
export function parseKmyNumber(text: string): ParsedKmyNumber {
  if (text === "") {
    return { kind: "value", value: ZERO };
  }
  const fraction = FRACTION_PATTERN.exec(text);
  if (fraction) {
    const [, lead, whole, numText, denText] = fraction;
    const num = BigInt(numText);
    const den = BigInt(denText);
    if (den === 0n) {
      throw new KmyCorruptFileError("a number has a zero denominator");
    }
    const unsigned = lead === undefined || lead === "-";
    if (
      unsigned &&
      num === AUTO_CALC_NUMERATOR &&
      den === AUTO_CALC_DENOMINATOR
    ) {
      return { kind: "autoCalc" };
    }
    if (lead === "-") {
      return { kind: "value", value: rational(-num, den) };
    }
    if (whole !== undefined) {
      return {
        kind: "value",
        value: rational(BigInt(whole) * den + num, den),
      };
    }
    return { kind: "value", value: rational(num, den) };
  }
  const decimal = DECIMAL_PATTERN.exec(text);
  if (decimal) {
    const [, minus, intPart, fracPart = ""] = decimal;
    const magnitude = rational(
      BigInt(intPart + fracPart),
      10n ** BigInt(fracPart.length),
    );
    return {
      kind: "value",
      value: minus ? neg(magnitude) : magnitude,
    };
  }
  return { kind: "invalid" };
}

export function add(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function neg(a: Rational): Rational {
  return a.num === 0n ? a : { num: -a.num, den: a.den };
}

export function sub(a: Rational, b: Rational): Rational {
  return add(a, neg(b));
}

export function mul(a: Rational, b: Rational): Rational {
  return rational(a.num * b.num, a.den * b.den);
}

/** `RangeError` when `b` is zero. */
export function div(a: Rational, b: Rational): Rational {
  if (b.num === 0n) {
    throw new RangeError("Division by a zero rational");
  }
  return rational(a.num * b.den, a.den * b.num);
}

export function abs(a: Rational): Rational {
  return a.num < 0n ? { num: -a.num, den: a.den } : a;
}

export function sign(a: Rational): -1 | 0 | 1 {
  return a.num < 0n ? -1 : a.num > 0n ? 1 : 0;
}

export function isZero(a: Rational): boolean {
  return a.num === 0n;
}

export function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sum(values: readonly Rational[]): Rational {
  let total = ZERO;
  for (const value of values) {
    total = add(total, value);
  }
  return total;
}

/**
 * Port of AlkValue::convertDenominator for a positive denominator: the
 * magnitude is rounded to a whole number of 1/den units by `method` and the
 * sign re-applied, so Floor moves a negative away from zero and Ceil a
 * positive one, HalfDown breaks ties toward zero, HalfUp away from it and
 * Round to the even neighbour. `Never` behaves as `Round` (spec 6.1).
 */
export function roundToDenominator(
  a: Rational,
  den: bigint,
  method: KmyRounding,
): Rational {
  if (den <= 0n) {
    throw new RangeError("Rounding denominator must be positive");
  }
  const negative = a.num < 0n;
  const scaledNum = babs(a.num) * den;
  let quotient = scaledNum / a.den;
  const remainder = scaledNum % a.den;
  if (remainder !== 0n) {
    const twice = remainder * 2n;
    let up: boolean;
    switch (method) {
      case KmyRounding.Floor:
        up = negative;
        break;
      case KmyRounding.Ceil:
        up = !negative;
        break;
      case KmyRounding.Truncate:
        up = false;
        break;
      case KmyRounding.Promote:
        up = true;
        break;
      case KmyRounding.HalfDown:
        up = twice > a.den;
        break;
      case KmyRounding.HalfUp:
        up = twice >= a.den;
        break;
      case KmyRounding.Never:
      case KmyRounding.Round:
      default:
        up = twice > a.den || (twice === a.den && quotient % 2n === 1n);
        break;
    }
    if (up) {
      quotient += 1n;
    }
  }
  return rational(negative ? -quotient : quotient, den);
}

/** Exact decimal at `places`, half away from zero; "-0" never produced. */
export function toDecimalString(a: Rational, places: number): string {
  if (!Number.isInteger(places) || places < 0) {
    throw new RangeError("places must be a non-negative integer");
  }
  const scale = 10n ** BigInt(places);
  const scaled = babs(a.num) * scale;
  let quotient = scaled / a.den;
  if ((scaled % a.den) * 2n >= a.den) {
    quotient += 1n;
  }
  const digits = quotient.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const fraction = places > 0 ? `.${digits.slice(digits.length - places)}` : "";
  const negative = a.num < 0n && quotient !== 0n;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/**
 * `a` as a `number` at `places`, or a refusal when its integer part has more
 * than the 16 digits the `NUMERIC(24,8)` and `NUMERIC(20,8)` columns store
 * (m3): such an amount cannot be imported as KMyMoney holds it.
 */
export function toNumber(a: Rational, places: number): number {
  const whole = (a.num < 0n ? -a.num : a.num) / a.den;
  if (whole >= COLUMN_INTEGER_LIMIT) {
    throw new KmyCorruptFileError("an amount is larger than Monize can store");
  }
  return Number(toDecimalString(a, places));
}

const COLUMN_INTEGER_LIMIT = 10n ** 16n;
