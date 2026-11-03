import { Injectable, Logger } from "@nestjs/common";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import {
  EtfSectorWeighting,
  HistoricalSeries,
  QuoteProvider,
  QuoteProviderName,
  QuoteProviderOptions,
  QuoteResult,
  SecurityLookupResult,
  StockSectorInfo,
} from "./providers/quote-provider.interface";
import { getTradingDateFromQuote } from "./providers/trading-date.util";
import {
  describeFetchFailure,
  isTransportFailure,
} from "../common/http/fetch-failure.util";
import { readCapped } from "../bonds/series-http";
import { publicOnlyLookup } from "../ai/providers/provider-egress";
import {
  isPrivateIp,
  unbracketHost,
} from "../ai/validators/safe-url.validator";
import {
  AmbiguousQuoteTableError,
  ParsedQuoteTable,
  parseQuoteTable,
} from "./html-table-quote.parser";

const FETCH_TIMEOUT_MS = 20_000;
/** A quote page is a few hundred kilobytes; ariva.de's is about 0.5 MB. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
/** One refresh asks for the quote and then the series: one download serves both. */
const PAGE_CACHE_TTL_MS = 5 * 60_000;
const PAGE_CACHE_MAX_ENTRIES = 200;
/**
 * How long a site that failed at the transport level (refused, unresolvable,
 * timed out) is not asked again. A refresh asks for the quote and then the
 * series, and several securities can share one site: one failure answers them
 * all for this long instead of one timeout each.
 */
const FAILED_ORIGIN_BACKOFF_MS = 10 * 60_000;

/**
 * Sent as a browser would: several of these sites answer a non-browser agent
 * with an empty page or a consent wall instead of the table.
 */
const REQUEST_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "de,en;q=0.8,es;q=0.6",
};

/** Why a page could not be read, for the preview and the log. */
export type QuoteTableFailure =
  | "invalid-url"
  | "private-address"
  | "too-many-redirects"
  | "http-status"
  | "too-large"
  | "unreachable"
  | "no-table"
  | "ambiguous";

export class QuoteTableError extends Error {
  constructor(
    readonly reason: QuoteTableFailure,
    readonly detail?: string,
  ) {
    super(`Quote table page refused: ${reason}${detail ? ` (${detail})` : ""}`);
    this.name = "QuoteTableError";
  }
}

/**
 * Every connection this provider opens is to a public address: the URL is the
 * user's, so the resolver refuses a private, loopback, link-local or metadata
 * answer at the moment the socket is opened (DNS rebinding included), and an
 * IP literal, which never reaches the resolver, is checked by `checkTarget`.
 */
const publicOnlyAgent = new Agent({
  connect: { lookup: publicOnlyLookup },
  headersTimeout: FETCH_TIMEOUT_MS,
  bodyTimeout: FETCH_TIMEOUT_MS,
});

/** The URL as it will be requested, or a refusal. */
export function checkQuoteTableUrl(target: string, base?: string): URL {
  let url: URL;
  try {
    url = new URL(target, base);
  } catch {
    throw new QuoteTableError("invalid-url");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new QuoteTableError("invalid-url");
  }
  const host = unbracketHost(url.hostname.toLowerCase());
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new QuoteTableError("private-address");
  }
  if (isIP(host) && isPrivateIp(host)) {
    throw new QuoteTableError("private-address");
  }
  return url;
}

/**
 * What a transport failure is remembered against: scheme, host and port. A
 * closed port says nothing about the site's other ports, so one user's address
 * on a refused port never backs off another user's working page on that host.
 */
function originOf(url: URL): string {
  return url.origin.toLowerCase();
}

function decode(body: Uint8Array, contentType: string | null): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/** The first day a named range reaches back to, or `null` for everything. */
export function rangeStart(range: string | undefined, now: Date): Date | null {
  const match = /^(\d+)(d|wk|mo|y)$/.exec((range ?? "").trim().toLowerCase());
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  if (range === "ytd") return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  if (!match) return null;
  const n = Number(match[1]);
  if (match[2] === "d") start.setUTCDate(start.getUTCDate() - n);
  else if (match[2] === "wk") start.setUTCDate(start.getUTCDate() - 7 * n);
  else if (match[2] === "mo") start.setUTCMonth(start.getUTCMonth() - n);
  else start.setUTCFullYear(start.getUTCFullYear() - n);
  return start;
}

