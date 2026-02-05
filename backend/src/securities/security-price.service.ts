import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SecurityPrice } from './entities/security-price.entity';
import { Security } from './entities/security.entity';

interface YahooQuoteResult {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketOpen?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  regularMarketTime?: number;
}

interface YahooSearchResult {
  symbol: string;
  shortname?: string;
  longname?: string;
  exchDisp?: string;
  typeDisp?: string;
}

export interface SecurityLookupResult {
  symbol: string;
  name: string;
  exchange: string | null;
  securityType: string | null;
  currencyCode: string | null;
}

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
  ) {}

  /**
   * Fetch quote data from Yahoo Finance for a single symbol using v8 chart API
   */
  private async fetchYahooQuote(symbol: string): Promise<YahooQuoteResult | null> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      if (!response.ok) {
        this.logger.warn(`Yahoo Finance API returned ${response.status} for ${symbol}`);
        return null;
      }

      const data = await response.json();

      if (data.chart?.result?.[0]?.meta) {
        const meta = data.chart.result[0].meta;
        return {
          symbol: meta.symbol,
          regularMarketPrice: meta.regularMarketPrice,
          regularMarketOpen: meta.regularMarketDayHigh ? undefined : undefined, // Not in meta
          regularMarketDayHigh: meta.regularMarketDayHigh,
          regularMarketDayLow: meta.regularMarketDayLow,
          regularMarketVolume: meta.regularMarketVolume,
          regularMarketTime: meta.regularMarketTime,
        };
      }

      return null;
    } catch (error) {
      this.logger.error(`Failed to fetch Yahoo Finance quote for ${symbol}: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch quote data from Yahoo Finance for multiple symbols
   */
  private async fetchYahooQuotes(symbols: string[]): Promise<Map<string, YahooQuoteResult>> {
    const results = new Map<string, YahooQuoteResult>();

    if (symbols.length === 0) {
      return results;
    }

    // Fetch each symbol individually (v8 chart API doesn't support batch)
    await Promise.all(
      symbols.map(async (symbol) => {
        const quote = await this.fetchYahooQuote(symbol);
        if (quote) {
          results.set(symbol, quote);
        }
      }),
    );

    return results;
  }

  /**
   * Refresh prices for all active securities
   */
  async refreshAllPrices(): Promise<PriceRefreshSummary> {
    const startTime = Date.now();
    this.logger.log('Starting price refresh for all securities');

    // Get all active securities that don't have price updates disabled
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

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Fetch prices for all securities in parallel
    await Promise.all(
      securities.map(async (security) => {
        // Get the Yahoo Finance symbol using exchange mapping
        const yahooSymbol = this.getYahooSymbol(security.symbol, security.exchange);
        let quote = await this.fetchYahooQuote(yahooSymbol);

        // If exchange-based symbol didn't work, try alternate suffixes
        if (!quote && yahooSymbol === security.symbol) {
          const alternateSymbols = this.getAlternateSymbols(security.symbol);
          for (const altSymbol of alternateSymbols) {
            quote = await this.fetchYahooQuote(altSymbol);
            if (quote) break;
          }
        }

        if (!quote || quote.regularMarketPrice === undefined) {
          results.push({
            symbol: security.symbol,
            success: false,
            error: 'No price data available',
          });
          failed++;
          return;
        }

        try {
          await this.savePriceData(security.id, today, quote);
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
  async refreshPricesForSecurities(securityIds: string[]): Promise<PriceRefreshSummary> {
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

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Fetch prices for all securities in parallel
    await Promise.all(
      securities.map(async (security) => {
        const yahooSymbol = this.getYahooSymbol(security.symbol, security.exchange);
        let quote = await this.fetchYahooQuote(yahooSymbol);

        // If exchange-based symbol didn't work, try alternate suffixes
        if (!quote && yahooSymbol === security.symbol) {
          const alternateSymbols = this.getAlternateSymbols(security.symbol);
          for (const altSymbol of alternateSymbols) {
            quote = await this.fetchYahooQuote(altSymbol);
            if (quote) break;
          }
        }

        if (!quote || quote.regularMarketPrice === undefined) {
          results.push({
            symbol: security.symbol,
            success: false,
            error: 'No price data available',
          });
          failed++;
          return;
        }

        try {
          await this.savePriceData(security.id, today, quote);
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
    // Check if price already exists for today
    const existing = await this.securityPriceRepository.findOne({
      where: { securityId, priceDate },
    });

    if (existing) {
      // Update existing price
      existing.openPrice = quote.regularMarketOpen ?? existing.openPrice;
      existing.highPrice = quote.regularMarketDayHigh ?? existing.highPrice;
      existing.lowPrice = quote.regularMarketDayLow ?? existing.lowPrice;
      existing.closePrice = quote.regularMarketPrice!;
      existing.volume = quote.regularMarketVolume ?? existing.volume;
      existing.source = 'yahoo_finance';
      return this.securityPriceRepository.save(existing);
    }

    // Create new price entry
    const priceEntry = this.securityPriceRepository.create({
      securityId,
      priceDate,
      openPrice: quote.regularMarketOpen,
      highPrice: quote.regularMarketDayHigh,
      lowPrice: quote.regularMarketDayLow,
      closePrice: quote.regularMarketPrice!,
      volume: quote.regularMarketVolume,
      source: 'yahoo_finance',
    });

    return this.securityPriceRepository.save(priceEntry);
  }

  /**
   * Get the Yahoo Finance symbol based on exchange
   */
  private getYahooSymbol(symbol: string, exchange: string | null): string {
    // If symbol already has a suffix, use it as-is
    if (symbol.includes('.')) {
      return symbol;
    }

    // Map exchanges to Yahoo Finance suffixes
    const exchangeSuffixMap: Record<string, string> = {
      // Canadian exchanges
      'TSX': '.TO',
      'TSE': '.TO',
      'TORONTO': '.TO',
      'TORONTO STOCK EXCHANGE': '.TO',
      'TSX-V': '.V',
      'TSX VENTURE': '.V',
      'TSXV': '.V',
      'CSE': '.CN',
      'CANADIAN SECURITIES EXCHANGE': '.CN',
      'NEO': '.NE',
      // US exchanges (no suffix needed)
      'NYSE': '',
      'NASDAQ': '',
      'AMEX': '',
      'ARCA': '',
      // Other international exchanges
      'LSE': '.L',
      'LONDON': '.L',
      'ASX': '.AX',
      'FRANKFURT': '.F',
      'XETRA': '.DE',
      'PARIS': '.PA',
      'TOKYO': '.T',
      'HONG KONG': '.HK',
      'HKEX': '.HK',
    };

    if (exchange) {
      const normalizedExchange = exchange.toUpperCase().trim();
      const suffix = exchangeSuffixMap[normalizedExchange];
      if (suffix !== undefined) {
        return `${symbol}${suffix}`;
      }
    }

    // Default: return symbol as-is (assumes US market)
    return symbol;
  }

  /**
   * Get alternate Yahoo Finance symbols for Canadian/international markets (fallback)
   */
  private getAlternateSymbols(symbol: string): string[] {
    const alternates: string[] = [];

    // Canadian market suffixes as fallback
    if (!symbol.includes('.')) {
      alternates.push(`${symbol}.TO`); // Toronto Stock Exchange
      alternates.push(`${symbol}.V`); // TSX Venture
      alternates.push(`${symbol}.CN`); // Canadian Securities Exchange
    }

    return alternates;
  }

  /**
   * Get the latest price for a security
   */
  async getLatestPrice(securityId: string): Promise<SecurityPrice | null> {
    return this.securityPriceRepository.findOne({
      where: { securityId },
      order: { priceDate: 'DESC' },
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
      .createQueryBuilder('sp')
      .where('sp.securityId = :securityId', { securityId })
      .orderBy('sp.priceDate', 'DESC')
      .take(limit);

    if (startDate) {
      query.andWhere('sp.priceDate >= :startDate', { startDate });
    }

    if (endDate) {
      query.andWhere('sp.priceDate <= :endDate', { endDate });
    }

    return query.getMany();
  }

  /**
   * Get exchange priority for sorting (lower = higher priority)
   * Priority: TSX (1), US exchanges (2), Other (3)
   */
  private getExchangePriority(symbol: string, exchDisp?: string): number {
    const suffix = symbol.includes('.') ? symbol.substring(symbol.lastIndexOf('.')).toUpperCase() : '';
    const exchange = (exchDisp || '').toUpperCase();

    // TSX and Canadian exchanges - highest priority
    if (suffix === '.TO' || suffix === '.V' || suffix === '.CN' || suffix === '.NE' ||
        exchange.includes('TORONTO') || exchange.includes('TSX') || exchange.includes('CANADA')) {
      return 1;
    }

    // US exchanges - second priority (no suffix typically means US)
    if (suffix === '' || exchange.includes('NYSE') || exchange.includes('NASDAQ') ||
        exchange.includes('AMEX') || exchange.includes('ARCA') || exchange === 'NYQ' ||
        exchange === 'NMS' || exchange === 'NGM' || exchange === 'PCX') {
      return 2;
    }

    // Everything else
    return 3;
  }

  /**
   * Lookup security information from Yahoo Finance
   */
  async lookupSecurity(query: string): Promise<SecurityLookupResult | null> {
    try {
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      if (!response.ok) {
        this.logger.warn(`Yahoo Finance search API returned ${response.status} for query: ${query}`);
        return null;
      }

      const data = await response.json();
      const quotes: YahooSearchResult[] = data.quotes || [];

      if (quotes.length === 0) {
        return null;
      }

      // Sort by exchange priority: TSX first, then US, then others
      const sortedQuotes = [...quotes].sort((a, b) => {
        const priorityA = this.getExchangePriority(a.symbol, a.exchDisp);
        const priorityB = this.getExchangePriority(b.symbol, b.exchDisp);
        return priorityA - priorityB;
      });

      // Find the best match - prefer exact symbol match within prioritized results
      const upperQuery = query.toUpperCase().trim();
      let bestMatch = sortedQuotes.find(
        (q) => this.extractBaseSymbol(q.symbol).toUpperCase() === upperQuery,
      );

      // If no exact symbol match, use the first result (highest priority exchange)
      if (!bestMatch) {
        bestMatch = sortedQuotes[0];
      }

      // Extract base symbol (remove suffix like .TO, .V, etc.)
      const baseSymbol = this.extractBaseSymbol(bestMatch.symbol);

      // Extract exchange from symbol suffix
      const exchange = this.extractExchangeFromSymbol(bestMatch.symbol) || bestMatch.exchDisp || null;

      // Map Yahoo type to our security type
      const securityType = this.mapYahooTypeToSecurityType(bestMatch.typeDisp);

      // Get currency from exchange
      const currencyCode = this.getCurrencyFromExchange(exchange, bestMatch.symbol);

      return {
        symbol: baseSymbol,
        name: bestMatch.longname || bestMatch.shortname || baseSymbol,
        exchange,
        securityType,
        currencyCode,
      };
    } catch (error) {
      this.logger.error(`Failed to lookup security: ${error.message}`);
      return null;
    }
  }

  /**
   * Extract base symbol without exchange suffix
   */
  private extractBaseSymbol(symbol: string): string {
    const dotIndex = symbol.lastIndexOf('.');
    if (dotIndex > 0) {
      return symbol.substring(0, dotIndex);
    }
    return symbol;
  }

  /**
   * Extract exchange from Yahoo symbol suffix
   */
  private extractExchangeFromSymbol(symbol: string): string | null {
    const dotIndex = symbol.lastIndexOf('.');
    if (dotIndex <= 0) {
      return null; // US market (no suffix)
    }

    const suffix = symbol.substring(dotIndex).toUpperCase();
    const suffixToExchange: Record<string, string> = {
      '.TO': 'TSX',
      '.V': 'TSX-V',
      '.CN': 'CSE',
      '.NE': 'NEO',
      '.L': 'LSE',
      '.AX': 'ASX',
      '.F': 'Frankfurt',
      '.DE': 'XETRA',
      '.PA': 'Paris',
      '.T': 'Tokyo',
      '.HK': 'HKEX',
    };

    return suffixToExchange[suffix] || null;
  }

  /**
   * Map Yahoo type display to our security type
   */
  private mapYahooTypeToSecurityType(typeDisp: string | undefined): string | null {
    if (!typeDisp) return null;

    const typeMap: Record<string, string> = {
      'Equity': 'STOCK',
      'ETF': 'ETF',
      'Mutual Fund': 'MUTUAL_FUND',
      'Bond': 'BOND',
      'Option': 'OPTION',
      'Cryptocurrency': 'CRYPTO',
    };

    return typeMap[typeDisp] || null;
  }

  /**
   * Get currency code from exchange name
   */
  private getCurrencyFromExchange(exchange: string | null, symbol: string): string | null {
    // If no exchange suffix, assume US market
    if (!exchange || symbol.indexOf('.') === -1) {
      return 'USD';
    }

    const exchangeToCurrency: Record<string, string> = {
      // Canadian
      'TSX': 'CAD',
      'TSX-V': 'CAD',
      'CSE': 'CAD',
      'NEO': 'CAD',
      // UK
      'LSE': 'GBP',
      // Australia
      'ASX': 'AUD',
      // Europe
      'Frankfurt': 'EUR',
      'XETRA': 'EUR',
      'Paris': 'EUR',
      // Asia
      'Tokyo': 'JPY',
      'HKEX': 'HKD',
    };

    return exchangeToCurrency[exchange] || null;
  }

  /**
   * Get the last update timestamp
   */
  async getLastUpdateTime(): Promise<Date | null> {
    const latest = await this.securityPriceRepository.findOne({
      where: {},
      order: { createdAt: 'DESC' },
    });
    return latest?.createdAt ?? null;
  }

  /**
   * Fetch historical daily prices from Yahoo Finance for a single symbol
   */
  private async fetchYahooHistorical(
    symbol: string,
  ): Promise<Array<{ date: Date; open: number | null; high: number | null; low: number | null; close: number; volume: number | null }> | null> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=max`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      if (!response.ok) {
        this.logger.warn(`Yahoo Finance API returned ${response.status} for historical ${symbol}`);
        return null;
      }

      const data = await response.json();
      const result = data.chart?.result?.[0];
      if (!result?.timestamp || !result?.indicators?.quote?.[0]) {
        return null;
      }

      const timestamps: number[] = result.timestamp;
      const quote = result.indicators.quote[0];
      const prices: Array<{ date: Date; open: number | null; high: number | null; low: number | null; close: number; volume: number | null }> = [];

      for (let i = 0; i < timestamps.length; i++) {
        const close = quote.close?.[i];
        if (close == null || isNaN(close)) continue;

        const date = new Date(timestamps[i] * 1000);
        date.setHours(0, 0, 0, 0);

        prices.push({
          date,
          open: quote.open?.[i] ?? null,
          high: quote.high?.[i] ?? null,
          low: quote.low?.[i] ?? null,
          close,
          volume: quote.volume?.[i] ?? null,
        });
      }

      return prices;
    } catch (error) {
      this.logger.error(`Failed to fetch historical prices for ${symbol}: ${error.message}`);
      return null;
    }
  }

  /**
   * Backfill historical prices for all active securities.
   * Only fetches prices back to the earliest investment transaction date for each security.
   */
  async backfillHistoricalPrices(): Promise<HistoricalBackfillSummary> {
    const startTime = Date.now();
    this.logger.log('Starting historical price backfill');

    const securities = await this.securitiesRepository.find({
      where: { isActive: true, skipPriceUpdates: false },
    });

    // Find earliest investment transaction date per security
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

    // Process sequentially to avoid rate limiting
    for (const security of securities) {
      const earliest = earliestTxDate.get(security.id);
      if (!earliest) {
        results.push({ symbol: security.symbol, success: true, pricesLoaded: 0 });
        successful++;
        continue;
      }

      const yahooSymbol = this.getYahooSymbol(security.symbol, security.exchange);
      let prices = await this.fetchYahooHistorical(yahooSymbol);

      // Fallback to alternate symbols if needed
      if (!prices && yahooSymbol === security.symbol) {
        const alternateSymbols = this.getAlternateSymbols(security.symbol);
        for (const altSymbol of alternateSymbols) {
          prices = await this.fetchYahooHistorical(altSymbol);
          if (prices) break;
        }
      }

      if (!prices || prices.length === 0) {
        results.push({ symbol: security.symbol, success: false, error: 'No historical data available' });
        failed++;
        continue;
      }

      // Filter to only keep prices from the earliest transaction date onward
      const cutoff = new Date(earliest);
      cutoff.setHours(0, 0, 0, 0);
      prices = prices.filter((p) => p.date >= cutoff);

      // Deduplicate by date (Yahoo can return duplicate timestamps)
      const seen = new Set<string>();
      prices = prices.filter((p) => {
        const key = p.date.toISOString().substring(0, 10);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (prices.length === 0) {
        results.push({ symbol: security.symbol, success: true, pricesLoaded: 0 });
        successful++;
        continue;
      }

      try {
        // Bulk upsert using raw SQL for performance
        const batchSize = 500;
        for (let i = 0; i < prices.length; i += batchSize) {
          const batch = prices.slice(i, i + batchSize);
          const values = batch.map(
            (p, idx) => {
              const offset = idx * 7;
              return `($${offset + 1}::UUID, $${offset + 2}::DATE, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, 'yahoo_finance')`;
            },
          ).join(', ');

          const params: any[] = [];
          for (const p of batch) {
            params.push(security.id, p.date, p.open, p.high, p.low, p.close, p.volume);
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

        this.logger.log(`Backfilled ${prices.length} prices for ${security.symbol} (from ${earliest})`);
        results.push({ symbol: security.symbol, success: true, pricesLoaded: prices.length });
        successful++;
        totalPricesLoaded += prices.length;
      } catch (error) {
        this.logger.error(`Failed to save historical prices for ${security.symbol}: ${error.message}`);
        results.push({ symbol: security.symbol, success: false, error: error.message });
        failed++;
      }

      // Small delay between securities to avoid rate limiting
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
   * Scheduled job to refresh prices daily at 5 PM EST (after market close)
   * Runs Monday-Friday only
   */
  @Cron('0 17 * * 1-5', { timeZone: 'America/New_York' })
  async scheduledPriceRefresh(): Promise<void> {
    this.logger.log('Running scheduled price refresh');
    try {
      await this.refreshAllPrices();
    } catch (error) {
      this.logger.error(`Scheduled price refresh failed: ${error.message}`);
    }
  }
}
