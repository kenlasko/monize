import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import {
  QuoteProvider,
  QuoteProviderName,
  QuoteProviderOptions,
  QuoteResult,
  SecurityLookupResult,
  HistoricalPrice,
  HistoricalSeries,
  StockSectorInfo,
  EtfSectorWeighting,
} from "./providers/quote-provider.interface";
import { getTradingDateFromQuote } from "./providers/trading-date.util";
import { ProviderHealthService } from "../provider-health/provider-health.service";
import { TrackedProviderId } from "../provider-health/providers";
import { rangeToStartDate } from "./providers/range-start.util";

/**
 * This client's id in `provider_health` and in the circuit breaker. It names the
 * host we call (`api.live.deutsche-boerse.com`) and is the primary key of the
 * durable alert state, so it must stay stable.
 */
const HEALTH_PROVIDER_ID: TrackedProviderId = "deutsche_boerse";

const DBG_API = "https://api.live.deutsche-boerse.com";
const DBG_WS = "wss://api.live.deutsche-boerse.com/v1/mds/ws";
const DBG_ORIGIN = "https://live.deutsche-boerse.com";

/** Börse Frankfurt keeps Frankfurt time; Xetra (ETR) is the primary venue. */
const DBG_TIMEZONE = "Europe/Berlin";
const DEFAULT_SOURCE = "ETR";

/**
 * The request-signing constant Börse Frankfurt's own public JavaScript uses to
 * build its `X-Client-TraceId`. It is a fixed string embedded in the site's app
 * bundle (`tracing.salt`), not a credential and not tied to any login -- the
 * page computes the anti-scraping headers client-side with it before a visitor
 * has authenticated anything. It is reproduced here so this provider signs the
 * way the browser does. The site rotates it when it rebuilds the bundle; a stale
 * value simply makes the token endpoint answer 401 and the provider return no
 * data, never a wrong number, so refreshing it is a one-line code change.
 */
const DBG_SALT = "af5a8d16eb5dc49f8a72b26fd9185475c7a";

const TOKEN_SAFETY_MARGIN_MS = 30_000;
const CURRENCY_CACHE_TTL_MS = 60_000;

/** Close the socket if no timeseries frame arrives within this idle window. */
const WS_IDLE_TIMEOUT_MS = 2_000;
/** Hard ceiling for the whole websocket exchange, whatever the stream does. */
const WS_TOTAL_TIMEOUT_MS = 20_000;

/**
 * The minimal websocket surface this provider uses, so a unit test can drive the
 * exchange with a fake instead of a real connection.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** One instrument as the Börse Frankfurt global search returns it. */
interface DbgSearchResult {
  isin?: string;
  symbol?: string;
  name?: { originalValue?: string };
  type?: string;
  currency?: string;
}

/** The fields this provider reads from the ISIN-keyed data sheet. */
interface DbgDataSheet {
  exchangeSymbol?: string;
  instrumentName?: { originalValue?: string };
  instrumentTypeKey?: string;
}

/** One daily bar as a `dataTimeseries` frame carries it. */
interface DbgTimeseriesFrame {
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  quantity?: number;
}

/**
 * Deutsche Börse / Börse Frankfurt historical-price provider.
 *
 * Börse Frankfurt does not serve daily history over a plain REST endpoint: its
 * price-history page streams the bars over a websocket (`/v1/mds/ws`). Reaching
 * them, reconstructed from the browser's own traffic, is:
 *
 *  1. Obtain a short-lived market-data token from `mdstokenservice/token`. Every
 *     request to the market-data host carries the same `Client-Date` /
 *     `X-Client-TraceId` / `X-Security` signature the site's own public
 *     JavaScript computes client-side (see `boerseSecurityHeaders`) -- no login,
 *     no credential. It needs no configuration.
 *  2. Open the websocket, authenticate with the token, then ask for the daily
 *     series with `listTimeseries` for a `marketstateId` built from the ISIN, the
 *     instrument's currency and the venue (`DELAYED[<isin>,<ccy>@ETR>STX]`).
 *  3. Collect the streamed `dataTimeseries` frames until the stream goes idle.
 *
 * The instrument is addressed by ISIN, and the currency the bars are in is read
 * from `/v1/data/currency` -- carried on the `HistoricalSeries` so the numbers
 * are never stored against a security in the wrong currency.
 */
