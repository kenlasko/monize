import { Injectable, Logger } from "@nestjs/common";
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
import {
  followRedirects,
  readCapped,
  SeriesBodyTooLargeError,
} from "../bonds/series-http";
import {
  AiEgressRefusedError,
  publicOnlyLookup,
} from "../ai/providers/provider-egress";
import { isRefusedHostName } from "../ai/validators/safe-url.validator";
import { rangeToStartDate } from "./providers/range-start.util";
import {
  AmbiguousQuoteTableError,
  ParsedQuoteTable,
  parseQuoteTable,
} from "./html-table-quote.parser";

const FETCH_TIMEOUT_MS = 20_000;
/** A quote page is a few hundred kilobytes; ariva.de's is about 0.5 MB. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** One refresh asks for the quote and then the series: one download serves both. */
const PAGE_CACHE_TTL_MS = 5 * 60_000;
const PAGE_CACHE_MAX_ENTRIES = 200;
/**
 * Price rows held across every cached page. A 5 MB page can carry a few
 * hundred thousand rows, so the entry count alone does not bound the memory:
 * the oldest pages are dropped until the rows fit.
 */
const PAGE_CACHE_MAX_ROWS = 250_000;
/**
 * How long a page address that failed at the transport level (refused,
 * unresolvable, timed out) is not asked again by a refresh. A refresh asks for
 * the quote and then the series of the same page: one failure answers both
 * instead of one timeout each. Keyed by the address, never by the site, so one
 * user's slow page never stops another user's page on the same site, and never
 * set by a preview, which a person can send at will.
 */
const FAILED_PAGE_BACKOFF_MS = 10 * 60_000;
/** The bytes searched for a `<meta charset>` when the header names none. */
const CHARSET_PRESCAN_BYTES = 1024;

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
 * answer at the moment the socket is opened (DNS rebinding included), and a
 * name or IP literal that is refused on its face is stopped earlier, by
 * `checkQuoteTableUrl`.
 */
const publicOnlyAgent = new Agent({
  connect: { lookup: publicOnlyLookup },
  headersTimeout: FETCH_TIMEOUT_MS,
  bodyTimeout: FETCH_TIMEOUT_MS,
});

/**
 * The URL as it will be requested, or a refusal. The names and literals the
 * shared policy refuses on their face (`isRefusedHostName`: blocked names and
 * suffixes, every spelling of a private IPv4 or IPv6 address) are refused
 * here; what a name resolves to is judged where the socket opens
 * (`publicOnlyLookup`), once, so a slow resolver reads as an unreachable site
 * and never as a private address.
 */
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
  if (isRefusedHostName(url.hostname)) {
    throw new QuoteTableError("private-address");
  }
  return url;
}

