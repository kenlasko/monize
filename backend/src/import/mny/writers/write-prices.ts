import { EntityManager } from "typeorm";
import { roundToDecimals } from "../../../common/round.util";
import { MnyExchangeRate, MnySecurityPrice } from "../model/mny-rows";
import { chunk } from "./chunk";
import {
  IsCoin,
  NO_COINS,
  canonicalRateRow,
} from "../../../currencies/canonical-rate.util";
import { loadCoinLookup } from "../../../currencies/coin-lookup";
import { returnedRows } from "../../../common/db/query-result";

/**
 * Bulk writers for `SP` price history and `CRNC_EXCHG` exchange rates.
 *
 * Both are additive inserts on the natural key the table is already unique on,
 * so importing the same file twice, or importing on top of prices a quote
 * provider fetched, converges rather than failing or duplicating. They differ on
 * a conflict, because the two tables have different owners:
 *
 * - `security_prices` hangs off the importing user's own securities, so the
 *   Money file wins: the user asked to import it, and its history is the one
 *   their transactions were entered against.
 * - `exchange_rates` is global reference data every user on the deployment
 *   converts through, so an existing observation wins and the Money row only
 *   fills a date nothing else holds (INV-FX-004). One user's file must not
 *   rewrite the rate another user's history is valued at.
 *
 * These are the two biggest tables in a real file -- the maintainer's Money Plus
 * file has 68,000 price rows -- so they go in as multi-row `INSERT ... ON
 * CONFLICT` statements with a smaller chunk than the transaction writer uses,
 * because each row binds more parameters.
 *
 * A rate row is oriented by `canonicalRateRow` before it is written, because
 * `exchange_rates` stores each pair once and Money records whichever direction
 * the user entered (INV-FX-003).
 */

/** 500 rows x 5 columns stays well inside Postgres's 65,535-parameter ceiling. */
export const UPSERT_CHUNK_SIZE = 500;

/** `security_prices.close_price` is `numeric(20,6)`. */
const PRICE_DECIMALS = 6;

/** `exchange_rates.rate` is `numeric(20,10)`. */
const RATE_DECIMALS = 10;

/** Marks the rows this import wrote, alongside `yahoo_finance` and friends. */
export const MNY_PRICE_SOURCE = "mny_import";

export interface PriceRow {
  readonly securityId: string;
  readonly priceDate: string;
  readonly closePrice: number;
}

/**
 * The last usable price per `(security, date)`.
 *
 * Money keeps several `SP` rows for one security and day -- an intraday quote
 * and the close, or a re-fetch. `hsp` is monotonic, so the highest handle is the
 * most recently written one and wins; rows without a handle fall back to file
 * order. Deduping here rather than letting the upsert do it keeps the statement
 * free of the "ON CONFLICT DO UPDATE cannot affect row a second time" error that
 * duplicate keys inside a single `VALUES` list would raise.
 */
export function dedupePrices(
  prices: readonly MnySecurityPrice[],
  securityIdByHandle: ReadonlyMap<number, string>,
): PriceRow[] {
  const byKey = new Map<string, { handle: number; row: PriceRow }>();

  prices.forEach((price, index) => {
    if (price.security === null || price.date === null) {
      return;
    }
    const securityId = securityIdByHandle.get(price.security);
    if (securityId === undefined) {
      return;
    }
    const closePrice = roundToDecimals(price.price, PRICE_DECIMALS);
    if (!Number.isFinite(closePrice) || closePrice <= 0) {
      return;
    }

    const key = `${securityId}|${price.date}`;
    const handle = price.handle ?? index;
    const existing = byKey.get(key);
    if (existing === undefined || handle >= existing.handle) {
      byKey.set(key, {
        handle,
        row: { securityId, priceDate: price.date, closePrice },
      });
    }
  });

  return [...byKey.values()].map((entry) => entry.row);
}

export async function writeSecurityPrices(
  manager: EntityManager,
  prices: readonly MnySecurityPrice[],
  securityIdByHandle: ReadonlyMap<number, string>,
  onProgress?: (processed: number, total: number) => Promise<void>,
): Promise<number> {
  const rows = dedupePrices(prices, securityIdByHandle);
  let processed = 0;

  for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
    const values = batch
      .map(
        (_, index) =>
          `($${index * 4 + 1}::uuid, $${index * 4 + 2}::date, $${index * 4 + 3}::numeric, $${index * 4 + 4})`,
      )
      .join(", ");
    await manager.query(
      `INSERT INTO security_prices (security_id, price_date, close_price, source)
            VALUES ${values}
       ON CONFLICT (security_id, price_date)
       DO UPDATE SET close_price = EXCLUDED.close_price,
                     source = EXCLUDED.source`,
      batch.flatMap((row) => [
        row.securityId,
        row.priceDate,
        row.closePrice,
        MNY_PRICE_SOURCE,
      ]),
    );
    processed += batch.length;
    await onProgress?.(processed, rows.length);
  }

  return rows.length;
}

