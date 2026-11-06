import { EntityManager, In } from "typeorm";
import { Currency } from "../currencies/entities/currency.entity";
import { AmountPrecisionCurrency } from "./amount-precision.util";
import { moneyDecimalsFor } from "./round.util";

/**
 * `currencies.decimal_places` of every code among `codes`, keyed by the
 * upper-cased code, read in one query on the caller's manager. Load it once per
 * operation, inside the operation's transaction, and thread the map; never
 * re-query per row. A code with no row is absent from the map and reads as the
 * column default through `moneyDecimalsForCode`.
 */
export async function loadCurrencyPlaces(
  manager: EntityManager,
  codes: readonly (string | null | undefined)[],
): Promise<ReadonlyMap<string, number>> {
  const unique = [
    ...new Set(
      codes
        .filter(
          (code): code is string => typeof code === "string" && code !== "",
        )
        .map((code) => code.toUpperCase()),
    ),
  ];
  if (unique.length === 0) return new Map();
  const rows = await manager.getRepository(Currency).find({
    select: { code: true, decimalPlaces: true },
    where: { code: In(unique) },
  });
  return new Map(
    rows.map((row) => [row.code.toUpperCase(), Number(row.decimalPlaces)]),
  );
}

/**
 * The money precision of `code` (`moneyDecimalsFor` of its loaded
 * `decimal_places`): four for every fiat currency and for a code the map does
 * not hold, a coin's own places (up to eight) otherwise.
 */
export function moneyDecimalsForCode(
  places: ReadonlyMap<string, number>,
  code: string | null | undefined,
): number {
  if (!code) return moneyDecimalsFor(undefined);
  return moneyDecimalsFor(places.get(code.toUpperCase()));
}

/**
 * `code` with its loaded `decimal_places`, in the shape `assertAmountPrecision`
 * takes; a code the map does not hold carries `null` (the column default).
 */
export function precisionCurrencyFor(
  places: ReadonlyMap<string, number>,
  code: string,
): AmountPrecisionCurrency {
  return { code, decimalPlaces: places.get(code.toUpperCase()) ?? null };
}
