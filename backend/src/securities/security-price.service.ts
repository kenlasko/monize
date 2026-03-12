import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In, DataSource } from "typeorm";
import { Cron } from "@nestjs/schedule";
import { SecurityPrice } from "./entities/security-price.entity";
import { Security } from "./entities/security.entity";
import { NetWorthService } from "../net-worth/net-worth.service";
import {
  YahooFinanceService,
  YahooQuoteResult,
  SecurityLookupResult,
  HistoricalPrice,
} from "./yahoo-finance.service";
import { CreateSecurityPriceDto } from "./dto/create-security-price.dto";
import { UpdateSecurityPriceDto } from "./dto/update-security-price.dto";

export { SecurityLookupResult } from "./yahoo-finance.service";

const TRANSACTION_SOURCES = [
  "buy",
  "sell",
  "reinvest",
  "transfer_in",
  "transfer_out",
];

export interface PriceUpdateResult {
  symbol: string;
  success: boolean;
  price?: number;
  error?: string;
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
}

export interface HistoricalBackfillSummary {
  totalSecurities: number;
  successful: number;
  failed: number;
  totalPricesLoaded: number;
  results: HistoricalBackfillResult[];
}

@Injectable()
export class SecurityPriceService {
  private readonly logger = new Logger(SecurityPriceService.name);

  constructor(
    @InjectRepository(SecurityPrice)
    private securityPriceRepository: Repository<SecurityPrice>,
    @InjectRepository(Security)
    private securitiesRepository: Repository<Security>,
    private dataSource: DataSource,
    private netWorthService: NetWorthService,
    private yahooFinance: YahooFinanceService,
  ) {}