@Injectable()
export class DeutscheBoerseFinanceService implements QuoteProvider {
  readonly name: QuoteProviderName = "deutsche_boerse";
  private readonly logger = new Logger(DeutscheBoerseFinanceService.name);

  private static readonly FETCH_TIMEOUT_MS = 15_000;

  /** Overridable so a unit test can inject a fake socket. */
  wsFactory: WebSocketFactory = (url) =>
    new WebSocket(url) as unknown as WebSocketLike;

  private token: string | null = null;
  private tokenExpiresAt = 0;
  private tokenPromise: Promise<string | null> | null = null;

  private readonly currencyCache = new Map<
    string,
    { value: string | null; expiresAt: number }
  >();

  constructor(private readonly health: ProviderHealthService) {}

  private async request(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const admission = this.health.assertAvailable(HEALTH_PROVIDER_ID);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        // Every call to the market-data host carries the same client-computed
        // signature the site's own JavaScript adds through its HTTP interceptor.
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          ...boerseSecurityHeaders(url),
        },
        signal: AbortSignal.timeout(
          DeutscheBoerseFinanceService.FETCH_TIMEOUT_MS,
        ),
      });
    } catch (error) {
      const counted = this.health.recordFailure(HEALTH_PROVIDER_ID, error);
      if (!counted && admission === "probe") {
        this.health.releaseProbe(HEALTH_PROVIDER_ID);
      }
      throw error;
    }
    if (!response.ok) this.health.recordSuccess(HEALTH_PROVIDER_ID);
    return response;
  }

  private async readBody<T>(response: Response): Promise<T> {
    const value = (await response.json()) as T;
    this.health.recordSuccess(HEALTH_PROVIDER_ID);
    return value;
  }

  private headers(extra: Record<string, string> = {}): HeadersInit {
    return {
      accept: "application/json",
      origin: DBG_ORIGIN,
      referer: `${DBG_ORIGIN}/`,
      ...extra,
    };
  }

  private async ensureToken(): Promise<string | null> {
    if (
      this.token &&
      Date.now() < this.tokenExpiresAt - TOKEN_SAFETY_MARGIN_MS
    ) {
      return this.token;
    }
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = this.mintToken();
    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
  }

  private async mintToken(): Promise<string | null> {
    try {
      const response = await this.request(
        `${DBG_API}/v1/mdstokenservice/token`,
        { headers: this.headers() },
      );
      if (!response.ok) {
        this.logger.warn(
          `Deutsche Börse token request returned ${response.status}`,
        );
        return null;
      }
      const body = await this.readBody<{ token?: string }>(response);
      if (!body.token) return null;
      this.token = body.token;
      // The token carries its own `exp` (epoch seconds); read it so the cache
      // expires with the token rather than on a fixed guess.
      this.tokenExpiresAt =
        decodeJwtExpiryMs(body.token) ?? Date.now() + 600_000;
      return this.token;
    } catch (error) {
      this.health.logFailure(
        this.logger,
        HEALTH_PROVIDER_ID,
        "Deutsche Börse market-data token",
        error,
      );
      return null;
    }
  }

  private async fetchCurrency(isin: string): Promise<string | null> {
    const key = isin.trim().toUpperCase();
    const cached = this.currencyCache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.value;

    let value: string | null = null;
    try {
      const response = await this.request(
        `${DBG_API}/v1/data/currency?isin=${encodeURIComponent(key)}`,
        { headers: this.headers() },
      );
      if (response.ok) {
        const body =
          await this.readBody<Array<{ currency?: string }>>(response);
        const first = Array.isArray(body) ? body[0] : undefined;
        value =
          first?.currency && typeof first.currency === "string"
            ? first.currency.toUpperCase()
            : null;
      } else if (response.status !== 404) {
        this.logger.warn(
          `Deutsche Börse currency for ${key} returned ${response.status}`,
        );
      }
    } catch (error) {
      this.health.logFailure(
        this.logger,
        HEALTH_PROVIDER_ID,
        `Deutsche Börse currency for ${key}`,
        error,
      );
      value = null;
    }
    this.currencyCache.set(key, {
      value,
      expiresAt: Date.now() + CURRENCY_CACHE_TTL_MS,
    });
    return value;
  }

  private marketstateId(
    isin: string,
    currency: string,
    source: string,
  ): string {
    return `DELAYED[${isin},${currency}@${source}>STX]`;
  }

  /**
   * Run one websocket exchange: authenticate, request the daily series for the
   * window, and resolve the streamed frames. A socket that errors or closes
   * before authenticating is a transport failure the breaker counts; anything
   * after authentication -- frames, or an empty window -- is an answer.
   */
  private async streamTimeseries(
    marketstateId: string,
    fromDate: Date,
    toDate: Date,
    token: string,
  ): Promise<DbgTimeseriesFrame[] | null> {
    const admission = this.health.assertAvailable(HEALTH_PROVIDER_ID);
    return new Promise<DbgTimeseriesFrame[] | null>((resolve) => {
      let socket: WebSocketLike;
      try {
        socket = this.wsFactory(DBG_WS);
      } catch (error) {
        const counted = this.health.recordFailure(HEALTH_PROVIDER_ID, error);
        if (!counted && admission === "probe") {
          this.health.releaseProbe(HEALTH_PROVIDER_ID);
        }
        this.logger.warn("Deutsche Börse websocket could not be opened");
        resolve(null);
        return;
      }

      const frames: DbgTimeseriesFrame[] = [];
      const requestId = "monize-ts";
      let authenticated = false;
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (
        result: DbgTimeseriesFrame[] | null,
        outcome: "answer" | "transport",
      ) => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(hardTimer);
        try {
          socket.close();
        } catch {
          // A socket that never opened has nothing to close.
        }
        if (outcome === "answer") {
          // The exchange authenticated and answered. An empty window (a holiday
          // span, a just-listed instrument) is a valid answer, not a failure --
          // recording it as one would open the breaker for every security over
          // one dataless ISIN, which is exactly what LSE's empty result avoids.
          this.health.recordSuccess(HEALTH_PROVIDER_ID);
        } else {
          // The socket errored or closed before it authenticated: a real
          // transport failure the breaker must count, so a websocket outage
          // opens it rather than retrying every ISIN for the full timeout.
          const error = Object.assign(
            new Error("Deutsche Börse websocket failed before delivering data"),
            { code: "ECONNRESET" },
          );
          const counted = this.health.recordFailure(HEALTH_PROVIDER_ID, error);
          if (!counted && admission === "probe") {
            this.health.releaseProbe(HEALTH_PROVIDER_ID);
          }
        }
        resolve(result);
      };

      const hardTimer = setTimeout(
        () =>
          finish(
            authenticated ? frames : null,
            authenticated ? "answer" : "transport",
          ),
        WS_TOTAL_TIMEOUT_MS,
      );

      // Only armed after authentication, so an idle stream is always an answer.
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => finish(frames, "answer"),
          WS_IDLE_TIMEOUT_MS,
        );
      };

      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            subscribeAuthentication: { token },
            requestId: "monize-auth",
          }),
        );
      });

      socket.addEventListener("message", (event) => {
        const parsed = parseFrame(event.data);
        if (!parsed) return;
        if (parsed.dataAuthentication && !authenticated) {
          authenticated = true;
          socket.send(
            JSON.stringify({
              listTimeseries: {
                resolution: "1D",
                marketstateId,
                start: fromDate.toISOString(),
                end: toDate.toISOString(),
                cleanSplits: false,
                cleanDividends: false,
                cleanDistributions: false,
                cleanSubscriptions: false,
                quality: "DELAYED",
              },
              requestId,
            }),
          );
          armIdle();
          return;
        }
        if (parsed.dataTimeseries && parsed.requestId === requestId) {
          frames.push(parsed.dataTimeseries);
          armIdle();
        }
      });

      socket.addEventListener("error", () => {
        // An error with data already in hand keeps the data; otherwise it is a
        // transport failure.
        finish(
          frames.length ? frames : null,
          frames.length ? "answer" : "transport",
        );
      });

      socket.addEventListener("close", () => {
        // A close after authentication ends the stream normally (frames or an
        // empty window); a close before it is a connection failure.
        finish(
          authenticated ? frames : null,
          authenticated ? "answer" : "transport",
        );
      });
    });
  }

  private async loadSeries(
    symbol: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<HistoricalSeries | null> {
    // A Deutsche Börse security is keyed by its Frankfurt ticker (e.g. IUSQ);
    // pricing addresses the instrument by ISIN, so resolve a ticker to its ISIN
    // through the search. An unresolvable symbol prices nothing (this provider
    // is not a blanket fallback, so it only ever sees its own securities).
    const isin = await this.resolveIsin(symbol);
    if (!isin) return null;
    const token = await this.ensureToken();
    if (!token) return null;
    const currency = await this.fetchCurrency(isin);
    if (!currency) return null;

    const marketstateId = this.marketstateId(isin, currency, DEFAULT_SOURCE);
    const frames = await this.streamTimeseries(
      marketstateId,
      fromDate,
      toDate,
      token,
    );
    if (frames == null) return null;

    const prices: HistoricalPrice[] = [];
    for (const frame of frames) {
      if (!frame.date || frame.close == null || isNaN(Number(frame.close))) {
        continue;
      }
      prices.push({
        date: new Date(`${frame.date}T00:00:00.000Z`),
        open: numOrNull(frame.open),
        high: numOrNull(frame.high),
        low: numOrNull(frame.low),
        close: Number(frame.close),
        adjClose: null,
        volume: numOrNull(frame.quantity),
      });
    }
    prices.sort((a, b) => a.date.getTime() - b.date.getTime());

    return {
      prices,
      currencyCode: currency,
      symbol: symbol.trim().toUpperCase(),
      exchange: DEFAULT_SOURCE,
    };
  }

  /**
   * The ISIN a series is fetched for: the value itself when it is already an
   * ISIN, otherwise the ISIN of the exact ticker match from the global search.
   * `null` when a ticker resolves to no Börse Frankfurt instrument.
   */
  private async resolveIsin(symbol: string): Promise<string | null> {
    const s = symbol.trim().toUpperCase();
    if (isIsin(s)) return s;
    for (const hit of await this.globalSearch(s)) {
      const isin =
        typeof hit.isin === "string" ? hit.isin.trim().toUpperCase() : "";
      const sym =
        typeof hit.symbol === "string" ? hit.symbol.trim().toUpperCase() : "";
      if (sym === s && isIsin(isin)) return isin;
    }
    return null;
  }

  async fetchHistoricalSeries(
    symbol: string,
    _exchange: string | null = null,
    range: string = "max",
    _opts?: QuoteProviderOptions,
  ): Promise<HistoricalSeries | null> {
    const toDate = new Date();
    const fromDate = rangeToStartDate(range, toDate);
    return this.loadSeries(symbol, fromDate, toDate);
  }

  async fetchHistoricalWindowSeries(
    symbol: string,
    _exchange: string | null,
    fromDate: Date,
    toDate: Date,
    _opts?: QuoteProviderOptions,
  ): Promise<HistoricalSeries | null> {
    return this.loadSeries(symbol, fromDate, toDate);
  }

  async fetchQuote(
    symbol: string,
    _exchange: string | null = null,
    _opts?: QuoteProviderOptions,
  ): Promise<QuoteResult | null> {
    // Börse Frankfurt streams live prices over the same socket; the newest
    // settled daily bar is a truthful, cheaper stand-in for a delayed feed.
    const toDate = new Date();
    const fromDate = new Date(toDate);
    fromDate.setUTCDate(fromDate.getUTCDate() - 10);
    const series = await this.loadSeries(symbol, fromDate, toDate);
    const last = series?.prices.length
      ? series.prices[series.prices.length - 1]
      : undefined;
    if (!series || !last) return null;
    return {
      symbol: series.symbol ?? symbol.trim().toUpperCase(),
      regularMarketPrice: last.close,
      regularMarketOpen: last.open ?? undefined,
      regularMarketDayHigh: last.high ?? undefined,
      regularMarketDayLow: last.low ?? undefined,
      regularMarketVolume: last.volume ?? undefined,
      regularMarketTime: Math.floor(last.date.getTime() / 1000),
      exchangeTimezone: DBG_TIMEZONE,
      regularSession: null,
      provider: "deutsche_boerse",
      currencyCode: series.currencyCode,
    };
  }

  /**
   * Search Börse Frankfurt by symbol, name or ISIN through its global search.
   * A ticker query answers with the symbol, name, currency and type inline; an
   * ISIN query omits the symbol and currency, so every hit is enriched from the
   * ISIN-keyed data sheet (ticker, name, type) and the currency endpoint when
   * those fields are missing. The candidate's symbol is the Frankfurt ticker
   * (e.g. `IUSQ`); pricing resolves it back to the ISIN it addresses.
   */
  async lookupSecurityMany(
    query: string,
    _preferredExchanges?: string[],
  ): Promise<SecurityLookupResult[]> {
    const items = await this.globalSearch(query);
    const results: SecurityLookupResult[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const isin =
        typeof item.isin === "string" ? item.isin.trim().toUpperCase() : "";
      if (!isIsin(isin) || seen.has(isin)) continue;
      seen.add(isin);

      let symbol = upperOrNull(item.symbol);
      let name = item.name?.originalValue?.trim() || null;
      let type = upperOrNull(item.type);
      let currency = upperOrNull(item.currency);

      if (!symbol || !name || !type) {
        const sheet = await this.fetchDataSheet(isin);
        symbol ??= sheet?.symbol ?? null;
        name ??= sheet?.name ?? null;
        type ??= sheet?.type ?? null;
      }
      // A candidate must carry a currency, or the security would be created
      // without one; the currency endpoint is the ISIN-keyed source.
      if (!currency) currency = await this.fetchCurrency(isin);

      results.push({
        symbol: symbol ?? isin,
        name: name ?? symbol ?? isin,
        exchange: DEFAULT_SOURCE,
        securityType: type,
        currencyCode: currency,
        provider: "deutsche_boerse",
      });
    }
    return results;
  }

  /** The ticker, name and type from the ISIN-keyed data sheet, best-effort. */
  private async fetchDataSheet(isin: string): Promise<{
    symbol: string | null;
    name: string | null;
    type: string | null;
  } | null> {
    try {
      const response = await this.request(
        `${DBG_API}/v1/data/data_sheet_header?isin=${encodeURIComponent(isin)}`,
        { headers: this.headers() },
      );
      if (!response.ok) {
        if (response.status !== 404) {
          this.logger.warn(
            `Deutsche Börse data sheet for ${isin} returned ${response.status}`,
          );
        }
        return null;
      }
      const body = await this.readBody<DbgDataSheet>(response);
      return {
        symbol: upperOrNull(body?.exchangeSymbol),
        name: body?.instrumentName?.originalValue?.trim() || null,
        type: upperOrNull(body?.instrumentTypeKey),
      };
    } catch (error) {
      this.health.logFailure(
        this.logger,
        HEALTH_PROVIDER_ID,
        `Deutsche Börse data sheet for ${isin}`,
        error,
      );
      return null;
    }
  }

  async lookupSecurity(
    query: string,
    preferredExchanges?: string[],
  ): Promise<SecurityLookupResult | null> {
    const many = await this.lookupSecurityMany(query, preferredExchanges);
    return many[0] ?? null;
  }

  /** Börse Frankfurt global search: instruments matching a symbol, name or ISIN. */
  private async globalSearch(query: string): Promise<DbgSearchResult[]> {
    const q = query.trim();
    if (!q) return [];
    try {
      const response = await this.request(
        `${DBG_API}/v1/global_search/limitedsearch/en?searchTerms=${encodeURIComponent(q)}`,
        { headers: this.headers() },
      );
      if (!response.ok) return [];
      const body = await this.readBody<unknown>(response);
      return flattenSearchResults(body);
    } catch (error) {
      this.health.logFailure(
        this.logger,
        HEALTH_PROVIDER_ID,
        `Deutsche Börse search for ${q}`,
        error,
      );
      return [];
    }
  }

  async fetchStockSectorInfo(): Promise<StockSectorInfo | null> {
    return null;
  }

  async fetchEtfSectorWeightings(): Promise<EtfSectorWeighting[] | null> {
    return null;
  }

  getTradingDate(quote: QuoteResult): Date {
    return getTradingDateFromQuote(quote);
  }
}