/** Whether a failed request was refused for connecting to a private address. */
function refusedAsPrivate(error: unknown): boolean {
  for (let e = error, i = 0; e && i < 8; i++) {
    if (e instanceof AiEgressRefusedError) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The page's text in the charset it declares, in the order the WHATWG
 * encoding sniffing uses: a byte-order mark, else the `Content-Type` header,
 * else a `<meta charset>` (or `http-equiv` Content-Type) in the first kilobyte,
 * else UTF-8. A German page served as bare `text/html` and declaring
 * ISO-8859-1 in its markup keeps its "Schluß", "März" and "€".
 */
function decode(body: Uint8Array, contentType: string | null): string {
  const declared =
    bomCharset(body) ??
    /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1] ??
    metaCharset(body);
  try {
    return new TextDecoder(declared ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

function bomCharset(body: Uint8Array): string | null {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return "utf-8";
  if (body[0] === 0xfe && body[1] === 0xff) return "utf-16be";
  if (body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
  return null;
}

function metaCharset(body: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(
    body.subarray(0, CHARSET_PRESCAN_BYTES),
  );
  const label =
    /<meta[^>]{0,200}?charset\s*=\s*["']?\s*([\w-]{1,40})/i.exec(head)?.[1] ??
    null;
  // Markup read as bytes cannot be UTF-16, so the standard reads that label as
  // UTF-8.
  return label && /^utf-16/i.test(label) ? "utf-8" : label;
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
 * remembered here instead, per page address, in process and bounded
 * (`failedPages`), set and read by refreshes only, and never persisted or
 * alerted.
 */
@Injectable()
export class HtmlTableFinanceService implements QuoteProvider {
  readonly name: QuoteProviderName = "html_table";
  private readonly logger = new Logger(HtmlTableFinanceService.name);
  private readonly cache = new Map<
    string,
    { table: ParsedQuoteTable; expiresAt: number }
  >();
  /** Price rows held in `cache`, bounded by `PAGE_CACHE_MAX_ROWS`. */
  private cachedRows = 0;

  /**
   * Loads in progress, so concurrent callers of one address (a refresh and a
   * preview, or two securities on the same page) await one download and parse
   * instead of each making their own. Entries leave when the load settles, a
   * rejection is never kept, and the map holds at most the loads running now.
   */
  private readonly pending = new Map<string, Promise<ParsedQuoteTable>>();

  /** Page addresses that failed at the transport level, and until when. */
  private readonly failedPages = new Map<string, number>();

  /**
   * Download and parse a page, throwing `QuoteTableError` with the reason.
   * The preview calls this with `preview: true`, so the user sees why, and so
   * a person testing an address neither waits out nor starts a back-off.
   */
  async loadTable(
    target: string,
    now: Date = new Date(),
    options: { preview?: boolean } = {},
  ): Promise<ParsedQuoteTable> {
    const cached = this.cache.get(target);
    if (cached && cached.expiresAt > now.getTime()) return cached.table;

    const running = this.pending.get(target);
    if (running) return running;
    const load = this.readTable(target, now, options.preview === true).finally(
      () => {
        this.pending.delete(target);
      },
    );
    this.pending.set(target, load);
    return load;
  }

  private async readTable(
    target: string,
    now: Date,
    preview: boolean,
  ): Promise<ParsedQuoteTable> {
    const html = await this.download(target, preview);
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

    this.remember(target, table, now);
    return table;
  }

  /**
   * Cache a parsed page: expired entries go first, then the oldest, until the
   * entry count and the row budget both fit. A table larger than the whole
   * budget is returned to its caller but not kept.
   */
  private remember(target: string, table: ParsedQuoteTable, now: Date): void {
    const rows = table.prices.length;
    this.forget(target);
    if (rows > PAGE_CACHE_MAX_ROWS) return;
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now.getTime()) this.forget(key);
    }
    for (const key of this.cache.keys()) {
      if (
        this.cache.size < PAGE_CACHE_MAX_ENTRIES &&
        this.cachedRows + rows <= PAGE_CACHE_MAX_ROWS
      ) {
        break;
      }
      this.forget(key);
    }
    this.cache.set(target, {
      table,
      expiresAt: now.getTime() + PAGE_CACHE_TTL_MS,
    });
    this.cachedRows += rows;
  }

  private forget(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cachedRows -= entry.table.prices.length;
    this.cache.delete(key);
  }

  private async download(target: string, preview: boolean): Promise<string> {
    // `url` is the hop being asked: a redirect to another page is checked, and
    // blamed, as that page, never as the address the security names.
    let url = checkQuoteTableUrl(target);
    let html: string;
    try {
      const response = await followRedirects({
        first: await this.get(url, preview),
        from: url.toString(),
        follow: true,
        call: () => this.get(url, preview),
        next: (location, from) => {
          url = checkQuoteTableUrl(location, from);
          return url.toString();
        },
        tooMany: () => new QuoteTableError("too-many-redirects"),
      });
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
        if (error instanceof SeriesBodyTooLargeError) {
          throw new QuoteTableError("too-large");
        }
        throw error;
      }
      html = decode(body, response.headers.get("content-type"));
    } catch (error) {
      if (error instanceof QuoteTableError) throw error;
      // A name that resolved to a private address is a refusal, not an outage:
      // said as one, and never backed off.
      if (refusedAsPrivate(error)) {
        throw new QuoteTableError("private-address");
      }
      if (isTransportFailure(error)) {
        // Only a failure to reach the page is remembered, and only by a
        // refresh: a status the site chose says the site is up.
        if (!preview) this.backOff(url);
        throw new QuoteTableError("unreachable", describeFetchFailure(error));
      }
      throw error;
    }
    this.failedPages.delete(url.href);
    return html;
  }

  private backOff(url: URL): void {
    if (this.failedPages.size >= PAGE_CACHE_MAX_ENTRIES) {
      const now = Date.now();
      for (const [key, until] of this.failedPages) {
        if (until <= now) this.failedPages.delete(key);
      }
      if (this.failedPages.size >= PAGE_CACHE_MAX_ENTRIES) {
        const oldest = this.failedPages.keys().next().value;
        if (oldest !== undefined) this.failedPages.delete(oldest);
      }
    }
    this.failedPages.set(url.href, Date.now() + FAILED_PAGE_BACKOFF_MS);
  }

  /**
   * One request, never following a redirect itself, to a public address only,
   * and, for a refresh, never to a page that failed within the back-off.
   */
  private get(url: URL, preview: boolean) {
    if (!preview && (this.failedPages.get(url.href) ?? 0) > Date.now()) {
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
    // From the start of today, so "5d" keeps five whole calendar days.
    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const start = rangeToStartDate(range ?? "max", today).getTime();
    return {
      prices: table.prices.filter((p) => p.date.getTime() >= start),
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
