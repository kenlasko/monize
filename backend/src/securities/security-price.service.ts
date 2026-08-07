import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { tr } from "../i18n/translate";
import { In, DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import { Cron } from "@nestjs/schedule";
import { SecurityPrice } from "./entities/security-price.entity";
import { Security } from "./entities/security.entity";
import { NetWorthService } from "../net-worth/net-worth.service";
import { UserPreference } from "../users/entities/user-preference.entity";
import { withSystemContext } from "../common/db/with-context";
import {
  QuoteProvider,
  QuoteProviderName,
  QuoteResult,
  HistoricalPrice,
  SecurityLookupResult,
} from "./providers/quote-provider.interface";
import {
  DEFAULT_QUOTE_PROVIDER,
  QuoteProviderRegistry,
} from "./providers/quote-provider.registry";
import { getTradingDateFromQuote } from "./providers/trading-date.util";
import { getMarketSessionFromQuote } from "./providers/market-session.util";
import { CreateSecurityPriceDto } from "./dto/create-security-price.dto";
import { UpdateSecurityPriceDto } from "./dto/update-security-price.dto";
import {
  DEFAULT_PRICE_HISTORY_ROWS,
  MAX_PRICE_HISTORY_ROWS,
} from "./dto/price-history-query.dto";
import { formatDateYMD } from "../common/date-utils";
import { mapWithConcurrency } from "../common/concurrency.util";

export { SecurityLookupResult } from "./providers/quote-provider.interface";

const TRANSACTION_SOURCES = [
  "buy",
  "sell",
  "reinvest",
  "transfer_in",
  "transfer_out",
];

// Cap simultaneous external quote fetches so a large securities universe does
// not fire hundreds of concurrent Yahoo/MSN requests and trip rate limits.
const QUOTE_FETCH_CONCURRENCY = 6;

/**
 * Price writes that were started without anybody waiting for them.
 *
 * Creating a security or an investment transaction kicks off a price fetch and
 * returns straight away -- deliberately, because the user should not wait on
 * Yahoo to see their own row. The write that lands afterwards is still a write,
 * and it arrives with no relationship to the request that caused it.
 *
 * Harmless in a running server. Not harmless against a database being torn
 * down: an integration suite that truncates `securities ... CASCADE` while one
 * of these is inserting into `security_prices` takes both sides of a lock in
 * the opposite order and deadlocks, or -- when the truncate wins -- the insert
 * comes back as a foreign key violation against a security that no longer
 * exists. Neither is a bug in the code under test, and both read as one.
 *
 * Module scope rather than instance state on purpose: the thing that needs to
 * wait is a test helper holding a `DataSource`, not a consumer of this service,
 * and giving it the whole DI graph to reach one boolean would be the larger
 * change. Nothing in `src/` waits on this; production keeps exactly the
 * fire-and-forget behaviour it had.
 */
const pendingPriceWrites = new Set<Promise<unknown>>();

/**
 * Resolves once every background price write started so far has finished, in
 * either direction. Call this before dropping or truncating price tables.
 *
 * Settled, not successful: a failed backfill has also stopped touching the
 * database, which is the only property a teardown needs.
 */
export async function settlePendingPriceWrites(): Promise<void> {
  // Snapshotted because a settling promise removes itself from the set, and a
  // backfill may start another write before it finishes.
  while (pendingPriceWrites.size > 0) {
    await Promise.allSettled([...pendingPriceWrites]);
  }
}

/** Register a background price write so `settlePendingPriceWrites` can see it. */
function trackPriceWrite<T>(work: Promise<T>): Promise<T> {
  pendingPriceWrites.add(work);
  // `finally` keeps the returned promise's own settlement untouched, so a
  // caller that does await this still sees the original result or rejection.
  return work.finally(() => pendingPriceWrites.delete(work));
}

function sourceFor(provider: QuoteProviderName | undefined): string {
  return provider === "msn" ? "msn_finance" : "yahoo_finance";
}

/**
 * A security is eligible for price refresh when skipPriceUpdates is false,
 * OR the user has explicitly opted in by setting a per-security provider
 * override or supplying an MSN Instrument ID. The latter exists because
 * QIF/OFX imports auto-flag securities with skipPriceUpdates=true (since the
 * symbol is auto-generated and may not be a real ticker), and we don't want
 * the user to also have to manually clear that flag after picking a provider.
 */
function isRefreshEligible(s: {
  skipPriceUpdates: boolean;
  quoteProvider: string | null;
  msnInstrumentId: string | null;
}): boolean {
  if (!s.skipPriceUpdates) return true;
  return Boolean(s.quoteProvider) || Boolean(s.msnInstrumentId);
}

export interface PriceUpdateResult {
  symbol: string;
  success: boolean;
  price?: number;
  error?: string;
  provider?: QuoteProviderName;
}

export interface PriceRefreshSummary {
  totalSecurities: number;
  updated: number;
  failed: number;
  skipped: number;
  results: PriceUpdateResult[];
  lastUpdated: Date;
}

export interface HistoricalBackfillResult {
  symbol: string;
  success: boolean;
  pricesLoaded?: number;
  error?: string;
  provider?: QuoteProviderName;
}

export interface HistoricalBackfillSummary {
  totalSecurities: number;
  successful: number;
  failed: number;
  totalPricesLoaded: number;
  results: HistoricalBackfillResult[];
}

interface UserContext {
  defaultQuoteProvider: QuoteProviderName;
  preferredExchanges: string[];
}

interface HistoricalWithProvider {
  prices: HistoricalPrice[];
  provider: QuoteProviderName;
}

@Injectable()
export class SecurityPriceService {
  private readonly logger = new Logger(SecurityPriceService.name);

  constructor(
    private dataSource: DataSource,
    private netWorthService: NetWorthService,
    private providers: QuoteProviderRegistry,
  ) {}

  // ─── User preference loading ─────────────────────────────────────────────

  /**
   * Build a per-user context map (default provider + preferred exchanges) for
   * the given set of user IDs, in a single query. Missing rows fall back to
   * the defaults.
   */
  private async loadUserContexts(
    userIds: string[],
  ): Promise<Map<string, UserContext>> {
    const ctx = new Map<string, UserContext>();
    if (userIds.length === 0) return ctx;

    const prefs = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).find({
        where: { userId: In([...new Set(userIds)]) },
      }),
    );

    for (const p of prefs) {
      ctx.set(p.userId, {
        defaultQuoteProvider:
          (p.defaultQuoteProvider as QuoteProviderName) ||
          DEFAULT_QUOTE_PROVIDER,
        preferredExchanges: p.preferredExchanges || [],
      });
    }

    for (const id of userIds) {
      if (!ctx.has(id)) {
        ctx.set(id, {
          defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
          preferredExchanges: [],
        });
      }
    }
    return ctx;
  }

  // ─── Quote fetch with provider fallback ──────────────────────────────────

  /**
   * Try each provider in registry order. Both "throws" and "returns null"
   * trigger the fallback. Returns the first quote that has a usable price.
   */
  private async fetchQuoteWithFallback(
    security: Security,
    ctx: UserContext,
  ): Promise<QuoteResult | null> {
    const ordered = this.providers.resolveForSecurity(
      security,
      ctx.defaultQuoteProvider,
    );

    this.logger.log(
      `Refresh ${security.symbol}: override=${security.quoteProvider ?? "(none)"} default=${ctx.defaultQuoteProvider} → trying [${ordered.map((p) => p.name).join(", ")}]`,
    );

    for (const provider of ordered) {
      try {
        const quote = await provider.fetchQuote(
          security.symbol,
          security.exchange,
          this.optsFor(provider, security, ctx),
        );
        if (quote && quote.regularMarketPrice !== undefined) {
          this.logger.log(
            `Refresh ${security.symbol}: ${provider.name} returned price=${quote.regularMarketPrice}`,
          );
          return { ...quote, provider: provider.name };
        }
        this.logger.log(
          `Refresh ${security.symbol}: ${provider.name} returned no usable price`,
        );
      } catch (err) {
        this.logger.warn(
          `${provider.name} fetchQuote failed for ${security.symbol}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.logger.warn(
      `Refresh ${security.symbol}: no provider returned a price`,
    );
    return null;
  }

  private async fetchHistoricalWithFallback(
    security: Security,
    range: string,
    ctx: UserContext,
  ): Promise<HistoricalWithProvider | null> {
    const ordered = this.providers.resolveForSecurity(
      security,
      ctx.defaultQuoteProvider,
    );

    for (const provider of ordered) {
      try {
        const prices = await provider.fetchHistorical(
          security.symbol,
          security.exchange,
          range,
          this.optsFor(provider, security, ctx),
        );
        if (prices && prices.length > 0) {
          return { prices, provider: provider.name };
        }
      } catch (err) {
        this.logger.warn(
          `${provider.name} fetchHistorical failed for ${security.symbol}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return null;
  }

  private optsFor(
    provider: QuoteProvider,
    security: Security,
    ctx: UserContext,
  ) {
    return {
      instrumentId:
        provider.name === "msn"
          ? (security.msnInstrumentId ?? undefined)
          : undefined,
      currencyCode: security.currencyCode,
      preferredExchanges: ctx.preferredExchanges,
    };
  }

  /**
   * If the quote came back with a different SecId than the stored one
   * (because we upgraded a legacy FullInstrument), persist the upgrade.
   */
  private async persistMsnIdUpgrade(
    security: Security,
    upgradedId: string,
  ): Promise<void> {
    if (!upgradedId || upgradedId === security.msnInstrumentId) return;
    try {
      this.logger.log(
        `Persisting upgraded MSN instrumentId for ${security.symbol}: ${security.msnInstrumentId ?? "(none)"} → ${upgradedId}`,
      );
      security.msnInstrumentId = upgradedId;
      await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Security).update(security.id, {
          msnInstrumentId: upgradedId,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to persist upgraded MSN id for ${security.symbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Cache the instrument's trading session on the Security row, so the UI can
   * say whether its market is open right now without a provider round trip.
   *
   * Only written when it changes, which is almost never -- an exchange moves
   * its hours rarely, and the daylight-saving shift is already handled by
   * storing local times against a zone rather than fixed offsets.
   */
  private async persistMarketSession(
    security: Security,
    quote: QuoteResult,
  ): Promise<void> {
    const session = getMarketSessionFromQuote(quote);
    if (!session) return;
    if (
      session.timezone === security.marketTimezone &&
      session.openTime === security.marketOpenTime &&
      session.closeTime === security.marketCloseTime
    ) {
      return;
    }
    try {
      security.marketTimezone = session.timezone;
      security.marketOpenTime = session.openTime;
      security.marketCloseTime = session.closeTime;
      await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Security).update(security.id, {
          marketTimezone: session.timezone,
          marketOpenTime: session.openTime,
          marketCloseTime: session.closeTime,
        }),
      );
    } catch (err) {
      // A price refresh that worked must not fail over its metadata.
      this.logger.warn(
        `Failed to persist market session for ${security.symbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * After MSN resolves a SecId on behalf of a security, cache it on the
   * Security row so subsequent refreshes skip the autosuggest hop.
   */
  private async persistMsnInstrumentIdIfResolved(
    security: Security,
    providerName: QuoteProviderName,
    ctx: UserContext,
  ): Promise<void> {
    if (providerName !== "msn" || security.msnInstrumentId) return;
    const msn = this.providers.getByName("msn");
    if (!msn.resolveInstrumentId) return;
    try {
      const id = await msn.resolveInstrumentId(
        security.symbol,
        security.exchange,
        ctx.preferredExchanges,
      );
      if (id) {
        security.msnInstrumentId = id;
        await withScopedDb(this.dataSource, (m) =>
          m.getRepository(Security).update(security.id, {
            msnInstrumentId: id,
          }),
        );
      }
    } catch (err) {
      this.logger.warn(
        `Failed to cache MSN instrument id for ${security.symbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── Grouping ────────────────────────────────────────────────────────────

  private groupKey(security: Security): string {
    return [
      security.symbol,
      security.exchange || "",
      security.quoteProvider || "",
      security.msnInstrumentId || "",
    ].join("|");
  }

  // ─── Refresh (current price) ─────────────────────────────────────────────

  /**
   * @param skipFresh When true, skip securities that already have a
   *   provider-fetched price for today so a post-close re-run of the scheduled
   *   job does not re-fetch quotes it just stored. Only the scheduled cron
   *   passes true; on-demand/manual refreshes pass false (the default) and
   *   always re-fetch every eligible security. Manual price entries
   *   (source = 'manual') never count as fresh, so a user-entered intraday
   *   price does not suppress the official close fetch.
   */
  /**
   * Refresh prices for EVERY user's active securities.
   *
   * Global by definition -- prices are keyed by symbol, not by owner, and one
   * fetch serves every holder -- so the system context belongs here rather than at
   * the call sites. It used to live only in the cron, which left the admin
   * maintenance endpoint reading `securities` in the requesting admin's own scope:
   * identical to global at RLS_MODE=off, and silently narrowed to "the admin's own
   * holdings" the moment enforcement is switched on. A maintenance operation whose
   * reach depends on which caller reached it is the trap; naming the scope in the
   * method closes it. A nested system context from the cron is the same identity,
   * so it joins rather than conflicting (see scoped-db's DR-01 check).
   *
   * `refreshPricesForSecurities` is the per-user counterpart: its controller
   * verifies ownership of every id before calling it.
   */
  async refreshAllPrices(skipFresh = false): Promise<PriceRefreshSummary> {
    return withSystemContext(() => this.refreshAllPricesGlobally(skipFresh));
  }

  private async refreshAllPricesGlobally(
    skipFresh: boolean,
  ): Promise<PriceRefreshSummary> {
    const startTime = Date.now();
    this.logger.log("Starting price refresh for all securities");

    const allActive = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).find({
        where: { isActive: true },
      }),
    );
    const eligible = allActive.filter((s) => isRefreshEligible(s));

    let securities = eligible;
    let skipped = 0;
    if (skipFresh && eligible.length > 0) {
      const today = formatDateYMD(new Date());
      const freshRows: { security_id: string }[] =
        (await withScopedDb(this.dataSource, (m) =>
          m.query(
            `SELECT DISTINCT security_id FROM security_prices
           WHERE security_id = ANY($1) AND price_date >= $2
             AND source IS DISTINCT FROM 'manual'`,
            [eligible.map((s) => s.id), today],
          ),
        )) ?? [];
      const freshIds = new Set(freshRows.map((r) => r.security_id));
      if (freshIds.size > 0) {
        securities = eligible.filter((s) => !freshIds.has(s.id));
        skipped = eligible.length - securities.length;
      }
    }

    if (securities.length === 0) {
      return {
        totalSecurities: eligible.length,
        updated: 0,
        failed: 0,
        skipped,
        results: [],
        lastUpdated: new Date(),
      };
    }

    const userContexts = await this.loadUserContexts(
      securities.map((s) => s.userId),
    );

    const results: PriceUpdateResult[] = [];
    let updated = 0;
    let failed = 0;

    const symbolGroups = new Map<string, Security[]>();
    for (const security of securities) {
      const key = this.groupKey(security);
      const group = symbolGroups.get(key) || [];
      group.push(security);
      symbolGroups.set(key, group);
    }

    const groups = [...symbolGroups.values()];
    const quotes = await mapWithConcurrency(
      groups,
      QUOTE_FETCH_CONCURRENCY,
      (group) => {
        const rep = group[0];
        const ctx = userContexts.get(rep.userId) || {
          defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
          preferredExchanges: [],
        };
        return this.fetchQuoteWithFallback(rep, ctx);
      },
    );

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const quote = quotes[i];

      if (!quote || quote.regularMarketPrice === undefined) {
        for (const security of group) {
          results.push({
            symbol: security.symbol,
            success: false,
            error: "No price data available",
          });
          failed++;
        }
        continue;
      }

      // Cache the MSN instrument id on securities that had none resolved yet,
      // and persist any FullInstrument → SecId upgrade.
      if (quote.provider === "msn") {
        for (const security of group) {
          await this.persistMsnInstrumentIdIfResolved(
            security,
            "msn",
            userContexts.get(security.userId) || {
              defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
              preferredExchanges: [],
            },
          );
          if (quote.msnResolvedInstrumentId) {
            await this.persistMsnIdUpgrade(
              security,
              quote.msnResolvedInstrumentId,
            );
          }
        }
      }

      const tradingDate = formatDateYMD(getTradingDateFromQuote(quote));
      for (const security of group) {
        try {
          await this.savePriceData(security.id, tradingDate, quote);
          await this.persistMarketSession(security, quote);
          results.push({
            symbol: security.symbol,
            success: true,
            price: quote.regularMarketPrice,
            provider: quote.provider,
          });
          updated++;
        } catch (error) {
          results.push({
            symbol: security.symbol,
            success: false,
            error: error.message,
          });
          failed++;
        }
      }
    }

    const duration = Date.now() - startTime;
    this.logger.log(
      `Price refresh completed in ${duration}ms: ${updated} updated, ${failed} failed, ${skipped} skipped`,
    );

    return {
      totalSecurities: securities.length,
      updated,
      failed,
      skipped,
      results,
      lastUpdated: new Date(),
    };
  }

  async refreshPricesForSecurities(
    securityIds: string[],
  ): Promise<PriceRefreshSummary> {
    const securities = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).find({
        where: { id: In(securityIds), isActive: true },
      }),
    );
    const eligible = securities.filter((s) => isRefreshEligible(s));
    const skipped = securities.length - eligible.length;
    if (skipped > 0) {
      const skippedSymbols = securities
        .filter((s) => !isRefreshEligible(s))
        .map((s) => s.symbol)
        .join(", ");
      this.logger.log(
        `Skipping ${skipped} security/securities flagged with skipPriceUpdates and no explicit provider override: ${skippedSymbols}`,
      );
    }
    securities.length = 0;
    securities.push(...eligible);

    if (securities.length === 0) {
      return {
        totalSecurities: 0,
        updated: 0,
        failed: 0,
        skipped: 0,
        results: [],
        lastUpdated: new Date(),
      };
    }

    const userContexts = await this.loadUserContexts(
      securities.map((s) => s.userId),
    );

    const results: PriceUpdateResult[] = [];
    let updated = 0;
    let failed = 0;

    const quotes = await mapWithConcurrency(
      securities,
      QUOTE_FETCH_CONCURRENCY,
      (security) => {
        const ctx = userContexts.get(security.userId) || {
          defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
          preferredExchanges: [],
        };
        return this.fetchQuoteWithFallback(security, ctx);
      },
    );

    for (let i = 0; i < securities.length; i++) {
      const security = securities[i];
      const quote = quotes[i];

      if (!quote || quote.regularMarketPrice === undefined) {
        results.push({
          symbol: security.symbol,
          success: false,
          error: "No price data available",
        });
        failed++;
        continue;
      }

      if (quote.provider === "msn") {
        await this.persistMsnInstrumentIdIfResolved(
          security,
          "msn",
          userContexts.get(security.userId) || {
            defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
            preferredExchanges: [],
          },
        );
        if (quote.msnResolvedInstrumentId) {
          await this.persistMsnIdUpgrade(
            security,
            quote.msnResolvedInstrumentId,
          );
        }
      }

      try {
        const tradingDate = formatDateYMD(getTradingDateFromQuote(quote));
        await this.savePriceData(security.id, tradingDate, quote);
        await this.persistMarketSession(security, quote);
        results.push({
          symbol: security.symbol,
          success: true,
          price: quote.regularMarketPrice,
          provider: quote.provider,
        });
        updated++;
      } catch (error) {
        results.push({
          symbol: security.symbol,
          success: false,
          error: error.message,
        });
        failed++;
      }
    }

    return {
      totalSecurities: securities.length,
      updated,
      failed,
      skipped: 0,
      results,
      lastUpdated: new Date(),
    };
  }

  /**
   * Save price data to the database. Source is derived from the quote's
   * provider tag, defaulting to yahoo_finance for back-compat.
   */
  private async savePriceData(
    securityId: string,
    priceDate: string,
    quote: QuoteResult,
  ): Promise<SecurityPrice> {
    const source = sourceFor(quote.provider);
    // The instant the quote was struck, which `priceDate` cannot carry and
    // `createdAt` does not track: a same-day refresh updates the row in place,
    // leaving createdAt at whatever time the row was first written today.
    const quotedAt = quote.regularMarketTime
      ? new Date(quote.regularMarketTime * 1000)
      : null;

    // One statement, arbitrated by `UNIQUE(security_id, price_date)`. This used
    // to read the row, then in one branch save a mutated copy and in the other
    // insert a new one -- a check-then-act on a path the 5 PM ET cron runs on
    // every replica at once, so two processes routinely fetch the same quote for
    // the same security and day, both find no row, and both insert. The loser
    // got a unique violation and that security had no price for the day.
    //
    // `COALESCE(EXCLUDED.x, security_prices.x)` keeps the previous value where
    // the quote does not supply one, which is what the `?? existing.x` in the old
    // update branch meant -- except it now reads the stored value rather than a
    // copy fetched before another writer touched it.
    return withScopedDb(this.dataSource, async (m) => {
      const rows: unknown = await m.query(
        `INSERT INTO security_prices
           (security_id, price_date, open_price, high_price, low_price,
            close_price, volume, source, quoted_at)
         VALUES ($1, $2::DATE, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (security_id, price_date) DO UPDATE SET
           close_price = EXCLUDED.close_price,
           open_price  = COALESCE(EXCLUDED.open_price,  security_prices.open_price),
           high_price  = COALESCE(EXCLUDED.high_price,  security_prices.high_price),
           low_price   = COALESCE(EXCLUDED.low_price,   security_prices.low_price),
           volume      = COALESCE(EXCLUDED.volume,      security_prices.volume),
           source      = EXCLUDED.source,
           quoted_at   = COALESCE(EXCLUDED.quoted_at,   security_prices.quoted_at)
         RETURNING id`,
        [
          securityId,
          priceDate,
          quote.regularMarketOpen ?? null,
          quote.regularMarketDayHigh ?? null,
          quote.regularMarketDayLow ?? null,
          quote.regularMarketPrice!,
          quote.regularMarketVolume ?? null,
          source,
          quotedAt,
        ],
      );

      const id = returnedRows<{ id: number }>(rows)[0]?.id;
      const saved = id
        ? await m.getRepository(SecurityPrice).findOne({ where: { id } })
        : null;
      if (!saved) {
        // `DO UPDATE` always returns its row, so this cannot happen without a
        // real fault -- better to say so than to hand back a synthesized entity.
        throw new Error(
          `Failed to persist price for security ${securityId} on ${priceDate}`,
        );
      }
      return saved;
    });
  }

  // ─── Read helpers ────────────────────────────────────────────────────────

  async getLatestPrice(securityId: string): Promise<SecurityPrice | null> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(SecurityPrice).findOne({
        where: { securityId },
        order: { priceDate: "DESC" },
      }),
    );
  }

  /**
   * Stored closes for one security, newest first.
   *
   * **`limit` truncates the oldest end, so a window is not a limit.** The rows
   * are ordered descending and `take(n)` keeps the first `n` of them, which
   * means a cap shorter than the history silently drops the beginning of it --
   * the opposite of what a caller asking for "the last five years" wants, and
   * invisible in the response because the array it gets back is a perfectly
   * well-formed shorter one. So a request that names a window gets the whole
   * window: `limit` defaults to `MAX_PRICE_HISTORY_ROWS` rather than to 365
   * whenever `startDate` is supplied, and the cap is then a memory bound rather
   * than a filter.
   *
   * A caller that supplies neither keeps the historical default.
   *
   * **Either bound counts as a window.** Keying this on `startDate` alone left
   * the trap open in the direction that matters most: "all time" is a request
   * with no start date, so a chart asking for the whole history sent only an
   * `endDate` and got the newest 365 rows back -- about one year, presented as
   * everything there is.
   */
  async getPriceHistory(
    securityId: string,
    startDate?: Date | string,
    endDate?: Date | string,
    limit?: number,
  ): Promise<SecurityPrice[]> {
    const effectiveLimit =
      limit ??
      (startDate || endDate
        ? MAX_PRICE_HISTORY_ROWS
        : DEFAULT_PRICE_HISTORY_ROWS);

    return withScopedDb(this.dataSource, (m) => {
      const query = m
        .getRepository(SecurityPrice)
        .createQueryBuilder("sp")
        .where("sp.securityId = :securityId", { securityId })
        .orderBy("sp.priceDate", "DESC")
        .take(effectiveLimit);

      if (startDate) {
        query.andWhere("sp.priceDate >= :startDate", { startDate });
      }

      if (endDate) {
        query.andWhere("sp.priceDate <= :endDate", { endDate });
      }

      return query.getMany();
    });
  }

  /**
   * Lookup a security via the user's configured provider(s). With provider
   * "auto" (the default), try the user's default provider first then fall back
   * to the other.
   */
  async lookupSecurity(
    userId: string,
    query: string,
    preferredExchanges?: string[],
    provider?: "yahoo" | "msn" | "auto",
  ): Promise<SecurityLookupResult | null> {
    const all = await this.lookupSecurityCandidates(
      userId,
      query,
      preferredExchanges,
      provider,
    );
    return all[0] || null;
  }

  /**
   * Return every plausible candidate for the query so the UI can show a
   * picker when more than one match exists.
   */
  async lookupSecurityCandidates(
    userId: string,
    query: string,
    preferredExchanges?: string[],
    provider?: "yahoo" | "msn" | "auto",
  ): Promise<SecurityLookupResult[]> {
    const contexts = await this.loadUserContexts([userId]);
    const ctx = contexts.get(userId) || {
      defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
      preferredExchanges: [],
    };
    const exchanges =
      preferredExchanges && preferredExchanges.length > 0
        ? preferredExchanges
        : ctx.preferredExchanges;

    const fetchFromProvider = async (
      p: QuoteProvider,
    ): Promise<SecurityLookupResult[]> => {
      try {
        if (p.lookupSecurityMany) {
          return await p.lookupSecurityMany(query, exchanges);
        }
        const single = await p.lookupSecurity(query, exchanges);
        return single ? [single] : [];
      } catch (err) {
        this.logger.warn(
          `${p.name} lookup failed for ${query}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    };

    if (provider === "yahoo" || provider === "msn") {
      return fetchFromProvider(this.providers.getByName(provider));
    }

    // auto: try the user's primary provider first; only fall back to the
    // secondary provider when the primary returns no candidates. Mirrors
    // fetchQuoteWithFallback so lookups respect the same Primary/Secondary
    // preference used during price refresh.
    const ordered = this.providers.resolveForSecurity(
      { quoteProvider: null },
      ctx.defaultQuoteProvider,
    );
    for (const p of ordered) {
      const results = await fetchFromProvider(p);
      if (results.length > 0) return results;
    }
    return [];
  }

  /**
   * Fetch the instrument's authoritative trading currency from a live quote
   * (provider `meta.currency`, GBX-normalized to GBP). Used at security-create
   * time to correct the exchange-guessed currency from the lookup, which is
   * wrong for non-local-currency listings (e.g. a USD ETF on the LSE). Returns
   * null if no provider reports a currency, so callers keep their fallback.
   */
  async fetchAuthoritativeCurrency(
    userId: string,
    symbol: string,
    exchange: string | null,
  ): Promise<string | null> {
    const contexts = await this.loadUserContexts([userId]);
    const ctx = contexts.get(userId) || {
      defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
      preferredExchanges: [],
    };
    const ordered = this.providers.resolveForSecurity(
      { quoteProvider: null },
      ctx.defaultQuoteProvider,
    );
    for (const p of ordered) {
      try {
        const quote = await p.fetchQuote(symbol, exchange);
        const currency = quote?.currencyCode?.trim();
        if (currency) return currency;
      } catch (err) {
        this.logger.warn(
          `${p.name} currency lookup failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return null;
  }

  async getLastUpdateTime(): Promise<Date | null> {
    const latest = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(SecurityPrice).findOne({
        where: {},
        order: { createdAt: "DESC" },
      }),
    );
    return latest?.createdAt ?? null;
  }

  // ─── Historical backfill ─────────────────────────────────────────────────

  private mergePrices(
    maxPrices: HistoricalPrice[],
    dailyPrices: HistoricalPrice[],
    oneYearAgo: Date,
  ): HistoricalPrice[] {
    const olderPrices = maxPrices.filter((p) => p.date < oneYearAgo);
    const merged = [...olderPrices, ...dailyPrices];

    const byDate = new Map<string, HistoricalPrice>();
    for (const p of merged) {
      byDate.set(p.date.toISOString().substring(0, 10), p);
    }

    return [...byDate.values()].sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    );
  }

  async backfillHistoricalPrices(): Promise<HistoricalBackfillSummary> {
    const startTime = Date.now();
    this.logger.log("Starting historical price backfill");

    const allActive = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).find({
        where: { isActive: true },
      }),
    );
    const securities = allActive.filter((s) => isRefreshEligible(s));

    const userContexts = await this.loadUserContexts(
      securities.map((s) => s.userId),
    );

    const earliestTxRows: Array<{ security_id: string; earliest: string }> =
      await withScopedDb(this.dataSource, (m) =>
        m.query(
          `SELECT security_id, MIN(transaction_date)::TEXT as earliest
         FROM investment_transactions
         WHERE security_id IS NOT NULL
         GROUP BY security_id`,
        ),
      );
    const earliestTxDate = new Map(
      earliestTxRows.map((r) => [r.security_id, r.earliest]),
    );

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    oneYearAgo.setHours(0, 0, 0, 0);
    const oneYearAgoStr = oneYearAgo.toISOString().substring(0, 10);

    const results: HistoricalBackfillResult[] = [];
    let successful = 0;
    let failed = 0;
    let totalPricesLoaded = 0;

    const symbolGroups = new Map<string, Security[]>();
    for (const security of securities) {
      const groupKey = this.groupKey(security);
      const group = symbolGroups.get(groupKey) || [];
      group.push(security);
      symbolGroups.set(groupKey, group);
    }

    for (const group of symbolGroups.values()) {
      const representative = group[0];
      const ctx = userContexts.get(representative.userId) || {
        defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
        preferredExchanges: [],
      };

      const groupEarliestDates = group
        .map((s) => earliestTxDate.get(s.id))
        .filter(Boolean) as string[];

      const needsOlderData =
        groupEarliestDates.length > 0 &&
        groupEarliestDates.some((d) => d < oneYearAgoStr);

      const daily = await this.fetchHistoricalWithFallback(
        representative,
        "1y",
        ctx,
      );

      let maxBundle: HistoricalWithProvider | null = null;
      if (needsOlderData) {
        maxBundle = await this.fetchHistoricalWithFallback(
          representative,
          "max",
          ctx,
        );
      }

      if (!daily && !maxBundle) {
        for (const security of group) {
          results.push({
            symbol: security.symbol,
            success: false,
            error: "No historical data available",
          });
          failed++;
        }
        continue;
      }

      const winner = daily || maxBundle!;
      if (winner.provider === "msn") {
        for (const security of group) {
          await this.persistMsnInstrumentIdIfResolved(
            security,
            "msn",
            userContexts.get(security.userId) || ctx,
          );
        }
      }

      let allPrices =
        maxBundle && daily
          ? this.mergePrices(maxBundle.prices, daily.prices, oneYearAgo)
          : (daily?.prices ?? maxBundle!.prices);

      const seen = new Set<string>();
      allPrices = allPrices.filter((p) => {
        const key = p.date.toISOString().substring(0, 10);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const source = sourceFor(winner.provider);

      for (const security of group) {
        const secEarliest = earliestTxDate.get(security.id);
        const secCutoffStr = secEarliest
          ? [oneYearAgoStr, secEarliest].sort()[0]
          : oneYearAgoStr;
        const secCutoff = new Date(secCutoffStr);
        secCutoff.setHours(0, 0, 0, 0);
        const prices = allPrices.filter((p) => p.date >= secCutoff);

        if (prices.length === 0) {
          results.push({
            symbol: security.symbol,
            success: true,
            pricesLoaded: 0,
            provider: winner.provider,
          });
          successful++;
          continue;
        }

        try {
          await this.bulkUpsertPrices(security.id, prices, source);

          this.logger.log(
            `Backfilled ${prices.length} prices for ${security.symbol} via ${winner.provider} (from ${secCutoffStr})`,
          );
          results.push({
            symbol: security.symbol,
            success: true,
            pricesLoaded: prices.length,
            provider: winner.provider,
          });
          successful++;
          totalPricesLoaded += prices.length;
        } catch (error) {
          this.logger.error(
            `Failed to save historical prices for ${security.symbol}: ${error.message}`,
          );
          results.push({
            symbol: security.symbol,
            success: false,
            error: error.message,
          });
          failed++;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const duration = Date.now() - startTime;
    this.logger.log(
      `Historical backfill completed in ${duration}ms: ${successful} successful, ${failed} failed, ${totalPricesLoaded} total prices`,
    );

    return {
      totalSecurities: securities.length,
      successful,
      failed,
      totalPricesLoaded,
      results,
    };
  }

  /**
   * Bulk upsert historical prices via raw SQL. Accepts the source tag so
   * MSN-sourced data can be stored with source='msn_finance'.
   */
  private async bulkUpsertPrices(
    securityId: string,
    prices: HistoricalPrice[],
    source: string,
  ): Promise<void> {
    const batchSize = 500;
    for (let i = 0; i < prices.length; i += batchSize) {
      const batch = prices.slice(i, i + batchSize);
      const values = batch
        .map((_, idx) => {
          const offset = idx * 9;
          return `($${offset + 1}::UUID, $${offset + 2}::DATE, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`;
        })
        .join(", ");

      const params: any[] = [];
      for (const p of batch) {
        params.push(
          securityId,
          p.date,
          p.open,
          p.high,
          p.low,
          p.close,
          p.adjClose,
          p.volume,
          source,
        );
      }

      // Only overwrite adjusted_close on conflict when the new payload has a
      // non-null value, so providers without adjclose support (MSN today)
      // don't blow away a previously-stored Yahoo value.
      await withScopedDb(this.dataSource, (m) =>
        m.query(
          `INSERT INTO security_prices (security_id, price_date, open_price, high_price, low_price, close_price, adjusted_close, volume, source)
         VALUES ${values}
         ON CONFLICT (security_id, price_date) DO UPDATE SET
           close_price = EXCLUDED.close_price,
           open_price = EXCLUDED.open_price,
           high_price = EXCLUDED.high_price,
           low_price = EXCLUDED.low_price,
           adjusted_close = COALESCE(EXCLUDED.adjusted_close, security_prices.adjusted_close),
           volume = EXCLUDED.volume,
           source = EXCLUDED.source`,
          params,
        ),
      );
    }
  }

  @Cron("0 17 * * 1-5", { timeZone: "America/New_York" })
  async scheduledPriceRefresh(): Promise<void> {
    this.logger.log("Running scheduled price refresh");
    try {
      // RLS (task C2): the price refresh groups securities across users by
      // symbol (irreducibly cross-user), and the snapshot recalc fans out over
      // every investment account, so the whole job runs under a system context.
      await withSystemContext(async () => {
        const result = await this.refreshAllPrices(true);
        if (result.updated > 0) {
          this.logger.log(
            "Recalculating investment snapshots after price refresh",
          );
          await this.netWorthService.recalculateAllInvestmentSnapshots();
        }
      });
    } catch (error) {
      this.logger.error(`Scheduled price refresh failed: ${error.message}`);
    }
  }

  /**
   * Backfill 1 year of daily prices for a single security. Called when a
   * security is newly created (manually or via import). Honors per-security
   * provider override + user default + preferredExchanges.
   */
  async backfillSecurity(security: Security): Promise<void> {
    // Registered rather than merely started. `SecuritiesService.create` does
    // not await this, so without a record of it the write is invisible to
    // anything that needs the database to be quiet.
    await trackPriceWrite(this.backfillSecurityRange(security, "1y"));
  }

  /**
   * Backfill historical prices for a single security over a configurable
   * range ("1y", "5y", "10y", "max", etc.). Returns the number of price rows
   * upserted. Used by callers that need deeper history than the daily-1y
   * default (e.g. Monte Carlo's per-holding stats).
   */
  async backfillSecurityRange(
    security: Security,
    range: string,
  ): Promise<number> {
    if (security.skipPriceUpdates) return 0;

    const [ctx] =
      (await this.loadUserContexts([security.userId])).values() || [];
    const userCtx = ctx || {
      defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
      preferredExchanges: [],
    };

    const bundle = await this.fetchHistoricalWithFallback(
      security,
      range,
      userCtx,
    );
    if (!bundle || bundle.prices.length === 0) {
      this.logger.warn(`No historical prices available for ${security.symbol}`);
      return 0;
    }

    if (bundle.provider === "msn") {
      await this.persistMsnInstrumentIdIfResolved(security, "msn", userCtx);
    }

    try {
      await this.bulkUpsertPrices(
        security.id,
        bundle.prices,
        sourceFor(bundle.provider),
      );
      this.logger.log(
        `Backfilled ${bundle.prices.length} ${range} prices for ${security.symbol} via ${bundle.provider}`,
      );
      return bundle.prices.length;
    } catch (error) {
      this.logger.error(
        `Failed to upsert backfilled prices for ${security.symbol}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  /**
   * Force-refresh historical prices for a single security across the full
   * period the user has held it (earliest investment transaction through the
   * latest available price), overwriting any existing rows. Unlike the
   * scheduled backfill this bypasses the skipPriceUpdates eligibility check:
   * the user has explicitly requested the update, and imports flag securities
   * with skipPriceUpdates=true, so this is how a user opts a single corrected
   * symbol back in. Scoped by userId for multi-tenancy.
   */
  async backfillSecurityHoldingPeriod(
    userId: string,
    securityId: string,
  ): Promise<HistoricalBackfillResult> {
    const security = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).findOne({
        where: { id: securityId, userId },
      }),
    );
    if (!security) {
      throw new NotFoundException(
        tr(
          "errors.securities.notFoundBySecurityId",
          `Security ${securityId} not found`,
          { securityId },
        ),
      );
    }

    const ctx = (await this.loadUserContexts([userId])).get(userId) ?? {
      defaultQuoteProvider: DEFAULT_QUOTE_PROVIDER,
      preferredExchanges: [],
    };

    // Earliest date the user has held the security. Null when there are no
    // transactions yet (e.g. a watchlist-only security) -- fall back to 1y.
    const earliestRows: Array<{ earliest: string | null }> = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT MIN(transaction_date)::TEXT as earliest
         FROM investment_transactions
         WHERE security_id = $1`,
          [securityId],
        ),
    );
    const earliestTx = earliestRows[0]?.earliest ?? null;

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    oneYearAgo.setHours(0, 0, 0, 0);
    const oneYearAgoStr = oneYearAgo.toISOString().substring(0, 10);

    const needsOlderData = !!earliestTx && earliestTx < oneYearAgoStr;

    const daily = await this.fetchHistoricalWithFallback(security, "1y", ctx);
    const maxBundle = needsOlderData
      ? await this.fetchHistoricalWithFallback(security, "max", ctx)
      : null;

    if (!daily && !maxBundle) {
      return {
        symbol: security.symbol,
        success: false,
        error: "No historical data available",
      };
    }

    const winner = daily || maxBundle!;
    if (winner.provider === "msn") {
      await this.persistMsnInstrumentIdIfResolved(security, "msn", ctx);
    }

    let allPrices =
      maxBundle && daily
        ? this.mergePrices(maxBundle.prices, daily.prices, oneYearAgo)
        : (daily?.prices ?? maxBundle!.prices);

    const seen = new Set<string>();
    allPrices = allPrices.filter((p) => {
      const key = p.date.toISOString().substring(0, 10);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Clip to the holding period: from the first transaction date (or 1y ago
    // when the security has never been transacted) through the latest price.
    const cutoffStr = earliestTx ?? oneYearAgoStr;
    const cutoff = new Date(cutoffStr);
    cutoff.setHours(0, 0, 0, 0);
    const prices = allPrices.filter((p) => p.date >= cutoff);

    if (prices.length === 0) {
      return {
        symbol: security.symbol,
        success: true,
        pricesLoaded: 0,
        provider: winner.provider,
      };
    }

    const source = sourceFor(winner.provider);
    try {
      await this.bulkUpsertPrices(security.id, prices, source);
    } catch (error) {
      this.logger.error(
        `Failed to force-backfill prices for ${security.symbol}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        symbol: security.symbol,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    this.logger.log(
      `Force-backfilled ${prices.length} prices for ${security.symbol} via ${winner.provider} (from ${cutoffStr})`,
    );

    return {
      symbol: security.symbol,
      success: true,
      pricesLoaded: prices.length,
      provider: winner.provider,
    };
  }

  /**
   * Upsert a transaction-derived price for a security on a given date.
   * Computes average price from all price-relevant transactions on that date.
   * Never overwrites provider-sourced (yahoo_finance, msn_finance) or manual
   * prices — the ON CONFLICT WHERE clause restricts updates to rows whose
   * existing source is itself a transaction action.
   */
  async upsertTransactionPrice(
    securityId: string,
    transactionDate: string,
  ): Promise<void> {
    return trackPriceWrite(
      this.upsertTransactionPriceInner(securityId, transactionDate),
    );
  }

  private async upsertTransactionPriceInner(
    securityId: string,
    transactionDate: string,
  ): Promise<void> {
    // Only actual trades (BUY/SELL/REINVEST) imply a market price. TRANSFER_IN/
    // TRANSFER_OUT legs carry the carried cost basis, not the market price on
    // the transfer date, so they are excluded from the derived price.
    const rows: Array<{
      avg_price: string;
      latest_action: string;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT AVG(price::numeric) as avg_price,
              (SELECT action FROM investment_transactions
               WHERE security_id = $1 AND transaction_date = $2
                 AND action IN ('BUY', 'SELL', 'REINVEST')
                 AND price IS NOT NULL
               ORDER BY created_at DESC LIMIT 1) as latest_action
       FROM investment_transactions
       WHERE security_id = $1
         AND transaction_date = $2
         AND action IN ('BUY', 'SELL', 'REINVEST')
         AND price IS NOT NULL`,
        [securityId, transactionDate],
      ),
    );

    const avgPrice = rows[0]?.avg_price
      ? Math.round(Number(rows[0].avg_price) * 1000000) / 1000000
      : null;
    const latestAction = rows[0]?.latest_action;

    if (avgPrice === null || latestAction === null) {
      await withScopedDb(this.dataSource, (m) =>
        m.query(
          `DELETE FROM security_prices
         WHERE security_id = $1 AND price_date = $2
           AND source = ANY($3)`,
          [securityId, transactionDate, TRANSACTION_SOURCES],
        ),
      );
      return;
    }

    const source = latestAction.toLowerCase();

    await withScopedDb(this.dataSource, (m) =>
      m.query(
        `INSERT INTO security_prices (security_id, price_date, close_price, source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (security_id, price_date)
       DO UPDATE SET close_price = $3, source = $4
       WHERE security_prices.source = ANY($5)`,
        [securityId, transactionDate, avgPrice, source, TRANSACTION_SOURCES],
      ),
    );
  }

  async backfillTransactionPrices(): Promise<{
    processed: number;
    created: number;
    skipped: number;
  }> {
    this.logger.log("Starting transaction price backfill");

    const pairs: Array<{
      security_id: string;
      transaction_date: string;
      avg_price: string;
      latest_action: string;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT it.security_id, it.transaction_date,
              AVG(it.price::numeric) as avg_price,
              (SELECT it2.action FROM investment_transactions it2
               WHERE it2.security_id = it.security_id
                 AND it2.transaction_date = it.transaction_date
                 AND it2.action IN ('BUY', 'SELL', 'REINVEST')
                 AND it2.price IS NOT NULL
               ORDER BY it2.created_at DESC LIMIT 1) as latest_action
       FROM investment_transactions it
       WHERE it.security_id IS NOT NULL
         AND it.price IS NOT NULL
         AND it.action IN ('BUY', 'SELL', 'REINVEST')
       GROUP BY it.security_id, it.transaction_date`,
      ),
    );

    let created = 0;
    let skipped = 0;
    const batchSize = 500;

    for (let i = 0; i < pairs.length; i += batchSize) {
      const batch = pairs.slice(i, i + batchSize);
      const values = batch
        .map((_, idx) => {
          const offset = idx * 4;
          return `($${offset + 1}::UUID, $${offset + 2}::DATE, $${offset + 3}, $${offset + 4})`;
        })
        .join(", ");

      const params: any[] = [];
      for (const pair of batch) {
        const price = Math.round(Number(pair.avg_price) * 1000000) / 1000000;
        params.push(
          pair.security_id,
          pair.transaction_date,
          price,
          pair.latest_action.toLowerCase(),
        );
      }

      const result = await withScopedDb(this.dataSource, (m) =>
        m.query(
          `INSERT INTO security_prices (security_id, price_date, close_price, source)
         VALUES ${values}
         ON CONFLICT (security_id, price_date)
         DO UPDATE SET close_price = EXCLUDED.close_price, source = EXCLUDED.source
         WHERE security_prices.source = ANY($${params.length + 1})`,
          [...params, TRANSACTION_SOURCES],
        ),
      );

      const affected = Array.isArray(result)
        ? result.length
        : (result?.rowCount ?? 0);
      created += affected;
    }

    skipped = pairs.length - created;

    this.logger.log(
      `Transaction price backfill completed: ${pairs.length} processed, ${created} created/updated, ${skipped} skipped`,
    );

    return { processed: pairs.length, created, skipped };
  }

  async createManualPrice(
    securityId: string,
    dto: CreateSecurityPriceDto,
  ): Promise<SecurityPrice> {
    // Same shape as the quote path, and the same reason: read-then-insert on a
    // uniquely-keyed row turns a second submission -- a double-clicked Save, or a
    // manual entry landing on the same day the price cron just wrote -- into a
    // unique violation instead of an update.
    return withScopedDb(this.dataSource, async (m) => {
      const rows: unknown = await m.query(
        `INSERT INTO security_prices
           (security_id, price_date, open_price, high_price, low_price,
            close_price, volume, source)
         VALUES ($1, $2::DATE, $3, $4, $5, $6, $7, 'manual')
         ON CONFLICT (security_id, price_date) DO UPDATE SET
           close_price = EXCLUDED.close_price,
           open_price  = COALESCE(EXCLUDED.open_price,  security_prices.open_price),
           high_price  = COALESCE(EXCLUDED.high_price,  security_prices.high_price),
           low_price   = COALESCE(EXCLUDED.low_price,   security_prices.low_price),
           volume      = COALESCE(EXCLUDED.volume,      security_prices.volume),
           source      = 'manual'
         RETURNING id`,
        [
          securityId,
          dto.priceDate,
          dto.openPrice ?? null,
          dto.highPrice ?? null,
          dto.lowPrice ?? null,
          dto.closePrice,
          dto.volume ?? null,
        ],
      );

      const id = returnedRows<{ id: number }>(rows)[0]?.id;
      const saved = id
        ? await m.getRepository(SecurityPrice).findOne({ where: { id } })
        : null;
      if (!saved) {
        throw new Error(
          `Failed to persist manual price for security ${securityId} on ${dto.priceDate}`,
        );
      }
      return saved;
    });
  }

  async updatePrice(
    securityId: string,
    priceId: number,
    dto: UpdateSecurityPriceDto,
  ): Promise<SecurityPrice> {
    const price = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(SecurityPrice).findOne({
        where: { id: priceId, securityId },
      }),
    );

    if (!price) {
      throw new NotFoundException(
        tr("errors.securities.priceNotFound", "Security price not found"),
      );
    }

    if (dto.closePrice !== undefined) price.closePrice = dto.closePrice;
    if (dto.openPrice !== undefined) price.openPrice = dto.openPrice;
    if (dto.highPrice !== undefined) price.highPrice = dto.highPrice;
    if (dto.lowPrice !== undefined) price.lowPrice = dto.lowPrice;
    if (dto.volume !== undefined) price.volume = dto.volume;
    if (dto.priceDate !== undefined) price.priceDate = dto.priceDate;
    price.source = "manual";

    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(SecurityPrice).save(price),
    );
  }

  async deletePrice(securityId: string, priceId: number): Promise<void> {
    const price = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(SecurityPrice).findOne({
        where: { id: priceId, securityId },
      }),
    );

    if (!price) {
      throw new NotFoundException(
        tr("errors.securities.priceNotFound", "Security price not found"),
      );
    }

    const priceDate = price.priceDate;

    await withScopedDb(this.dataSource, (m) =>
      m.getRepository(SecurityPrice).remove(price),
    );

    await this.upsertTransactionPrice(securityId, priceDate).catch((err) =>
      this.logger.warn(
        `Failed to backfill transaction price after deletion: ${err.message}`,
      ),
    );
  }
}
