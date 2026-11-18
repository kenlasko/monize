import { moneyDecimalsFor } from "../../../common/round.util";
import { KmySplit } from "../model/kmy-raw";
import {
  Rational,
  div,
  isZero,
  mul,
  neg,
  rational,
  toNumber,
} from "../model/kmy-rational";

/**
 * Rational to `number`, at a currency's places (spec 4.5), and the leg
 * arithmetic of spec 4.7 / 5.6.3. Every conversion starts from the exact
 * rational and rounds once, half away from zero; sums that must agree are done
 * in integer minor units (`bigint`), never as floats.
 */

/** `NUMERIC(20,8)`: shares and a split's ratio. */
export const QUANTITY_PLACES = 8;
/** `INVESTMENT_PRICE_DECIMALS`: a per-share price. */
export const PRICE_PLACES = 10;
/** `NUMERIC(20,10)`: an exchange rate and the file's price history. */
export const RATE_PLACES = 10;

/** Decimal places of a currency's amounts: 4 for a fiat, the coin's own (up to 8) for a CRYPTO code. */
export function amountPlaces(
  currencyCode: string,
  coinDecimals: ReadonlyMap<string, number>,
): number {
  return moneyDecimalsFor(coinDecimals.get(currencyCode) ?? 2);
}

/** `a` in whole units of `10^-places`, rounded half away from zero. */
export function toUnits(a: Rational, places: number): bigint {
  const scaled = (a.num < 0n ? -a.num : a.num) * 10n ** BigInt(places);
  let quotient = scaled / a.den;
  if ((scaled % a.den) * 2n >= a.den) {
    quotient += 1n;
  }
  return a.num < 0n ? -quotient : quotient;
}

/** The `number` a count of minor units denotes, through an exact decimal string. */
export function unitsToNumber(units: bigint, places: number): number {
  return toNumber(rational(units, 10n ** BigInt(places)), places);
}

/** The amount, rounded once at the currency's places. */
export function amountNumber(
  a: Rational,
  currencyCode: string,
  coinDecimals: ReadonlyMap<string, number>,
): number {
  return toNumber(a, amountPlaces(currencyCode, coinDecimals));
}

export function quantityNumber(a: Rational): number {
  return toNumber(a, QUANTITY_PLACES);
}

export function priceNumber(a: Rational): number {
  return toNumber(a, PRICE_PLACES);
}

export function rateNumber(a: Rational): number {
  return toNumber(a, RATE_PLACES);
}

/** True when `a` is exactly representable at `places` decimals. */
export function isExactAt(a: Rational, places: number): boolean {
  return (a.num * 10n ** BigInt(places)) % a.den === 0n;
}

/**
 * The shares of a split, with the compensation of fix versions below 12
 * (spec 5.1): a split whose account currency equals the transaction commodity
 * uses `value` when `shares` is 0.
 */
export function effectiveShares(
  split: KmySplit,
  accountCurrency: string,
  commodity: string,
  fixVersion: number,
): Rational {
  if (
    fixVersion < 12 &&
    isZero(split.shares) &&
    accountCurrency === commodity
  ) {
    return split.value;
  }
  return split.shares;
}

/**
 * The exact amount of a leg in the parent's currency (spec 4.7):
 * `-o.value * parent.shares / parent.value`, exactly `-o.value` when the
 * parent's account currency is the transaction commodity. `null` when the
 * parent's value is 0 and the ratio is undefined.
 */
export function legRational(
  otherValue: Rational,
  parentValue: Rational,
  parentShares: Rational,
  parentInCommodity: boolean,
): Rational | null {
  if (parentInCommodity) {
    return neg(otherValue);
  }
  if (isZero(parentValue)) {
    return null;
  }
  return neg(mul(otherValue, div(parentShares, parentValue)));
}

/**
 * `positive / negative` as a rate rounded once at 10 places, from the two
 * already-rounded amounts' magnitudes; `null` when either is zero.
 */
export function impliedRate(
  receivingUnits: bigint,
  sendingUnits: bigint,
): number | null {
  const top = receivingUnits < 0n ? -receivingUnits : receivingUnits;
  const bottom = sendingUnits < 0n ? -sendingUnits : sendingUnits;
  if (top === 0n || bottom === 0n) {
    return null;
  }
  return rateNumber(rational(top, bottom));
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date written `YYYY-MM-DD`. */
export function isIsoDate(value: string | null | undefined): value is string {
  if (!value) {
    return false;
  }
  const match = ISO_DATE.exec(value);
  if (!match) {
    return false;
  }
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
