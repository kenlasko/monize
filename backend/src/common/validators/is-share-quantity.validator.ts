import { applyDecorators } from "@nestjs/common";
import { IsNumber, ValidateBy } from "class-validator";
import { decimalPlacesOf } from "../amount-precision.util";
import { MONEY_SCALE } from "../round.util";

/**
 * Validates a quantity of shares or coins: a finite number with at most
 * `maxPlaces` decimal places (eight by default, the quantity columns' scale).
 * Use it instead of `@IsNumber({ maxDecimalPlaces: n })` on a quantity.
 *
 * It does not use `maxDecimalPlaces`: class-validator reads the places off
 * `value.toString().split(".")[1].length`, which throws a TypeError (a 500)
 * for any value below 1e-6 because JavaScript prints those in exponent form
 * ("5e-8"). 0.00000005 BTC is a legitimate position. The places are counted by
 * `decimalPlacesOf`, which is exponent-safe. Pair with `@IsOptional()` where
 * the field is optional and with `@Min(...)` / `@IsPositive()` for its bounds.
 */
export function IsShareQuantity(
  maxPlaces: number = MONEY_SCALE,
): PropertyDecorator {
  return applyDecorators(
    IsNumber(),
    ValidateBy({
      name: "hasShareQuantityPlaces",
      validator: {
        validate: (value: unknown): boolean =>
          typeof value === "number" &&
          Number.isFinite(value) &&
          decimalPlacesOf(value) <= maxPlaces,
        defaultMessage: () =>
          `quantity must have at most ${maxPlaces} decimal places`,
      },
    }),
  );
}
