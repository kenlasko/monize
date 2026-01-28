import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
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

@Injectable()
export class SecurityPriceService {
  private readonly logger = new Logger(SecurityPriceService.name);

  constructor(
    @InjectRepository(SecurityPrice)
    private securityPriceRepository: Repository<SecurityPrice>,
    @InjectRepository(Security)
    private securitiesRepository: Repository<Security>,
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

    // Get all active securities
    const securities = await this.securitiesRepository.find({
      where: { isActive: true },
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
      where: { id: In(securityIds), isActive: true },
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

      return {
        symbol: baseSymbol,
        name: bestMatch.longname || bestMatch.shortname || baseSymbol,
        exchange,
        securityType,
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