/**
 * Prices read from a table on a web page whose address the user gives per
 * security (`securities.quote_url`), the way Portfolio Performance's
 * "Table on website" source works.
 *
 * The page is downloaded once per refresh and parsed by
 * `html-table-quote.parser.ts`; the newest row is the quote and every row is
 * the series. It never searches, never backs up another provider, and returns
 * `null` for a security without an address.
 *
 * The addresses are the users', so this provider deliberately stays out of
 * `ProviderHealthService`: that breaker is keyed by a fixed provider id,
 * persisted to `provider_health` and alerts the administrators, none of which
 * fits an unbounded set of hosts a user chose. A transport failure is
 * remembered here instead, per origin, in process and bounded
 * (`failedOrigins`), and is never persisted or alerted.
 */
@Injectable()
export class HtmlTableFinanceService implements QuoteProvider {
  readonly name: QuoteProviderName = "html_table";
  private readonly logger = new Logger(HtmlTableFinanceService.name);
  private readonly cache = new Map<
    string,
    { table: ParsedQuoteTable; expiresAt: number }
  >();

  /**
   * Loads in progress, so concurrent callers of one address (a refresh and a
   * preview, or two securities on the same page) await one download and parse
   * instead of each making their own. Entries leave when the load settles, a
   * rejection is never kept, and the map holds at most the loads running now.
   */
  private readonly pending = new Map<string, Promise<ParsedQuoteTable>>();

  /** Origins that failed at the transport level, and until when to skip them. */
  private readonly failedOrigins = new Map<string, number>();

  /**
   * Download and parse a page, throwing `QuoteTableError` (or the transport
   * error) with the reason. The preview calls this so the user sees why.
   */
  async loadTable(
    target: string,
    now: Date = new Date(),
  ): Promise<ParsedQuoteTable> {
    const cached = this.cache.get(target);
    if (cached && cached.expiresAt > now.getTime()) return cached.table;

    const running = this.pending.get(target);
    if (running) return running;
    const load = this.readTable(target, now).finally(() => {
      this.pending.delete(target);
    });
    this.pending.set(target, load);
    return load;
  }

  private async readTable(
    target: string,
    now: Date,
  ): Promise<ParsedQuoteTable> {
    const html = await this.download(target);
    let table: ParsedQuoteTable | null;
    try {
      table = parseQuoteTable(html, now);
    } catch (error) {
      if (error instanceof AmbiguousQuoteTableError) {
        throw new QuoteTableError("ambiguous", error.what);
      }
      throw error;
    }
    if (!table) throw new QuoteTableError("no-table");

    if (this.cache.size >= PAGE_CACHE_MAX_ENTRIES) this.cache.clear();
    this.cache.set(target, {
      table,
      expiresAt: now.getTime() + PAGE_CACHE_TTL_MS,
    });
    return table;
  }

  private async download(target: string): Promise<string> {
    // `url` is the hop being asked: a redirect to another site is checked,
    // and blamed, as that site, never as the one the address started on.
    let url = checkQuoteTableUrl(target);
    let html: string;
    try {
      let response = await this.get(url);
      for (let hops = 0; ; hops += 1) {
        const location = response.headers.get("location");
        if (response.status < 300 || response.status >= 400 || !location) break;
        await response.body?.cancel();
        if (hops >= MAX_REDIRECTS)
          throw new QuoteTableError("too-many-redirects");
        url = checkQuoteTableUrl(location, url.toString());
        response = await this.get(url);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new QuoteTableError("http-status", String(response.status));
      }
      let body: Uint8Array;
      try {
        body = await readCapped(
          response as unknown as Response,
          MAX_BODY_BYTES,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "SeriesBodyTooLargeError"
        ) {
          throw new QuoteTableError("too-large");
        }
        throw error;
      }
      html = decode(body, response.headers.get("content-type"));
    } catch (error) {
      // A refused address or a status the site chose says the site is up; only
      // a failure to reach it is remembered.
      if (!(error instanceof QuoteTableError) && isTransportFailure(error)) {
        if (this.failedOrigins.size >= PAGE_CACHE_MAX_ENTRIES) {
          this.failedOrigins.clear();
        }
        this.failedOrigins.set(
          originOf(url),
          Date.now() + FAILED_ORIGIN_BACKOFF_MS,
        );
        throw new QuoteTableError("unreachable", describeFetchFailure(error));
      }
      throw error;
    }
    this.failedOrigins.delete(originOf(url));
    return html;
  }

