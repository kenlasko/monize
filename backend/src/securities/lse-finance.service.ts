import { Injectable, Logger } from "@nestjs/common";
import { isGbxCurrency, convertGbxToGbp } from "../common/gbx-currency.util";
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
 * This client's id in `provider_health` and in the circuit breaker.
 *
 * Distinct from the `QuoteProviderName` ("lse") a security is priced by: this
 * one names the *hosts we call* (the London Stock Exchange page API and the
 * financial.com widget backend that serves its charts) and is the primary key
 * of the durable alert state, so it must stay stable.
 */
const HEALTH_PROVIDER_ID: TrackedProviderId = "lse";

/** The exchange these listings trade on; LSE keeps London time. */
const LSE_TIMEZONE = "Europe/London";

/**
 * The LSE public page API and the financial.com widget backend both check the
 * page's own origin. Sending the same `Origin`/`Referer` the browser does is
 * what the reconstructed calls need; there is nothing user-specific in them.
 */
const LSE_ORIGIN = "https://www.londonstockexchange.com";

/** The daily-history fields the chart widget asks for, in its own vocabulary. */
const TIMESERIES_FIDS = "_DATE_END,CLOSE_PRC,HIGH_1,OPEN_PRC,LOW_1";

/** The financial.com session JWT is short-lived; refresh a little early. */
const TOKEN_SAFETY_MARGIN_MS = 30_000;

/** Instrument master data rarely changes within a request burst. */
const INSTRUMENT_CACHE_TTL_MS = 60_000;

/** One instrument's master record, as `instruments/alldata` reports it. */
interface LseInstrument {
  tidm: string;
  isin: string | null;
  name: string | null;
  currency: string | null;
  market: string | null;
  instrumenttype: string | null;
  lastprice: number | null;
  openingprice: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  lastvolume: number | null;
  lastpricedate: string | null;
}

/** One match from the LSE search autocomplete endpoint. */
interface LseAutocompleteInstrument {
  tidm?: string;
  code?: string;
  description?: string;
  category?: string;
  /** `true` for a real LSE listing; null/absent for a mirror or venue entry. */
  islse?: boolean | null;
}

/** One daily bar as the financial.com timeseries endpoint returns it. */
interface LseTimeseriesRow {
  _DATE_END?: string;
  CLOSE_PRC?: string;
  OPEN_PRC?: string;
  HIGH_1?: string;
  LOW_1?: string;
}

/**
 * London Stock Exchange historical-price provider.
 *
 * The LSE company page serves its price chart from a third-party widget backend
 * (financial.com, an LSEG partner). Reaching the daily history is a short chain,
 * all reconstructed from the browser's own traffic and carrying no user
 * credentials:
 *
 *  1. Resolve the TIDM (ticker) to a Reuters Instrument Code -- `AGGU` ->
 *     `AGGU.L`. LSE listings follow the `.L` convention, so the RIC is built
 *     directly rather than depending on a second lookup.
 *  2. Obtain a SAML artifact from the LSE feed handler and exchange it at
 *     financial.com for a short-lived session JWT.
 *  3. Ask the timeseries endpoint for daily bars in an explicit date window,
 *     passing the JWT.
 *
 * The bars themselves carry no currency, so the currency this series is in is
 * read from the instrument's own master record (`instruments/alldata`) -- which
 * is the whole point of `HistoricalSeries.currencyCode`: a USD-denominated ETF
 * on the LSE is exactly the case an exchange guess gets wrong.
 */
@Injectable()
export class LseFinanceService implements QuoteProvider {
  readonly name: QuoteProviderName = "lse";
  private readonly logger = new Logger(LseFinanceService.name);

  private static readonly FETCH_TIMEOUT_MS = 15_000;
  private static readonly PAGE_API = "https://api.londonstockexchange.com";
  private static readonly WIDGET_API =
    "https://refinitiv-widgets.financial.com";

  /** Cached financial.com session JWT and the instant it stops being valid. */
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private tokenPromise: Promise<string | null> | null = null;

  /** Per-TIDM instrument master cache, so a quote and a series share one read. */
  private readonly instrumentCache = new Map<
    string,
    { value: LseInstrument | null; expiresAt: number }
  >();

  constructor(private readonly health: ProviderHealthService) {}

