import { EntityManager, In } from "typeorm";
import { Currency } from "../currencies/entities/currency.entity";
import { AmountPrecisionCurrency } from "./amount-precision.util";
import { moneyDecimalsFor } from "./round.util";

/** The distinct, upper-cased, non-empty codes among `codes`. */
function distinctCodes(
  codes: readonly (string | null | undefined)[],
): string[] {
  return [
    ...new Set(
      codes
        .filter(
          (code): code is string => typeof code === "string" && code !== "",
        )
        .map((code) => code.toUpperCase()),
    ),
  ];
}

/**
 * `currencies.decimal_places` of every code among `codes`, keyed by the
 * upper-cased code, read in one query on the caller's manager, for a WRITER:
 * call it inside the write's transaction, before the first write, and thread
 * the map; never re-query per row. A code with no row is absent from the map
 * and reads as the column default through `moneyDecimalsForCode`.
 *
 * The rows are read `FOR KEY SHARE`, the lock the written row's foreign key
 * takes anyway, so the places an amount is held to are the places it commits
 * under (INV-MONEY-001). The lowering gate (`CurrenciesService.
 * assertDecimalPlacesFit`) locks the same row `FOR UPDATE` and then scans the
 * stored amounts (`currency_min_decimal_places_in_use`) in a later statement,
 * which conflicts with this read: a read arriving while a lowering holds the
 * row waits for that commit and, under READ COMMITTED, returns the new
 * version, so it checks the new places; a lowering arriving after this read
 * waits for the write to commit, and its scan (a fresh snapshot) then sees the
 * written amount and refuses `decimalPlacesInUse`. A plain read would let both
 * commit: an eight-place row under a four-place currency.
 *
 * Lock order: the currencies row is the only lock a writer and the gate
 * share. The gate takes it as its first lock and takes no account,
 * transaction or advisory lock after it (its scan is a plain read; it writes
 * only the currency row itself and the editor's `user_currency_preferences`
 * row, which no amount writer locks), so a writer can never hold something the
 * gate waits for while it waits on the currency row: no cycle, whatever the
 * writer locked before this read. Writers read currencies before the account
 * rows their balance deltas lock (`lockAccountsForBalanceWrite`,
 * `updateBalance`), and `FOR KEY SHARE` does not conflict with another
 * writer's `FOR KEY SHARE` or with the foreign-key check of an insert, so two
 * writers never wait on each other here; the rows are taken in code order all
 * the same. The kind gate and the delete (`kindUpdates`, `removeWithin`) lock
 * the same row `FOR UPDATE` first too and are ordered the same way.
 *
 * `FOR KEY SHARE` errors in a READ ONLY transaction (and on a standby): a
 * reader (a report, a detail view, a preview, an export) uses
 * `loadCurrencyPlacesForRead`.
 *
 * Read through the Currency repository's `query`, which runs on the caller's
 * manager and its transaction.
 */
export async function loadCurrencyPlaces(
  manager: EntityManager,
  codes: readonly (string | null | undefined)[],
): Promise<ReadonlyMap<string, number>> {
  const unique = distinctCodes(codes);
  if (unique.length === 0) return new Map();
  const rows: Array<{ code: string; decimal_places: number | string }> =
    await manager
      .getRepository(Currency)
      .query(
        "SELECT code, decimal_places FROM currencies WHERE code = ANY($1::varchar[]) ORDER BY code FOR KEY SHARE",
        [unique],
      );
  return new Map(
    rows.map((row) => [row.code.toUpperCase(), Number(row.decimal_places)]),
  );
}

/**
 * {@link loadCurrencyPlaces} without the lock, for a READER: a report, a
 * detail view, a preview, an export, or a figure computed in a transaction of
 * its own that writes nothing in the currency. It takes no row lock, so it
 * never waits on a lowering and runs in a READ ONLY transaction; the places it
 * returns can be superseded by a lowering committing beside it, which is
 * harmless where nothing is written at them. Never use it to judge an amount a
 * write is about to store: that is `loadCurrencyPlaces`, inside the write.
 */
export async function loadCurrencyPlacesForRead(
  manager: EntityManager,
  codes: readonly (string | null | undefined)[],
): Promise<ReadonlyMap<string, number>> {
  const unique = distinctCodes(codes);
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
