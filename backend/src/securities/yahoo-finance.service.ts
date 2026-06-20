import { Injectable, Logger } from "@nestjs/common";
import * as https from "https";
import { isGbxCurrency, convertGbxToGbp } from "../common/gbx-currency.util";
import {
  QuoteProvider,
  QuoteProviderName,
  QuoteProviderOptions,
  QuoteResult,
  SecurityLookupResult,
  HistoricalPrice,
  IntradayInterval,
  IntradayPoint,
  IntradayRange,
  StockSectorInfo,
  EtfSectorWeighting,
} from "./providers/quote-provider.interface";
import { getTradingDateFromQuote } from "./providers/trading-date.util";

// Back-compat re-exports so existing imports keep compiling during the migration.
export type YahooQuoteResult = QuoteResult;
export type {
  SecurityLookupResult,
  HistoricalPrice,
  StockSectorInfo,
  EtfSectorWeighting,
} from "./providers/quote-provider.interface";

interface YahooSearchResult {
  symbol: string;
  shortname?: string;
  longname?: string;
  exchDisp?: string;
  typeDisp?: string;
}

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

@Injectable()
export class YahooFinanceService implements QuoteProvider {
  readonly name: QuoteProviderName = "yahoo";

  private readonly logger = new Logger(YahooFinanceService.name);

  private static readonly FETCH_TIMEOUT_MS = 10000;
  private static readonly USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // Yahoo's public chart API doesn't publish a rate limit but returns 429
  // (and occasionally 503) when we burst-fetch dozens of symbols during a
  // catalog-wide price refresh. Cap concurrency and retry transparently on
  // throttled responses so the caller doesn't have to think about it.
  private static readonly MAX_CONCURRENT_REQUESTS = 5;
  private static readonly INTER_REQUEST_GAP_MS = 100;
  private static readonly MAX_RETRIES = 2;
  private static readonly RETRY_INITIAL_DELAY_MS = 500;
  private static readonly RETRY_MAX_DELAY_MS = 30_000;
  private static readonly THROTTLED_STATUSES: ReadonlySet<number> = new Set([
    429, 503,
  ]);

  // Simple async semaphore: at most MAX_CONCURRENT_REQUESTS fetches in flight
  // at once. Anyone who calls acquireSlot() while the gate is full waits in
  // a FIFO queue until releaseSlot() admits them.
  private activeRequests = 0;
  private readonly waitQueue: Array<() => void> = [];

  /** Cached crumb+cookie for v10 API authentication */
  private crumb: string | null = null;
  private cookie: string | null = null;
  private crumbExpiresAt = 0;
  private crumbPromise: Promise<boolean> | null = null;

  private async acquireSlot(): Promise<void> {
    if (this.activeRequests < YahooFinanceService.MAX_CONCURRENT_REQUESTS) {
      this.activeRequests++;
      return;
    }
    await new Promise<void>((resolve) => this.waitQueue.push(resolve));
    this.activeRequests++;
  }

