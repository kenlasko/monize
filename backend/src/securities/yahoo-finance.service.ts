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
  HistoricalSeries,
  IntradayInterval,
  IntradayPoint,
  IntradayRange,
  StockSectorInfo,
  EtfSectorWeighting,
} from "./providers/quote-provider.interface";
import { getTradingDateFromQuote } from "./providers/trading-date.util";
import {
  cryptoLookupFields,
  isCryptoExchange,
} from "./providers/crypto-pair.util";
import { barDate } from "./providers/market-session.util";
import { describeFetchFailure } from "../common/http/fetch-failure.util";
import { ProviderHealthService } from "../provider-health/provider-health.service";
import { TrackedProviderId } from "../provider-health/providers";

/**
 * This client's id in `provider_health` and in the circuit breaker.
 *
 * Distinct from `QuoteProviderName` ("yahoo"), which names the *quote provider*
 * a security is priced by. This one names the *host we call*, is the primary key
 * of the durable alert state, and must therefore stay stable.
 */
const HEALTH_PROVIDER_ID: TrackedProviderId = "yahoo_finance";

// Back-compat re-exports so existing imports keep compiling during the migration.
export type YahooQuoteResult = QuoteResult;
export type {
  SecurityLookupResult,
  HistoricalPrice,
  StockSectorInfo,
  EtfSectorWeighting,
} from "./providers/quote-provider.interface";

/** One item as the search endpoint's `quotes[]` carries it. */
export interface YahooSearchResult {
  symbol: string;
  /** `EQUITY`, `ETF`, `CURRENCY`, ...; the machine-readable sibling of `typeDisp`. */
  quoteType?: string;
  shortname?: string;
  longname?: string;
  exchDisp?: string;
  typeDisp?: string;
}

/** One item as the search endpoint's `news[]` carries it. */
interface YahooNewsItem {
  uuid?: string;
  title?: string;
  publisher?: string;
  link?: string;
  /** Unix seconds, not milliseconds. */
  providerPublishTime?: number;
  type?: string;
  thumbnail?: {
    resolutions?: { url?: string; width?: number; height?: number }[];
  };
  relatedTickers?: string[];
}

/** A news item, narrowed to what the detail page shows. */
export interface SecurityNewsItem {
  id: string;
  title: string;
  publisher: string | null;
  link: string;
  /** ISO timestamp; the UI turns it into "44m ago". */
  publishedAt: string | null;
  /** `STORY` or `VIDEO` -- the only two the endpoint returns. */
  type: string | null;
  /**
   * Path on our own API for the thumbnail, or null when the item has none.
   * Never the upstream URL: the CSP is `img-src 'self' data: blob:`, and the
   * reader's browser has no business contacting the publisher's CDN.
   */
  thumbnailUrl: string | null;
  /**
   * Every symbol the item was filed under. The requested one is in here, but so
   * are others -- see `fetchNews`.
   */
  relatedTickers: string[];
}

/**
 * Statuses that mean "there is no such series", as opposed to "not now".
 *
 * Only these may be reported to a caller as an empty answer: a 429, a 5xx or a
 * 401 (a stale crumb) says nothing about whether the symbol has history, and
 * caching one as "no history" is how a throttled minute becomes half an hour of
 * a report rendering unpriced.
 */
const SYMBOL_ABSENT_STATUSES: ReadonlySet<number> = new Set([404, 422]);

/**
 * `chart.error.code` values that mean the same thing in a 200 body.
 *
 * Yahoo reports throttling, auth and its own faults through this field too, so
 * the set is an allowlist rather than "an error is present".
 */
const SYMBOL_ABSENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "Not Found",
  "Bad Request",
]);

/**
 * The `chart.error.description` of a 400 that is an answer rather than a fault.
 *
 * Yahoo refuses a window it has no history for with a 400 whose body reads
 * `Data doesn't exist for startDate = 1000684800, endDate = 1004486400` -- a
 * statement about this symbol over this window, in the same class as a 404. A
 * request this client built wrong is also a 400, and that one says nothing
 * about the symbol, so the status alone cannot decide: the description does.
 *
 * Reading the two as one refusal is issue #1409. `USDCAD=X` has no history
 * before December 2003, so a since-inception valuation asked for 2000-2003,
 * got `null` ("the provider declined"), and the empty-window memory that would
 * have stopped it asking again may only remember an answer -- so every
 * subsequent portfolio summary re-issued the same 76 doomed calls, forever.
 */
