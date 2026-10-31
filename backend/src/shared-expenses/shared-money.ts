import { BadRequestException } from "@nestjs/common";
import { ExactDecimal } from "../bonds/domain/exact-decimal";
import { tr } from "../i18n/translate";

export const SHARED_MONEY_SCALE = 10_000n;
export const SHARED_AMOUNT_LIMIT = 999_999_999_999n * SHARED_MONEY_SCALE;
export const SHARED_PARTICIPANT_LIMIT = 50;

export function invalidSharedAmount(): never {
  throw new BadRequestException(
    tr(
      "sharedExpenses.invalidAmount",
      "Enter a valid amount at the supported currency precision",
    ),
  );
}

/** Decimal strings stay exact until the explicit legacy-ledger boundary. */
export function fixedUnits(
  value: string,
  places: number,
  signed = false,
): bigint {
  if (
    typeof value !== "string" ||
    value.length > 32 ||
    !Number.isInteger(places) ||
    places < 0 ||
    places > 10 ||
    !/^-?\d+(?:\.\d+)?$/.test(value) ||
    (!signed && value.startsWith("-"))
  )
    invalidSharedAmount();
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  if (fraction.length > places) invalidSharedAmount();
  const units =
    BigInt(whole) * 10n ** BigInt(places) +
    BigInt(fraction.padEnd(places, "0") || "0");
  return negative ? -units : units;
}

export function currencyQuantum(places: number): bigint {
  if (!Number.isInteger(places) || places < 0 || places > 4)
    invalidSharedAmount();
  return 10n ** BigInt(4 - places);
}

export function sharedAmount(
  value: string,
  places: number,
  positive = true,
): bigint {
  const units = fixedUnits(value, 4);
  if (
    units > SHARED_AMOUNT_LIMIT ||
    (positive ? units <= 0n : units < 0n) ||
    units % currencyQuantum(places) !== 0n
  )
    invalidSharedAmount();
  return units;
}

export function moneyText(units: bigint): string {
  return ExactDecimal.of(units, SHARED_MONEY_SCALE).toFixed(4);
}

/** A number-based ledger must be able to represent the accepted decimal. */
export function ledgerAmount(units: bigint): number {
  const text = moneyText(units);
  const value = Number(text);
  if (
    !Number.isFinite(value) ||
    Math.abs(value) > Number(SHARED_AMOUNT_LIMIT / SHARED_MONEY_SCALE) ||
    !/^-?\d+(?:\.\d+)?$/.test(String(value)) ||
    ExactDecimal.parse(String(value)).cmp(ExactDecimal.parse(text)) !== 0
  ) {
    invalidSharedAmount();
  }
  return value;
}

/** Convert the total once; allocation of the converted total happens afterwards. */
export function convertSharedAmount(
  units: bigint,
  rate: string,
  places: number,
): bigint {
  currencyQuantum(places);
  const scaledRate = fixedUnits(rate, 10);
  if (scaledRate <= 0n || scaledRate >= 10n ** 20n) invalidSharedAmount();
  const result = ExactDecimal.of(units, SHARED_MONEY_SCALE)
    .mul(ExactDecimal.of(scaledRate, 10n ** 10n))
    .toFixed(places);
  return sharedAmount(result, places, false);
}
