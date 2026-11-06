import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import {
  DataSource,
  EntityManager,
  FindOperator,
  MoreThanOrEqual,
  LessThanOrEqual,
  And,
} from "typeorm";
import { Cron } from "@nestjs/schedule";
import { ExchangeRate } from "./entities/exchange-rate.entity";
import { Currency, CurrencyKind } from "./entities/currency.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { mapWithConcurrency } from "../common/concurrency.util";
import { resolveFxRateOrNull, roundFxRate } from "../common/fx-entry.util";
import { roundMoney } from "../common/round.util";
import { addDaysYMD, todayYMD } from "../common/date-utils";
import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import {
  FetchSyncJob,
  FetchSyncService,
} from "../common/jobs/fetch-sync.service";
import {
  EmptyWindowMemory,
  monthFetchWindow,
} from "../common/time-series/history-fill";
import {
  FX_MAX_RATE_AGE_DAYS,
  FxRateMode,
  FxRateResolution,
  describeFxGap,
  fxReferenceDate,
  resolveFxRate,
} from "../common/time-series/fx-rate-resolver";
import { preferredCurrency } from "../common/default-currency.util";
import {
  IsCoin,
  NO_COINS,
  canonicalRateRefusal,
  canonicalRateRow,
  codeOrderedPair,
  isCanonicalOrientation,
} from "./canonical-rate.util";
import { loadCoinLookup } from "./coin-lookup";
import { loadCurrencyDecimalPlaces } from "./currency-decimal-places";
import { FxProviderChain } from "./providers/fx-provider-chain";
import { FxObservation } from "./providers/fx-provider.interface";

/**
 * Cap on concurrent window fills from a read path (`ensureRatesForDate`), so a
 * report short of many pairs does not burst them all at whichever provider
 * carries them. The daily refresh needs no cap of its own: it asks the chain
 * once per base currency, in sequence, and an adapter bounds its own fan-out
 * (`FX_FETCH_CONCURRENCY` in the Yahoo adapter).
 */
const FX_WINDOW_FILL_CONCURRENCY = 6;

/**
 * A pair key that does not distinguish direction, because neither the fetch nor
 * the storage does: one provider call answers USD->CAD and CAD->USD alike, and
 * the pair is stored once, so the two are one unit of work and one negative-cache
 * entry.
 *
 * Plain code order (`codeOrderedPair`), the order `exchange_rate_coverage`
 * keys a pair by, and deliberately not the storage orientation: a pair with one
 * coin side is stored coin -> fiat whichever code sorts first
 * (`isCanonicalOrientation`), but a key names the pair, not a direction, and
 * one that moved with `currencies.kind` would disagree with the coverage row
 * for the same pair.
 */
export function directionlessPairKey(from: string, to: string): string {
  const [first, second] = codeOrderedPair(from, to);
  return `${first}|${second}`;
}

/** Whether a `directionlessPairKey` names `code` on either side. */
export function pairKeyHasCode(pairKey: string, code: string): boolean {
  return pairKey.split("|").includes(code.toUpperCase());
}

/**
 * An inclusive `rate_date` range, both bounds as `YYYY-MM-DD` strings.
 *
 * The entity declares `rateDate: Date` because the column is a SQL `date`, but
 * the values that cross the driver in both directions are strings: `main.ts`
 * sets the `pg` DATE parser to hand the literal back unparsed, and a select-side
 * parameter is rendered by `pg` rather than normalised by TypeORM -- so a `Date`
 * bound is rendered in the process time zone and, west of UTC, names the
 * previous calendar day. The cast is to the declared column type only; the
 * comparison itself is string-to-date, which PostgreSQL resolves per calendar
 * date in every time zone.
 */
function ymdSpan(fromYmd: string, toYmd: string): FindOperator<Date> {
  return And(
    MoreThanOrEqual(fromYmd),
    LessThanOrEqual(toYmd),
  ) as unknown as FindOperator<Date>;
}

/**
 * One amount converted at the rate that applied on `date`. `rate` is
 * `fromCurrency -> toCurrency` at FX precision (10dp); `convertedAmount` is
 * money (4dp). `date` is the day whose rate was asked for, after clamping a
 * future date to today.
 */
export interface DatedConversion {
  amount: number;
  fromCurrency: string;
  toCurrency: string;
  date: string;
  rate: number;
  convertedAmount: number;
}

/** A currency in use, as the refresh reads it. */
interface CurrencyInUse {
  code: string;
  kind: CurrencyKind;
  quoteSymbol: string | null;
}

/**
 * The canonical pairs of `codes` (sorted) grouped by the code each is stored
 * under, keeping only the pairs `keep` admits and the bases left with a quote:
 * one chain question per base carrying every quote stored against it, because
 * a provider that publishes a whole base at once answers all of them in one
 * call, and one that quotes pair by pair fans out inside its adapter. Each
 * pair is oriented by `isCanonicalOrientation`, so a coin's pairs with a fiat
 * sit under the coin whichever code sorts first, and each base's quotes are
 * exactly the pairs stored under it. Bases come in the order their first pair
 * is met walking `codes` in order, quotes in `codes` order, so the question
 * order is the same on every replica.
 */
export function canonicalPairsByBase(
  codes: readonly string[],
  keep: (base: string, quote: string) => boolean,
  isCoin: IsCoin = NO_COINS,
): Array<{ base: string; quotes: string[] }> {
  const byBase = new Map<string, string[]>();
  for (const [i, a] of codes.entries()) {
    for (const b of codes.slice(i + 1)) {
      const [base, quote] = isCanonicalOrientation(a, b, isCoin)
        ? [a, b]
        : [b, a];
      if (!keep(base, quote)) continue;
      byBase.set(base, [...(byBase.get(base) ?? []), quote]);
    }
  }
  return [...byBase.entries()].map(([base, quotes]) => ({ base, quotes }));
}

export interface RateUpdateResult {
  pair: string;
  success: boolean;
  rate?: number;
  error?: string;
}

export interface RateRefreshSummary {
  totalPairs: number;
  updated: number;
  failed: number;
  results: RateUpdateResult[];
  lastUpdated: Date;
}

export interface HistoricalRateBackfillResult {
  pair: string;
  success: boolean;
  ratesLoaded: number;
  error?: string;
}

export interface HistoricalRateBackfillSummary {
  totalPairs: number;
  successful: number;
  failed: number;
  totalRatesLoaded: number;
  results: HistoricalRateBackfillResult[];
}

@Injectable()
export class ExchangeRateService implements OnModuleInit {
  private readonly logger = new Logger(ExchangeRateService.name);

  /** Pair-months the provider answered with nothing. See `EmptyWindowMemory`. */
  private readonly emptyRateWindows = new EmptyWindowMemory();

  constructor(
    private dataSource: DataSource,
    /**
     * The configured exchange rate providers behind one door. Every provider
     * question this service asks goes through here, so which provider answers
     * is `FX_PROVIDERS`' decision and a stored row's `source` is the answering
     * provider's own slug; nothing in this file names a provider (INV-FX-005).
     */
    private readonly fxProviders: FxProviderChain,
    private readonly fetchSync: FetchSyncService,
  ) {}

  /**
   * On application startup, check if exchange rates exist and are recent.
   * If not, trigger a refresh so currency conversions work immediately.
   *
   * RLS: a bootstrap hook has no request context, and everything this reads is
   * cross-user (the recency probe on the global exchange_rates table, then the
   * sweep for users holding foreign-currency accounts), so the whole body runs
   * under `withSystemContext` -- the same shape C2 gave the crons. The per-user
   * backfills it fans out are re-wrapped in `withUserContext` below.
   */
  async onModuleInit(): Promise<void> {
    await withSystemContext(() => this.checkRatesOnStartup());
  }