  /**
   * The single door the breaker sits on: every outbound call goes through here,
   * so a refusal here refuses all of them. A `ProviderUnavailableError` is
   * raised before any work, exactly as the Yahoo client does it.
   */
  private async request(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const admission = this.health.assertAvailable(HEALTH_PROVIDER_ID);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(LseFinanceService.FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      // No response at all is the availability signal the breaker counts; an
      // error it does not count (a bad URL) leaves the probe slot to be handed
      // back rather than held against a healthy provider.
      const counted = this.health.recordFailure(HEALTH_PROVIDER_ID, error);
      if (!counted && admission === "probe") {
        this.health.releaseProbe(HEALTH_PROVIDER_ID);
      }
      throw error;
    }
    // A non-2xx is a complete answer with nothing left to read, so it is
    // recorded here; a 2xx becomes a success only once its body arrives
    // (`readBody`), because headers alone are not a completed request.
    if (!response.ok) this.health.recordSuccess(HEALTH_PROVIDER_ID);
    return response;
  }

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

  private pageHeaders(extra: Record<string, string> = {}): HeadersInit {
    return {
      accept: "application/json",
      origin: LSE_ORIGIN,
      referer: `${LSE_ORIGIN}/`,
      ...extra,
    };
  }

  /** `AGGU` -> `AGGU.L`; an already-qualified RIC (contains a dot) is kept. */
  private toRic(symbol: string): string {
    const trimmed = symbol.trim().toUpperCase();
    return trimmed.includes(".") ? trimmed : `${trimmed}.L`;
  }

  /**
   * A valid financial.com session JWT, minted through the SAML chain and cached
   * until shortly before it expires. `null` when the chain could not complete,
   * which the callers treat as "no answer" rather than an error.
   */
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
      const samlResponse = await this.request(
        `${LseFinanceService.PAGE_API}/api/gw/feedhandler/token/saml`,
        { headers: this.pageHeaders() },
      );
      if (!samlResponse.ok) {
        this.logger.warn(
          `LSE SAML token request returned ${samlResponse.status}`,
        );
        return null;
      }
      const saml = await this.readBody<{ encodedToken?: string }>(samlResponse);
      const encodedToken = saml.encodedToken;
      if (!encodedToken) return null;

      const login = await this.request(
        `${LseFinanceService.WIDGET_API}/auth/api/v1/sessions/samllogin?fetchToken=true`,
        {
          method: "POST",
          headers: this.pageHeaders({
            "content-type": "application/x-www-form-urlencoded",
          }),
          body: `SAMLResponse=${encodeURIComponent(encodedToken)}`,
        },
      );
      if (!login.ok) {
        this.logger.warn(`financial.com SAML login returned ${login.status}`);
        return null;
      }
      const session = await this.readBody<{
        token?: string;
        expiresAt?: number;
      }>(login);
      if (!session.token) return null;