  /**
   * One request, never following a redirect itself, to a public address only,
   * and never to a site that failed to answer within the back-off.
   */
  private get(url: URL) {
    if ((this.failedOrigins.get(originOf(url)) ?? 0) > Date.now()) {
      throw new QuoteTableError("unreachable", "failed recently");
    }
    return undiciFetch(url, {
      redirect: "manual",
      headers: REQUEST_HEADERS,
      dispatcher: publicOnlyAgent,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  }

  /** The table for a security, or `null` (logged) when it cannot be read. */
  private async tableFor(
    symbol: string,
    opts: QuoteProviderOptions | undefined,
  ): Promise<ParsedQuoteTable | null> {
    const target = opts?.quoteUrl;
    if (!target) return null;
    try {
      return await this.loadTable(target);
    } catch (error) {
      this.logger.warn(
        `No price table for ${symbol}: ${
          error instanceof QuoteTableError
            ? error.message
            : describeFetchFailure(error)
        }`,
      );
      return null;
    }
  }

  async fetchQuote(
    symbol: string,
    _exchange: string | null = null,
    opts?: QuoteProviderOptions,
  ): Promise<QuoteResult | null> {
    const table = await this.tableFor(symbol, opts);
    const last = table?.prices[table.prices.length - 1];
    if (!table || !last) return null;
    return {
      symbol,
      regularMarketPrice: last.close,
      regularMarketOpen: last.open ?? undefined,
      regularMarketDayHigh: last.high ?? undefined,
      regularMarketDayLow: last.low ?? undefined,
      regularMarketVolume: last.volume ?? undefined,
      regularMarketTime: Math.floor(last.date.getTime() / 1000),
      exchangeTimezone: null,
      regularSession: null,
      provider: "html_table",
      currencyCode: table.currencyCode,
    };
  }

  async fetchHistoricalSeries(
    symbol: string,
    _exchange: string | null = null,
    range?: string,
    opts?: QuoteProviderOptions,
  ): Promise<HistoricalSeries | null> {
    const table = await this.tableFor(symbol, opts);
    if (!table) return null;
    const start = rangeStart(range, new Date());
    return {
      prices: start
        ? table.prices.filter((p) => p.date.getTime() >= start.getTime())
        : table.prices,
      currencyCode: table.currencyCode,
      symbol,
      exchange: null,
    };
  }

  /**
   * The rows of one window, for the month-by-month gap fill. A page covers only
   * its own few weeks, so a window before them answers `[]`: an answer, which
   * lets the fill remember the month as empty instead of re-reading the page.
   */
  async fetchHistoricalWindowSeries(
    symbol: string,
    _exchange: string | null,
    fromDate: Date,
    toDate: Date,
    opts?: QuoteProviderOptions,
  ): Promise<HistoricalSeries | null> {
    const table = await this.tableFor(symbol, opts);
    if (!table) return null;
    const from = fromDate.getTime();
    const to = toDate.getTime();
    return {
      prices: table.prices.filter(
        (p) => p.date.getTime() >= from && p.date.getTime() <= to,
      ),
      currencyCode: table.currencyCode,
      symbol,
      exchange: null,
    };
  }

  /** A page address is not searchable: securities are set up by hand. */
  async lookupSecurity(): Promise<SecurityLookupResult | null> {
    return null;
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
