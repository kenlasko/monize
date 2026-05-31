import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In, DataSource } from "typeorm";
import { Cron } from "@nestjs/schedule";
import { SecurityPrice } from "./entities/security-price.entity";
import { Security } from "./entities/security.entity";
import { NetWorthService } from "../net-worth/net-worth.service";
import { UserPreference } from "../users/entities/user-preference.entity";
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
import { CreateSecurityPriceDto } from "./dto/create-security-price.dto";
import { UpdateSecurityPriceDto } from "./dto/update-security-price.dto";
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
    @InjectRepository(SecurityPrice)
    private securityPriceRepository: Repository<SecurityPrice>,
    @InjectRepository(Security)
    private securitiesRepository: Repository<Security>,
    @InjectRepository(UserPreference)
    private userPreferencesRepository: Repository<UserPreference>,
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

    const prefs = await this.userPreferencesRepository.find({
      where: { userId: In([...new Set(userIds)]) },
    });

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
      await this.securitiesRepository.update(security.id, {
        msnInstrumentId: upgradedId,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to persist upgraded MSN id for ${security.symbol}: ${err instanceof Error ? err.message : String(err)}`,
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
        await this.securitiesRepository.update(security.id, {
          msnInstrumentId: id,
        });
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

  async refreshAllPrices(): Promise<PriceRefreshSummary> {
    const startTime = Date.now();
    this.logger.log("Starting price refresh for all securities");

    const allActive = await this.securitiesRepository.find({
      where: { isActive: true },
    });
    const eligible = allActive.filter((s) => isRefreshEligible(s));

    // Skip securities that already have a price stored for today's date so a
    // re-run after the daily close (or an on-demand refresh) doesn't re-fetch
    // quotes that are already current. UTC "today" matches the US trading date
    // at the 17:00 ET cron; outside that window nothing matches and we refresh
    // everything, so this only ever avoids redundant work, never skips a
    // security that needs updating.
    let securities = eligible;
    let skipped = 0;
    if (eligible.length > 0) {
      const today = formatDateYMD(new Date());
      const freshRows: { security_id: string }[] =
        (await this.dataSource.query(
          `SELECT DISTINCT security_id FROM security_prices
           WHERE security_id = ANY($1) AND price_date >= $2`,
          [eligible.map((s) => s.id), today],
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
    const securities = await this.securitiesRepository.find({
      where: { id: In(securityIds), isActive: true },
    });
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

    const existing = await this.securityPriceRepository.findOne({
      where: { securityId, priceDate },
    });

    if (existing) {
      existing.openPrice = quote.regularMarketOpen ?? existing.openPrice;
      existing.highPrice = quote.regularMarketDayHigh ?? existing.highPrice;
      existing.lowPrice = quote.regularMarketDayLow ?? existing.lowPrice;
      existing.closePrice = quote.regularMarketPrice!;
      existing.volume = quote.regularMarketVolume ?? existing.volume;
      existing.source = source;
      return this.securityPriceRepository.save(existing);
    }

    const priceEntry = this.securityPriceRepository.create({
      securityId,
      priceDate,
      openPrice: quote.regularMarketOpen,
      highPrice: quote.regularMarketDayHigh,
      lowPrice: quote.regularMarketDayLow,
      closePrice: quote.regularMarketPrice!,
      volume: quote.regularMarketVolume,
      source,
    });

    return this.securityPriceRepository.save(priceEntry);
  }

  // ─── Read helpers ────────────────────────────────────────────────────────

  async getLatestPrice(securityId: string): Promise<SecurityPrice | null> {
    return this.securityPriceRepository.findOne({
      where: { securityId },
      order: { priceDate: "DESC" },
    });
  }

  async getPriceHistory(
    securityId: string,
    startDate?: Date,
    endDate?: Date,
    limit: number = 365,
  ): Promise<SecurityPrice[]> {
    const query = this.securityPriceRepository
      .createQueryBuilder("sp")
      .where("sp.securityId = :securityId", { securityId })
      .orderBy("sp.priceDate", "DESC")
      .take(limit);

    if (startDate) {
      query.andWhere("sp.priceDate >= :startDate", { startDate });
    }

    if (endDate) {
      query.andWhere("sp.priceDate <= :endDate", { endDate });
    }

    return query.getMany();
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

  async getLastUpdateTime(): Promise<Date | null> {
    const latest = await this.securityPriceRepository.findOne({
      where: {},
      order: { createdAt: "DESC" },
    });
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

    const allActive = await this.securitiesRepository.find({
      where: { isActive: true },
    });
    const securities = allActive.filter((s) => isRefreshEligible(s));

    const userContexts = await this.loadUserContexts(
      securities.map((s) => s.userId),
    );

    const earliestTxRows: Array<{ security_id: string; earliest: string }> =
      await this.dataSource.query(
        `SELECT security_id, MIN(transaction_date)::TEXT as earliest
         FROM investment_transactions
         WHERE security_id IS NOT NULL
         GROUP BY security_id`,
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
      await this.dataSource.query(
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
      );
    }
  }

  @Cron("0 17 * * 1-5", { timeZone: "America/New_York" })
  async scheduledPriceRefresh(): Promise<void> {
    this.logger.log("Running scheduled price refresh");
    try {
      const result = await this.refreshAllPrices();
      if (result.updated > 0) {
        this.logger.log(
          "Recalculating investment snapshots after price refresh",
        );
        await this.netWorthService.recalculateAllInvestmentSnapshots();
      }
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
    await this.backfillSecurityRange(security, "1y");
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
    // Only actual trades (BUY/SELL/REINVEST) imply a market price. TRANSFER_IN/
    // TRANSFER_OUT legs carry the carried cost basis, not the market price on
    // the transfer date, so they are excluded from the derived price.
    const rows: Array<{
      avg_price: string;
      latest_action: string;
    }> = await this.dataSource.query(
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
    );

    const avgPrice = rows[0]?.avg_price
      ? Math.round(Number(rows[0].avg_price) * 1000000) / 1000000
      : null;
    const latestAction = rows[0]?.latest_action;

    if (avgPrice === null || latestAction === null) {
      await this.dataSource.query(
        `DELETE FROM security_prices
         WHERE security_id = $1 AND price_date = $2
           AND source = ANY($3)`,
        [securityId, transactionDate, TRANSACTION_SOURCES],
      );
      return;
    }

    const source = latestAction.toLowerCase();

    await this.dataSource.query(
      `INSERT INTO security_prices (security_id, price_date, close_price, source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (security_id, price_date)
       DO UPDATE SET close_price = $3, source = $4
       WHERE security_prices.source = ANY($5)`,
      [securityId, transactionDate, avgPrice, source, TRANSACTION_SOURCES],
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
    }> = await this.dataSource.query(
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

      const result = await this.dataSource.query(
        `INSERT INTO security_prices (security_id, price_date, close_price, source)
         VALUES ${values}
         ON CONFLICT (security_id, price_date)
         DO UPDATE SET close_price = EXCLUDED.close_price, source = EXCLUDED.source
         WHERE security_prices.source = ANY($${params.length + 1})`,
        [...params, TRANSACTION_SOURCES],
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
    const existing = await this.securityPriceRepository.findOne({
      where: { securityId, priceDate: dto.priceDate },
    });

    if (existing) {
      existing.closePrice = dto.closePrice;
      existing.openPrice = dto.openPrice as number;
      existing.highPrice = dto.highPrice as number;
      existing.lowPrice = dto.lowPrice as number;
      existing.volume = dto.volume as number;
      existing.source = "manual";
      return this.securityPriceRepository.save(existing);
    }

    const priceEntry = this.securityPriceRepository.create({
      securityId,
      priceDate: dto.priceDate,
      closePrice: dto.closePrice,
      openPrice: dto.openPrice as number,
      highPrice: dto.highPrice as number,
      lowPrice: dto.lowPrice as number,
      volume: dto.volume as number,
      source: "manual",
    });

    return this.securityPriceRepository.save(priceEntry);
  }

  async updatePrice(
    securityId: string,
    priceId: number,
    dto: UpdateSecurityPriceDto,
  ): Promise<SecurityPrice> {
    const price = await this.securityPriceRepository.findOne({
      where: { id: priceId, securityId },
    });

    if (!price) {
      throw new NotFoundException("Security price not found");
    }

    if (dto.closePrice !== undefined) price.closePrice = dto.closePrice;
    if (dto.openPrice !== undefined) price.openPrice = dto.openPrice;
    if (dto.highPrice !== undefined) price.highPrice = dto.highPrice;
    if (dto.lowPrice !== undefined) price.lowPrice = dto.lowPrice;
    if (dto.volume !== undefined) price.volume = dto.volume;
    if (dto.priceDate !== undefined) price.priceDate = dto.priceDate;
    price.source = "manual";

    return this.securityPriceRepository.save(price);
  }

  async deletePrice(securityId: string, priceId: number): Promise<void> {
    const price = await this.securityPriceRepository.findOne({
      where: { id: priceId, securityId },
    });

    if (!price) {
      throw new NotFoundException("Security price not found");
    }

    const priceDate = price.priceDate;

    await this.securityPriceRepository.remove(price);

    await this.upsertTransactionPrice(securityId, priceDate).catch((err) =>
      this.logger.warn(
        `Failed to backfill transaction price after deletion: ${err.message}`,
      ),
    );
  }
}
