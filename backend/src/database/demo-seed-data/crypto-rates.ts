import { EntityManager } from "typeorm";
import { addDaysYMD } from "../../common/date-utils";
import { roundFxRate } from "../../common/fx-entry.util";

/**
 * The demo's cryptocurrency (`docs/future-plans/crypto-accounts.md`, the
 * contract shared by every phase): Bitcoin, priced from Yahoo's `BTC-CAD`,
 * at the four places money holds (`docs/specs/crypto-accounts.md`,
 * decision 4).
 */
export const DEMO_CRYPTO_CURRENCY = {
  code: "BTC",
  name: "Bitcoin",
  symbol: "₿",
  decimals: 4,
  kind: "CRYPTO",
  quoteSymbol: "BTC-CAD",
} as const;

/** The fiat the demo prices its coin in, and the level its series moves around. */
const DEMO_CRYPTO_FIAT = "CAD";
const DEMO_BTC_CAD_LEVEL = 137_000;

/**
 * The `exchange_rates.source` of the demo's coin rates: the crypto provider's
 * slug, the one a live refresh of the same pair writes.
 */
export const DEMO_CRYPTO_RATE_SOURCE = "yahoo_crypto";

/**
 * One observation of the coin's rate: an amount in `from` times `rate` is the
 * amount in `to`. The writer (`ExchangeRateService.storeRateSeries`) stores it
 * in the pair's one orientation.
 */
export interface DemoRateRow {
  from: string;
  to: string;
  date: string;
  rate: number;
}

/**
 * Daily `BTC -> CAD` rates for every day of the `days` up to and including
 * `today` (a coin trades every day, weekends included). Deterministic, so a
 * reset reseeds the same figures for the same day: a slow swing of about 6%
 * around `DEMO_BTC_CAD_LEVEL` with a smaller weekly ripple, so the day to day
 * move stays well under 1%.
 */
export function generateDemoCryptoRates(
  today: string,
  days = 366,
): DemoRateRow[] {
  const rows: DemoRateRow[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = addDaysYMD(today, -offset);
    const t = days - 1 - offset;
    const level =
      DEMO_BTC_CAD_LEVEL *
      (1 + 0.06 * Math.sin(t / 45) + 0.008 * Math.sin(t / 3.5));
    rows.push({
      from: DEMO_CRYPTO_CURRENCY.code,
      to: DEMO_CRYPTO_FIAT,
      date,
      rate: roundFxRate(level),
    });
  }
  return rows;
}

/**
 * Create or refresh the demo's coin. Shared by the base seed and the demo
 * seed, because the daily demo reset reseeds the rates without the base seed,
 * and a database first seeded before the coin existed has no `BTC` row for
 * them to reference.
 */
export async function upsertDemoCryptoCurrency(
  manager: EntityManager,
): Promise<void> {
  const coin = DEMO_CRYPTO_CURRENCY;
  await manager.query(
    `INSERT INTO currencies (code, name, symbol, decimal_places, kind, quote_symbol)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (code) DO UPDATE SET
       name = EXCLUDED.name,
       symbol = EXCLUDED.symbol,
       decimal_places = EXCLUDED.decimal_places,
       kind = EXCLUDED.kind,
       quote_symbol = EXCLUDED.quote_symbol`,
    [
      coin.code,
      coin.name,
      coin.symbol,
      coin.decimals,
      coin.kind,
      coin.quoteSymbol,
    ],
  );
}