  /**
   * Refresh prices for all active securities
   */
  async refreshAllPrices(): Promise<PriceRefreshSummary> {
    const startTime = Date.now();
    this.logger.log("Starting price refresh for all securities");

    const securities = await this.securitiesRepository.find({
      where: { isActive: true, skipPriceUpdates: false },
    });

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

    const results: PriceUpdateResult[] = [];
    let updated = 0;
    let failed = 0;
    const skipped = 0;

    // Group securities by (symbol, exchange) to deduplicate API calls
    const symbolGroups = new Map<string, Security[]>();
    for (const security of securities) {
      const key = `${security.symbol}|${security.exchange || ""}`;
      const group = symbolGroups.get(key) || [];
      group.push(security);
      symbolGroups.set(key, group);
    }

    for (const group of symbolGroups.values()) {
      const representative = group[0];
      const yahooSymbol = this.yahooFinance.getYahooSymbol(
        representative.symbol,
        representative.exchange,
      );
      let quote = await this.yahooFinance.fetchQuote(yahooSymbol);

      if (!quote && yahooSymbol === representative.symbol) {
        const alternateSymbols = this.yahooFinance.getAlternateSymbols(
          representative.symbol,
        );
        for (const altSymbol of alternateSymbols) {
          quote = await this.yahooFinance.fetchQuote(altSymbol);
          if (quote) break;
        }
      }

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

      const tradingDate = this.yahooFinance.getTradingDate(quote);
      for (const security of group) {
        try {
          await this.savePriceData(security.id, tradingDate, quote);
          results.push({
            symbol: security.symbol,
            success: true,
            price: quote.regularMarketPrice,
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

  /**
   * Refresh prices for specific securities
   */
  async refreshPricesForSecurities(
    securityIds: string[],
  ): Promise<PriceRefreshSummary> {
    const securities = await this.securitiesRepository.find({
      where: { id: In(securityIds), isActive: true, skipPriceUpdates: false },
    });

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

    const results: PriceUpdateResult[] = [];
    let updated = 0;
    let failed = 0;

    for (const security of securities) {
      const yahooSymbol = this.yahooFinance.getYahooSymbol(
        security.symbol,
        security.exchange,
      );
      let quote = await this.yahooFinance.fetchQuote(yahooSymbol);

      if (!quote && yahooSymbol === security.symbol) {
        const alternateSymbols = this.yahooFinance.getAlternateSymbols(
          security.symbol,
        );
        for (const altSymbol of alternateSymbols) {
          quote = await this.yahooFinance.fetchQuote(altSymbol);
          if (quote) break;
        }
      }

      if (!quote || quote.regularMarketPrice === undefined) {
        results.push({
          symbol: security.symbol,
          success: false,
          error: "No price data available",
        });
        failed++;
        continue;
      }

      try {
        const tradingDate = this.yahooFinance.getTradingDate(quote);
        await this.savePriceData(security.id, tradingDate, quote);
        results.push({
          symbol: security.symbol,
          success: true,
          price: quote.regularMarketPrice,
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
   * Save price data to the database
   */
  private async savePriceData(
    securityId: string,
    priceDate: Date,
    quote: YahooQuoteResult,
  ): Promise<SecurityPrice> {
    const existing = await this.securityPriceRepository.findOne({
      where: { securityId, priceDate },
    });

    if (existing) {
      existing.openPrice = quote.regularMarketOpen ?? existing.openPrice;
      existing.highPrice = quote.regularMarketDayHigh ?? existing.highPrice;
      existing.lowPrice = quote.regularMarketDayLow ?? existing.lowPrice;
      existing.closePrice = quote.regularMarketPrice!;
      existing.volume = quote.regularMarketVolume ?? existing.volume;
      existing.source = "yahoo_finance";
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
      source: "yahoo_finance",
    });

    return this.securityPriceRepository.save(priceEntry);
  }

  /**
   * Get the latest price for a security
   */
  async getLatestPrice(securityId: string): Promise<SecurityPrice | null> {
    return this.securityPriceRepository.findOne({
      where: { securityId },
      order: { priceDate: "DESC" },
    });
  }

  /**
   * Get price history for a security
   */
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
   * Lookup security information (delegates to Yahoo Finance)
   */
  async lookupSecurity(query: string): Promise<SecurityLookupResult | null> {
    return this.yahooFinance.lookupSecurity(query);
  }

  /**
   * Get the last update timestamp
   */
  async getLastUpdateTime(): Promise<Date | null> {
    const latest = await this.securityPriceRepository.findOne({
      where: {},
      order: { createdAt: "DESC" },
    });
    return latest?.createdAt ?? null;
  }

  /**
   * Fetch historical prices for a symbol with alternate-symbol fallback.
   * Returns null if no data is available from any symbol variant.
   */
  private async fetchWithFallback(
    symbol: string,
    exchange: string | null,
    range: string = "max",
  ): Promise<HistoricalPrice[] | null> {
    const yahooSymbol = this.yahooFinance.getYahooSymbol(symbol, exchange);
    let prices = await this.yahooFinance.fetchHistorical(yahooSymbol, range);

    if (!prices && yahooSymbol === symbol) {
      const alternateSymbols = this.yahooFinance.getAlternateSymbols(symbol);
      for (const altSymbol of alternateSymbols) {
        prices = await this.yahooFinance.fetchHistorical(altSymbol, range);
        if (prices) break;
      }
    }

    return prices;
  }

  /**
   * Merge two price arrays, preferring dailyPrices for dates within the last year
   * and maxPrices for older dates. Deduplicates by date.
   */
  private mergePrices(
    maxPrices: HistoricalPrice[],
    dailyPrices: HistoricalPrice[],
    oneYearAgo: Date,
  ): HistoricalPrice[] {
    // Use max-range data for dates before 1Y ago, daily data for the last year
    const olderPrices = maxPrices.filter((p) => p.date < oneYearAgo);
    const merged = [...olderPrices, ...dailyPrices];

    // Deduplicate by date string, keeping the later entry (daily data wins)
    const byDate = new Map<string, HistoricalPrice>();
    for (const p of merged) {
      byDate.set(p.date.toISOString().substring(0, 10), p);
    }

    return [...byDate.values()].sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    );
  }

  /**
   * Backfill historical prices for all active securities.
   * Fetches daily prices for the last year and monthly for older periods.
   * Always backfills at least 1 year, even for securities with no transactions.
   */
  async backfillHistoricalPrices(): Promise<HistoricalBackfillSummary> {
    const startTime = Date.now();
    this.logger.log("Starting historical price backfill");

    const securities = await this.securitiesRepository.find({
      where: { isActive: true, skipPriceUpdates: false },
    });

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

    // Group securities by (symbol, exchange) to deduplicate API calls
    const symbolGroups = new Map<string, Security[]>();
    for (const security of securities) {
      const groupKey = `${security.symbol}|${security.exchange || ""}`;
      const group = symbolGroups.get(groupKey) || [];
      group.push(security);
      symbolGroups.set(groupKey, group);
    }

    for (const group of symbolGroups.values()) {
      const representative = group[0];

      // Determine the earliest cutoff across the group (min of 1Y ago and earliest tx)
      const groupEarliestDates = group
        .map((s) => earliestTxDate.get(s.id))
        .filter(Boolean) as string[];

      const needsOlderData =
        groupEarliestDates.length > 0 &&
        groupEarliestDates.some((d) => d < oneYearAgoStr);

      // Always fetch daily 1Y data for guaranteed daily granularity
      const dailyPrices = await this.fetchWithFallback(
        representative.symbol,
        representative.exchange,
        "1y",
      );

      // Also fetch max range if transactions exist before 1Y ago
      let maxPrices: HistoricalPrice[] | null = null;
      if (needsOlderData) {
        maxPrices = await this.fetchWithFallback(
          representative.symbol,
          representative.exchange,
          "max",
        );
      }

      if (!dailyPrices && !maxPrices) {
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

      // Merge: daily 1Y data + monthly older data from max range
      let allPrices =
        maxPrices && dailyPrices
          ? this.mergePrices(maxPrices, dailyPrices, oneYearAgo)
          : dailyPrices || maxPrices!;

      // Deduplicate by date
      const seen = new Set<string>();
      allPrices = allPrices.filter((p) => {
        const key = p.date.toISOString().substring(0, 10);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      for (const security of group) {
        // Per-security cutoff: earliest of 1Y ago or earliest transaction
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
          });
          successful++;
          continue;
        }

        try {
          await this.bulkUpsertPrices(security.id, prices);

          this.logger.log(
            `Backfilled ${prices.length} prices for ${security.symbol} (from ${secCutoffStr})`,
          );
          results.push({
            symbol: security.symbol,
            success: true,
            pricesLoaded: prices.length,
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

      // Small delay between symbols to avoid rate limiting
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
   * Bulk upsert historical prices using raw SQL for performance
   */
  private async bulkUpsertPrices(
    securityId: string,
    prices: HistoricalPrice[],
  ): Promise<void> {
    const batchSize = 500;
    for (let i = 0; i < prices.length; i += batchSize) {
      const batch = prices.slice(i, i + batchSize);
      const values = batch
        .map((p, idx) => {
          const offset = idx * 7;
          return `($${offset + 1}::UUID, $${offset + 2}::DATE, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, 'yahoo_finance')`;
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
          p.volume,
        );
      }

      await this.dataSource.query(
        `INSERT INTO security_prices (security_id, price_date, open_price, high_price, low_price, close_price, volume, source)
         VALUES ${values}
         ON CONFLICT (security_id, price_date) DO UPDATE SET
           close_price = EXCLUDED.close_price,
           open_price = EXCLUDED.open_price,
           high_price = EXCLUDED.high_price,
           low_price = EXCLUDED.low_price,
           volume = EXCLUDED.volume,
           source = EXCLUDED.source`,
        params,
      );
    }
  }

  /**
   * Scheduled job to refresh prices daily at 5 PM EST (after market close)
   */
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
   * Backfill 1 year of daily prices for a single security.
   * Called when a new security is created (manually or via QIF import).
   */
  async backfillSecurity(security: Security): Promise<void> {
    if (security.skipPriceUpdates) return;

    const prices = await this.fetchWithFallback(
      security.symbol,
      security.exchange,
      "1y",
    );
    if (!prices || prices.length === 0) {
      this.logger.warn(`No historical prices available for ${security.symbol}`);
      return;
    }

    try {
      await this.bulkUpsertPrices(security.id, prices);
      this.logger.log(
        `Backfilled ${prices.length} daily prices for ${security.symbol}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to backfill daily prices for ${security.symbol}: ${error.message}`,
      );
    }
  }

  /**
   * Upsert a transaction-derived price for a security on a given date.
   * Computes average price from all price-relevant transactions on that date.
   * Never overwrites yahoo_finance or manual prices.
   */
  async upsertTransactionPrice(
    securityId: string,
    transactionDate: string,
  ): Promise<void> {
    const rows: Array<{
      avg_price: string;
      latest_action: string;
    }> = await this.dataSource.query(
      `SELECT AVG(price::numeric) as avg_price,
              (SELECT action FROM investment_transactions
               WHERE security_id = $1 AND transaction_date = $2
                 AND action IN ('BUY', 'SELL', 'REINVEST', 'TRANSFER_IN', 'TRANSFER_OUT')
                 AND price IS NOT NULL
               ORDER BY created_at DESC LIMIT 1) as latest_action
       FROM investment_transactions
       WHERE security_id = $1
         AND transaction_date = $2
         AND action IN ('BUY', 'SELL', 'REINVEST', 'TRANSFER_IN', 'TRANSFER_OUT')
         AND price IS NOT NULL`,
      [securityId, transactionDate],
    );

    const avgPrice = rows[0]?.avg_price
      ? Math.round(Number(rows[0].avg_price) * 1000000) / 1000000
      : null;
    const latestAction = rows[0]?.latest_action;

    if (avgPrice === null || latestAction === null) {
      // No transactions remain -- remove any transaction-sourced price
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

  /**
   * Backfill transaction-derived prices for all securities.
   * Processes all distinct (security_id, transaction_date) pairs.
   */
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
                 AND it2.action IN ('BUY', 'SELL', 'REINVEST', 'TRANSFER_IN', 'TRANSFER_OUT')
                 AND it2.price IS NOT NULL
               ORDER BY it2.created_at DESC LIMIT 1) as latest_action
       FROM investment_transactions it
       WHERE it.security_id IS NOT NULL
         AND it.price IS NOT NULL
         AND it.action IN ('BUY', 'SELL', 'REINVEST', 'TRANSFER_IN', 'TRANSFER_OUT')
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

  /**
   * Create a manual price entry (source='manual').
   * Overwrites any existing price for that date.
   */
  async createManualPrice(
    securityId: string,
    dto: CreateSecurityPriceDto,
  ): Promise<SecurityPrice> {
    const existing = await this.securityPriceRepository.findOne({
      where: { securityId, priceDate: new Date(dto.priceDate) },
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
      priceDate: new Date(dto.priceDate),
      closePrice: dto.closePrice,
      openPrice: dto.openPrice as number,
      highPrice: dto.highPrice as number,
      lowPrice: dto.lowPrice as number,
      volume: dto.volume as number,
      source: "manual",
    } as Partial<SecurityPrice>);

    return this.securityPriceRepository.save(priceEntry);
  }

  /**
   * Update an existing price entry. Sets source to 'manual'.
   */
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
    if (dto.priceDate !== undefined) price.priceDate = new Date(dto.priceDate);
    price.source = "manual";

    return this.securityPriceRepository.save(price);
  }

  /**
   * Delete a price entry. Backfills from transactions if available.
   */
  async deletePrice(securityId: string, priceId: number): Promise<void> {
    const price = await this.securityPriceRepository.findOne({
      where: { id: priceId, securityId },
    });

    if (!price) {
      throw new NotFoundException("Security price not found");
    }

    const priceDate =
      typeof price.priceDate === "string"
        ? price.priceDate
        : price.priceDate.toISOString().substring(0, 10);

    await this.securityPriceRepository.remove(price);

    // Backfill from transactions if available
    await this.upsertTransactionPrice(securityId, priceDate).catch((err) =>
      this.logger.warn(
        `Failed to backfill transaction price after deletion: ${err.message}`,
      ),
    );
  }
}
