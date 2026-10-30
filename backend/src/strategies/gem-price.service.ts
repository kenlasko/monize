import { Injectable, Logger } from "@nestjs/common";
import { DataSource, EntityManager, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { todayYMD } from "../common/date-utils";
import { GemAssetRole } from "./entities/gem-strategy-asset.entity";
import { BOUNDARY_LAG_DAYS, PricePoint } from "./gem-momentum.util";
import { loadPriceSeries } from "../common/time-series/price-series.util";
import { GemRange } from "./gem-report.types";
import { Security } from "../securities/entities/security.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { preferredCurrency } from "../common/default-currency.util";
import {
  buildRateIndex,
  convertAtDate,
} from "../common/time-series/rate-index.util";

/** How far back each chart range reaches, in months. `null` means "all history". */
const RANGE_MONTHS: Record<GemRange, number | null> = {
  "3M": 3,
  "6M": 6,
  "1Y": 12,
  "3Y": 36,
  "5Y": 60,
  MAX: null,
};

/**
 * Sampling per range. Daily closes are what the shorter windows are for; over
 * several years they would ship tens of thousands of points the chart cannot
 * draw distinctly, so long ranges are thinned to one close per week or month.
 */
const RANGE_SAMPLING: Record<GemRange, "day" | "week" | "month"> = {
  "3M": "day",
  "6M": "day",
  "1Y": "day",
  "3Y": "week",
  "5Y": "month",
  MAX: "month",
};

/**
 * Days of prices to load *before* a window opens.
 *
 * The same span a boundary close may be old and still count (`BOUNDARY_LAG_DAYS`),
 * and necessarily so: a series loaded from exactly the boundary does not contain
 * the close that prices it, because `price_date >= from` excludes it and a
 * lookup can only search backwards. Loading less than the rule accepts would
 * discard prices the rule would have used.
 */
export {
  PRICE_WINDOW_LEAD_DAYS,
  withLeadDays,
} from "../common/time-series/price-boundary.util";

/** A security's close prices, oldest first. */
export type PriceSeries = PricePoint[];

/** Prices keyed by strategy role, for the roles that have an instrument. */
export type PricesByRole = Partial<Record<GemAssetRole, PriceSeries>>;

export function rangeMonths(range: GemRange): number | null {
  return RANGE_MONTHS[range];
}

export function rangeSampling(range: GemRange): "day" | "week" | "month" {
  return RANGE_SAMPLING[range];
}

/**
 * Price reads for the GEM report. Kept apart from the evaluation and position
 * logic so those receive plain arrays and stay free of SQL.
 */
@Injectable()
export class GemPriceService {
  private readonly logger = new Logger(GemPriceService.name);

  constructor(private dataSource: DataSource) {}

  /**
   * Close prices per security from `fromDate` onwards, oldest first, thinned to
   * the requested sampling. Weekly/monthly sampling keeps the last close of each
   * bucket (DISTINCT ON), which is what a period-end comparison wants.
   *
   * **Adjusted closes, and one basis per series.** Everything downstream of
   * this method measures a *return over time*: momentum, the performance chart,
   * the backtest. On raw closes a 4-for-1 split reads as a 75% crash, which
   * does not merely dent the chart -- it flips the absolute-momentum test and
   * hands the signal to the safe asset -- and every distribution is silently
   * dropped from the return of whichever instrument pays the most, which is
   * usually the bond leg the equities are being measured against.
   *
   * A per-row `COALESCE(adjusted_close, close_price)` looked like the same
   * thing and was not. `adjusted_close` is nullable *per row* and only the
   * provider backfill writes it; transaction-derived prices, the MNY import and
   * the demo seed all insert a raw close beside it. The coalesce therefore
   * spliced raw rows into an adjusted series for any instrument the user has
   * ever traded -- a security adjusted to 50 around a split, with a purchase
   * recorded at the unadjusted 205, produced a +310% trailing return that runs
   * the absolute-momentum test, and a -73% drawdown that never happened. That
   * is exactly what `docs/time-series-contract.md` rule 1 forbids: never mix
   * adjusted and raw prices for the same instrument inside one calculation.
   *
   * So the basis is decided per security, over the window being read: if any
   * row in it carries an adjusted close, the series is the adjusted rows only,
   * and the unadjusted rows are left out rather than converted. If none does,
   * the series is raw throughout -- consistent, and the only series available
   * for an instrument nobody has adjusted data for. Splits still distort a
   * wholly-raw series; that is a data gap to fill, not something a fallback per
   * row can paper over.
   *
   * Valuing today's holdings is the other case and stays on the raw close:
   * `latestPrices` answers "what is this position worth", where the adjusted
   * series is the wrong number.
   *
   * One query for every security: the report needs four series and issuing four
   * round trips per request buys nothing.
   */
  async loadSeries(
    securityIds: string[],
    fromDate: string,
    sampling: "day" | "week" | "month" = "day",
    manager?: EntityManager,
    convertForUserId?: string,
  ): Promise<Map<string, PriceSeries>> {
    const series = new Map<string, PriceSeries>();
    if (securityIds.length === 0) return series;

    const load = async (m: EntityManager) => {
      const loaded = await loadPriceSeries(m, {
        table: "security_prices",
        ids: securityIds,
        fromDate,
        sampling,
      });
      const result = new Map<string, PriceSeries>();
      for (const [securityId, { points }] of loaded) {
        result.set(securityId, points);
      }
      return convertForUserId
        ? this.convertToReportCurrency(m, result, fromDate, convertForUserId)
        : result;
    };

    return manager ? load(manager) : withScopedDb(this.dataSource, load);
  }

  /**
   * Re-express each series in the user's reporting currency, close by close, at
   * the rate for that close's own date (`convertAtDate`, the one resolver).
   *
   * A return compared across instruments has to be a return in one currency:
   * a USD fund +8% against a PLN bill +5% with USD/PLN down 10% is -2.8% for
   * the PLN reader. A close with no admissible rate is dropped, never carried
   * at 1:1, so a span ending on it is unpriced and the period defers or
   * becomes a gap; the pair is named in the log.
   */
  private async convertToReportCurrency(
    manager: EntityManager,
    series: Map<string, PriceSeries>,
    fromDate: string,
    userId: string,
  ): Promise<Map<string, PriceSeries>> {
    const preference = await manager
      .getRepository(UserPreference)
      .findOne({ where: { userId } });
    const securities = await manager.getRepository(Security).find({
      where: { id: In([...series.keys()]) },
      select: { id: true, currencyCode: true },
    });
    const reportCurrency = preferredCurrency(preference);
    const currencyById = new Map(
      securities.map((security) => [security.id, security.currencyCode]),
    );
    const foreign = new Set(
      [...currencyById.values()].filter((code) => code !== reportCurrency),
    );
    if (foreign.size === 0) return series;

    const rateIndex = await buildRateIndex(
      (sql, params) => manager.query(sql, params),
      foreign,
      reportCurrency,
      fromDate,
      todayYMD(),
    );
    const converted = new Map<string, PriceSeries>();
    for (const [securityId, points] of series) {
      const currency = currencyById.get(securityId);
      if (!currency || currency === reportCurrency) {
        converted.set(securityId, points);
        continue;
      }
      converted.set(
        securityId,
        points.flatMap((point) => {
          const close = convertAtDate(
            point.close,
            currency,
            reportCurrency,
            point.date,
            rateIndex,
            this.logger,
          );
          return close === null ? [] : [{ ...point, close }];
        }),
      );
    }
    return converted;
  }

  /**
   * Latest close per security, for valuing holdings -- but only where that
   * close is recent enough to stand for today.
   *
   * A security with no usable price is absent from the map so callers can tell
   * "not priced" from "worth zero". Absent now covers both a security nobody
   * has ever priced and one whose newest quote is older than
   * `BOUNDARY_LAG_DAYS`, because valuing a position at an arbitrarily old close
   * is the same error with a longer fuse. It fed `totalMarketValue`, the
   * transfer value, the realized gain and the tax estimate: 1,000 units of a
   * fund last quoted two years ago at 45 were reported as 45,000 to move and a
   * 25,000 gain to be taxed, with no warning anywhere, because the staleness
   * check the report does run only looks at the strategy's own roles and this
   * holding filled none of them.
   *
   * The same fortnight every other boundary in this module is held to
   * (`docs/time-series-contract.md` rule 2, `docs/financial-calculation-contract.md`
   * rule 4). The report's five-day `STALE_PRICES` banner is a softer, separate
   * signal: it says "this is getting old", where this says "this is not a
   * price of today at all".
   */
  async latestPrices(
    securityIds: string[],
    manager?: EntityManager,
    asOf: string = todayYMD(),
  ): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    if (securityIds.length === 0) return prices;
    const sql = `SELECT DISTINCT ON (security_id) security_id, close_price
                   FROM security_prices
                  WHERE security_id = ANY($1::uuid[])
                    AND close_price IS NOT NULL
                    AND price_date >= $2::date
                    AND price_date <= $3::date
                  ORDER BY security_id, price_date DESC`;
    const oldest = new Date(`${asOf}T00:00:00Z`);
    oldest.setUTCDate(oldest.getUTCDate() - BOUNDARY_LAG_DAYS);
    const params = [securityIds, oldest.toISOString().slice(0, 10), asOf];
    const rows: Array<{ security_id: string; close_price: string }> = manager
      ? await manager.query(sql, params)
      : await withScopedDb(this.dataSource, (m) => m.query(sql, params));
    for (const row of rows) {
      prices.set(row.security_id, Number(row.close_price));
    }
    return prices;
  }

  /**
   * Latest price date **per security**. A security with no price at all is
   * absent from the map, which is what tells "never priced" apart from
   * "priced, but a while ago".
   *
   * The report asks per security rather than for one aggregate because the
   * aggregate is a maximum: a US quote refreshed this morning hid an ex-US
   * instrument last priced three weeks ago, and hid one that had never been
   * priced entirely. A signal is only as current as its stalest input, and
   * naming which input that is turns the warning into something actionable.
   */
  async latestPriceDates(
    securityIds: string[],
    manager?: EntityManager,
  ): Promise<Map<string, string>> {
    const latest = new Map<string, string>();
    if (securityIds.length === 0) return latest;
    const sql = `SELECT security_id, MAX(price_date)::text AS latest
                   FROM security_prices
                  WHERE security_id = ANY($1::uuid[])
                    AND close_price IS NOT NULL
                  GROUP BY security_id`;
    const rows: Array<{ security_id: string; latest: string | null }> = manager
      ? await manager.query(sql, [securityIds])
      : await withScopedDb(this.dataSource, (m) => m.query(sql, [securityIds]));
    for (const row of rows) {
      if (row.latest) latest.set(row.security_id, row.latest);
    }
    return latest;
  }

  /**
   * Earliest close date per security. A security with no prices at all is
   * absent from the map, which is what tells "never priced" apart from "priced,
   * but not far enough back" when deciding whether history has to be fetched.
   */
  async earliestPriceDates(
    securityIds: string[],
    manager?: EntityManager,
  ): Promise<Map<string, string>> {
    const earliest = new Map<string, string>();
    if (securityIds.length === 0) return earliest;
    const sql = `SELECT security_id, MIN(price_date)::text AS earliest
                   FROM security_prices
                  WHERE security_id = ANY($1::uuid[])
                    AND close_price IS NOT NULL
                  GROUP BY security_id`;
    const rows: Array<{ security_id: string; earliest: string | null }> =
      manager
        ? await manager.query(sql, [securityIds])
        : await withScopedDb(this.dataSource, (m) =>
            m.query(sql, [securityIds]),
          );
    for (const row of rows) {
      if (row.earliest) earliest.set(row.security_id, row.earliest);
    }
    return earliest;
  }
}
