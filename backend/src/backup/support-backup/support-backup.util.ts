import { MONEY_SCALE } from "../../common/round.util";

/**
 * Primitive obfuscation operations shared by the rules engine and the JSONB
 * handlers. Kept dependency-free (bar the money-scale constant) so they are
 * trivially unit-testable.
 */

/**
 * Masks a free-text value keeping the first and last two characters, replacing
 * the middle with asterisks: `Biedronka` -> `Bi*****ka`. Strings of four
 * characters or fewer are fully masked (there is no safe middle to preserve),
 * so no value ever leaks more than four of its real characters. Non-string or
 * empty input is returned unchanged.
 *
 * Uses the spread operator to count Unicode code points rather than UTF-16
 * code units, so multi-byte characters (accented letters, CJK) are not split.
 */
export function maskText(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }
  const chars = [...value];
  if (chars.length <= 4) {
    return "*".repeat(chars.length);
  }
  const head = chars.slice(0, 2).join("");
  const tail = chars.slice(-2).join("");
  const stars = "*".repeat(chars.length - 4);
  return `${head}${stars}${tail}`;
}

/**
 * Multiplies a monetary value by the obfuscation multiplier, rounding to
 * `MONEY_SCALE` (eight) decimal places, the scale of the money columns, via
 * integer arithmetic to avoid floating-point drift, per the project's
 * financial-math convention. Rounding at four would truncate a coin amount in
 * the support copy (0.00002500 BTC scaled by 1.5 is 0.000037500, not 0.0000);
 * a fiat value carries at most four places on the way in, so it is unchanged.
 * Null/undefined pass through; unparseable values are returned unchanged.
 */
export function scaleMoney(value: unknown, multiplier: number): unknown {
  return scaleTo(value, multiplier, MONEY_SCALE);
}

/**
 * Multiplies a quantity (share count) by the multiplier, rounding to eight
 * decimal places (the `decimal(20,8)` quantity scale). Scaling the quantity in
 * lockstep with the total keeps `quantity x price x fx` internally consistent
 * while hiding the real position size.
 */
export function scaleQuantity(value: unknown, multiplier: number): unknown {
  return scaleTo(value, multiplier, 8);
}

function scaleTo(
  value: unknown,
  multiplier: number,
  decimals: number,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return value;
  }
  const factor = 10 ** decimals;
  return Math.round(num * multiplier * factor) / factor;
}
