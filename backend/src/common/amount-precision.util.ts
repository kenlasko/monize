import { BadRequestException } from "@nestjs/common";
import { tr } from "../i18n/translate";
import { moneyDecimalsFor } from "./round.util";

/** A plain or exponential decimal literal, as a request or a driver spells one. */
const DECIMAL_LITERAL = /^[+-]?(\d+)?(?:\.(\d*))?(?:e([+-]?\d+))?$/i;

/**
 * The number of decimal places `value` carries, counted on its shortest
 * decimal spelling, so trailing zeros never count (`0.00002500` has 6 places,
 * `12.3400` has 2).
 *
 * A number is read through `toExponential()`, which always yields the
 * shortest round-trip digits in a `d.ddde±N` form; `toString()` switches to
 * exponential notation below 1e-6, so counting the digits after its "." would
 * miss `1e-7` entirely. A string is counted on its own digits, so a value with
 * more significant digits than a double holds is not rounded before it is
 * judged. A non-finite number or a string that is not a decimal literal has
 * no places to count and reads as 0: whether it is an amount at all is the
 * DTO's question, not this one.
 */
export function decimalPlacesOf(value: number | string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value === 0) return 0;
    return placesOf(value.toExponential());
  }
  const text = value.trim();
  if (text === "" || !DECIMAL_LITERAL.test(text)) return 0;
  return placesOf(text);
}

function placesOf(literal: string): number {
  const match = DECIMAL_LITERAL.exec(literal);
  if (!match) return 0;
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  const exponent = match[3] === undefined ? 0 : Number(match[3]);
  return Math.max(0, fraction.length - exponent);
}

/** What `assertAmountPrecision` needs to know about the amount's currency. */
export interface AmountPrecisionCurrency {
  code: string;
  /** `currencies.decimal_places`; null reads as the column default, 2. */
  decimalPlaces: number | null;
}

/**
 * Refuse an amount with more places than its currency's money precision
 * (`moneyDecimalsFor(currency.decimalPlaces)`): four for every fiat currency,
 * the coin's own places (up to eight) for a cryptocurrency. The amount is
 * refused, never rounded, so a figure the user typed is never stored as a
 * different one (INV-MONEY-001, `docs/specs/money-precision.md` decision 6).
 *
 * Call it inside the write's transaction, before the first write, on every
 * writer of an amount in the account's currency; `field` names the request
 * field the reader has to correct.
 */
export function assertAmountPrecision(
  amount: number | string,
  currency: AmountPrecisionCurrency,
  field: string,
): void {
  const places = moneyDecimalsFor(currency.decimalPlaces);
  if (decimalPlacesOf(amount) <= places) return;
  const code = currency.code;
  throw new BadRequestException(
    tr(
      "errors.transactions.amountPrecisionExceeded",
      `The amount in "${field}" has more decimal places than ${code} carries (${places}). Enter it with at most ${places} decimal places; a currency's decimal places are set on the Currencies page.`,
      { code, places, field },
    ),
  );
}
