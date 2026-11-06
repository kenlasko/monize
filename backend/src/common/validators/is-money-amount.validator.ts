import { applyDecorators } from "@nestjs/common";
import { IsNumber, ValidateBy } from "class-validator";
import { decimalPlacesOf } from "../amount-precision.util";
import { MONEY_SCALE } from "../round.util";

/**
 * Validates a money amount: a finite number with at most `maxPlaces` decimal
 * places (`MONEY_SCALE`, the money columns' scale, by default; pass 4 for a
 * fiat-only column, or the field's own places for a unit price). Use it
 * instead of `@IsNumber({ maxDecimalPlaces: n })` on an amount.
 *
 * It does not use `maxDecimalPlaces`: class-validator reads the places off
 * `value.toString().split(".")[1].length`, which throws a TypeError (a 500)
 * for any value below 1e-6 because JavaScript prints those in exponent form
 * ("5e-8"). 0.00000005 BTC is a legitimate amount. The places are counted by
 * `decimalPlacesOf`, which reads the shortest round-trip digits through
 * `toExponential()`. Pair with `@IsOptional()` where the field is optional and
 * with `@Min(...)` / `@Max(...)` where it has bounds.
 */
export function IsMoneyAmount(
  maxPlaces: number = MONEY_SCALE,
): PropertyDecorator {
  return applyDecorators(
    IsNumber(),
    ValidateBy({
      name: "hasMoneyAmountPlaces",
      validator: {
        validate: (value: unknown): boolean =>
          typeof value === "number" &&
          Number.isFinite(value) &&
          decimalPlacesOf(value) <= maxPlaces,
        defaultMessage: () =>
          `amount must have at most ${maxPlaces} decimal places`,
      },
    }),
  );
}
