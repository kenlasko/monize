import { Injectable, Logger } from "@nestjs/common";
import * as https from "https";
import { isGbxCurrency, convertGbxToGbp } from "../common/gbx-currency.util";

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

export interface StockSectorInfo {
  sector: string | null;
  industry: string | null;
}

export interface EtfSectorWeighting {
  sector: string;
  weight: number;
}

/** Normalize Yahoo's ETF sector keys to display names */
const YAHOO_SECTOR_NAMES: Record<string, string> = {
  realestate: "Real Estate",
  consumer_cyclical: "Consumer Cyclical",
  basic_materials: "Basic Materials",
  consumer_defensive: "Consumer Defensive",
  technology: "Technology",
  communication_services: "Communication Services",
  financial_services: "Financial Services",
  utilities: "Utilities",
  industrials: "Industrials",
  healthcare: "Healthcare",
  energy: "Energy",
};

const YAHOO_BASE_URL = "https://query1.finance.yahoo.com";

/** Max length for symbols and search queries sent to Yahoo Finance. */
const MAX_QUERY_LENGTH = 200;

/**
 * Validate and build a Yahoo Finance URL, ensuring the result always
 * points to the expected host.
 */
function buildYahooUrl(path: string, query?: Record<string, string>): string {
  const url = new URL(path, YAHOO_BASE_URL);
  if (url.origin !== YAHOO_BASE_URL) {
    throw new Error("Yahoo Finance URL origin mismatch");
  }
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

@Injectable()
export class YahooFinanceService {
  private readonly logger = new Logger(YahooFinanceService.name);

  private static readonly FETCH_TIMEOUT_MS = 30000;
  private static readonly USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  /** Cached crumb+cookie for v10 API authentication */
  private crumb: string | null = null;
  private cookie: string | null = null;
  private crumbExpiresAt = 0;
  private crumbPromise: Promise<boolean> | null = null;

  /**
   * Obtain a fresh Yahoo Finance crumb+cookie pair.
   * Visits finance.yahoo.com for cookies, then fetches the crumb endpoint.
   * Caches for 1 hour; concurrent calls share one in-flight request.
   */
  private async ensureCrumb(forceRefresh = false): Promise<boolean> {
    if (
      !forceRefresh &&
      this.crumb &&
      this.cookie &&
      Date.now() < this.crumbExpiresAt
    ) {
      return true;
    }

    // Deduplicate concurrent calls
    if (this.crumbPromise) return this.crumbPromise;

    this.crumbPromise = this.fetchCrumb();
    try {
      return await this.crumbPromise;
    } finally {
      this.crumbPromise = null;
    }
  }

  private async fetchCrumb(): Promise<boolean> {
    try {
      // Step 1: Visit finance.yahoo.com to get cookies
      // Use https module instead of fetch because Yahoo's response headers
      // exceed Node.js undici's default maxHeaderSize (16KB)
      const cookieStr = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Cookie request timeout")),
          YahooFinanceService.FETCH_TIMEOUT_MS,
        );
        https
          .get(
            "https://finance.yahoo.com/",
            {
              headers: {
                "User-Agent": YahooFinanceService.USER_AGENT,
                Accept: "text/html",
              },
              maxHeaderSize: 65536,
            },
            (res) => {
              clearTimeout(timer);
              res.resume(); // drain the response body
              const setCookies = res.headers["set-cookie"] ?? [];
              resolve(
                setCookies
                  .map((c) => c.split(";")[0])
                  .filter(Boolean)
                  .join("; "),
              );
            },
          )
          .on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
      });

      if (!cookieStr) {
        this.logger.warn("Yahoo Finance: no cookies received");
        return false;
      }

      // Step 2: Fetch crumb using cookies
      const crumbResp = await fetch(
        "https://query2.finance.yahoo.com/v1/test/getcrumb",
        {
          headers: {
            "User-Agent": YahooFinanceService.USER_AGENT,
            Cookie: cookieStr,
          },
          signal: AbortSignal.timeout(YahooFinanceService.FETCH_TIMEOUT_MS),
        },
      );

      if (!crumbResp.ok) {
        this.logger.warn(
          `Yahoo Finance crumb endpoint returned ${crumbResp.status}`,
        );
        return false;
      }

      const crumbText = await crumbResp.text();
      if (!crumbText || crumbText.length > 50 || crumbText.startsWith("{")) {
        this.logger.warn("Yahoo Finance: invalid crumb response");
        return false;
      }

      this.crumb = crumbText;
      this.cookie = cookieStr;
      this.crumbExpiresAt = Date.now() + 60 * 60 * 1000; // 1 hour
      return true;
    } catch (error) {
      this.logger.error(
        "Failed to obtain Yahoo Finance crumb",
        error instanceof Error ? error.stack : undefined,
      );
      return false;
    }
  }

  /**
   * Make an authenticated v10 API request with crumb+cookie.
   * Retries once with a fresh crumb on 401.
   */
  private async fetchV10(url: string): Promise<Response | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ok = await this.ensureCrumb(attempt > 0);
      if (!ok) return null;

      const separator = url.includes("?") ? "&" : "?";
      const fullUrl = `${url}${separator}crumb=${encodeURIComponent(this.crumb!)}`;

      let response: Response;
      try {
        response = await fetch(fullUrl, {
          headers: {
            "User-Agent": YahooFinanceService.USER_AGENT,
            Cookie: this.cookie!,
          },
          redirect: "error",
          signal: AbortSignal.timeout(YahooFinanceService.FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        this.logger.error(`Yahoo Finance v10 fetch error: ${err}`);
        return null;
      }

      if (response.status === 401 && attempt === 0) {
        this.logger.warn("Yahoo Finance v10: got 401, refreshing crumb");
        await response.text().catch(() => {}); // drain body before retry
        continue;
      }

      return response;
    }
    return null;
  }

  async fetchQuote(symbol: string): Promise<YahooQuoteResult | null> {
    try {
      const safeSymbol = symbol.slice(0, MAX_QUERY_LENGTH);
      const url = buildYahooUrl(
        `/v8/finance/chart/${encodeURIComponent(safeSymbol)}`,
        { interval: "1d", range: "1d" },
      );

      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        redirect: "error",
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
        const gbx = isGbxCurrency(meta.currency);
        const convert = (v: number | undefined) =>
          v !== undefined && gbx ? convertGbxToGbp(v) : v;

        return {
          symbol: meta.symbol,
          regularMarketPrice: convert(meta.regularMarketPrice),
          regularMarketOpen: convert(meta.regularMarketOpen),
          regularMarketDayHigh: convert(meta.regularMarketDayHigh),
          regularMarketDayLow: convert(meta.regularMarketDayLow),
          regularMarketVolume: meta.regularMarketVolume,
          regularMarketTime: meta.regularMarketTime,
        };
      }

      return null;
    } catch (error) {
      this.logger.error(
        `Failed to fetch Yahoo Finance quote for ${symbol}`,
        error instanceof Error ? error.stack : undefined,
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
   * Fetch historical daily prices from Yahoo Finance for a single symbol.
   * @param range - Yahoo Finance range string (e.g. "1y", "5y", "max"). Defaults to "max".
   */
  async fetchHistorical(
    symbol: string,
    range: string = "max",
  ): Promise<HistoricalPrice[] | null> {
    try {
      const safeSymbol = symbol.slice(0, MAX_QUERY_LENGTH);
      const safeRange = range.slice(0, 10);
      const url = buildYahooUrl(
        `/v8/finance/chart/${encodeURIComponent(safeSymbol)}`,
        { interval: "1d", range: safeRange },
      );

      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        redirect: "error",
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

      const gbx = isGbxCurrency(result.meta?.currency);
      const convertPrice = (v: number | null | undefined): number | null => {
        if (v == null) return null;
        return gbx ? convertGbxToGbp(v) : v;
      };

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
          open: convertPrice(quote.open?.[i]) ?? null,
          high: convertPrice(quote.high?.[i]) ?? null,
          low: convertPrice(quote.low?.[i]) ?? null,
          close: gbx ? convertGbxToGbp(close) : close,
          volume: quote.volume?.[i] ?? null,
        });
      }

      return prices;
    } catch (error) {
      this.logger.error(
        `Failed to fetch historical prices for ${symbol}`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }

  /**
   * Lookup security information from Yahoo Finance
   */
  async lookupSecurity(query: string): Promise<SecurityLookupResult | null> {
    try {
      const safeQuery = query.slice(0, MAX_QUERY_LENGTH);
      const url = buildYahooUrl("/v1/finance/search", {
        q: safeQuery,
        quotesCount: "10",
        newsCount: "0",
      });

      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        redirect: "error",
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
      this.logger.error(
        "Failed to lookup security",
        error instanceof Error ? error.stack : undefined,
      );
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

  /**
   * Fetch stock sector/industry info via Yahoo Finance v10 quoteSummary API
   */
  async fetchStockSectorInfo(symbol: string): Promise<StockSectorInfo | null> {
    try {
      const safeSymbol = symbol.slice(0, MAX_QUERY_LENGTH);
      const url = buildYahooUrl("/v1/finance/search", {
        q: safeSymbol,
        quotesCount: "5",
        newsCount: "0",
      });

      const response = await fetch(url, {
        headers: {
          "User-Agent": YahooFinanceService.USER_AGENT,
        },
        redirect: "error",
        signal: AbortSignal.timeout(YahooFinanceService.FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.warn(
          `Yahoo Finance search returned ${response.status} for ${symbol}`,
        );
        return null;
      }

      const data = await response.json();
      const quotes = data.quotes || [];

      // Find exact symbol match
      const match = quotes.find(
        (q: Record<string, string>) =>
          q.symbol?.toUpperCase() === symbol.toUpperCase(),
      );

      if (!match) {
        return { sector: null, industry: null };
      }

      return {
        sector: match.sector || match.sectorDisp || null,
        industry: match.industry || match.industryDisp || null,
      };
    } catch (error) {
      this.logger.error(
        `Failed to fetch sector info for ${symbol}`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }

  /**
   * Fetch ETF sector weightings via Yahoo Finance v10 quoteSummary API
   */
  async fetchEtfSectorWeightings(
    symbol: string,
  ): Promise<EtfSectorWeighting[] | null> {
    try {
      const safeSymbol = symbol.slice(0, MAX_QUERY_LENGTH);
      const url = buildYahooUrl(
        `/v10/finance/quoteSummary/${encodeURIComponent(safeSymbol)}`,
        { modules: "topHoldings" },
      );

      const response = await this.fetchV10(url);

      if (!response || !response.ok) {
        this.logger.warn(
          `Yahoo Finance topHoldings returned ${response?.status ?? "no response"} for ${symbol}`,
        );
        return null;
      }

      const data = await response.json();
      const topHoldings = data.quoteSummary?.result?.[0]?.topHoldings;

      if (!topHoldings?.sectorWeightings) {
        return [];
      }

      const weightings: EtfSectorWeighting[] = [];
      for (const entry of topHoldings.sectorWeightings) {
        // Each entry is like { "realestate": { "raw": 0.0234 } }
        const key = Object.keys(entry)[0];
        if (!key) continue;
        const rawValue = entry[key]?.raw ?? 0;
        if (rawValue <= 0) continue;

        const displayName =
          YAHOO_SECTOR_NAMES[key] || key.charAt(0).toUpperCase() + key.slice(1);
        weightings.push({ sector: displayName, weight: rawValue });
      }

      return weightings;
    } catch (error) {
      this.logger.error(
        `Failed to fetch ETF sector weightings for ${symbol}`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }
}