/**
 * The `Client-Date` / `X-Client-TraceId` / `X-Security` triple Börse Frankfurt's
 * own page computes client-side for every market-data request, reproduced
 * exactly (verified byte-for-byte against captured traffic):
 *
 *   Client-Date      = ISO-8601 of `now` in Europe/Berlin, to the second, with
 *                      the numeric offset ("2026-09-24T09:21:48+02:00").
 *   X-Client-TraceId = md5(Client-Date + requestUrl + salt).
 *   X-Security       = md5(now in Europe/Berlin, "yyyyMMddHHmm") -- the current
 *                      minute; no salt, no url.
 *
 * The exchange keeps Frankfurt time, so the stamps are computed in that zone
 * regardless of where the server runs. `now` is injectable for testing.
 */
export function boerseSecurityHeaders(
  url: string,
  now: Date = new Date(),
  salt: string = DBG_SALT,
): Record<string, string> {
  const p = berlinParts(now);
  const offset = berlinOffset(now, p);
  const clientDate = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
  const minuteStamp = `${p.year}${p.month}${p.day}${p.hour}${p.minute}`;
  return {
    "Client-Date": clientDate,
    "X-Client-TraceId": md5(clientDate + url + salt),
    "X-Security": md5(minuteStamp),
  };
}

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

