import { applyDecorators } from "@nestjs/common";
import { IsNumber, Min, ValidateBy } from "class-validator";
import { FX_RATE_DECIMALS, roundFxRate } from "../fx-entry.util";

/**
 * The smallest rate the `NUMERIC(20,10)` rate column holds: one unit in its
 * last place. A CAD -> BTC rate is 0.0000073529, a JPY -> BTC rate is near
 * 0.00000007, so no floor above this may refuse a coin pair's own rate.
 */
export const MIN_FX_RATE = 1 / 10 ** FX_RATE_DECIMALS;

/**
 * Validates an exchange rate: a finite number that is positive and
 * representable at the rate column's ten places (`MIN_FX_RATE` and up). Use it
 * instead of `@IsNumber({ maxDecimalPlaces: 10 })` plus an ad-hoc `@Min(...)`.
 *
 * It does not use `maxDecimalPlaces`: class-validator reads the places off
 * `value.toString().split(".")[1]`, which throws a TypeError (a 500) for any
 * value below 1e-6 because JavaScript prints those in exponent form ("1e-7").
 * A coin pair's rate is routinely that small. Pair with `@IsOptional()` where
 * the field is optional and with `@Max(...)` where the rate has a ceiling.
 */
export function IsFxRate(): PropertyDecorator {
  return applyDecorators(
    IsNumber(),
    Min(MIN_FX_RATE),
    ValidateBy({
      name: "hasFxRatePlaces",
      validator: {
        validate: (value: unknown): boolean =>
          typeof value === "number" &&
          Number.isFinite(value) &&
          roundFxRate(value) === value,
        defaultMessage: () =>
          `$property must have at most ${FX_RATE_DECIMALS} decimal places`,
      },
    }),
  );
}
