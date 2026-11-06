import { FIAT_MONEY_DECIMALS, roundMoney } from "../../common/round.util";

/**
 * Primitive obfuscation operations shared by the rules engine and the JSONB
 * handlers. Kept dependency-free (bar the money-precision constant) so they are
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
 * `decimals` places via integer arithmetic to avoid floating-point drift, per
 * the project's financial-math convention. `decimals` is the money precision of
 * the currency the value is in: `FIAT_MONEY_DECIMALS` by default, so a fiat
 * value scales byte for byte as it always did (12.3456 x 1.37 is 16.9135, not
 * 16.913472, which the restored copy's four-place rows would refuse), and the
 * caller passes `moneyDecimalsFor(...)` of a coin's currency so
 * 0.00002500 BTC scaled by 1.5 is 0.0000375, not 0.0000. Null/undefined pass
 * through; unparseable values are returned unchanged.
 */
export function scaleMoney(
  value: unknown,
  multiplier: number,
  decimals: number = FIAT_MONEY_DECIMALS,
): unknown {
  return scaleTo(value, multiplier, decimals);
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
  // `roundMoney` shifts the shortest decimal string through BigInt once the
  // scaled value is large, so 150,000,000 x 2.5 at eight places stays exact
  // where `Math.round(x * 1e8) / 1e8` leaves the safe-integer range.
  return roundMoney(num * multiplier, decimals);
}