interface BerlinParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

/** The wall-clock fields of an instant in Europe/Berlin, each zero-padded. */
function berlinParts(date: Date): BerlinParts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: DBG_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const { type, value } of fmt.formatToParts(date)) parts[type] = value;
  // Some ICU builds render midnight as "24"; normalise it to "00".
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** The `+HH:MM` / `-HH:MM` Europe/Berlin offset for the instant (CET or CEST). */
function berlinOffset(date: Date, p: BerlinParts): string {
  const asIfUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  const minutes = Math.round((asIfUtc - date.getTime()) / 60000);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.trunc(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

interface ParsedFrame {
  requestId?: string;
  dataAuthentication?: unknown;
  dataTimeseries?: DbgTimeseriesFrame;
}

/** A websocket text frame to the shape this provider reads, or null. */
function parseFrame(data: unknown): ParsedFrame | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as ParsedFrame;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function numOrNull(value: number | undefined): number | null {
  return value == null || isNaN(Number(value)) ? null : Number(value);
}

/** A non-empty string trimmed and upper-cased, or null. */
function upperOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().toUpperCase()
    : null;
}

/** Whether a string is ISIN-shaped (2 letters, 9 alphanumerics, 1 check digit). */
function isIsin(value: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(value.trim().toUpperCase());
}

/**
 * The global search wraps its hits in nested arrays (`[[{...}]]`), sometimes
 * grouped by category. Walk any depth and collect the leaf objects.
 */
function flattenSearchResults(body: unknown): DbgSearchResult[] {
  const out: DbgSearchResult[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node && typeof node === "object") out.push(node as DbgSearchResult);
  };
  visit(body);
  return out;
}

/** The `exp` claim of a JWT as epoch milliseconds, or null when unreadable. */
function decodeJwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64").toString("utf8"),
    ) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