      this.token = session.token;
      // `expiresAt` is epoch seconds; without one, assume the observed ~5 min.
      this.tokenExpiresAt = session.expiresAt
        ? session.expiresAt * 1000
        : Date.now() + 300_000;
      return this.token;
    } catch (error) {
      this.health.logFailure(
        this.logger,
        HEALTH_PROVIDER_ID,
        "LSE session token",
        error,
      );
      return null;
    }
  }

  /** The instrument master record for a TIDM, cached briefly. */
  private async fetchInstrument(symbol: string): Promise<LseInstrument | null> {
    const tidm = symbol.trim().toUpperCase();
    const cached = this.instrumentCache.get(tidm);
    if (cached && Date.now() < cached.expiresAt) return cached.value;

    let value: LseInstrument | null = null;
    try {
      const response = await this.request(
        `${LseFinanceService.PAGE_API}/api/gw/lse/instruments/alldata/${encodeURIComponent(tidm)}`,
        { headers: this.pageHeaders() },
      );
      if (response.ok) {
        const data = await this.readBody<Record<string, unknown>>(response);
        value = this.parseInstrument(tidm, data);
      } else if (response.status !== 404) {
        this.logger.warn(
          `LSE instrument data for ${tidm} returned ${response.status}`,
        );
      }
    } catch (error) {
      this.health.logFailure(
        this.logger,
        HEALTH_PROVIDER_ID,
        `LSE instrument data for ${tidm}`,
        error,
      );
      value = null;
    }
    this.instrumentCache.set(tidm, {
      value,
      expiresAt: Date.now() + INSTRUMENT_CACHE_TTL_MS,
    });
    return value;
  }

  private parseInstrument(
    tidm: string,
    data: Record<string, unknown>,
  ): LseInstrument | null {
    if (!data || typeof data !== "object") return null;
    const num = (v: unknown): number | null =>
      v == null || v === "" || isNaN(Number(v)) ? null : Number(v);
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.trim() ? v : null;
    return {
      tidm,
      isin: str(data.isin),
      name: str(data.description) ?? str(data.name),
      currency: str(data.currency),
      market: str(data.market),
      instrumenttype: str(data.instrumenttype),
      lastprice: num(data.lastprice),
      openingprice: num(data.openingprice),
      high: num(data.high),
      low: num(data.low),
      volume: num(data.volume),
      lastvolume: num(data.lastvolume),
      lastpricedate: str(data.lastpricedate),
    };
  }

  async fetchQuote(
    symbol: string,
    _exchange: string | null = null,
    _opts?: QuoteProviderOptions,
  ): Promise<QuoteResult | null> {
    const instrument = await this.fetchInstrument(symbol);
    if (!instrument || instrument.lastprice == null) return null;

    const gbx = isGbxCurrency(instrument.currency);
    const price = (v: number | null): number | undefined =>
      v == null ? undefined : gbx ? convertGbxToGbp(v) : v;
    // An unparseable date must not become a NaN epoch that then corrupts
    // quoted_at and the derived trading date; only a real timestamp is used.
    const parsedTime = instrument.lastpricedate
      ? new Date(instrument.lastpricedate).getTime()
      : NaN;
    const time = Number.isFinite(parsedTime)
      ? Math.floor(parsedTime / 1000)
      : undefined;

    return {
      symbol: instrument.tidm,
      regularMarketPrice: price(instrument.lastprice),
      regularMarketOpen: price(instrument.openingprice),
      regularMarketDayHigh: price(instrument.high),
      regularMarketDayLow: price(instrument.low),
      regularMarketVolume:
        instrument.volume ?? instrument.lastvolume ?? undefined,
      regularMarketTime: time,
      exchangeTimezone: LSE_TIMEZONE,
      regularSession: null,
      provider: "lse",
      currencyCode: instrument.currency
        ? gbx
          ? "GBP"
          : instrument.currency
        : null,
    };
  }

  async fetchHistoricalSeries(
    symbol: string,
    exchange: string | null = null,
    range: string = "max",
    opts?: QuoteProviderOptions,
  ): Promise<HistoricalSeries | null> {
    const toDate = new Date();
    const fromDate = rangeToStartDate(range, toDate);
    return this.fetchHistoricalWindowSeries(
      symbol,
      exchange,
      fromDate,
      toDate,
      opts,
    );
  }

  async fetchHistoricalWindowSeries(
    symbol: string,
    _exchange: string | null,
    fromDate: Date,
    toDate: Date,
    _opts?: QuoteProviderOptions,
  ): Promise<HistoricalSeries | null> {
    const token = await this.ensureToken();
    if (!token) return null;

    const ric = this.toRic(symbol);
    const params = new URLSearchParams({
      ric,
      fromDate: toYmd(fromDate),
      toDate: toYmd(toDate),
      fids: TIMESERIES_FIDS,
      samples: "D",
      appendRecentData: "all",
    });

    let rows: LseTimeseriesRow[];
    try {
      const response = await this.request(
        `${LseFinanceService.WIDGET_API}/rest/api/timeseries/historical?${params.toString()}`,
        { headers: this.pageHeaders({ jwt: token }) },
      );
      if (!response.ok) {
        // A 401/403 means the session lapsed between mint and use; drop it so
        // the next call re-mints, and report no answer for this one.
        if (response.status === 401 || response.status === 403) {
          this.token = null;
        }
        this.logger.warn(
          `LSE timeseries for ${ric} returned ${response.status}`,
        );
        return null;
      }
      const body = await this.readBody<{
        data?: LseTimeseriesRow[];
        status?: string;
      }>(response);
      rows = Array.isArray(body.data) ? body.data : [];
    } catch (error) {
      this.health.logFailure(
        this.logger,
        HEALTH_PROVIDER_ID,
        `LSE historical prices for ${ric}`,
        error,
      );
      return null;
    }

    // The currency the bars are in is the instrument's own, read separately.
    // Without it we cannot tell pence from pounds, so a GBX series would be
    // stored 100x too large; withhold the whole answer rather than guess, and
    // the caller keeps its previous data. (An unverifiable currency is a
    // different, safe outcome only when the numbers are already in one unit.)
    const instrument = await this.fetchInstrument(symbol);
    if (!instrument?.currency) {
      this.logger.warn(
        `LSE currency unknown for ${ric}; withholding historical series`,
      );
      return null;
    }
    const gbx = isGbxCurrency(instrument.currency);
    const currencyCode = gbx ? "GBP" : instrument.currency;

    const prices: HistoricalPrice[] = [];
    for (const row of rows) {
      const close = parsePrice(row.CLOSE_PRC);
      // A "-" (or blank) close is the widget's way of saying the session had no
      // trade -- a holiday or a halt. It is not a zero; the bar is skipped.
      if (close == null || !row._DATE_END) continue;
      const conv = (v: number | null): number | null =>
        v == null ? null : gbx ? convertGbxToGbp(v) : v;
      prices.push({
        date: new Date(`${row._DATE_END}T00:00:00.000Z`),
        open: conv(parsePrice(row.OPEN_PRC)),
        high: conv(parsePrice(row.HIGH_1)),
        low: conv(parsePrice(row.LOW_1)),
        close: gbx ? convertGbxToGbp(close) : close,
        adjClose: null,
        volume: null,
      });
    }

    return {
      prices,
      currencyCode,
      symbol: instrument?.tidm ?? symbol.trim().toUpperCase(),
      exchange: instrument?.market ?? "LSE",
    };
  }

  /**
   * The LSE search autocomplete matches a query by ISIN, TIDM or name and
   * returns the listings it finds; only the real LSE lines (`islse`) are kept,
   * so a Turquoise or venue-mirror entry does not masquerade as the main-market
   * listing. Each kept listing is enriched with its master record so the
   * candidate carries a currency.
   */
  async lookupSecurityMany(
    query: string,
    _preferredExchanges?: string[],
  ): Promise<SecurityLookupResult[]> {
    const instruments = await this.autocomplete(query);
    const results: SecurityLookupResult[] = [];
    for (const inst of instruments) {
      if (inst.islse !== true || !inst.tidm) continue;
      const detail = await this.fetchInstrument(inst.tidm);
      const gbx = isGbxCurrency(detail?.currency);
      results.push({
        symbol: inst.tidm,
        name: detail?.name ?? inst.description ?? inst.tidm,
        exchange: detail?.market ?? "LSE",
        securityType: detail?.instrumenttype ?? null,
        currencyCode: detail?.currency ? (gbx ? "GBP" : detail.currency) : null,
        provider: "lse",
      });
    }
    return results;
  }

  async lookupSecurity(
    query: string,
    preferredExchanges?: string[],
  ): Promise<SecurityLookupResult | null> {
    const many = await this.lookupSecurityMany(query, preferredExchanges);
    if (many.length > 0) return many[0];

    // Nothing from search: treat the query as a bare TIDM (the pre-search path).
    const instrument = await this.fetchInstrument(query);
    if (!instrument) return null;
    const gbx = isGbxCurrency(instrument.currency);
    return {
      symbol: instrument.tidm,
      name: instrument.name ?? instrument.tidm,
      exchange: instrument.market ?? "LSE",
      securityType: instrument.instrumenttype,
      currencyCode: instrument.currency
        ? gbx
          ? "GBP"
          : instrument.currency
        : null,
      provider: "lse",
    };
  }

  /** LSE search autocomplete: instruments matching an ISIN, TIDM or name. */
  private async autocomplete(
    query: string,
  ): Promise<LseAutocompleteInstrument[]> {
    const q = query.trim();
    if (!q) return [];
    try {
      const response = await this.request(
        `${LseFinanceService.PAGE_API}/api/gw/lse/search/autocomplete?q=${encodeURIComponent(q)}&size=5`,
        { headers: this.pageHeaders() },
      );
      if (!response.ok) return [];
      const body = await this.readBody<{
        instruments?: LseAutocompleteInstrument[];
      }>(response);
      return Array.isArray(body.instruments) ? body.instruments : [];
    } catch (error) {
      this.health.logFailure(
        this.logger,
        HEALTH_PROVIDER_ID,
        `LSE search for ${q}`,
        error,
      );
      return [];
    }
  }

  /**
   * The instrument master exposes only numeric ICB codes, not readable sector
   * names, so sector information is left to another provider.
   */
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

/** `Date` -> `YYYY-MM-DD` in UTC, the form the timeseries endpoint expects. */
function toYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A widget price string (`"5.874"`, `"-"`, `""`) to a number or null. */
function parsePrice(value: string | undefined): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return null;
  const n = Number(trimmed);
  return isNaN(n) ? null : n;
}