export interface ExchangeRateRow {
  readonly fromCurrency: string;
  readonly toCurrency: string;
  readonly rate: number;
  readonly rateDate: string;
}

/**
 * Resolves `CRNC_EXCHG` handles into ISO codes, dropping what cannot be used and
 * orienting what survives.
 *
 * A rate needs both currencies, a date and a positive rate; a row missing any of
 * those describes nothing. Self-rates (`USD -> USD`) are dropped too: they are
 * always 1 and only get in the way of the rate lookup.
 *
 * Money records whichever orientation the user happened to enter, and
 * `exchange_rates` stores one orientation per pair, so each row is put through
 * `canonicalRateRow` before it is keyed (INV-FX-003). Two recordings of one pair
 * and date -- `USD -> GBP` and `GBP -> USD` -- therefore collapse onto one key
 * rather than becoming two rows that disagree, and the same dedupe that keeps
 * the multi-row `INSERT` free of "cannot affect row a second time" now also
 * keeps the pair from contradicting itself.
 *
 * `isCoin` is `currencies.kind` read once for the import: a pair with one coin
 * side is stored coin -> fiat whichever code sorts first. A rate the column
 * cannot hold (at or above 1e10 as stored, or nothing at ten decimals) is
 * dropped like any other unusable row rather than failing the whole insert.
 */
export function resolveExchangeRates(
  rates: readonly MnyExchangeRate[],
  currencyByHandle: ReadonlyMap<number, string>,
  isCoin: IsCoin = NO_COINS,
): ExchangeRateRow[] {
  const byKey = new Map<string, ExchangeRateRow>();

  for (const rate of rates) {
    if (rate.fromCurrency === null || rate.toCurrency === null) {
      continue;
    }
    const fromCurrency = currencyByHandle.get(rate.fromCurrency);
    const toCurrency = currencyByHandle.get(rate.toCurrency);
    const value = roundToDecimals(rate.rate, RATE_DECIMALS);

    if (
      fromCurrency === undefined ||
      toCurrency === undefined ||
      rate.date === null
    ) {
      continue;
    }

    // Refuses a self-pair and a non-positive or non-finite rate, so the checks
    // this replaces stay in one place.
    const row = canonicalRateRow(fromCurrency, toCurrency, value, isCoin);
    if (row === null) {
      continue;
    }

    // Later rows win, matching the price rule and Money's own write order.
    byKey.set(`${row.from}|${row.to}|${rate.date}`, {
      fromCurrency: row.from,
      toCurrency: row.to,
      rate: row.rate,
      rateDate: rate.date,
    });
  }

  return [...byKey.values()];
}

/**
 * Inserts the file's rates for the dates `exchange_rates` holds nothing for, and
 * returns how many it actually added.
 *
 * `DO NOTHING`, never `DO UPDATE` (INV-FX-004): the table is shared by every
 * user, so a rate already there -- a provider's observation, or another user's
 * earlier import -- is left as it is. What a Money file records may be what one
 * user's bank charged rather than the market, and overwriting would revalue
 * every other user's history at it. Filling a gap is the point of importing
 * rates at all: a Money file can hold history from before any provider covers
 * the pair. The reverse holds too: a provider refresh that later replaces a
 * gap this import filled loses nothing of the user's, because what their own
 * transactions actually exchanged at is carried on the transactions themselves
 * (INV-FX-002), not in this table.
 */
export async function writeExchangeRates(
  manager: EntityManager,
  rates: readonly MnyExchangeRate[],
  currencyByHandle: ReadonlyMap<number, string>,
): Promise<number> {
  const rows = resolveExchangeRates(
    rates,
    currencyByHandle,
    await loadCoinLookup(manager),
  );
  let inserted = 0;

  for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
    const values = batch
      .map(
        (_, index) =>
          `($${index * 5 + 1}, $${index * 5 + 2}, $${index * 5 + 3}::numeric, $${index * 5 + 4}::date, $${index * 5 + 5})`,
      )
      .join(", ");
    const result: unknown = await manager.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate, rate_date, source)
            VALUES ${values}
       ON CONFLICT (from_currency, to_currency, rate_date) DO NOTHING
       RETURNING id`,
      batch.flatMap((row) => [
        row.fromCurrency,
        row.toCurrency,
        row.rate,
        row.rateDate,
        MNY_PRICE_SOURCE,
      ]),
    );
    // A skipped conflict returns no row, so this counts what was added rather
    // than what the file offered.
    inserted += returnedRows<{ id: number }>(result).length;
  }

  return inserted;
}