const ABSENT_WINDOW_DESCRIPTION = /^data doesn['\u2019]?t exist/i;

/** A quote outcome meaning the chart endpoint answered that the symbol does not exist. */
const SYMBOL_ABSENT = Symbol("symbol-absent");

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

  constructor(private readonly health: ProviderHealthService) {}

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
   *
   * It is also the single door the circuit breaker sits on: every Yahoo request
   * except the crumb handshake goes through here, so refusing here refuses all
   * of them. A `ProviderUnavailableError` is raised *before* the concurrency
   * gate, because a refusal that first queues behind five in-flight 60-second
   * timeouts costs precisely what the breaker exists to save (issue #1265).
   */
  private async throttledFetch(
    url: string,
    init: RequestInit = {},
    opts: { maxRetries?: number; timeoutMs?: number } = {},
  ): Promise<Response> {
    const maxRetries = opts.maxRetries ?? YahooFinanceService.MAX_RETRIES;
    const timeoutMs = opts.timeoutMs ?? YahooFinanceService.FETCH_TIMEOUT_MS;
    const admission = this.health.assertAvailable(HEALTH_PROVIDER_ID);
    await this.acquireSlot();
    try {
      let lastResponse: Response | null = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let response: Response;
        try {
          response = await fetch(url, {
            ...init,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          // No response at all: the availability signal the breaker counts.
          // An error it does not count (a bad URL, an aborted body read) is not
          // an outcome either, so the probe slot this request may be holding
          // goes back rather than being held against a healthy provider.
          // Only the probe holder may hand the slot back: a straggler admitted
          // through a closed breaker owns nothing, and releasing then would
          // free somebody else's probe and let a second one out beside it.
          const counted = this.health.recordFailure(HEALTH_PROVIDER_ID, error);
          if (!counted && admission === "probe") {
            this.health.releaseProbe(HEALTH_PROVIDER_ID);
          }
          throw error;
        }
        // A 2xx is *not* recorded as a success here. Headers are not a
        // completed request: a provider that accepts the connection and then
        // stalls the body answers them every time, and recording that closed
        // the breaker on every probe -- so it flapped once a window, the
        // escalation never grew, and each fresh episode reset the alert's
        // fifteen-minute clock so no alert was ever sent. A 2xx is recorded by
        // `readBody`, where the body actually arrives.
        //
        // Anything else *is* recorded, right here. A non-2xx is a complete
        // answer with nothing left for the caller to read, and every branch
        // that handles one used to record it for itself -- which meant nine
        // places to remember and two that did not, each leaving the probe slot
        // held for two minutes against a provider that had just answered a
        // routine 404.
        if (!response.ok) this.health.recordSuccess(HEALTH_PROVIDER_ID);
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

  /**
   * Read a response body, and record the request as *completed* if it arrives.
   *
   * This is where a Yahoo request becomes a success as far as the breaker is
   * concerned. Headers alone are not enough (see `throttledFetch`), and a body
   * that stalls rejects here with `UND_ERR_BODY_TIMEOUT` -- counted by the
   * caller's catch through `logFailure`, which is the single door for that.
   */
  private async readBody<T>(
    response: Response,
    as: "json" | "text" = "json",
  ): Promise<T> {
    const value = (await (as === "json"
      ? response.json()
      : response.text())) as T;
    this.health.recordSuccess(HEALTH_PROVIDER_ID);
    return value;
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

  // Cookie sources tried in order when establishing a v10 session. fc.yahoo.com
  // returns the A1 auth cookie directly (a 404 page, but the Set-Cookie is what
  // we want) and sidesteps the GDPR consent redirect that finance.yahoo.com hits
  // in some regions/data-centres -- that redirect yields only a consent cookie,
  // which getcrumb then rejects with a 401. finance.yahoo.com stays as a fallback.
  private static readonly COOKIE_SOURCES: ReadonlyArray<string> = [
    "https://fc.yahoo.com/",
    "https://finance.yahoo.com/",
  ];

  /**
   * Fetch the first-party cookies Yahoo sets for `url`, joined into a single
   * Cookie header value. Returns "" when none are offered. Resolves regardless
   * of HTTP status (fc.yahoo.com answers 404 but still sets the cookie we need).
   */
  private fetchYahooCookie(url: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          // Carries a code, so `isTransportFailure` counts it: a timeout is the
          // most common shape of "this host is unreachable", and an Error with
          // only a message would have been read as a logic error and ignored by
          // the breaker.
          reject(
            Object.assign(new Error("Cookie request timeout"), {
              code: "ETIMEDOUT",
              hostname: new URL(url).hostname,
            }),
          ),
        YahooFinanceService.FETCH_TIMEOUT_MS,
      );
      https
        .get(
          url,
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
  }

  private async fetchCrumb(): Promise<boolean> {
    // The handshake does not go through throttledFetch, and a failed crumb is
    // not cached -- so while Yahoo is unreachable every v10 caller used to pay
    // two cookie timeouts plus a getcrumb timeout before failing. Refuse it
    // with the same breaker the rest of the client uses.
    const admission = this.health.tryRequest(HEALTH_PROVIDER_ID);
    if (admission === "refused") return false;
    let lastStatus: number | string = "no cookies";
    let lastError: unknown = null;
    // Whether anything here produced evidence about the API host. The slot
    // `tryRequest` just took is exclusive, so it has to be given back one way
    // or another before this returns.
    let reported = false;
    for (const source of YahooFinanceService.COOKIE_SOURCES) {
      try {
        const cookieStr = await this.fetchYahooCookie(source);
        // Deliberately *not* a recorded success. The cookie sources are
        // fc.yahoo.com and finance.yahoo.com; everything else in this client
        // talks to query1.finance.yahoo.com. Counting a cookie response as
        // "the provider answered" kept the failure count oscillating
        // between 0 and 1 while the API host was down, so the breaker never
        // opened -- and it closed a half-open probe on evidence about a
        // different host, resetting the escalation.
        if (!cookieStr) {
          lastStatus = "no cookies";
          continue;
        }

        const crumbResp = await fetch(
          "https://query1.finance.yahoo.com/v1/test/getcrumb",
          {
            headers: {
              "User-Agent": YahooFinanceService.USER_AGENT,
              Cookie: cookieStr,
            },
            signal: AbortSignal.timeout(YahooFinanceService.FETCH_TIMEOUT_MS),
          },
        );

        if (!crumbResp.ok) {
          // This request does not go through `throttledFetch`, so the non-2xx
          // rule has to be applied here: the API host answered in full, and
          // there is no body left to stall on.
          this.health.recordSuccess(HEALTH_PROVIDER_ID);
          reported = true;
          lastStatus = crumbResp.status;
          await crumbResp.text().catch(() => undefined);
          continue;
        }

        const crumbText = await this.readBody<string>(crumbResp, "text");
        reported = true;
        if (!crumbText || crumbText.length > 50 || crumbText.startsWith("{")) {
          lastStatus = "invalid crumb";
          continue;
        }

        this.crumb = crumbText;
        this.cookie = cookieStr;
        this.crumbExpiresAt = Date.now() + 60 * 60 * 1000;
        return true;
      } catch (error) {
        // A cookie host that will not answer is weaker evidence than an API
        // host that will not, but it is evidence in the safe direction: both
        // are Yahoo, and over-counting a failure at worst opens the breaker on
        // a provider that is broadly unreachable. Under-counting was the defect.
        // Only a counted failure is an outcome: an error the breaker ignores
        // leaves the slot to be handed back below.
        reported =
          this.health.recordFailure(HEALTH_PROVIDER_ID, error) || reported;
        lastStatus = describeFetchFailure(error);
        lastError = error;
        // That failure may have re-armed the window. Trying the second cookie
        // source anyway would put a second ungated socket on a provider the
        // breaker has just refused -- two per window, where the whole point of
        // half-open is one.
        if (this.health.wouldRefuse(HEALTH_PROVIDER_ID)) break;
      }
    }

    // Every cookie source answered, none with a cookie: the API host was never
    // called, so there is nothing to record -- but the probe slot still has to
    // go back, or the next two minutes of Yahoo calls are refused for a
    // provider nothing has shown to be down.
    if (!reported && admission === "probe") {
      this.health.releaseProbe(HEALTH_PROVIDER_ID);
    }

    // Through the rate-limited door like every other provider failure: the
    // handshake is attempted per v10 caller, so a bare warn here is one line
    // per symbol -- the flood, one layer down. A status-only failure carries no
    // error to describe, so it is given one.
    this.health.logFailure(
      this.logger,
      HEALTH_PROVIDER_ID,
      "crumb handshake",
      lastError ?? new Error(`could not obtain a crumb (last: ${lastStatus})`),
    );
    return false;
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
        this.health.logFailure(
          this.logger,
          HEALTH_PROVIDER_ID,
          "v10 request",
          err,
        );
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
      for (const altSymbol of this.getAlternateSymbols(symbol, exchange)) {
        const alt = await this.fetchQuoteRaw(altSymbol);
        if (alt) return alt;
      }
    }
    return null;
  }

  /**
   * One symbol's latest quote, keeping "Yahoo says there is no such symbol"
   * apart from "Yahoo did not answer": `{ quote }` with the quote, `{ quote:
   * null }` when the chart endpoint answered that the symbol does not exist (a
   * 404 or 422, or a 200 whose `chart.error` is `SYMBOL_ABSENT_ERROR_CODES`),
   * `null` for anything else -- a throttle, a fault, an open breaker, a body
   * this client cannot read. The symbol is asked as given, with no exchange
   * suffix and no alternate listing, through the same throttle and breaker as
   * every other Yahoo call. For a caller that may remember an absence (the
   * crypto exchange rate provider, INV-FX-005); `fetchQuote` folds both into
   * `null` as before.
   */
  async fetchQuoteAnswer(
    yahooSymbol: string,
  ): Promise<{ quote: QuoteResult | null } | null> {
    const outcome = await this.fetchQuoteOutcome(yahooSymbol);
    if (outcome === SYMBOL_ABSENT) return { quote: null };
    return outcome === null ? null : { quote: outcome };
  }

  private async fetchQuoteRaw(
    yahooSymbol: string,
  ): Promise<QuoteResult | null> {
    const outcome = await this.fetchQuoteOutcome(yahooSymbol);
    return outcome === SYMBOL_ABSENT ? null : outcome;
  }

  private async fetchQuoteOutcome(
    yahooSymbol: string,
  ): Promise<QuoteResult | typeof SYMBOL_ABSENT | null> {
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
        return SYMBOL_ABSENT_STATUSES.has(response.status)
          ? SYMBOL_ABSENT
          : null;
      }

      const data = await this.readBody<any>(response);

      if (data.chart?.result?.[0]?.meta) {
        const result = data.chart.result[0];
        const meta = result.meta;
        const gbx = isGbxCurrency(meta.currency);
        // null (JSON) must stay "no value": null / 100 is 0, a bogus price.
        const convert = (v: number | null | undefined) =>
          v == null ? undefined : gbx ? convertGbxToGbp(v) : v;

        // The chart-endpoint meta omits regularMarketOpen, so fall back to
        // the first non-null open in the indicators series (today's open
        // for range=1d&interval=1d).
        const openSeries = result.indicators?.quote?.[0]?.open as
          (number | null | undefined)[] | undefined;
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
          exchangeTimezone: meta.exchangeTimezoneName ?? null,
          // The window for the day this quote came from, so a half day or a
          // holiday is the provider's answer rather than our assumption.
          regularSession:
            typeof meta.currentTradingPeriod?.regular?.start === "number" &&
            typeof meta.currentTradingPeriod?.regular?.end === "number"
              ? {
                  start: meta.currentTradingPeriod.regular.start,
                  end: meta.currentTradingPeriod.regular.end,
                }
              : null,
          // Authoritative currency from the instrument itself. GBX/GBp (pence,
          // the LSE quote unit) maps to GBP since prices above are converted to
          // pounds; otherwise pass the reported currency (e.g. USD for a
          // USD-denominated LSE ETF, where guessing from the exchange is wrong).
          currencyCode: meta.currency ? (gbx ? "GBP" : meta.currency) : null,
          provider: "yahoo",
        };
      }

      return SYMBOL_ABSENT_ERROR_CODES.has(
        String(data.chart?.error?.code ?? ""),
      )
        ? SYMBOL_ABSENT
        : null;
    } catch (error) {
      this.health.logFailure(
        this.logger,
        HEALTH_PROVIDER_ID,
        `quote for ${yahooSymbol}`,
        error,
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

  async fetchHistoricalSeries(
    symbol: string,
    exchange: string | null = null,
    range: string = "max",
    _opts?: QuoteProviderOptions,
  ): Promise<HistoricalSeries | null> {
    return this.fetchHistoricalQuery(
      symbol,
      exchange,
      `interval=1d&range=${encodeURIComponent(range)}`,
    );
  }

  /**
   * The bars only, for the callers that have no security currency to verify
   * them against: the FX pair series and the market-index series, neither of
   * which is stored against a `securities` row. Every path that writes into
   * `security_prices` takes the series instead, so the currency reaches the
   * acceptance point.
   */
  async fetchHistorical(
    symbol: string,
    exchange: string | null = null,
    range: string = "max",
    opts?: QuoteProviderOptions,
  ): Promise<HistoricalPrice[] | null> {
    const series = await this.fetchHistoricalSeries(
      symbol,
      exchange,
      range,
      opts,
    );
    return series ? series.prices : null;
  }

  /**
   * Fetch the daily series bounded to an explicit [from, to] date window using
   * Yahoo's period1/period2 parameters, instead of a `range` like "max". Use
   * this when you only need a few days around a specific date (e.g. the FX rate
   * for one transaction's date): it returns ~a handful of bars rather than the
   * entire multi-year history, which keeps the request fast and the parsed
   * payload small (the "max" range can be thousands of bars / several MB).
   */
  async fetchHistoricalWindowSeries(
    symbol: string,
    exchange: string | null,
    fromDate: Date,
    toDate: Date,
  ): Promise<HistoricalSeries | null> {
    const period1 = Math.floor(fromDate.getTime() / 1000);
    const period2 = Math.floor(toDate.getTime() / 1000);
    return this.fetchHistoricalQuery(
      symbol,
      exchange,
      `period1=${period1}&period2=${period2}&interval=1d`,
    );
  }

  /** The windowed bars only; see {@link fetchHistorical}. */
  async fetchHistoricalWindow(
    symbol: string,
    exchange: string | null,
    fromDate: Date,
    toDate: Date,
  ): Promise<HistoricalPrice[] | null> {
    const series = await this.fetchHistoricalWindowSeries(
      symbol,
      exchange,
      fromDate,
      toDate,
    );
    return series ? series.prices : null;
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
  ): Promise<HistoricalSeries | null> {
    const primary = this.getYahooSymbol(symbol, exchange);
    const series = await this.fetchHistoricalRaw(primary, query);
    if (series?.prices.length) return series;

    // Bars, not merely an answer. An empty answer used to be `null` and so fell
    // through to the alternates by accident; now that it is `[]` -- which is
    // truthy -- returning on it would silently retire the alternate-symbol
    // fallback for every windowed fetch (a `.TO` listing asked for a window
    // before it listed on the primary exchange, say).
    if (primary === symbol) {
      for (const altSymbol of this.getAlternateSymbols(symbol, exchange)) {
        const alt = await this.fetchHistoricalRaw(altSymbol, query);
        if (alt?.prices.length) return alt;
      }
    }

    // No alternate had bars either. The primary's own answer decides what this
    // was: an empty series if it answered with an empty window, `null` if
    // nothing did.
    return series;
  }

  /**
   * Whether a non-OK response is Yahoo saying the window holds no history.
   *
   * Only a 400 is read: the statuses that already mean "no such series" are
   * decided by `SYMBOL_ABSENT_STATUSES` before this is called, and a 429, a
   * 5xx or a 401 is the provider declining to answer -- reading a body for one
   * of those cannot turn it into an answer. The body is read with `text()`
   * rather than `readBody`, because `throttledFetch` has already recorded a
   * non-OK response with the breaker and a second success would count one
   * answer twice.
   */
  private async describesAbsentWindow(response: Response): Promise<boolean> {
    if (response.status !== 400) return false;
    try {
      const body = await response.text();
      const description = String(
        (JSON.parse(body) as any)?.chart?.error?.description ?? "",
      ).trim();
      return ABSENT_WINDOW_DESCRIPTION.test(description);
    } catch {
      // An unparseable body is not a statement about the symbol.
      return false;
    }
  }

  private async fetchHistoricalRaw(
    yahooSymbol: string,
    query: string,
  ): Promise<HistoricalSeries | null> {
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
        // A 404 or 422 is the provider answering *about this symbol*: it has no
        // such series. A 429, a 5xx or a 401 is not an answer -- it is the
        // provider declining to give one -- and the difference decides whether
        // a caller may remember the window as empty. Collapsing both into
        // `null` meant a symbol nobody carries was re-asked on every report
        // render, because the negative cache could never be written for it.
        if (
          SYMBOL_ABSENT_STATUSES.has(response.status) ||
          (await this.describesAbsentWindow(response))
        ) {
          return { prices: [], currencyCode: null, symbol: yahooSymbol };
        }
        return null;
      }

      const data = await this.readBody<any>(response);
      const result = data.chart?.result?.[0];
      // No result object. A `chart.error` beside it is an answer about the
      // symbol only when it says the symbol is the problem -- Yahoo puts
      // "Unauthorized", "Too Many Requests" and "Internal Server Error" in the
      // same field, and reading one of those as "no such series" writes the
      // negative cache the status allowlist above exists to protect. Anything
      // else is a body this client does not understand, which is also not an
      // answer. Either way the caller's alternate-symbol fallback still gets
      // its turn, because that turns on bars rather than on an answer.
      if (!result) {
        const code = String(data.chart?.error?.code ?? "");
        return SYMBOL_ABSENT_ERROR_CODES.has(code)
          ? { prices: [], currencyCode: null, symbol: yahooSymbol }
          : null;
      }
      // A result with no timestamps *is* an answer: the window predates the
      // instrument, or it did not trade in it. Returning `null` for that made
      // "answered with nothing" and "no usable answer" indistinguishable, and
      // the market-index chunking read every refused window as "the index did
      // not exist yet" -- storing one year as if it were the whole history.
      const gbx = isGbxCurrency(result.meta?.currency);
      // The currency this whole answer is in, carried on the bundle: the bars
      // below are already in it (pence divided into pounds where the listing
      // is quoted in GBX), and the acceptance point needs to know which
      // listing produced them before it stores the numbers against a security.
      const seriesMeta = {
        currencyCode: result.meta?.currency
          ? gbx
            ? "GBP"
            : String(result.meta.currency)
          : null,
        symbol: (result.meta?.symbol as string | undefined) ?? yahooSymbol,
        exchange: (result.meta?.fullExchangeName ??
          result.meta?.exchangeName ??
          null) as string | null,
      };
      if (!result.timestamp) return { prices: [], ...seriesMeta };
      // Timestamps but no quote series is a malformed answer, not an empty
      // window: null, so the caller can try an alternate symbol.
      if (!result.indicators?.quote?.[0]) return null;

      const convertPrice = (v: number | null | undefined): number | null => {
        if (v == null) return null;
        return gbx ? convertGbxToGbp(v) : v;
      };

      const timestamps: number[] = result.timestamp;
      // A daily bar's timestamp is the instant its session *opened*, so the
      // calendar day it belongs to is the exchange's, not the server's and not
      // UTC. Reading it with `setHours(0,0,0,0)` made `price_date` a function of
      // the container's TZ, and shifted an ASX bar opening 23:00 UTC (10:00
      // AEDT the following day) back onto the previous date under a UTC server.
      const exchangeZone: string | undefined =
        result.meta?.exchangeTimezoneName;
      const quote = result.indicators.quote[0];
      // Total-return adjusted close (split + dividend adjusted). Yahoo
      // returns this as a parallel array under indicators.adjclose[0].
      const adjcloseSeries: (number | null | undefined)[] | undefined =
        result.indicators?.adjclose?.[0]?.adjclose;
      const prices: HistoricalPrice[] = [];

      for (let i = 0; i < timestamps.length; i++) {
        const close = quote.close?.[i];
        if (close == null || isNaN(close)) continue;

        const date = barDate(timestamps[i], exchangeZone);

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

      return { prices, ...seriesMeta };
    } catch (error) {
      this.health.logFailure(
        this.logger,
        HEALTH_PROVIDER_ID,
        `historical prices for ${yahooSymbol}`,
        error,
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
      for (const altSymbol of this.getAlternateSymbols(symbol, exchange)) {
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

      const data = await this.readBody<any>(response);
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
      this.health.logFailure(
        this.logger,
        HEALTH_PROVIDER_ID,
        `intraday series for ${yahooSymbol}`,
        error,
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

  /**
   * The quotes Yahoo's search endpoint answers for free text, unread beyond
   * the array, through `throttledFetch` (the breaker, the throttle and the
   * retry stay in front of it). `null` when Yahoo did not answer: refused by
   * the breaker, a transport failure, a non-2xx or an unreadable body. `[]`
   * when it answered with no quotes.
   */
  async searchQuotes(
    query: string,
    count: number,
  ): Promise<YahooSearchResult[] | null> {
    try {
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=${count}&newsCount=0`;

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
        return null;
      }

      const data = await this.readBody<any>(response);
      const quotes: unknown = data?.quotes;
      if (!Array.isArray(quotes)) return [];
      return quotes.filter(
        (quote): quote is YahooSearchResult =>
          typeof quote?.symbol === "string",
      );
    } catch (error) {
      this.health.logFailure(this.logger, HEALTH_PROVIDER_ID, "search", error);
      return null;
    }
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

      const data = await this.readBody<any>(response);
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

      return sortedQuotes.map((q) => this.toLookupResult(q));
    } catch (error) {
      this.health.logFailure(
        this.logger,
        HEALTH_PROVIDER_ID,
        "security lookup",
        error,
      );
      return [];
    }
  }

  /**
   * One search result as a lookup candidate. A coin (`BTC-EUR`) is not a
   * listing: it keeps its whole symbol, and its exchange and currency are what
   * `cryptoLookupFields` says for every provider (the canonical `CRYPTO`, not
   * Yahoo's `CCC`, and the fiat leg of the symbol, never the exchange guess,
   * which reads every dotless symbol as USD; issue #379).
   */
  private toLookupResult(q: YahooSearchResult): SecurityLookupResult {
    const securityType =
      this.mapYahooTypeToSecurityType(q.typeDisp) ??
      (q.quoteType?.toUpperCase() === "CRYPTOCURRENCY" ? "CRYPTO" : null);
    if (securityType === "CRYPTO") {
      return {
        symbol: q.symbol,
        name: q.longname || q.shortname || q.symbol,
        securityType,
        ...cryptoLookupFields(q.symbol),
        provider: "yahoo",
      };
    }
    const baseSymbol = this.extractBaseSymbol(q.symbol);
    const exchange =
      this.extractExchangeFromSymbol(q.symbol) || q.exchDisp || null;
    return {
      symbol: baseSymbol,
      name: q.longname || q.shortname || baseSymbol,
      exchange,
      securityType,
      currencyCode: this.getCurrencyFromExchange(exchange, q.symbol),
      provider: "yahoo",
    };
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

  /**
   * The Canadian listings to try when the primary symbol misses. `exchange` is
   * the security's own: a coin (`CRYPTO`, or Yahoo's `CCC` on a security created
   * before the lookup named `CRYPTO`) trades on no exchange, so `BTC-EUR.TO` is
   * three guaranteed misses on every refresh of a pair Yahoo did not answer.
   * Keyed on the exchange, never on the symbol's shape: `BTC-USDT` has no ISO
   * last leg, and a hyphenated listing can have one.
   */
  getAlternateSymbols(
    symbol: string,
    exchange: string | null = null,
  ): string[] {
    const alternates: string[] = [];

    if (isCryptoExchange(exchange)) return alternates;

    // A caret ticker is an index (^GSPC, ^FTSE), not a listing. Yahoo's exchange
    // suffixes are meaningless on one, so trying `^GSPC.TO` costs three extra
    // round trips per miss and can only ever fail.
    if (symbol.startsWith("^")) return alternates;

    // Same argument for a currency pair (`USDCAD=X`): it is not listed on an
    // exchange, so `USDCAD=X.TO` is three guaranteed misses. That cost lands on
    // the on-demand historical FX fetch, which asks for a pair precisely when
    // nothing is stored for it, so the miss path is the one it walks.
    if (symbol.endsWith("=X")) return alternates;

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

      const data = await this.readBody<any>(response);
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
      this.health.logFailure(
        this.logger,
        HEALTH_PROVIDER_ID,
        `sector info for ${yahooSymbol}`,
        error,
      );
      return null;
    }
  }

  /**
   * The fund's asset-class split -- stocks, bonds, cash and the rest -- as
   * weights 0-1, or null when the provider has nothing.
   *
   * Yahoo has always returned these positions in `topHoldings`; until now they
   * were only read to synthesise a description. They are the one breakdown a
   * provider can fill that the GEM comparison can use for the defensive roles,
   * where bonds against equities is the distinction that matters. Country, the
   * breakdown the equity roles need, is not in this module and stays manual.
   *
   * "Other" is deliberately dropped: the convention for these columns is that a
   * shortfall under 100% is displayed as "Other" rather than stored, so storing
   * it would double-count at display time.
   */
  async fetchEtfAssetPositions(
    symbol: string,
    exchange: string | null = null,
  ): Promise<Array<{ name: string; weight: number }> | null> {
    return (await this.fetchEtfBreakdowns(symbol, exchange)).assets;
  }

  async fetchEtfSectorWeightings(
    symbol: string,
    exchange: string | null = null,
    _opts?: QuoteProviderOptions,
  ): Promise<EtfSectorWeighting[] | null> {
    return (await this.fetchEtfBreakdowns(symbol, exchange)).sectors;
  }

  /**
   * Both fund breakdowns from one request.
   *
   * The sector weightings and the asset-class positions live in the same
   * `topHoldings` module, so asking for them separately is two identical round
   * trips per fund -- doubling the calls a refresh makes against a provider
   * that rate-limits, for data that arrived together the first time. The two
   * single-breakdown methods stay because `fetchEtfSectorWeightings` is part of
   * the `QuoteProvider` interface, but both now read one response.
   *
   * Either half is null when the request failed, and an empty array when the
   * request succeeded and the fund simply has no such breakdown -- the
   * difference decides whether a caller may store the absence.
   */
  async fetchEtfBreakdowns(
    symbol: string,
    exchange: string | null = null,
  ): Promise<{
    sectors: EtfSectorWeighting[] | null;
    assets: Array<{ name: string; weight: number }> | null;
  }> {
    const yahooSymbol = this.getYahooSymbol(symbol, exchange);
    try {
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}?modules=topHoldings`;

      const response = await this.fetchV10(url);

      if (!response || !response.ok) {
        this.logger.warn(
          `Yahoo Finance topHoldings returned ${response?.status ?? "no response"} for ${yahooSymbol}`,
        );
        return { sectors: null, assets: null };
      }

      const data = await this.readBody<any>(response);
      const topHoldings = data.quoteSummary?.result?.[0]?.topHoldings;
      if (!topHoldings) return { sectors: [], assets: [] };

      return {
        sectors: this.parseSectorWeightings(topHoldings),
        assets: this.parseAssetPositions(topHoldings),
      };
    } catch (error) {
      this.health.logFailure(
        this.logger,
        HEALTH_PROVIDER_ID,
        `ETF breakdowns for ${yahooSymbol}`,
        error,
      );
      return { sectors: null, assets: null };
    }
  }

  private parseSectorWeightings(topHoldings: any): EtfSectorWeighting[] {
    if (!topHoldings?.sectorWeightings) return [];
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
  }

  private parseAssetPositions(
    topHoldings: any,
  ): Array<{ name: string; weight: number }> {
    const positions: Array<{ name: string; key: string }> = [
      { name: "Stocks", key: "stockPosition" },
      { name: "Bonds", key: "bondPosition" },
      { name: "Cash", key: "cashPosition" },
      { name: "Preferred", key: "preferredPosition" },
      { name: "Convertible", key: "convertiblePosition" },
    ];

    return positions
      .map(({ name, key }) => ({
        name,
        weight: Number(topHoldings[key]?.raw),
      }))
      .filter((entry) => Number.isFinite(entry.weight) && entry.weight > 0);
  }

  /**
   * Best-effort free-text description for a security, fetched from Yahoo's
   * v10 quoteSummary (cookie+crumb) for the "Fetch from Yahoo" pre-fill.
   *
   * Stocks expose `summaryProfile.longBusinessSummary` (full prose) -- returned
   * verbatim. ETFs/funds expose no prose, so we synthesize a one-liner from the
   * fund family, asset-class split, expense ratio and yield, e.g.
   *   "iShares Core Global Aggregate Bond ETF (BlackRock). ~99% bonds, ~1% cash. TER 0.10%, yield 3.14%."
   *
   * Returns null when nothing usable comes back. Never throws -- the caller
   * treats the suggestion as advisory and the user can always edit or ignore it.
   */
  async fetchSecurityProfileDescription(
    symbol: string,
    exchange: string | null = null,
  ): Promise<string | null> {
    return (await this.fetchSecurityProfile(symbol, exchange)).description;
  }

  /**
   * The description *and* the issuer's website, from one `quoteSummary` call.
   *
   * `summaryProfile.website` rides along in a response this already fetched and
   * discarded, so surfacing it costs no extra request, no extra crumb and no
   * extra rate-limit budget. It is populated for shares; for ETFs and funds
   * Yahoo gives a fund family and no URL, so the field comes back null and the
   * user types it.
   *
   * There is no investor-relations address to read: no `quoteSummary` module
   * carries one, and neither does MSN. That field stays manual by nature.
   */
  async fetchSecurityProfile(
    symbol: string,
    exchange: string | null = null,
  ): Promise<{ description: string | null; website: string | null }> {
    const yahooSymbol = this.getYahooSymbol(symbol, exchange);
    try {
      const modules =
        "summaryProfile,quoteType,fundProfile,topHoldings,summaryDetail";
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}?modules=${modules}`;

      const response = await this.fetchV10(url);
      if (!response || !response.ok) {
        this.logger.warn(
          `Yahoo Finance profile returned ${response?.status ?? "no response"} for ${yahooSymbol}`,
        );
        return { description: null, website: null };
      }

      const data = await this.readBody<any>(response);
      const result = data.quoteSummary?.result?.[0];
      if (!result) return { description: null, website: null };

      const prose: string | undefined =
        result.summaryProfile?.longBusinessSummary;
      const description =
        prose && prose.trim().length > 0
          ? prose.trim()
          : this.synthesizeFundDescription(result);

      return { description, website: this.pickWebsite(result) };
    } catch (error) {
      this.health.logFailure(
        this.logger,
        HEALTH_PROVIDER_ID,
        `profile for ${yahooSymbol}`,
        error,
      );
      return { description: null, website: null };
    }
  }

  /**
   * The website from a `quoteSummary` result, or null.
   *
   * Only an http(s) address is accepted: the value is a third-party string that
   * the UI turns into a link, so it is no more trusted than one a user typed.
   */
  private pickWebsite(result: Record<string, any>): string | null {
    const raw: unknown =
      result.summaryProfile?.website ?? result.assetProfile?.website;
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    return /^https?:\/\//i.test(trimmed) ? trimmed : null;
  }

  /**
   * Build a one-line description for a fund/ETF from the structured
   * quoteSummary modules. Returns null when not enough is available to say
   * anything useful.
   */
  private synthesizeFundDescription(
    result: Record<string, any>,
  ): string | null {
    const name: string | undefined =
      result.quoteType?.longName || result.quoteType?.shortName;
    const family: string | undefined = result.fundProfile?.family;
    const topHoldings = result.topHoldings ?? {};

    // Asset-class split (positions are fractions, e.g. bondPosition.raw=0.994).
    const positions: string[] = (
      [
        { label: "stocks", weight: topHoldings.stockPosition?.raw },
        { label: "bonds", weight: topHoldings.bondPosition?.raw },
        { label: "cash", weight: topHoldings.cashPosition?.raw },
        { label: "other", weight: topHoldings.otherPosition?.raw },
        { label: "preferred", weight: topHoldings.preferredPosition?.raw },
        { label: "convertible", weight: topHoldings.convertiblePosition?.raw },
      ] as Array<{ label: string; weight: number }>
    )
      .filter((p) => typeof p.weight === "number" && p.weight > 0.005)
      .sort((a, b) => b.weight - a.weight)
      .map((p) => `~${Math.round(p.weight * 100)}% ${p.label}`);

    const ter: number | undefined =
      result.fundProfile?.feesExpensesInvestment?.annualReportExpenseRatio?.raw;
    const yieldVal: number | undefined = result.summaryDetail?.yield?.raw;

    const parts: string[] = [];
    const lead = [name, family ? `(${family})` : null]
      .filter(Boolean)
      .join(" ");
    if (lead) parts.push(`${lead}.`);
    if (positions.length > 0) parts.push(`${positions.join(", ")}.`);

    const metrics: string[] = [];
    if (typeof ter === "number" && ter > 0) {
      metrics.push(`TER ${(ter * 100).toFixed(2)}%`);
    }
    if (typeof yieldVal === "number" && yieldVal > 0) {
      metrics.push(`yield ${(yieldVal * 100).toFixed(2)}%`);
    }
    if (metrics.length > 0) parts.push(`${metrics.join(", ")}.`);

    const description = parts.join(" ").trim();
    return description.length > 0 ? description : null;
  }

  /**
   * Headlines filed against a symbol.
   *
   * The same `v1/finance/search` endpoint `lookupSecurityMany` already uses,
   * with `newsCount` turned up instead of down -- so this inherits the
   * concurrency cap, the 429/503 backoff and the timeout, and adds no new
   * upstream surface.
   *
   * Two things the caller has to know about the data. It is filed by *mention*,
   * not by subject: a story about Berkshire that lists AAPL among five tickers
   * comes back for AAPL, so the UI must not claim these are stories about the
   * company. And the publisher mix is whatever the endpoint returns -- Reuters
   * beside Motley Fool and Zacks -- which is broader than the curated stream
   * Yahoo's own web page shows.
   *
   * Nothing here is an advertisement: the feed carries only `STORY` and `VIDEO`.
   * The "Ad" rows on Yahoo's page are injected client-side by Taboola and never
   * reach the API.
   */
  async fetchNews(symbol: string, count = 15): Promise<SecurityNewsItem[]> {
    try {
      const url =
        `https://query1.finance.yahoo.com/v1/finance/search` +
        `?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=${count}` +
        `&enableFuzzyQuery=false`;

      const response = await this.throttledFetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });

      if (!response.ok) {
        this.logger.warn(
          `Yahoo news lookup returned ${response.status} for ${symbol}`,
        );
        return [];
      }

      const data = await this.readBody<any>(response);
      const items: YahooNewsItem[] = data.news || [];
      return items.flatMap((item) => this.toNewsItem(item));
    } catch (error) {
      // News is decoration on a page that works without it, so a failure here
      // is logged and swallowed rather than shown as a broken page.
      this.health.logFailure(
        this.logger,
        HEALTH_PROVIDER_ID,
        `news lookup for ${symbol}`,
        error,
      );
      return [];
    }
  }

  /**
   * Narrow one raw item, dropping anything that could not be rendered safely.
   *
   * A story with no title or no link is not a story. The link's scheme is
   * checked because the UI turns it into an anchor -- the value comes from a
   * third party, so it is no more trusted here than a user-typed one.
   */
  private toNewsItem(item: YahooNewsItem): SecurityNewsItem[] {
    const title = item.title?.trim();
    const link = item.link?.trim();
    if (!title || !link || !/^https?:\/\//i.test(link)) return [];

    return [
      {
        id: item.uuid || link,
        title,
        publisher: item.publisher?.trim() || null,
        link,
        // Unix *seconds* upstream; a millisecond reading would date every story
        // to 1970.
        publishedAt:
          typeof item.providerPublishTime === "number" &&
          isFinite(item.providerPublishTime)
            ? new Date(item.providerPublishTime * 1000).toISOString()
            : null,
        type: item.type?.trim() || null,
        thumbnailUrl: this.pickThumbnail(item),
        relatedTickers: (item.relatedTickers || []).filter(
          (ticker) => typeof ticker === "string" && ticker.length > 0,
        ),
      },
    ];
  }

  /**
   * The upstream thumbnail closest to the size the list renders, or null.
   *
   * Returns the upstream address; the controller is what turns it into a path on
   * our own API. Only an https URL is considered -- an http image would be
   * blocked as mixed content anyway.
   */
  private pickThumbnail(item: YahooNewsItem): string | null {
    const resolutions = item.thumbnail?.resolutions || [];
    const usable = resolutions.filter(
      (resolution) => resolution.url && /^https:\/\//i.test(resolution.url),
    );
    if (usable.length === 0) return null;
    // Smallest that still covers a 96px thumbnail, else the smallest there is:
    // the list draws these tiny, and a 1200px hero is wasted bytes.
    const sorted = [...usable].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
    return (
      sorted.find((resolution) => (resolution.width ?? 0) >= 96)?.url ||
      sorted[0].url ||
      null
    );
  }
}