  /**
   * How long one replica holds the FX fetch.
   *
   * Comfortably longer than a refresh takes and comfortably shorter than the
   * daily cron's interval, so a replica killed mid-fetch never blocks the next
   * day's tick: the expiry alone hands the job back.
   */
  private readonly FETCH_LEASE_MS = 15 * 60 * 1000;

  private async checkRatesOnStartup(): Promise<void> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Check for rates within the last 3 days (covers weekends — Friday rates still valid on Monday)
      const cutoff = new Date(today);
      cutoff.setDate(cutoff.getDate() - 3);

      const recentRate = await withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(ExchangeRate).findOne({
          where: { rateDate: MoreThanOrEqual(cutoff) },
        }),
      );

      if (!recentRate) {
        // A rollout of N pods all find no recent rate and all fetch. The lease
        // is what makes that one fetch; the per-user historical backfills below
        // stay outside it, because they are per user, cheap, and already
        // idempotent.
        const fetched = await this.fetchSync.withLease(
          FetchSyncJob.ExchangeRates,
          this.FETCH_LEASE_MS,
          async () => {
            this.logger.log(
              "No recent exchange rates found — fetching rates on startup",
            );
            const summary = await this.refreshAllRates();
            this.logger.log(
              `Startup rate refresh: ${summary.updated} updated, ${summary.failed} failed`,
            );
          },
        );
        if (!fetched) {
          this.logger.log(
            "Startup rate refresh is being done by another replica",
          );
        }
      } else {
        this.logger.log("Exchange rates are up to date");
      }
      // Check if historical rates need backfilling for any user's accounts or securities
      const usersWithForeignAccounts: Array<{ user_id: string }> =
        await withScopedDb(this.dataSource, (manager) =>
          manager.query(
            `SELECT DISTINCT user_id FROM (
             SELECT a.user_id
             FROM accounts a
             INNER JOIN user_preferences up ON up.user_id = a.user_id
             WHERE a.is_closed = false
               AND a.currency_code != up.default_currency
             UNION
             SELECT a.user_id
             FROM securities s
             INNER JOIN holdings h ON h.security_id = s.id
             INNER JOIN accounts a ON a.id = h.account_id AND a.is_closed = false
             INNER JOIN user_preferences up ON up.user_id = a.user_id
             WHERE s.currency_code != up.default_currency
               AND s.is_active = true
               AND h.quantity > 0
           ) sub`,
          ),
        );

      for (const { user_id } of usersWithForeignAccounts) {
        withUserContext(user_id, () =>
          this.backfillHistoricalRates(user_id),
        ).catch((err) =>
          this.logger.warn(
            `Startup historical rate backfill failed for user ${user_id}: ${err.message}`,
          ),
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to check/refresh exchange rates on startup: ${error.message}`,
      );
    }
  }

  /**
   * An observation as the `from -> to` rate that was asked about. The chain
   * answers in whichever orientation the provider quoted, so a reverse
   * observation is reciprocated here at the rate column's precision. A pair
   * nothing answered never reaches this: the chain hands back no observation
   * (null) for it and the caller reports the pair as unknown, never as 1.
   */
  private rateAsAsked(from: string, observation: FxObservation): number {
    if (observation.from === from) return observation.rate;
    const reverse = observation.rate;
    return roundFxRate(1 / reverse);
  }

  /**
   * Save or update one provider observation, in the one orientation the pair is
   * stored in, dated by the observation and attributed to `source`, the slug of
   * the provider that made it.
   *
   * One row, not two. The inverse row that used to be written beside it existed
   * so a reverse lookup would find something, but nothing kept the pair
   * reciprocal, and a write that touched one side only left two rows disagreeing
   * about one date (`canonicalRateRow`, INV-FX-003). Every reader resolves either
   * direction through `resolveFxRate`, so the reverse lookup loses nothing.
   *
   * The date is the provider's, not the refresh's (plan decision 5): a reference
   * rate published for Friday is Friday's row whichever day the refresh runs,
   * and no row is written for a day the provider published nothing. `source`
   * arrives beside the observation from the chain; this file knows no
   * provider's name (INV-FX-005).
   *
   * `isCoin` is the refresh's own reading of `currencies.kind` for the codes in
   * use, so a coin pair is stored coin -> fiat (`isCanonicalOrientation`)
   * without a second read per pair.
   */
  private async saveRate(
    observation: FxObservation,
    source: string,
    isCoin: IsCoin,
  ): Promise<ExchangeRate> {
    const { from, to, rate, date } = observation;
    const row = canonicalRateRow(from, to, rate, isCoin);
    if (row === null) {
      // A same-currency pair or a non-positive rate: absent, not applicable.
      // A rate the column cannot hold (at or above 1e10, or nothing at ten
      // decimals) is reported as out of range. Refused before the write rather
      // than stored as a rate nothing may use; the refresh reports this one
      // pair and carries on with the rest.
      if (canonicalRateRefusal(from, to, rate, isCoin) === "out_of_range") {
        throw new Error(
          `Rate out of range: ${from}/${to} at ${rate} for ${date} does not fit the rate column`,
        );
      }
      throw new Error(
        `Refusing to store exchange rate ${from}/${to} at ${rate} for ${date}`,
      );
    }
    return withScopedDb(this.dataSource, (manager) =>
      this.upsertCanonicalRate(
        manager,
        row.from,
        row.to,
        row.rate,
        date,
        source,
      ),
    );
  }

  /**
   * Upsert one row whose orientation `canonicalRateRow` has already decided,
   * under the caller's coin lookup (`saveRate`). The codes arrive canonical;
   * this does not re-order them. `date` is a
   * `YYYY-MM-DD` string cast by PostgreSQL: a `Date` here would be rendered by
   * `pg` in the process time zone and, west of UTC, name the previous calendar
   * day (`ymdSpan` explains the same trap on the read side).
   */
  private async upsertCanonicalRate(
    manager: EntityManager,
    from: string,
    to: string,
    rate: number,
    date: string,
    source: string,
  ): Promise<ExchangeRate> {
    // One statement, arbitrated by `UNIQUE(from_currency, to_currency,
    // rate_date)`. This used to be a `findOne` and then either a save of the
    // found row or an insert -- a check-then-act, and one every replica runs:
    // the exchange-rate cron fires everywhere at 5:05 PM ET, so two processes
    // routinely fetch the same pair for the same day, both find no row, and both
    // insert. The loser got a unique violation and the refresh reported a pair
    // it had in fact fetched as failed.
    //
    // `persistRateSeries` a few lines below already did it this way; the two are
    // now consistent, which matters because they write the same rows.
    const rows: unknown = await manager.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
       VALUES ($1, $2, $3::DATE, $4, $5)
       ON CONFLICT (from_currency, to_currency, rate_date) DO UPDATE SET
         rate = EXCLUDED.rate,
         source = EXCLUDED.source
       RETURNING id`,
      [from, to, date, rate, source],
    );

    // `DO UPDATE` always returns the row, so a read-back is only needed to hand
    // the caller an entity. Scoped by the id just written rather than by the
    // triple, so it cannot pick up a different row.
    const id = returnedRows<{ id: number }>(rows)[0]?.id;
    const saved = id
      ? await manager.getRepository(ExchangeRate).findOne({ where: { id } })
      : null;
    if (!saved) {
      // Nothing else can make an upsert return no row, so this is a real fault
      // rather than a state to paper over with a synthesized entity.
      throw new Error(
        `Failed to persist exchange rate ${from}/${to} for ${date}`,
      );
    }
    return saved;
  }

  /**
   * Bulk-upsert a daily series of observations for one pair, one row per day in
   * the pair's canonical orientation, every row attributed to `source`.
   *
   * A provider call returns a whole daily series for the period asked for, and
   * costs the same whether that is one day or a hundred. Persisting only the
   * day that was wanted threw the rest away and sent the next lookup for a
   * neighbouring date straight back out to the provider -- which is how a user
   * stepping a date field backwards ran into rate limits. Storing the series
   * makes one call cover the whole window.
   *
   * The points may arrive in either orientation, and in both at once: a chain
   * answer may merge a provider's direct and reverse symbols, and
   * `canonicalRateRow` orients each point from its own `from`/`to`, so a window
   * fetched as `USD->CAD` and one fetched as `CAD->USD` land on the same rows
   * rather than on two sets that can drift apart (INV-FX-003). One row per day,
   * the last point for a day winning.
   */
  private async persistRateSeries(
    points: readonly FxObservation[],
    source: string,
  ): Promise<number> {
    if (points.length === 0) return 0;
    return withScopedDb(this.dataSource, async (manager) => {
      // Which codes are coins, read once for the whole series: a pair with one
      // coin side is stored coin -> fiat (`isCanonicalOrientation`).
      const isCoin = await loadCoinLookup(manager);

      // One row per canonical triple, last value wins, ignoring anything unusable.
      const byDay = new Map<string, [string, string, string, number]>();
      let outOfRange = 0;
      for (const point of points) {
        const row = canonicalRateRow(point.from, point.to, point.rate, isCoin);
        if (row === null) {
          // A same-currency point or a non-positive rate: absent, not a rate. A
          // rate the column cannot hold is skipped and counted, never allowed
          // to fail the statement for the rest of the window.
          if (
            canonicalRateRefusal(point.from, point.to, point.rate, isCoin) ===
            "out_of_range"
          ) {
            outOfRange++;
          }
          continue;
        }
        byDay.set(`${row.from}|${row.to}|${point.date}`, [
          row.from,
          row.to,
          point.date,
          row.rate,
        ]);
      }
      if (outOfRange > 0) {
        this.logger.warn(
          `Skipped ${outOfRange} exchange rate observation(s) out of range for the rate column (${source})`,
        );
      }
      const rows = [...byDay.values()];
      if (rows.length === 0) return 0;

      const batchSize = 500;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const values = batch
          .map((_, idx) => {
            const offset = idx * 5;
            return `($${offset + 1}, $${offset + 2}, $${offset + 3}::DATE, $${offset + 4}, $${offset + 5})`;
          })
          .join(", ");
        const params: Array<string | number> = [];
        for (const [f, t, date, rate] of batch) {
          params.push(f, t, date, rate, source);
        }

        await manager.query(
          `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
           VALUES ${values}
           ON CONFLICT (from_currency, to_currency, rate_date) DO UPDATE SET
             rate = EXCLUDED.rate,
             source = EXCLUDED.source`,
          params,
        );
      }

      return rows.length;
    });
  }

  /**
   * Store a daily series that did not come through the chain -- the demo
   * seed's coin rates -- under the `source` the caller names, through the same
   * writer as a fetched window: each point in its pair's one orientation
   * (`canonicalRateRow`, INV-FX-003), one row per day, the last point for a
   * day winning and replacing what the day held. Answers how many rows it
   * wrote. Not for a provider's observations, which reach the table through
   * the refresh and the window fills.
   */
  async storeRateSeries(
    points: readonly FxObservation[],
    source: string,
  ): Promise<number> {
    return this.persistRateSeries(points, source);
  }

  /**
   * Refresh exchange rates for all currencies in use
   */
  /**
   * Refresh every currency pair in use across the deployment.
   *
   * Global by definition: `exchange_rates` is shared reference data, and the pair
   * set is assembled from every user's accounts, securities and default currency.
   * The system context therefore belongs here, not at the call sites -- left to the
   * caller's ambient identity, the manual endpoint spans all users at
   * RLS_MODE=off and silently narrows to the caller's own currencies at enforce,
   * so the same button would mean two different things. A nested system context
   * from the cron is the same identity and joins.
   */
  async refreshAllRates(): Promise<RateRefreshSummary> {
    return withSystemContext(() => this.refreshRatesGlobally("all"));
  }

  /**
   * Refresh only the pairs in use with a CRYPTO currency on at least one side
   * (`docs/specs/crypto-accounts.md`, decision 6): the weekend tick's body. A
   * coin trades every day, while Frankfurter publishes no weekend rate and a
   * fiat pair cannot have moved, so the fiat pairs are not asked. The weekday
   * refresh (`refreshAllRates`) already covers the crypto pairs. Global for the
   * same reason as `refreshAllRates`.
   */
  async refreshCryptoRates(): Promise<RateRefreshSummary> {
    return withSystemContext(() => this.refreshRatesGlobally("crypto"));
  }

  /**
   * Every currency in use across the deployment, with the kind and price
   * symbol the refresh reports a coin's missing symbol by: account currencies,
   * security currencies for active holdings, and every user's preferred
   * default currency. Including defaults ensures we fetch (CAD, GBP) even when
   * the user has no GBP-denominated accounts -- otherwise their GBP totals
   * would silently fall back to unconverted CAD values. Sorted, so the pair set
   * and the order the chain is asked in are the same on every replica and
   * every run rather than whatever order the query returned.
   */
  private async currenciesInUse(): Promise<CurrencyInUse[]> {
    const rows: Array<{
      code: string;
      kind?: string | null;
      quoteSymbol?: string | null;
    }> = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT DISTINCT code, c.kind, c.quote_symbol AS "quoteSymbol" FROM (
         SELECT currency_code AS code FROM accounts WHERE is_closed = false
         UNION
         SELECT s.currency_code AS code
         FROM securities s
         INNER JOIN holdings h ON h.security_id = s.id
         INNER JOIN accounts a ON a.id = h.account_id AND a.is_closed = false
         WHERE s.is_active = true AND h.quantity > 0
         UNION
         SELECT default_currency AS code FROM user_preferences
         WHERE default_currency IS NOT NULL
       ) sub
       LEFT JOIN currencies c USING (code)`,
      ),
    );
    const byCode = new Map<string, CurrencyInUse>();
    for (const row of rows) {
      if (byCode.has(row.code)) continue;
      byCode.set(row.code, {
        code: row.code,
        kind: row.kind === "CRYPTO" ? "CRYPTO" : "FIAT",
        quoteSymbol: row.quoteSymbol ?? null,
      });
    }
    return [...byCode.values()].sort((a, b) =>
      a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
    );
  }

  private async refreshRatesGlobally(
    scope: "all" | "crypto",
  ): Promise<RateRefreshSummary> {
    const startTime = Date.now();
    this.logger.log(
      scope === "crypto"
        ? "Starting cryptocurrency exchange rate refresh"
        : "Starting exchange rate refresh",
    );

    const inUse = await this.currenciesInUse();
    const codes = inUse.map((currency) => currency.code);
    const byCode = new Map(inUse.map((currency) => [currency.code, currency]));
    this.logger.log(`Currencies in use: ${codes.join(", ")}`);

    const isCoin = (code: string) => byCode.get(code)?.kind === "CRYPTO";
    const byBase = canonicalPairsByBase(
      codes,
      (base, quote) => (scope === "all" ? true : isCoin(base) || isCoin(quote)),
      isCoin,
    );
    if (byBase.length === 0) {
      return {
        totalPairs: 0,
        updated: 0,
        failed: 0,
        results: [],
        lastUpdated: new Date(),
      };
    }
    const totalPairs = byBase.reduce((n, { quotes }) => n + quotes.length, 0);

    /**
     * The coin side of a pair no provider carries because the coin has no
     * price symbol: the repair is on the Currencies page, not in
     * `FX_PROVIDERS` (spec section 7). `null` for any other uncarried pair.
     */
    const unmappedCoin = (base: string, quote: string): string | null =>
      [base, quote].find(
        (code) => isCoin(code) && byCode.get(code)?.quoteSymbol == null,
      ) ?? null;
    const results: RateUpdateResult[] = [];
    let updated = 0;
    let failed = 0;

    // Bases in sequence. The chain is asked once per base and an adapter bounds
    // its own fan-out, so this loop is not where the provider load is shaped.
    for (const { base, quotes } of byBase) {
      const answer = await this.fxProviders.latest(base, quotes);
      for (const quote of quotes) {
        const pairLabel = `${base}/${quote}`;
        const observation = answer.found.get(quote);

        if (observation === undefined) {
          // Three reports with three repairs, kept apart: a quote no carrying
          // provider answered is an outage the next tick retries; one answered
          // without a rate resolves from the last admissible day or stays
          // unknown, never at a guessed figure; a pair no configured provider
          // carries is a fact about `FX_PROVIDERS` for the operator to act on.
          const coin = unmappedCoin(base, quote);
          const error = answer.unanswered.includes(quote)
            ? "No provider answered"
            : answer.uncarried.includes(quote)
              ? coin !== null
                ? `${coin} has no price symbol; map one on the Currencies page`
                : `No configured provider carries ${pairLabel}`
              : "No rate data available";
          results.push({ pair: pairLabel, success: false, error });
          failed++;
          continue;
        }

        try {
          // Saved in the orientation the provider quoted and on the date it
          // published; `saveRate` stores it in the pair's one canonical
          // orientation under the provider's own source slug.
          await this.saveRate(observation, observation.source, isCoin);
          results.push({
            pair: pairLabel,
            success: true,
            rate: this.rateAsAsked(base, observation),
          });
          updated++;
        } catch (error) {
          results.push({
            pair: pairLabel,
            success: false,
            error: error.message,
          });
          failed++;
        }
      }
    }

    const duration = Date.now() - startTime;
    this.logger.log(
      `${scope === "crypto" ? "Cryptocurrency exchange rate" : "Exchange rate"} refresh completed in ${duration}ms: ${updated} updated, ${failed} failed`,
    );

    return {
      totalPairs,
      updated,
      failed,
      results,
      lastUpdated: new Date(),
    };
  }

  /**
   * Backfill historical exchange rates for accounts with non-default currencies.
   * Fetches daily rates from the earliest transaction date to today.
   *
   * @param userId - The user whose default currency determines the conversion target
   * @param accountIds - Optional list of account IDs to scope the backfill (e.g. post-import)
   */
  async backfillHistoricalRates(
    userId: string,
    accountIds?: string[],
  ): Promise<HistoricalRateBackfillSummary> {
    const startTime = Date.now();
    this.logger.log("Starting historical exchange rate backfill");

    // 1. Get user's default currency
    const pref = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(UserPreference).findOne({
        where: { userId },
      }),
    );
    const defaultCurrency = preferredCurrency(pref);

    // 2. Find non-default currencies and their earliest transaction dates
    //    Includes both account currencies AND security currencies held in those accounts
    let accountFilter = "";
    const params: any[] = [defaultCurrency];

    if (accountIds && accountIds.length > 0) {
      accountFilter = `AND a.id = ANY($2::UUID[])`;
      params.push(accountIds);
    }

    // Both discovery queries read from one snapshot -- they feed a single
    // pair->earliest-date map, so a row appearing between them would skew it.
    const [accountCurrencyRows, securityCurrencyRows] = await withScopedDb(
      this.dataSource,
      async (manager) => {
        // Query 1: Account-level currencies (accounts in a non-default currency)
        const accountRows: Array<{
          currency_code: string;
          earliest: string;
        }> = await manager.query(
          `SELECT a.currency_code,
              LEAST(
                (SELECT MIN(t.transaction_date) FROM transactions t WHERE t.account_id = a.id),
                (SELECT MIN(it.transaction_date) FROM investment_transactions it WHERE it.account_id = a.id AND it.status != 'VOID')
              )::TEXT AS earliest
       FROM accounts a
       WHERE a.currency_code != $1
         AND a.is_closed = false
         ${accountFilter}`,
          params,
        );

        // Query 2: Security-level currencies (securities in a non-default currency held in active accounts)
        const securityRows: Array<{
          currency_code: string;
          earliest: string;
        }> = await manager.query(
          `SELECT DISTINCT s.currency_code,
              (SELECT MIN(it.transaction_date)::TEXT
               FROM investment_transactions it
               WHERE it.security_id = s.id
                 AND it.status != 'VOID') AS earliest
       FROM securities s
       INNER JOIN holdings h ON h.security_id = s.id
       INNER JOIN accounts a ON a.id = h.account_id AND a.is_closed = false
       WHERE s.currency_code != $1
         AND s.is_active = true
         AND h.quantity > 0
         ${accountFilter ? `AND h.account_id = ANY($2::UUID[])` : ""}`,
          params,
        );

        return [accountRows, securityRows] as const;
      },
    );

    // 3. Determine unique currency pairs and the global earliest date per pair.
    //    `earliest` is the DATE as text (`::TEXT` in both queries), compared as
    //    the calendar day it names rather than parsed into a local-midnight
    //    `Date` and read back through the process time zone.
    const pairEarliest = new Map<string, string>();
    const allRows = [...accountCurrencyRows, ...securityCurrencyRows];
    for (const row of allRows) {
      if (!row.earliest) continue;
      const pairKey = `${row.currency_code}->${defaultCurrency}`;
      const earliest = row.earliest.slice(0, 10);
      const existing = pairEarliest.get(pairKey);
      if (!existing || earliest < existing) {
        pairEarliest.set(pairKey, earliest);
      }
    }

    if (pairEarliest.size === 0) {
      this.logger.log("No currency pairs require historical backfill");
      return {
        totalPairs: 0,
        successful: 0,
        failed: 0,
        totalRatesLoaded: 0,
        results: [],
      };
    }

    this.logger.log(
      `Currency pairs to backfill: ${Array.from(pairEarliest.keys()).join(", ")}`,
    );

    // 4. Fetch and store historical rates for each pair
    const results: HistoricalRateBackfillResult[] = [];
    let successful = 0;
    let failed = 0;
    let totalRatesLoaded = 0;

    for (const [pairKey, earliest] of pairEarliest.entries()) {
      const [from, to] = pairKey.split("->");

      // Skip if we already have historical rates for this pair, in either
      // direction: a pair is stored once, so asking only about `from->to` reads
      // a pair held the other way as uncovered and re-fetches it from the
      // provider on every run, forever. `readCoverage` asks the same way.
      const existingRates = await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `SELECT COUNT(*)::INT AS count FROM exchange_rates
         WHERE (from_currency = $1 AND to_currency = $2)
            OR (from_currency = $2 AND to_currency = $1)`,
          [from, to],
        ),
      );

      if (existingRates[0]?.count > 0) {
        results.push({ pair: `${from}/${to}`, success: true, ratesLoaded: 0 });
        successful++;
        continue;
      }

      // One question to the chain over the span the user's data covers, from
      // the earliest transaction through today. An adapter clips its answer to
      // the window, so the date filter this loop applied over a whole-history
      // download went with the download.
      const { points, answered, source } = await this.fxProviders.dailySeries(
        from,
        to,
        earliest,
        todayYMD(),
      );

      if (points.length === 0 || source === null) {
        // Two reports, kept apart: a carrying provider that did not answer is an
        // outage the next startup retries; providers that answered with nothing
        // have no history for this pair over the span, and nothing here can
        // supply it. Neither is a reason to invent a rate (INV-FX-001).
        results.push({
          pair: `${from}/${to}`,
          success: false,
          ratesLoaded: 0,
          error: answered
            ? "No historical data available"
            : "A provider did not answer",
        });
        failed++;
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }

      try {
        // The same bulk upsert the single-date lookup uses, oriented row by row
        // and attributed to the provider that answered.
        const ratesLoaded = await this.persistRateSeries(points, source);

        this.logger.log(
          `Backfilled ${ratesLoaded} rates for ${from}/${to} (from ${earliest})`,
        );
        results.push({
          pair: `${from}/${to}`,
          success: true,
          ratesLoaded,
        });
        successful++;
        totalRatesLoaded += ratesLoaded;
      } catch (error) {
        this.logger.error(
          `Failed to save historical rates for ${from}/${to}: ${error.message}`,
        );
        results.push({
          pair: `${from}/${to}`,
          success: false,
          ratesLoaded: 0,
          error: error.message,
        });
        failed++;
      }

      // Small delay between pairs to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const duration = Date.now() - startTime;
    this.logger.log(
      `Historical rate backfill completed in ${duration}ms: ${successful} successful, ${failed} failed, ${totalRatesLoaded} total rates`,
    );

    return {
      totalPairs: pairEarliest.size,
      successful,
      failed,
      totalRatesLoaded,
      results,
    };
  }

  /**
   * Make sure the stored series can answer `date` for each pair, fetching from
   * the provider the ones it cannot.
   *
   * The daily refresh only ever writes today, and `backfillHistoricalRates`
   * skips a pair the moment it has *any* row -- so a user whose USD/CAD history
   * starts at their import has nothing at all for 2017, and a point-in-time
   * report asked about that year cannot present a USD account in CAD or value a
   * USD holding inside a CAD brokerage. Neither is a number to guess at: the
   * report reports the pair as missing and the total goes null, which is what
   * the user sees as "Total unavailable". The rates are simply not there yet,
   * so this fetches them.
   *
   * **The unit is a calendar month, not a day.** One provider call returns the
   * whole daily series for whatever period it is asked for and costs the same
   * either way, so asking for the month around `date` -- plus
   * `BOUNDARY_LAG_DAYS` of lead, which is the span `closeAt` may reach back
   * over, so the first days of the month are answerable too -- makes every
   * other date in that month a database read. A user stepping a report back
   * through a year pays twelve calls per pair rather than three hundred.
   *
   * Best-effort by construction: it is called from a read path, so a provider
   * failure is logged and the report renders with the pair still missing rather
   * than the request failing. Callers decide which pairs are missing; this does
   * not re-check the database, and it never invents a rate -- a pair the
   * provider has no data for stays absent.
   *
   * Returns the number of daily observations persisted.
   */
  async ensureRatesForDate(
    pairs: ReadonlyArray<{ from: string; to: string }>,
    date: string,
  ): Promise<number> {
    // A pair is stored once, whichever way it was asked for, so USD->CAD and
    // CAD->USD are the same piece of work and must not be fetched twice.
    const wanted = new Map<string, { from: string; to: string }>();
    for (const pair of pairs) {
      if (!pair.from || !pair.to || pair.from === pair.to) continue;
      const key = directionlessPairKey(pair.from, pair.to);
      if (!wanted.has(key)) wanted.set(key, pair);
    }
    if (wanted.size === 0) return 0;

    const month = date.slice(0, 7);
    const due = [...wanted.entries()].filter(
      ([key]) => !this.emptyRateWindows.has(key, month),
    );
    if (due.length === 0) return 0;

    const [start, end] = monthFetchWindow(date);
    this.logger.log(
      `Fetching historical rates for ${due.map(([, p]) => `${p.from}/${p.to}`).join(", ")} over ${start} to ${end}`,
    );

    const loaded = await mapWithConcurrency(
      due,
      FX_WINDOW_FILL_CONCURRENCY,
      async ([key, pair]) => {
        try {
          const { stored, answered, carried } = await this.fillRateWindow(
            pair.from,
            pair.to,
            start,
            end,
          );
          // An uncarried pair (a coin with no price symbol) was asked of
          // nobody: remembering its window would outlive the symbol the reader
          // maps next, and forgetting it costs no provider call.
          if (stored === 0 && answered && carried !== false) {
            // Nothing exists for this pair in this era -- a currency that
            // predates the provider's history, or one it does not carry. Note
            // it, so a report reloaded on the same date does not re-ask.
            //
            // Only when the provider actually answered: a refusal and a
            // transport failure produce the same zero, and this memory holds
            // for 30 minutes -- long enough for a two-minute outage to leave
            // every foreign-currency total in the report null well after the
            // provider came back. The fill reports it, because it is the one
            // that saw the response.
            this.emptyRateWindows.remember(key, month);
            this.logger.warn(
              `No historical rates available for ${pair.from}/${pair.to} over ${start} to ${end}`,
            );
          }
          return stored;
        } catch (error) {
          this.logger.warn(
            `Historical rate fetch ${pair.from}->${pair.to} over ${start} to ${end} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return 0;
        }
      },
    );

    return loaded.reduce((sum, count) => sum + count, 0);
  }

  /**
   * Forget this process's on-demand empty windows for every pair with `code`
   * on either side, because what prices `code` changed (a coin's price symbol
   * set or re-pointed). Through `ExchangeRateHistoryService.forgetEmptyWindowsFor`.
   */
  forgetEmptyRateWindowsFor(code: string): void {
    this.emptyRateWindows.forgetSubjects((pair) => pairKeyHasCode(pair, code));
  }

  /**
   * One pair, one window, persisted in the pair's canonical orientation under
   * the answering provider's source.
   *
   * One question to the chain. Which provider answers, and how -- the Yahoo
   * adapter asks its direct symbol, then the reverse when the direct answer is
   * empty or sparse, and merges the two densest first -- is the chain's and the
   * adapters' business. What comes back is a series in whichever orientations
   * answered, which `persistRateSeries` orients row by row, so a window fetched
   * either way lands on the same rows (INV-FX-003).
   *
   * @returns the number of observations persisted, and whether the window was
   *   *answered*: a provider found observations, every carrying provider
   *   answered with nothing, or no configured provider carries the pair. It is
   *   `false` the moment a carrying provider did not answer and nothing was
   *   found, because that provider may hold history the others do not
   *   (INV-FX-005). Only an answered window may be remembered as empty: an
   *   outage and an empty window produce the same zero, and the memory holds
   *   for 30 minutes. And whether the pair is *carried* (`FxDailySeriesResult`):
   *   `false` when no provider that may be asked carries it, which is a fact
   *   about the configuration and the coin's mapping rather than about any
   *   provider's history, so a caller remembers no empty window and records no
   *   coverage for it.
   *
   * Public so `ExchangeRateHistoryService` can reach it: a user-driven history
   * extension asks the chain exactly the question the on-demand fill asks, and
   * a second copy of "fetch a window and persist it" is how the two would drift.
   */
  async fillRateWindow(
    from: string,
    to: string,
    start: string,
    end: string,
  ): Promise<{ stored: number; answered: boolean; carried: boolean }> {
    const { points, answered, carried, source } =
      await this.fxProviders.dailySeries(from, to, start, end);
    if (points.length === 0 || source === null) {
      return { stored: 0, answered, carried };
    }
    return {
      stored: await this.persistRateSeries(points, source),
      answered,
      carried,
    };
  }

  /**
   * The current rate of every pair, one row per directionless pair.
   *
   * The answer `resolveFxRate` gives in `live` mode, listed rather than asked
   * for: the newest observation of either stored direction that is inside
   * `FX_MAX_RATE_AGE_DAYS` of today, and nothing for a pair whose newest row is
   * older (a rate is a price; a nine-month-old one does not describe today). A
   * tie on the date goes to the canonical orientation, so the choice never
   * depends on row order.
   *
   * One row per pair, not one per stored direction, because a database upgraded
   * from before 1.17 holds a frozen mirror row (`USD->CAD`) beside the canonical
   * row the refresh keeps current (`CAD->USD`), and a direct-first reader of a
   * list that carried both took the frozen one (INV-FX-001, INV-FX-003).
   *
   * The bound is a `YYYY-MM-DD` string compared with the row's date, never a
   * `Date` (see `ymdSpan`). The query still takes the newest row per stored
   * direction, so it returns at most two rows per pair whatever the history.
   */
  async getLatestRates(): Promise<ExchangeRate[]> {
    const today = todayYMD();
    const oldest = addDaysYMD(today, -FX_MAX_RATE_AGE_DAYS);
    // `live` mode may take an observation from after today inside the same bound.
    const newest = addDaysYMD(today, FX_MAX_RATE_AGE_DAYS);
    const { rows, isCoin } = await withScopedDb(
      this.dataSource,
      async (manager) => ({
        rows: await manager
          .getRepository(ExchangeRate)
          .createQueryBuilder("er")
          .distinctOn(["er.from_currency", "er.to_currency"])
          .orderBy("er.from_currency")
          .addOrderBy("er.to_currency")
          .addOrderBy("er.rate_date", "DESC")
          .getMany(),
        // The tie goes to the orientation the pair is stored in now, which
        // for a coin pair is coin -> fiat (`isCanonicalOrientation`).
        isCoin: await loadCoinLookup(manager),
      }),
    );

    const chosen = new Map<string, { row: ExchangeRate; date: string }>();
    for (const row of rows) {
      // Zero and negative are absent, not applicable (`resolveFxRate`).
      if (!(Number(row.rate) > 0)) continue;
      const date =
        row.rateDate instanceof Date
          ? row.rateDate.toISOString().slice(0, 10)
          : String(row.rateDate).slice(0, 10);
      if (date < oldest || date > newest) continue;
      const key = directionlessPairKey(row.fromCurrency, row.toCurrency);
      const held = chosen.get(key);
      if (
        held === undefined ||
        date > held.date ||
        (date === held.date &&
          isCanonicalOrientation(row.fromCurrency, row.toCurrency, isCoin))
      ) {
        chosen.set(key, { row, date });
      }
    }
    return [...chosen.values()]
      .map(({ row }) => row)
      .sort(
        (a, b) =>
          a.fromCurrency.localeCompare(b.fromCurrency) ||
          a.toCurrency.localeCompare(b.toCurrency),
      );
  }

  /**
   * The latest stored rate for a pair, in whichever direction it is stored.
   *
   * Both directions are read and `resolveFxRate` chooses between them, so this
   * answers the same question as every other lookup rather than a
   * direction-specific one of its own. It used to read the stored pair one way
   * only, returning `null` whenever the pair happened to be held the other way
   * -- harmless while every fetch wrote a mirror row, and a silent gap once a
   * pair is stored once (INV-FX-003). The posting fallbacks and the
   * scheduled-estimate refresh were the callers that went unanswered.
   */
  async getLatestRate(
    from: string,
    to: string,
    /**
     * Reject a stored rate older than this many days, returning null instead.
     *
     * Omitted, `FX_MAX_RATE_AGE_DAYS` applies, like every other rate lookup. A
     * rate is a price: one from nine months ago converts a 10,000 USD holding
     * into a confident PLN total that is off by the year's currency move, with
     * nothing in the payload saying so (`docs/financial-calculation-contract.md`
     * rules 3 and 4). A caller that really wants a different bound passes it;
     * none asks for an unbounded answer.
     */
    maxAgeDays: number = FX_MAX_RATE_AGE_DAYS,
  ): Promise<number | null> {
    if (from === to) return 1;
    const today = todayYMD();
    // The age bound on the query as well as in the resolver: the resolver
    // decides admissibility, this just keeps the rows it reads bounded. A
    // calendar step, not a local-midnight `Date` read back through `toISOString`.
    // `MoreThanOrEqual` stays spelled out here rather than behind a helper:
    // `price-boundary.one-door.spec.ts` reads the lower bound of a newest-row
    // read off the lines around the ordering, and a bound it cannot see is a
    // bound the next reader cannot see either. The string cast is what
    // `ymdSpan` explains -- a `Date` bound is rendered by `pg` in the process
    // time zone and, west of UTC, names the previous calendar day.
    const bound = {
      rateDate: MoreThanOrEqual(
        addDaysYMD(today, -maxAgeDays),
      ) as unknown as FindOperator<Date>,
    };
    const [direct, reverse] = await withScopedDb(
      this.dataSource,
      async (manager) => {
        const repo = manager.getRepository(ExchangeRate);
        const newest = (f: string, t: string) =>
          repo.findOne({
            where: { fromCurrency: f, toCurrency: t, ...bound },
            order: { rateDate: "DESC" },
          });
        return [await newest(from, to), await newest(to, from)] as const;
      },
    );

    const observed = (row: ExchangeRate | null) => {
      if (row === null) return undefined;
      const date =
        row.rateDate instanceof Date
          ? row.rateDate.toISOString().slice(0, 10)
          : String(row.rateDate).slice(0, 10);
      return [{ date, rate: Number(row.rate) }];
    };

    // `live`: the freshest observation rather than one dated on or before today,
    // which is what "the latest rate" has always meant here, under the same age
    // bound as every other lookup.
    return resolveFxRate(
      from,
      to,
      today,
      (f, t) => (f === from && t === to ? observed(direct) : observed(reverse)),
      {
        mode: "live",
        maxAgeDays,
        today,
      },
    ).rate;
  }

  /**
   * The stored observations that could price `onDate`, resolved through the one
   * door (`resolveFxRate`).
   *
   * This is the shared stored-rate step behind `getRateForDate` and any caller
   * that needs the *whole* answer -- the observation's own date, the direction
   * it was stored in, and the reason there is none -- rather than a bare
   * number. Only the admissible span is read (`FX_MAX_RATE_AGE_DAYS` back from
   * the clamped date, both directions), which is what stops one ancient row
   * standing in for a date it says nothing about and, equally, stops that row
   * short-circuiting the provider fetch that would have filled the gap.
   */
  async resolveStoredRate(
    from: string,
    to: string,
    onDate: string,
    options?: { mode?: FxRateMode; maxAgeDays?: number },
  ): Promise<FxRateResolution> {
    const mode = options?.mode ?? "historical";
    const maxAgeDays = options?.maxAgeDays ?? FX_MAX_RATE_AGE_DAYS;
    const today = todayYMD();

    if (!from || !to || from === to) {
      return resolveFxRate(from, to, onDate, () => undefined, {
        mode,
        maxAgeDays,
        today,
      });
    }

    // The reference day, refusing a value that names none: the span below is a
    // pair of `YYYY-MM-DD` strings and a request parameter typed `string` may
    // arrive as an array (`fxReferenceDate`).
    const reference = fxReferenceDate(onDate, today, mode);
    if (reference === null) {
      return resolveFxRate(from, to, onDate, () => undefined, {
        mode,
        maxAgeDays,
        today,
      });
    }
    // The span is expressed as YYYY-MM-DD strings, never `Date` objects.
    // TypeORM does not normalise a select-side parameter: `pg` renders a `Date`
    // in the process time zone, and PostgreSQL's cast to `date` keeps whatever
    // literal date that rendering produced. West of UTC a UTC-midnight `Date`
    // renders as the previous day, so the upper bound became yesterday and the
    // reference date's own row -- today's rate, in `live` mode -- dropped out of
    // the result. A string is compared as the calendar date it names in every
    // time zone.
    const floor = addDaysYMD(reference, -maxAgeDays);
    const span = ymdSpan(floor, reference);

    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(ExchangeRate).find({
        where: [
          { fromCurrency: from, toCurrency: to, rateDate: span },
          { fromCurrency: to, toCurrency: from, rateDate: span },
        ],
        order: { rateDate: "ASC" },
      }),
    );

    const observed = new Map<string, Array<{ date: string; rate: number }>>();
    for (const row of rows) {
      const key = `${row.fromCurrency}->${row.toCurrency}`;
      const date =
        row.rateDate instanceof Date
          ? row.rateDate.toISOString().slice(0, 10)
          : String(row.rateDate).slice(0, 10);
      const list = observed.get(key);
      const point = { date, rate: Number(row.rate) };
      if (list) list.push(point);
      else observed.set(key, [point]);
    }

    return resolveFxRate(
      from,
      to,
      onDate,
      (f, t) => observed.get(`${f}->${t}`),
      {
        mode,
        maxAgeDays,
        today,
      },
    );
  }

  /**
   * Get the exchange rate for a currency pair as of a specific date.
   *
   * Unlike the once-a-day stored snapshot, this returns the
   * rate that applied on the transaction's date -- essential for back-dated
   * transactions, where the latest snapshot can be far from the historical
   * rate. Precedence:
   *   0. A date in the future has no rate and never will until it arrives, so
   *      the target is clamped to today and the answer is today's rate. Without
   *      the clamp a future date fell through to a Yahoo window that contains
   *      nothing, and the lookup returned null for a scheduled transaction
   *      posted ahead of time.
   *   1. The stored observations inside the admissible span, resolved by
   *      `resolveFxRate`: the most recent one on or before the target, in
   *      either stored direction. This is what makes a weekend or a holiday
   *      resolve -- Saturday and Sunday carry Friday's rate forward.
   *   2. When the span holds none, a historical daily window fetched from the
   *      provider around the target date, resolved by the same rule and
   *      persisted for reuse. The step is driven by *coverage of the target*,
   *      not by "does this pair have any row at all": one 2019 row used to
   *      short-circuit it, which is how a 285-day hole stayed a hole.
   * Returns null when no rate can be determined (so the caller can reject or
   * flag the operation rather than silently assuming 1.0). There is no
   * unbounded "latest stored rate of any date" step any more: a rate is a price
   * and an arbitrarily old one does not describe the date being asked about
   * (`docs/time-series-contract.md` section 2.2).
   */
  async getRateForDate(
    from: string,
    to: string,
    date: string | Date,
    options?: {
      /**
       * Fetch a provider window when the stored span covers nothing. Default
       * true; a read-only caller (a report converting hundreds of rows) passes
       * false to stay inside the database.
       */
      fetchMissing?: boolean;
      mode?: FxRateMode;
    },
  ): Promise<number | null> {
    if (from === to) return 1;

    const requested =
      typeof date === "string"
        ? date.slice(0, 10)
        : date.toISOString().slice(0, 10);

    // 0. Clamp a future date to today: today's rate is the best available
    //    estimate, and it is the same figure the bills list is showing.
    const todayUtc = todayYMD();
    const target = requested > todayUtc ? todayUtc : requested;

    // 1. The stored history, through the one door.
    const stored = await this.resolveStoredRate(from, to, target, {
      mode: options?.mode,
    });
    if (stored.rate !== null) return stored.rate;
    if (options?.fetchMissing === false) return null;

    // 2. Fetch a provider window around the target (not the full "max" history)
    //    and resolve it by the same rule.
    //
    //    The window is wide because it costs nothing to be: one call returns
    //    the whole daily series for the period, and every bar in it is
    //    persisted below. Six weeks back and one forward means a user stepping
    //    a date field through a month of history pays for a single fetch, and
    //    the reverse pair is filled in at the same time. It was two weeks back
    //    and one point kept, so neighbouring dates each went back out to the
    //    provider and ran into its rate limits. The span back is the age bound
    //    itself, so the fetch covers exactly what the bound would accept.
    const windowStart = addDaysYMD(target, -FX_MAX_RATE_AGE_DAYS);
    const windowEnd = addDaysYMD(target, 7);
    const { points, source } = await this.fxProviders.dailySeries(
      from,
      to,
      windowStart,
      windowEnd,
    );
    if (points.length > 0 && source !== null) {
      try {
        // The whole window, not just the day that was asked for: the next
        // lookup for any date in it is then a database read. Persisted whether
        // or not the target itself resolves, because a neighbouring date may.
        const persisted = await this.persistRateSeries(points, source);
        this.logger.log(
          `Stored ${persisted} daily ${from}/${to} rates around ${target} from one lookup`,
        );
      } catch (error) {
        this.logger.warn(
          `Could not persist historical rates ${from}->${to} around ${target}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      // The same rule as the stored step: the closest observation on or before
      // the target, never one from after it, in whichever orientation the
      // provider answered -- `resolveFxRate` reads both and inverts the reverse
      // one, as it does for the stored rows these just became. A window that
      // brackets the target but starts after it answers nothing -- it used to
      // answer with its nearest point in either direction, which is the
      // look-ahead this closes.
      const resolved = resolveFxRate(
        from,
        to,
        target,
        (f, t) => {
          const observed = points.filter((p) => p.from === f && p.to === t);
          return observed.length > 0
            ? observed.map(({ date, rate }) => ({ date, rate }))
            : undefined;
        },
        { mode: options?.mode, today: todayUtc },
      );
      if (resolved.rate !== null) return resolved.rate;
    }

    this.logger.warn(
      describeFxGap(
        `${from}->${to}`,
        target,
        stored.reason ?? "no_observation",
      ),
    );
    return null;
  }

  /**
   * Convert one amount between two currencies at the rate that applied on a
   * date -- the shared implementation behind the AI Assistant's and the MCP
   * server's `calculate` tool (`operation: "convert"`), so a model never does
   * the conversion itself.
   *
   * `date` is optional and defaults to today (`todayYMD`, the caller's request
   * timezone); a future date is clamped to today by `getRateForDate`, and the
   * clamped date is what `date` reports back. The rate goes through
   * `resolveFxRateOrNull`, the one market-rate ladder (the admissible stored
   * observations on or before the date, then a provider window resolved by the
   * same rule), so the figure matches what a transaction posted on that date
   * would carry.
   *
   * Returns `null` when no usable rate exists in either direction -- never `1`,
   * and never the input amount: `docs/specs/fx-conversion-completeness.md`.
   * Either stored direction answers, because the ladder resolves the pair
   * through `resolveFxRate`; this does not chase the reverse pair itself.
   */
  async convertOnDate(
    amount: number,
    fromCurrency: string,
    toCurrency: string,
    date?: string,
  ): Promise<DatedConversion | null> {
    const from = fromCurrency.toUpperCase();
    const to = toCurrency.toUpperCase();
    const requested = (date ?? todayYMD()).slice(0, 10);
    const today = todayYMD();
    // The same clamp `getRateForDate` applies, surfaced so the caller learns
    // which day's rate it actually received.
    const effectiveDate = requested > today ? today : requested;

    if (from === to) {
      return {
        amount,
        fromCurrency: from,
        toCurrency: to,
        date: effectiveDate,
        rate: 1,
        convertedAmount: amount,
      };
    }

    // One lookup. The second one this used to make -- the pair reversed, the
    // answer reciprocated -- could never add anything: the ladder it calls
    // already consults both stored directions and inverts the reverse
    // observation itself, so a `null` from the first call means the pair is
    // unknown, not that it is held the other way.
    const rate = await resolveFxRateOrNull(this, from, to, effectiveDate);
    if (rate === null) return null;

    return {
      amount,
      fromCurrency: from,
      toCurrency: to,
      date: effectiveDate,
      rate,
      convertedAmount: roundMoney(amount * rate),
    };
  }

  /**
   * Get the current spot rate for a currency pair, fetched live through the
   * provider chain. `FxProviderChain.live` asks the providers with a live feed
   * first (Yahoo, which checks a quote below 1 against its reverse symbol and
   * refuses one too coarse either way), then the chain's latest published
   * observation, and answers in whichever orientation the provider quoted; the
   * stored history in `live` mode is the fallback when the chain has nothing
   * (rate limited, unsupported pair, offline). Plan decision 8.
   *
   * The stored fallback is `resolveStoredRate` in `live` mode, not an
   * unbounded newest-row read: a rate quoted as "right now" is still a price,
   * so an observation older than `FX_MAX_RATE_AGE_DAYS` is not one. The
   * unbounded read is what let a 276-day-old rate be cached as live and carried
   * into a portfolio total that reported itself complete (issue #1390).
   *
   * Use this for "as of now" valuations such as the Investments portfolio
   * summary so they line up with the live intraday Portfolio Value Over Time
   * chart, which fetches live FX directly from the quote provider, rather than
   * the once-a-day stored snapshot. Returns `null` when neither a live quote
   * nor an admissible stored rate exists; `null` is unknown, and no caller may
   * read it as 1 or as the unconverted amount (INV-FX-001).
   */
  async getLiveRate(from: string, to: string): Promise<number | null> {
    if (from === to) return 1;
    try {
      // Whichever provider and orientation answered; a chain with nothing
      // falls through to the stored rate and then to null, never to 1.
      const observation = await this.fxProviders.live(from, to);
      if (observation !== null) {
        return this.rateAsAsked(from, observation);
      }
    } catch (error) {
      this.logger.warn(
        `Live FX fetch ${from}->${to} failed, falling back to stored rate: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const stored = await this.resolveStoredRate(from, to, todayYMD(), {
      mode: "live",
    });
    if (stored.rate === null && stored.reason !== null) {
      this.logger.warn(
        describeFxGap(`${from}->${to}`, todayYMD(), stored.reason),
      );
    }
    return stored.rate;
  }

  /**
   * Get exchange rates within a date range (for historical net worth)
   */
  async getRateHistory(
    startDate?: string,
    endDate?: string,
  ): Promise<ExchangeRate[]> {
    const where: any = {};
    if (startDate) {
      where.rateDate = MoreThanOrEqual(startDate);
    }
    if (endDate) {
      where.rateDate = startDate
        ? And(MoreThanOrEqual(startDate), LessThanOrEqual(endDate))
        : LessThanOrEqual(endDate);
    }

    return withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(ExchangeRate).find({
        where,
        order: { rateDate: "ASC", fromCurrency: "ASC", toCurrency: "ASC" },
      }),
    );
  }

  /**
   * `decimal_places` of each non-ISO code among `codes` (a coin's row), for
   * text that states an amount in its own currency (`decimalPlacesFor`). One
   * read, none when every code is ISO.
   */
  async getCurrencyDecimalPlaces(
    codes: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    return withScopedDb(this.dataSource, (manager) =>
      loadCurrencyDecimalPlaces(manager, codes),
    );
  }

  /**
   * Get all active currencies
   */
  async getCurrencies(): Promise<Currency[]> {
    return withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(Currency).find({
        where: { isActive: true },
        order: { code: "ASC" },
      }),
    );
  }

  /**
   * Get the last time exchange rates were updated
   */
  async getLastUpdateTime(): Promise<Date | null> {
    const latest = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(ExchangeRate).findOne({
        where: {},
        order: { createdAt: "DESC" },
      }),
    );
    return latest?.createdAt ?? null;
  }

  /**
   * Scheduled job to refresh exchange rates daily at 5:05 PM EST (after market
   * close). Runs Monday-Friday only. Staggered five minutes after the security
   * price refresh (5:00 PM) so the two Yahoo-hitting jobs do not burst at the
   * same instant.
   */
  @Cron("5 17 * * 1-5", { timeZone: "America/New_York" })
  async scheduledRateRefresh(): Promise<void> {
    this.logger.log("Running scheduled exchange rate refresh");
    try {
      // RLS (task C2): the currency-detection read spans all users' accounts,
      // securities, holdings and preferences (writes only the global
      // exchange_rates table), so the refresh runs under a system context.
      //
      // One replica per tick makes the provider calls (task C2). The upserts
      // beneath are idempotent, so this is about cost and rate limits rather
      // than about correctness -- which is why a lost lease is a debug line and
      // never blocks the next tick.
      await withSystemContext(() =>
        this.fetchSync.withLease(
          FetchSyncJob.ExchangeRates,
          this.FETCH_LEASE_MS,
          async () => {
            await this.refreshAllRates();
          },
        ),
      );
    } catch (error) {
      this.logger.error(
        `Scheduled exchange rate refresh failed: ${error.message}`,
      );
    }
  }

  /**
   * Saturday and Sunday at 5:10 PM New York time: the pairs with a CRYPTO side
   * only (`refreshCryptoRates`, `docs/specs/crypto-accounts.md` decision 6). A
   * coin's Yahoo session is the UTC day, still open at 17:10 New York, so each
   * run stores the current UTC day's quote; the weekday refresh covers the
   * rest of the week. Held under the same `FetchSyncJob.ExchangeRates` lease
   * as the weekday refresh, wrapped whole in the system context, for the same
   * reason: one replica per tick asks the provider, and the upserts beneath
   * are idempotent, so a lost lease costs quota, never data.
   */
  @Cron("10 17 * * 0,6", { timeZone: "America/New_York" })
  async scheduledCryptoRateRefresh(): Promise<void> {
    this.logger.log("Running scheduled cryptocurrency exchange rate refresh");
    try {
      await withSystemContext(() =>
        this.fetchSync.withLease(
          FetchSyncJob.ExchangeRates,
          this.FETCH_LEASE_MS,
          async () => {
            await this.refreshCryptoRates();
          },
        ),
      );
    } catch (error) {
      this.logger.error(
        `Scheduled cryptocurrency exchange rate refresh failed: ${error.message}`,
      );
    }
  }
}