  private releaseSlot(): void {
    this.activeRequests--;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Fetch wrapper that:
   *   - caps concurrency at MAX_CONCURRENT_REQUESTS,
   *   - leaves a small inter-request gap so we don't burst the next slot,
   *   - retries 429/503 with exponential backoff (honoring Retry-After).
   *
   * Non-throttled HTTP errors (4xx other than 429, 5xx other than 503) are
   * returned to the caller untouched -- the helper only handles the
   * "upstream is asking us to slow down" case. Network errors propagate.
   */
  private async throttledFetch(
    url: string,
    init: RequestInit = {},
    opts: { maxRetries?: number; timeoutMs?: number } = {},
  ): Promise<Response> {
    const maxRetries = opts.maxRetries ?? YahooFinanceService.MAX_RETRIES;
    const timeoutMs = opts.timeoutMs ?? YahooFinanceService.FETCH_TIMEOUT_MS;
    await this.acquireSlot();
    try {
      let lastResponse: Response | null = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(timeoutMs),
        });
        lastResponse = response;
        if (!YahooFinanceService.THROTTLED_STATUSES.has(response.status)) {
          return response;
        }
        // Drain the body so the connection can be reused.
        await response.text().catch(() => undefined);
        if (attempt === maxRetries) return response;

        // Honor Retry-After (delta-seconds) when the server provides one,
        // otherwise back off exponentially. The MAX_CONCURRENT_REQUESTS gate
        // and INTER_REQUEST_GAP_MS already keep retries naturally
        // staggered, so we don't add explicit jitter on top.
        const retryAfter = response.headers.get("retry-after");
        const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : 0;
        const backoff =
          YahooFinanceService.RETRY_INITIAL_DELAY_MS * 2 ** attempt;
        const delayMs = Math.min(
          Math.max(retryAfterMs, backoff),
          YahooFinanceService.RETRY_MAX_DELAY_MS,
        );
        this.logger.warn(
          `Yahoo Finance returned ${response.status}; retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`,
        );
        await this.sleep(delayMs);
      }
      return lastResponse!;
    } finally {
      // Stagger slot release so the next request can't immediately follow
      // the previous one back-to-back -- spreads load and helps avoid the
      // 429 in the first place.
      setTimeout(
        () => this.releaseSlot(),
        YahooFinanceService.INTER_REQUEST_GAP_MS,
      );
    }
  }

  private async ensureCrumb(forceRefresh = false): Promise<boolean> {
    if (
      !forceRefresh &&
      this.crumb &&
      this.cookie &&
      Date.now() < this.crumbExpiresAt
    ) {
      return true;
    }

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
              res.resume();
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
      this.crumbExpiresAt = Date.now() + 60 * 60 * 1000;
      return true;
    } catch (error) {
      this.logger.error(
        "Failed to obtain Yahoo Finance crumb",
        error instanceof Error ? error.stack : undefined,
      );
      return false;
    }
  }

  private async fetchV10(url: string): Promise<Response | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ok = await this.ensureCrumb(attempt > 0);
      if (!ok) return null;

      const separator = url.includes("?") ? "&" : "?";
      const fullUrl = `${url}${separator}crumb=${encodeURIComponent(this.crumb!)}`;

      let response: Response;
      try {
        response = await this.throttledFetch(fullUrl, {
          headers: {
            "User-Agent": YahooFinanceService.USER_AGENT,
            Cookie: this.cookie!,
          },
        });
      } catch (err) {
        this.logger.error(`Yahoo Finance v10 fetch error: ${err}`);
        return null;
      }

      if (response.status === 401 && attempt === 0) {
        this.logger.warn("Yahoo Finance v10: got 401, refreshing crumb");
        await response.text().catch(() => {});
        continue;
      }

      return response;
    }
    return null;
  }

  async fetchQuote(
    symbol: string,
    exchange: string | null = null,
    _opts?: QuoteProviderOptions,
  ): Promise<QuoteResult | null> {
    const primary = this.getYahooSymbol(symbol, exchange);
    const quote = await this.fetchQuoteRaw(primary);
    if (quote) return quote;

    if (primary === symbol) {
      for (const altSymbol of this.getAlternateSymbols(symbol)) {
        const alt = await this.fetchQuoteRaw(altSymbol);
        if (alt) return alt;
      }
    }
    return null;
  }

  private async fetchQuoteRaw(
    yahooSymbol: string,
  ): Promise<QuoteResult | null> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`;

      const response = await this.throttledFetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });

      if (!response.ok) {
        this.logger.warn(
          `Yahoo Finance API returned ${response.status} for ${yahooSymbol}`,
        );
        return null;
      }

      const data = await response.json();

      if (data.chart?.result?.[0]?.meta) {
        const result = data.chart.result[0];
        const meta = result.meta;
        const gbx = isGbxCurrency(meta.currency);
        const convert = (v: number | undefined) =>
          v !== undefined && gbx ? convertGbxToGbp(v) : v;

        // The chart-endpoint meta omits regularMarketOpen, so fall back to
        // the first non-null open in the indicators series (today's open
        // for range=1d&interval=1d).
        const openSeries = result.indicators?.quote?.[0]?.open as
          | (number | null | undefined)[]
          | undefined;
        const openFromSeries = openSeries?.find(
          (v): v is number => v != null && !Number.isNaN(v),
        );

        return {
          symbol: meta.symbol,
          regularMarketPrice: convert(meta.regularMarketPrice),
          regularMarketOpen: convert(meta.regularMarketOpen ?? openFromSeries),
          regularMarketDayHigh: convert(meta.regularMarketDayHigh),
          regularMarketDayLow: convert(meta.regularMarketDayLow),
          regularMarketVolume: meta.regularMarketVolume,
          regularMarketTime: meta.regularMarketTime,
          // Authoritative currency from the instrument itself. GBX/GBp (pence,
          // the LSE quote unit) maps to GBP since prices above are converted to
          // pounds; otherwise pass the reported currency (e.g. USD for a
          // USD-denominated LSE ETF, where guessing from the exchange is wrong).
          currencyCode: meta.currency ? (gbx ? "GBP" : meta.currency) : null,
          provider: "yahoo",
        };
      }

      return null;
    } catch (error) {
      this.logger.error(
        `Failed to fetch Yahoo Finance quote for ${yahooSymbol}`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }

  /** Convenience batch method. Fetches each symbol in parallel (exchange assumed already baked into symbol). */
  async fetchQuotes(symbols: string[]): Promise<Map<string, QuoteResult>> {
    const results = new Map<string, QuoteResult>();
    if (symbols.length === 0) return results;
    await Promise.all(
      symbols.map(async (symbol) => {
        const quote = await this.fetchQuoteRaw(symbol);
        if (quote) results.set(symbol, quote);
      }),
    );
    return results;
  }

  async fetchHistorical(
    symbol: string,
    exchange: string | null = null,
    range: string = "max",
    _opts?: QuoteProviderOptions,
  ): Promise<HistoricalPrice[] | null> {
    return this.fetchHistoricalQuery(
      symbol,
      exchange,
      `interval=1d&range=${encodeURIComponent(range)}`,
    );
  }

  /**
   * Fetch the daily series bounded to an explicit [from, to] date window using
   * Yahoo's period1/period2 parameters, instead of a `range` like "max". Use
   * this when you only need a few days around a specific date (e.g. the FX rate
   * for one transaction's date): it returns ~a handful of bars rather than the
   * entire multi-year history, which keeps the request fast and the parsed
   * payload small (the "max" range can be thousands of bars / several MB).
   */
  async fetchHistoricalWindow(
    symbol: string,
    fromDate: Date,
    toDate: Date,
    exchange: string | null = null,
  ): Promise<HistoricalPrice[] | null> {
    const period1 = Math.floor(fromDate.getTime() / 1000);
    const period2 = Math.floor(toDate.getTime() / 1000);
    return this.fetchHistoricalQuery(
      symbol,
      exchange,
      `period1=${period1}&period2=${period2}&interval=1d`,
    );
  }

  /**
   * Shared primary-then-alternate-symbol resolution for the v8 chart history
   * API. `query` is the URL query fragment (either a `range=...` or a
   * `period1=...&period2=...` window).
   */
  private async fetchHistoricalQuery(
    symbol: string,
    exchange: string | null,
    query: string,
  ): Promise<HistoricalPrice[] | null> {
    const primary = this.getYahooSymbol(symbol, exchange);
    const prices = await this.fetchHistoricalRaw(primary, query);
    if (prices) return prices;

    if (primary === symbol) {
      for (const altSymbol of this.getAlternateSymbols(symbol)) {
        const alt = await this.fetchHistoricalRaw(altSymbol, query);
        if (alt) return alt;
      }
    }
    return null;
  }

  private async fetchHistoricalRaw(
    yahooSymbol: string,
    query: string,
  ): Promise<HistoricalPrice[] | null> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?${query}`;

      const response = await this.throttledFetch(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
        },
        { timeoutMs: 60_000 },
      );

      if (!response.ok) {
        this.logger.warn(
          `Yahoo Finance API returned ${response.status} for historical ${yahooSymbol}`,
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
      // Total-return adjusted close (split + dividend adjusted). Yahoo
      // returns this as a parallel array under indicators.adjclose[0].
      const adjcloseSeries: (number | null | undefined)[] | undefined =
        result.indicators?.adjclose?.[0]?.adjclose;
      const prices: HistoricalPrice[] = [];

      for (let i = 0; i < timestamps.length; i++) {
        const close = quote.close?.[i];
        if (close == null || isNaN(close)) continue;

        const date = new Date(timestamps[i] * 1000);
        date.setHours(0, 0, 0, 0);

        const adjRaw = adjcloseSeries?.[i];
        const adjClose =
          adjRaw == null || isNaN(adjRaw)
            ? null
            : gbx
              ? convertGbxToGbp(adjRaw)
              : adjRaw;

        prices.push({
          date,
          open: convertPrice(quote.open?.[i]) ?? null,
          high: convertPrice(quote.high?.[i]) ?? null,
          low: convertPrice(quote.low?.[i]) ?? null,
          close: gbx ? convertGbxToGbp(close) : close,
          adjClose,
          volume: quote.volume?.[i] ?? null,
        });
      }

      return prices;
    } catch (error) {
      this.logger.error(
        `Failed to fetch historical prices for ${yahooSymbol}`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }

  async fetchIntradaySeries(
    symbol: string,
    exchange: string | null,
    opts: { interval: IntradayInterval; range: IntradayRange },
  ): Promise<IntradayPoint[] | null> {
    const primary = this.getYahooSymbol(symbol, exchange);
    const points = await this.fetchIntradayRaw(primary, opts);
    if (points) return points;

    if (primary === symbol) {
      for (const altSymbol of this.getAlternateSymbols(symbol)) {
        const alt = await this.fetchIntradayRaw(altSymbol, opts);
        if (alt) return alt;
      }
    }
    return null;
  }

  // Intraday FX series. Yahoo exposes currency pairs under the
  // "{FROM}{TO}=X" symbol convention (e.g. USDCAD=X for USD->CAD) on the
  // same chart endpoint as equities, so we reuse fetchIntradayRaw. Used
  // by the Portfolio Value Over Time chart so foreign-currency holdings
  // and cash are valued at each bar's FX rate, not the latest spot.
  async fetchIntradayFxSeries(
    fromCurrency: string,
    toCurrency: string,
    opts: { interval: IntradayInterval; range: IntradayRange },
  ): Promise<IntradayPoint[] | null> {
    if (fromCurrency === toCurrency) return null;
    const pairSymbol = `${fromCurrency.toUpperCase()}${toCurrency.toUpperCase()}=X`;
    return this.fetchIntradayRaw(pairSymbol, opts);
  }

  private async fetchIntradayRaw(
    yahooSymbol: string,
    { interval, range }: { interval: IntradayInterval; range: IntradayRange },
  ): Promise<IntradayPoint[] | null> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;

      // Intraday is called inline by the chart endpoint which has its own
      // tight client timeout, so cap retries lower than the default to avoid
      // exceeding it. If we're being throttled we'll get fallbackToDaily
      // upstream anyway.
      const response = await this.throttledFetch(
        url,
        {
          headers: { "User-Agent": YahooFinanceService.USER_AGENT },
        },
        { maxRetries: 1 },
      );

      if (!response.ok) {
        this.logger.warn(
          `Yahoo Finance intraday returned ${response.status} for ${yahooSymbol} (${interval}/${range})`,
        );
        return null;
      }

      const data = await response.json();
      const result = data.chart?.result?.[0];
      if (!result?.timestamp || !result.indicators?.quote?.[0]) {
        return null;
      }

      const gbx = isGbxCurrency(result.meta?.currency);
      const timestamps: number[] = result.timestamp;
      const closes: (number | null | undefined)[] =
        result.indicators.quote[0].close ?? [];
      const opens: (number | null | undefined)[] =
        result.indicators.quote[0].open ?? [];

      const points: IntradayPoint[] = [];
      // Forward-fill nulls so multi-security alignment doesn't drop bars.
      let lastClose: number | null = null;
      for (let i = 0; i < timestamps.length; i++) {
        const rawClose = closes[i];
        if (rawClose != null && !isNaN(rawClose)) {
          lastClose = gbx ? convertGbxToGbp(rawClose) : rawClose;
        }
        if (lastClose === null) continue;
        const rawOpen = opens[i];
        const open =
          rawOpen != null && !isNaN(rawOpen)
            ? gbx
              ? convertGbxToGbp(rawOpen)
              : rawOpen
            : null;
        points.push({
          timestamp: new Date(timestamps[i] * 1000),
          open,
          close: lastClose,
        });
      }

      return points;
    } catch (error) {
      this.logger.error(
        `Failed to fetch intraday series for ${yahooSymbol}`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }

  async lookupSecurity(
    query: string,
    preferredExchanges?: string[],
  ): Promise<SecurityLookupResult | null> {
    const all = await this.lookupSecurityMany(query, preferredExchanges);
    return all[0] || null;
  }

  async lookupSecurityMany(
    query: string,
    preferredExchanges?: string[],
  ): Promise<SecurityLookupResult[]> {
    try {
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=50&newsCount=0`;

      const response = await this.throttledFetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });

      if (!response.ok) {
        this.logger.warn(
          `Yahoo Finance search API returned ${response.status} for query: ${query}`,
        );
        return [];
      }

      const data = await response.json();
      const quotes: YahooSearchResult[] = data.quotes || [];

      if (quotes.length === 0) {
        return [];
      }

      const sortedQuotes = [...quotes].sort((a, b) => {
        const priorityA = this.getExchangePriority(
          a.symbol,
          a.exchDisp,
          preferredExchanges,
        );
        const priorityB = this.getExchangePriority(
          b.symbol,
          b.exchDisp,
          preferredExchanges,
        );
        return priorityA - priorityB;
      });

      // Float the exact-ticker match (if any) to the front, keep the rest in
      // preferred-exchange order.
      const upperQuery = query.toUpperCase().trim();
      const exactIdx = sortedQuotes.findIndex(
        (q) => this.extractBaseSymbol(q.symbol).toUpperCase() === upperQuery,
      );
      if (exactIdx > 0) {
        const [exact] = sortedQuotes.splice(exactIdx, 1);
        sortedQuotes.unshift(exact);
      }

      return sortedQuotes.map((q) => {
        const baseSymbol = this.extractBaseSymbol(q.symbol);
        const exchange =
          this.extractExchangeFromSymbol(q.symbol) || q.exchDisp || null;
        const securityType = this.mapYahooTypeToSecurityType(q.typeDisp);
        const currencyCode = this.getCurrencyFromExchange(exchange, q.symbol);
        return {
          symbol: baseSymbol,
          name: q.longname || q.shortname || baseSymbol,
          exchange,
          securityType,
          currencyCode,
          provider: "yahoo" as const,
        };
      });
    } catch (error) {
      this.logger.error(
        "Failed to lookup security",
        error instanceof Error ? error.stack : undefined,
      );
      return [];
    }
  }

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

  getAlternateSymbols(symbol: string): string[] {
    const alternates: string[] = [];

    if (!symbol.includes(".")) {
      alternates.push(`${symbol}.TO`);
      alternates.push(`${symbol}.V`);
      alternates.push(`${symbol}.CN`);
    }

    return alternates;
  }

  getTradingDate(quote: QuoteResult): Date {
    return getTradingDateFromQuote(quote);
  }

  async resolveInstrumentId(): Promise<string | null> {
    return null;
  }

  extractBaseSymbol(symbol: string): string {
    const dotIndex = symbol.lastIndexOf(".");
    if (dotIndex > 0) {
      return symbol.substring(0, dotIndex);
    }
    return symbol;
  }

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

  getExchangePriority(
    symbol: string,
    exchDisp?: string,
    preferredExchanges?: string[],
  ): number {
    const suffix = symbol.includes(".")
      ? symbol.substring(symbol.lastIndexOf(".")).toUpperCase()
      : "";
    const exchange = (exchDisp || "").toUpperCase();

    if (preferredExchanges && preferredExchanges.length > 0) {
      for (let i = 0; i < preferredExchanges.length; i++) {
        if (this.matchesExchange(suffix, exchange, preferredExchanges[i])) {
          return -(preferredExchanges.length - i);
        }
      }
    }

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

  private matchesExchange(
    suffix: string,
    exchDisp: string,
    preferredExchange: string,
  ): boolean {
    const pref = preferredExchange.toUpperCase().trim();

    const exchangeMatchers: Record<
      string,
      { suffixes: string[]; displays: string[] }
    > = {
      TSX: { suffixes: [".TO"], displays: ["TORONTO", "TSX"] },
      TSE: { suffixes: [".TO"], displays: ["TORONTO", "TSX"] },
      TORONTO: { suffixes: [".TO"], displays: ["TORONTO", "TSX"] },
      "TSX-V": { suffixes: [".V"], displays: ["TSX VENTURE", "TSXV"] },
      TSXV: { suffixes: [".V"], displays: ["TSX VENTURE", "TSXV"] },
      CSE: { suffixes: [".CN"], displays: ["CSE", "CANADIAN"] },
      NEO: { suffixes: [".NE"], displays: ["NEO"] },
      NYSE: { suffixes: [""], displays: ["NYSE", "NYQ"] },
      NASDAQ: { suffixes: [""], displays: ["NASDAQ", "NMS", "NGM"] },
      AMEX: { suffixes: [""], displays: ["AMEX"] },
      ARCA: { suffixes: [""], displays: ["ARCA", "PCX"] },
      LSE: { suffixes: [".L"], displays: ["LSE", "LONDON"] },
      LONDON: { suffixes: [".L"], displays: ["LSE", "LONDON"] },
      ASX: {
        suffixes: [".AX"],
        displays: ["ASX", "SYDNEY", "AUSTRALIAN"],
      },
      FRANKFURT: { suffixes: [".F"], displays: ["FRANKFURT", "FRA"] },
      XETRA: { suffixes: [".DE"], displays: ["XETRA", "GER"] },
      PARIS: { suffixes: [".PA"], displays: ["PARIS", "PAR", "EURONEXT"] },
      TOKYO: { suffixes: [".T"], displays: ["TOKYO", "JPX", "TSE"] },
      HKEX: { suffixes: [".HK"], displays: ["HKEX", "HONG KONG"] },
      "HONG KONG": { suffixes: [".HK"], displays: ["HKEX", "HONG KONG"] },
    };

    const matcher = exchangeMatchers[pref];
    if (!matcher) {
      return exchDisp.includes(pref);
    }

    if (matcher.suffixes.some((s) => s !== "" && s === suffix)) {
      return true;
    }

    return matcher.displays.some((d) => exchDisp.includes(d));
  }

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

  async fetchStockSectorInfo(
    symbol: string,
    exchange: string | null = null,
    _opts?: QuoteProviderOptions,
  ): Promise<StockSectorInfo | null> {
    const yahooSymbol = this.getYahooSymbol(symbol, exchange);
    try {
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(yahooSymbol)}&quotesCount=5&newsCount=0`;

      const response = await this.throttledFetch(url, {
        headers: {
          "User-Agent": YahooFinanceService.USER_AGENT,
        },
      });

      if (!response.ok) {
        this.logger.warn(
          `Yahoo Finance search returned ${response.status} for ${yahooSymbol}`,
        );
        return null;
      }

      const data = await response.json();
      const quotes = data.quotes || [];

      const match = quotes.find(
        (q: Record<string, string>) =>
          q.symbol?.toUpperCase() === yahooSymbol.toUpperCase(),
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
        `Failed to fetch sector info for ${yahooSymbol}`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }

  async fetchEtfSectorWeightings(
    symbol: string,
    exchange: string | null = null,
    _opts?: QuoteProviderOptions,
  ): Promise<EtfSectorWeighting[] | null> {
    const yahooSymbol = this.getYahooSymbol(symbol, exchange);
    try {
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}?modules=topHoldings`;

      const response = await this.fetchV10(url);

      if (!response || !response.ok) {
        this.logger.warn(
          `Yahoo Finance topHoldings returned ${response?.status ?? "no response"} for ${yahooSymbol}`,
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
        `Failed to fetch ETF sector weightings for ${yahooSymbol}`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }
}
