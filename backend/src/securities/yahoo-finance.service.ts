import { Injectable, Logger } from "@nestjs/common";

export interface YahooQuoteResult {
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

export interface HistoricalPrice {
  date: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

@Injectable()
export class YahooFinanceService {
  private readonly logger = new Logger(YahooFinanceService.name);

  /**
   * Fetch quote data from Yahoo Finance for a single symbol using v8 chart API
   */
  private static readonly FETCH_TIMEOUT_MS = 30000;

  async fetchQuote(symbol: string): Promise<YahooQuoteResult | null> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;

      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        signal: AbortSignal.timeout(YahooFinanceService.FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.warn(
          `Yahoo Finance API returned ${response.status} for ${symbol}`,
        );
        return null;
      }

      const data = await response.json();

      if (data.chart?.result?.[0]?.meta) {
        const meta = data.chart.result[0].meta;
        return {
          symbol: meta.symbol,
          regularMarketPrice: meta.regularMarketPrice,
          regularMarketOpen: meta.regularMarketOpen,
          regularMarketDayHigh: meta.regularMarketDayHigh,
          regularMarketDayLow: meta.regularMarketDayLow,
          regularMarketVolume: meta.regularMarketVolume,
          regularMarketTime: meta.regularMarketTime,
        };
      }

