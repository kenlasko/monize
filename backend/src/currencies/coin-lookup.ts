import { EntityManager } from "typeorm";
import { Currency } from "./entities/currency.entity";
import { IsCoin } from "./canonical-rate.util";

/**
 * Which codes are CRYPTO currencies, read once from `currencies.kind` on the
 * caller's scoped manager, for a writer of `exchange_rates` to orient by
 * (`isCanonicalOrientation`: a pair with exactly one coin side is stored
 * coin -> fiat). One query per operation, never one per row: a window fill or
 * an import orients hundreds of rows by the same answer.
 *
 * `currencies` is global reference data, so the answer is the same under any
 * identity; the caller's manager keeps the read inside its transaction.
 */
export async function loadCoinLookup(manager: EntityManager): Promise<IsCoin> {
  const rows = await manager
    .getRepository(Currency)
    .find({ select: { code: true }, where: { kind: "CRYPTO" } });
  const coins = new Set(rows.map((row) => row.code.toUpperCase()));
  return (code: string) => coins.has(code.toUpperCase());
}
