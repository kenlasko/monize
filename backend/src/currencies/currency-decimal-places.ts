import { EntityManager, In } from "typeorm";
import { isIsoCurrencyCode } from "../common/format-currency.util";
import { Currency } from "./entities/currency.entity";

/**
 * `decimal_places` of every non-ISO code among `codes`, read in one query on
 * the caller's manager, for `decimalPlacesFor`. An ISO code is not read: its
 * places are its ISO minor unit. No query at all when every code is ISO, which
 * is the common case.
 */
export async function loadCurrencyDecimalPlaces(
  manager: EntityManager,
  codes: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const nonIso = [...new Set(codes.map((code) => code.toUpperCase()))].filter(
    (code) => !isIsoCurrencyCode(code),
  );
  if (nonIso.length === 0) return new Map();
  const rows = await manager.getRepository(Currency).find({
    select: { code: true, decimalPlaces: true },
    where: { code: In(nonIso) },
  });
  return new Map(rows.map((row) => [row.code, Number(row.decimalPlaces)]));
}