      return null;
    } catch (error) {
      this.logger.error(
        `Failed to fetch Yahoo Finance quote for ${symbol}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Fetch quote data from Yahoo Finance for multiple symbols
   */
  async fetchQuotes(symbols: string[]): Promise<Map<string, YahooQuoteResult>> {
    const results = new Map<string, YahooQuoteResult>();

    if (symbols.length === 0) {
      return results;
    }

    await Promise.all(
      symbols.map(async (symbol) => {
        const quote = await this.fetchQuote(symbol);
        if (quote) {
          results.set(symbol, quote);
        }
      }),
    );

    return results;
  }

  /**
   * Fetch historical daily prices from Yahoo Finance for a single symbol
   */
  async fetchHistorical(symbol: string): Promise<HistoricalPrice[] | null> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=max`;

      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        this.logger.warn(
          `Yahoo Finance API returned ${response.status} for historical ${symbol}`,
        );
        return null;
      }

      const data = await response.json();
      const result = data.chart?.result?.[0];
      if (!result?.timestamp || !result?.indicators?.quote?.[0]) {
        return null;
      }

      const timestamps: number[] = result.timestamp;
      const quote = result.indicators.quote[0];
      const prices: HistoricalPrice[] = [];

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
      this.logger.error(
        `Failed to fetch historical prices for ${symbol}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Lookup security information from Yahoo Finance
   */
  async lookupSecurity(query: string): Promise<SecurityLookupResult | null> {
    try {
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`;

      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        signal: AbortSignal.timeout(YahooFinanceService.FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.warn(
          `Yahoo Finance search API returned ${response.status} for query: ${query}`,
        );
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

      if (!bestMatch) {
        bestMatch = sortedQuotes[0];
      }

      const baseSymbol = this.extractBaseSymbol(bestMatch.symbol);
      const exchange =
        this.extractExchangeFromSymbol(bestMatch.symbol) ||
        bestMatch.exchDisp ||
        null;
      const securityType = this.mapYahooTypeToSecurityType(bestMatch.typeDisp);
      const currencyCode = this.getCurrencyFromExchange(
        exchange,
        bestMatch.symbol,
      );

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
   * Get the Yahoo Finance symbol based on exchange
   */
  getYahooSymbol(symbol: string, exchange: string | null): string {
    if (symbol.includes(".")) {
      return symbol;
    }

    const exchangeSuffixMap: Record<string, string> = {
      TSX: ".TO",
      TSE: ".TO",
      TORONTO: ".TO",
      "TORONTO STOCK EXCHANGE": ".TO",
      "TSX-V": ".V",
      "TSX VENTURE": ".V",
      TSXV: ".V",
      CSE: ".CN",
      "CANADIAN SECURITIES EXCHANGE": ".CN",
      NEO: ".NE",
      NYSE: "",
      NASDAQ: "",
      AMEX: "",
      ARCA: "",
      LSE: ".L",
      LONDON: ".L",
      ASX: ".AX",
      FRANKFURT: ".F",
      XETRA: ".DE",
      PARIS: ".PA",
      TOKYO: ".T",
      "HONG KONG": ".HK",
      HKEX: ".HK",
    };

    if (exchange) {
      const normalizedExchange = exchange.toUpperCase().trim();
      const suffix = exchangeSuffixMap[normalizedExchange];
      if (suffix !== undefined) {
        return `${symbol}${suffix}`;
      }
    }

    return symbol;
  }

  /**
   * Get alternate Yahoo Finance symbols for Canadian/international markets (fallback)
   */
  getAlternateSymbols(symbol: string): string[] {
    const alternates: string[] = [];

    if (!symbol.includes(".")) {
      alternates.push(`${symbol}.TO`);
      alternates.push(`${symbol}.V`);
      alternates.push(`${symbol}.CN`);
    }

    return alternates;
  }

  /**
   * Get the trading date for a Yahoo quote.
   */
  getTradingDate(quote: YahooQuoteResult): Date {
    if (quote.regularMarketTime) {
      const marketDate = new Date(quote.regularMarketTime * 1000);
      // M17: Use UTC consistently to avoid timezone-dependent date drift
      marketDate.setUTCHours(0, 0, 0, 0);
      return marketDate;
    }

    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    const day = date.getUTCDay();
    if (day === 0) date.setUTCDate(date.getUTCDate() - 2);
    else if (day === 6) date.setUTCDate(date.getUTCDate() - 1);
    return date;
  }

  /**
   * Extract base symbol without exchange suffix
   */
  extractBaseSymbol(symbol: string): string {
    const dotIndex = symbol.lastIndexOf(".");
    if (dotIndex > 0) {
      return symbol.substring(0, dotIndex);
    }
    return symbol;
  }

  /**
   * Extract exchange from Yahoo symbol suffix
   */
  extractExchangeFromSymbol(symbol: string): string | null {
    const dotIndex = symbol.lastIndexOf(".");
    if (dotIndex <= 0) {
      return null;
    }

    const suffix = symbol.substring(dotIndex).toUpperCase();
    const suffixToExchange: Record<string, string> = {
      ".TO": "TSX",
      ".V": "TSX-V",
      ".CN": "CSE",
      ".NE": "NEO",
      ".L": "LSE",
      ".AX": "ASX",
      ".F": "Frankfurt",
      ".DE": "XETRA",
      ".PA": "Paris",
      ".T": "Tokyo",
      ".HK": "HKEX",
    };

    return suffixToExchange[suffix] || null;
  }

  /**
   * Get exchange priority for sorting (lower = higher priority)
   */
  getExchangePriority(symbol: string, exchDisp?: string): number {
    const suffix = symbol.includes(".")
      ? symbol.substring(symbol.lastIndexOf(".")).toUpperCase()
      : "";
    const exchange = (exchDisp || "").toUpperCase();

    if (
      suffix === ".TO" ||
      suffix === ".V" ||
      suffix === ".CN" ||
      suffix === ".NE" ||
      exchange.includes("TORONTO") ||
      exchange.includes("TSX") ||
      exchange.includes("CANADA")
    ) {
      return 1;
    }

    if (
      suffix === "" ||
      exchange.includes("NYSE") ||
      exchange.includes("NASDAQ") ||
      exchange.includes("AMEX") ||
      exchange.includes("ARCA") ||
      exchange === "NYQ" ||
      exchange === "NMS" ||
      exchange === "NGM" ||
      exchange === "PCX"
    ) {
      return 2;
    }

    return 3;
  }

  /**
   * Map Yahoo type display to our security type
   */
  private mapYahooTypeToSecurityType(
    typeDisp: string | undefined,
  ): string | null {
    if (!typeDisp) return null;

    const typeMap: Record<string, string> = {
      Equity: "STOCK",
      ETF: "ETF",
      "Mutual Fund": "MUTUAL_FUND",
      Bond: "BOND",
      Option: "OPTION",
      Cryptocurrency: "CRYPTO",
    };

    return typeMap[typeDisp] || null;
  }

  /**
   * Get currency code from exchange name
   */
  private getCurrencyFromExchange(
    exchange: string | null,
    symbol: string,
  ): string | null {
    if (!exchange || symbol.indexOf(".") === -1) {
      return "USD";
    }

    const exchangeToCurrency: Record<string, string> = {
      TSX: "CAD",
      "TSX-V": "CAD",
      CSE: "CAD",
      NEO: "CAD",
      LSE: "GBP",
      ASX: "AUD",
      Frankfurt: "EUR",
      XETRA: "EUR",
      Paris: "EUR",
      Tokyo: "JPY",
      HKEX: "HKD",
    };

    return exchangeToCurrency[exchange] || null;
  }
}
