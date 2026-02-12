import { Injectable, Logger } from "@nestjs/common";
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

export { SecurityLookupResult } from "./yahoo-finance.service";

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

    await Promise.all(
      Array.from(symbolGroups.values()).map(async (group) => {
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
          return;
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
      }),
    );

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

    await Promise.all(
      securities.map(async (security) => {
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
          return;
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
      }),
    );

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
   * Backfill historical prices for all active securities.
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

      const groupEarliestDates = group
        .map((s) => earliestTxDate.get(s.id))
        .filter(Boolean) as string[];

      if (groupEarliestDates.length === 0) {
        for (const security of group) {
          results.push({
            symbol: security.symbol,
            success: true,
            pricesLoaded: 0,
          });
          successful++;
        }
        continue;
      }

      const groupEarliest = groupEarliestDates.sort()[0];

      const yahooSymbol = this.yahooFinance.getYahooSymbol(
        representative.symbol,
        representative.exchange,
      );
      let allPrices = await this.yahooFinance.fetchHistorical(yahooSymbol);

      if (!allPrices && yahooSymbol === representative.symbol) {
        const alternateSymbols = this.yahooFinance.getAlternateSymbols(
          representative.symbol,
        );
        for (const altSymbol of alternateSymbols) {
          allPrices = await this.yahooFinance.fetchHistorical(altSymbol);
          if (allPrices) break;
        }
      }

      if (!allPrices || allPrices.length === 0) {
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

      // Filter and deduplicate
      const groupCutoff = new Date(groupEarliest);
      groupCutoff.setHours(0, 0, 0, 0);
      allPrices = allPrices.filter((p) => p.date >= groupCutoff);

      const seen = new Set<string>();
      allPrices = allPrices.filter((p) => {
        const key = p.date.toISOString().substring(0, 10);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      for (const security of group) {
        const secEarliest = earliestTxDate.get(security.id);
        if (!secEarliest) {
          results.push({
            symbol: security.symbol,
            success: true,
            pricesLoaded: 0,
          });
          successful++;
          continue;
        }

        const secCutoff = new Date(secEarliest);
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
            `Backfilled ${prices.length} prices for ${security.symbol} (from ${secEarliest})`,
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
}
