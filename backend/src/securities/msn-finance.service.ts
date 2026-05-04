import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { isGbxCurrency, convertGbxToGbp } from "../common/gbx-currency.util";
import {
  QuoteProvider,
  QuoteProviderName,
  QuoteProviderOptions,
  QuoteResult,
  HistoricalPrice,
  SecurityLookupResult,
  StockSectorInfo,
  EtfSectorWeighting,
} from "./providers/quote-provider.interface";
import { getTradingDateFromQuote } from "./providers/trading-date.util";

// MSN / Bing Finance API endpoints. The autosuggest and Quotes endpoints are
// the same ones MSMoneyQuotes.exe uses (reverse-engineered from the v3.0
// binary, 2023-09-17). Chart-timeseries and stockdetails-page URLs are kept
// as best-effort fallbacks.
const AUTOSUGGEST_URL =
  "https://services.bingapis.com/contentservices-finance.csautosuggest/api/v1/Query";
/** Live quote endpoint (returns OHLC + last price for one or more SecIds). */
const QUOTES_URL = "https://assets.msn.com/service/Finance/Quotes";
const CHART_URL = "https://assets.msn.com/service/Finance/Charts/timeseries";
const STOCK_DETAILS_PAGE = "https://www.msn.com/en-us/money/stockdetails";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REFERER = "https://www.msn.com/en-us/money";
const FETCH_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_SIZE = 500;

// Monize exchange name → MSN ISO MIC / exchange code.
const EXCHANGE_TO_MSN: Record<string, string> = {
  NASDAQ: "XNAS",
  NYSE: "XNYS",
  AMEX: "XASE",
  ARCA: "ARCX",
  TSX: "XTSE",
  TSE: "XTSE",
  "TSX-V": "XTSX",
  TSXV: "XTSX",
  CSE: "XCNQ",
  NEO: "NEOE",
  LSE: "XLON",
  LONDON: "XLON",
  ASX: "XASX",
  FRANKFURT: "XFRA",
  XETRA: "XETR",
  PARIS: "XPAR",
  TOKYO: "XTKS",
  HKEX: "XHKG",
  "HONG KONG": "XHKG",
};

// Exchanges that are served by the Canadian MSN market.
const CANADIAN_EXCHANGES = new Set([
  "TSX",
  "TSE",
  "TSX-V",
  "TSXV",
  "CSE",
  "NEO",
]);

interface CacheEntry {
  id: string | null;
  expiresAt: number;
}

interface AutosuggestItem {
  // Bing Finance autosuggest uses inconsistent casing across endpoints, so
  // accept every realistic variant and normalise via getField below.
  Symbol?: string;
  symbol?: string;
  TradingSymbol?: string;
  tradingSymbol?: string;
  SecId?: string;
  secId?: string;
  Name?: string;
  name?: string;
  DisplayName?: string;
  displayName?: string;
  ShortName?: string;
  shortName?: string;
  LongName?: string;
  longName?: string;
  Description?: string;
  description?: string;
  Exchange?: string;
  exchange?: string;
  ExchangeId?: string;
  exchangeId?: string;
  Mic?: string;
  mic?: string;
  ExchangeName?: string;
  exchangeName?: string;
  SecurityType?: string;
  securityType?: string;
  Type?: string;
  type?: string;
  InstrumentType?: string;
  instrumentType?: string;
  Currency?: string;
  currency?: string;
  CurrencyCode?: string;
  currencyCode?: string;

  // MSN Finance's internal short-coded fields. These are what Bing actually
  // returns for mutual fund / equity autosuggest payloads (each stock item
  // is a stringified JSON blob in the response; keys are abbreviations).
  //   OS001    → the ticker / fund code (e.g. "AAPL", "BMO692")
  //   OS01W    → display/short name
  //   OS0LN    → long / full name
  //   RT0SN    → also the display name in some responses
  //   FullInstrument → the MSN Financial Instrument ID (used as SecId)
  OS001?: string;
  OS01W?: string;
  OS0LN?: string;
  RT0SN?: string;
  FullInstrument?: string;

  // Catch-all for unknown MSN field codes so TypeScript lets us index into
  // the raw item.
  [key: string]: string | undefined;
}

/**
 * Like getField but skips values equal to the item's ticker symbol. Needed
 * because MSN's `DisplayName` is sometimes populated with the ticker for
 * mutual funds — returning it unfiltered would make Name == Symbol in the UI.
 */
function pickNameCandidate(
  item: AutosuggestItem,
  candidates: string[],
  symbolUp: string | undefined,
): string | undefined {
  for (const key of candidates) {
    const val = item[key];
    if (typeof val !== "string") continue;
    const trimmed = val.trim();
    if (!trimmed) continue;
    if (symbolUp && trimmed.toUpperCase() === symbolUp) continue;
    return trimmed;
  }
  return undefined;
}

/**
 * Last-resort name extractor: pick a non-index, non-symbol string field that
 * looks like a proper company/fund name.
 *
 * Heuristics, in order of preference:
 *   1. Contains a space and is 4–80 chars (most company/fund names).
 *   2. Begins with a capital letter AND is 4–80 chars.
 *   3. Any non-code string value.
 *
 * Very long strings (>150 chars) are always rejected — those are descriptions
 * or disclaimer text, never a name.
 */
function findLongestNameField(
  item: AutosuggestItem,
  symbol: string | null | undefined,
  secId: string | null | undefined,
): string | undefined {
  const looksLikeCompanyName = (s: string): boolean =>
    /\s/.test(s) && s.length >= 4 && s.length <= 80;
  const looksLikeProperNoun = (s: string): boolean =>
    /^[A-Z]/.test(s) && s.length >= 4 && s.length <= 80;

  let spaceCandidate: string | undefined;
  let properCandidate: string | undefined;
  let anyCandidate: string | undefined;

  for (const key of Object.keys(item)) {
    if (/Index$/i.test(key)) continue;
    const val = item[key];
    if (typeof val !== "string") continue;
    const trimmed = val.trim();
    if (!trimmed || trimmed.length > 150) continue;
    if (symbol && trimmed === symbol) continue;
    if (secId && trimmed === secId) continue;
    // Skip short codes (< 4 chars) and lowercase-only ones (search indices).
    if (trimmed.length < 4) continue;

    if (looksLikeCompanyName(trimmed)) {
      if (!spaceCandidate || trimmed.length < spaceCandidate.length) {
        spaceCandidate = trimmed;
      }
    } else if (looksLikeProperNoun(trimmed)) {
      if (!properCandidate || trimmed.length < properCandidate.length) {
        properCandidate = trimmed;
      }
    } else if (!anyCandidate) {
      anyCandidate = trimmed;
    }
  }
  return spaceCandidate || properCandidate || anyCandidate;
}

/**
 * MSN's autosuggest returns each stock as a stringified JSON blob. Normalise
 * so every element is an object.
 */
function normaliseStocks(raw: unknown): AutosuggestItem[] {
  if (!Array.isArray(raw)) return [];
  const out: AutosuggestItem[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object") {
      out.push(entry as AutosuggestItem);
    } else if (typeof entry === "string") {
      try {
        const parsed = JSON.parse(entry);
        if (parsed && typeof parsed === "object") {
          out.push(parsed as AutosuggestItem);
        }
      } catch {
        // skip unparseable entries
      }
    }
  }
  return out;
}

function getField(
  item: AutosuggestItem,
  ...candidates: (keyof AutosuggestItem)[]
): string | undefined {
  for (const key of candidates) {
    const val = item[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return undefined;
}

@Injectable()
export class MsnFinanceService implements QuoteProvider {
  readonly name: QuoteProviderName = "msn";

  private readonly logger = new Logger(MsnFinanceService.name);

  private readonly instrumentIdCache = new Map<string, CacheEntry>();

  /**
   * API key for the Quotes endpoint. Required: set via the MSN_API_KEY env
   * var. When unset, fetchQuote skips the Quotes endpoint and falls through
   * to the chart-timeseries fallback.
   */
  private readonly apiKey: string | null;

  constructor(@Optional() configService?: ConfigService) {
    const fromEnv = configService?.get<string>("MSN_API_KEY")?.trim();
    this.apiKey = fromEnv && fromEnv.length > 0 ? fromEnv : null;
    if (!this.apiKey) {
      this.logger.error(
        "MSN_API_KEY env var is not set. The MSN Quotes endpoint requires " +
          "this key — live MSN quotes will fail until it is configured. " +
          "Set MSN_API_KEY in your environment to enable.",
      );
    } else {
      this.logger.log("MSN_API_KEY loaded from environment.");
    }
  }

  /** Whether MSN_API_KEY is configured. Used by the UI to surface a hint. */
  isApiKeyConfigured(): boolean {
    return !!this.apiKey;
  }

  // ─── Cache helpers ────────────────────────────────────────────────────────

  private cacheKey(
    symbol: string,
    exchange: string | null,
    preferredExchanges?: string[],
  ): string {
    // Preferred-exchange preferences are part of the cache key so that a user
    // whose top pick is TSX doesn't inherit a cached SecId resolved against
    // NYSE by another user's request.
    const prefs = (preferredExchanges || [])
      .slice(0, 3)
      .map((e) => e.toUpperCase())
      .join(",");
    return `${symbol.toUpperCase()}|${(exchange || "").toUpperCase()}|${prefs}`;
  }

  private getCached(key: string): CacheEntry | null {
    const entry = this.instrumentIdCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.instrumentIdCache.delete(key);
      return null;
    }
    return entry;
  }

  private setCached(key: string, id: string | null): void {
    if (this.instrumentIdCache.size >= CACHE_MAX_SIZE) {
      const oldestKey = this.instrumentIdCache.keys().next().value;
      if (oldestKey) this.instrumentIdCache.delete(oldestKey);
    }
    this.instrumentIdCache.set(key, {
      id,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }

  // ─── HTTP helper ──────────────────────────────────────────────────────────

  private async httpGetJson<T>(
    url: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<T | null> {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Referer: REFERER,
          Accept: "application/json",
          ...extraHeaders,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`MSN Finance GET ${url} returned ${response.status}`);
        return null;
      }
      return (await response.json()) as T;
    } catch (error) {
      this.logger.warn(
        `MSN Finance GET ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  // ─── Instrument ID resolution ─────────────────────────────────────────────

  async resolveInstrumentId(
    symbol: string,
    exchange: string | null,
    preferredExchanges?: string[],
  ): Promise<string | null> {
    const key = this.cacheKey(symbol, exchange, preferredExchanges);
    const cached = this.getCached(key);
    if (cached) return cached.id;

    const markets = this.marketOrderFor(exchange, preferredExchanges);

    for (const market of markets) {
      const id = await this.queryAutosuggest(
        symbol,
        exchange,
        market,
        preferredExchanges,
      );
      if (id) {
        this.setCached(key, id);
        return id;
      }
    }

    this.setCached(key, null);
    return null;
  }

  /**
   * Decide which MSN market (en-us / en-ca) to hit first for autosuggest.
   * Canada wins if the security's exchange or the user's top preferred exchange
   * is a Canadian one; otherwise en-us is tried first.
   */
  private marketOrderFor(
    exchange: string | null,
    preferredExchanges: string[] | undefined,
  ): string[] {
    const canadianFromExchange =
      exchange && CANADIAN_EXCHANGES.has(exchange.toUpperCase());
    const topPref = preferredExchanges?.[0]?.toUpperCase();
    const canadianFromPref = topPref ? CANADIAN_EXCHANGES.has(topPref) : false;

    return canadianFromExchange || canadianFromPref
      ? ["en-ca", "en-us"]
      : ["en-us", "en-ca"];
  }

  private async queryAutosuggest(
    query: string,
    exchange: string | null,
    market: string,
    preferredExchanges?: string[],
  ): Promise<string | null> {
    const url = `${AUTOSUGGEST_URL}?query=${encodeURIComponent(query)}&market=${encodeURIComponent(market)}&count=5`;
    const data = await this.httpGetJson<{
      data?: { stocks?: unknown };
    }>(url);
    const stocks = normaliseStocks(data?.data?.stocks);
    if (stocks.length === 0) return null;

    const match = this.pickBestStock(
      stocks,
      query,
      exchange,
      preferredExchanges,
    );
    return match
      ? getField(match, "SecId", "secId", "FullInstrument") || null
      : null;
  }

  private pickBestStock(
    stocks: AutosuggestItem[],
    query: string,
    exchange: string | null,
    preferredExchanges?: string[],
  ): AutosuggestItem | null {
    const upperQuery = query.toUpperCase().trim();

    const symbolOf = (s: AutosuggestItem) =>
      (
        getField(
          s,
          "Symbol",
          "symbol",
          "TradingSymbol",
          "tradingSymbol",
          "OS001",
        ) || ""
      ).toUpperCase();
    const exchangeOf = (s: AutosuggestItem) =>
      (
        getField(
          s,
          "Exchange",
          "exchange",
          "Mic",
          "mic",
          "ExchangeId",
          "exchangeId",
        ) || ""
      ).toUpperCase();

    const exactSymbol = stocks.filter((s) => symbolOf(s) === upperQuery);
    const pool = exactSymbol.length > 0 ? exactSymbol : stocks;

    // 1. Direct exchange match (security's stored exchange wins).
    const targetExchange = exchange
      ? EXCHANGE_TO_MSN[exchange.toUpperCase()]
      : null;
    if (targetExchange) {
      const exchangeMatch = pool.find((s) => exchangeOf(s) === targetExchange);
      if (exchangeMatch) return exchangeMatch;
    }

    // 2. User's preferred exchanges, in priority order.
    if (preferredExchanges && preferredExchanges.length > 0) {
      for (const pref of preferredExchanges) {
        const mapped = EXCHANGE_TO_MSN[pref.toUpperCase()];
        if (!mapped) continue;
        const prefMatch = pool.find((s) => exchangeOf(s) === mapped);
        if (prefMatch) return prefMatch;
      }
    }

    return pool[0] || null;
  }

  // ─── Security lookup ──────────────────────────────────────────────────────

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
    // Query each market in priority order until we get results. For a user
    // whose top preferred exchange is Canadian, MSN's Canadian market yields
    // far better coverage of Canadian mutual funds than en-us does.
    const markets = this.marketOrderFor(null, preferredExchanges);
    let stocks: AutosuggestItem[] = [];
    for (const market of markets) {
      const url = `${AUTOSUGGEST_URL}?query=${encodeURIComponent(query)}&market=${encodeURIComponent(market)}&count=50`;
      const data = await this.httpGetJson<{
        data?: { stocks?: unknown };
      }>(url);
      const m = normaliseStocks(data?.data?.stocks);
      if (m.length > 0) {
        stocks = m;
        break;
      }
    }
    if (stocks.length === 0) return [];

    const sorted = [...stocks].sort((a, b) => {
      const ea = getField(a, "Exchange", "exchange", "Mic", "mic");
      const eb = getField(b, "Exchange", "exchange", "Mic", "mic");
      const pa = this.preferredExchangePriority(ea, preferredExchanges);
      const pb = this.preferredExchangePriority(eb, preferredExchanges);
      return pa - pb;
    });

    // Surface what Bing returned so operators can extend candidate lists if
    // MSN changes their field names. Log the first item's keys AND values so
    // unfamiliar field codes are easy to identify from a single log line.
    if (sorted[0]) {
      this.logger.log(
        `MSN lookup "${query}" found ${sorted.length} raw match(es); first item body=${JSON.stringify(sorted[0]).slice(0, 1500)}`,
      );
    }

    const results: SecurityLookupResult[] = [];
    for (const item of sorted) {
      const converted = this.itemToLookupResult(item, preferredExchanges);
      if (converted) results.push(converted);
    }
    return results;
  }

  /**
   * Map one autosuggest entry to a SecurityLookupResult. Returns null when
   * the entry has neither a symbol-ish nor an instrument-id field — such
   * entries would pollute the UI (e.g. ticker = upper-cased query).
   */
  private itemToLookupResult(
    item: AutosuggestItem,
    preferredExchanges: string[] | undefined,
  ): SecurityLookupResult | null {
    const extractedSymbol = (
      getField(
        item,
        "Symbol",
        "symbol",
        "TradingSymbol",
        "tradingSymbol",
        "OS001",
      ) || ""
    ).toUpperCase();
    // SecId (short form, e.g. "a1xzim" / "bb36yc") is what MSN's Quotes
    // endpoint expects. FullInstrument (e.g. "F18068765888") is a different
    // identifier MSN uses internally and the Quotes endpoint 404s on it.
    // Prefer SecId; fall back to FullInstrument only if SecId is absent.
    const extractedSecId = getField(item, "SecId", "secId", "FullInstrument");

    if (!extractedSymbol && !extractedSecId) return null;

    const symbol = extractedSymbol || "";
    if (extractedSecId && symbol) {
      this.setCached(
        this.cacheKey(symbol, null, preferredExchanges),
        extractedSecId,
      );
    }

    const rawExchange = getField(
      item,
      "Exchange",
      "exchange",
      "Mic",
      "mic",
      "MicCode",
      "micCode",
      "ExchangeId",
      "exchangeId",
      "ExchangeCode",
      "exchangeCode",
      "ExchangeName",
      "exchangeName",
      "Market",
      "market",
      "MarketCode",
      "marketCode",
      "MarketIdentifier",
      "marketIdentifier",
      "MarketIdentifierCode",
      "marketIdentifierCode",
      "Venue",
      "venue",
      "TradingVenue",
      "tradingVenue",
      "CP", // MSN country/venue plate observed in responses
      "cp",
      "PrimaryExchange",
      "primaryExchange",
    );
    const exchange =
      this.mapMsnExchangeToMonize(rawExchange) || this.scanExchangeCode(item);

    // Name candidates. Ordering matters: MSN's `DisplayName` is unreliable
    // for mutual funds (it's often the *ticker* like "TDB164", not the
    // name), so it's deferred to last and gated to values that aren't the
    // symbol. OS0LN / OS01W / RT0SN consistently hold the full fund name.
    const SYMBOL_UP = extractedSymbol;
    const namePickOrder: string[] = [
      // MSN-encoded full-name fields (observed in responses):
      "OS0LN", // long name
      "OS01W", // short / display name
      "RT0SN", // fund name variant
      // Standard Bing / MSN name fields:
      "LongName",
      "longName",
      "CompanyName",
      "companyName",
      "FullName",
      "fullName",
      "LegalName",
      "legalName",
      "Name",
      "name",
      "ShortName",
      "shortName",
      "Title",
      "title",
      // Fund-abbreviation fields:
      "FriendlyName",
      "friendlyName",
      "AC042",
      "OS0F",
      "OS0FN",
      // DisplayName last, and even then only if it isn't the ticker.
      "DisplayName",
      "displayName",
    ];
    const namedName = pickNameCandidate(item, namePickOrder, SYMBOL_UP);
    // Last-resort: MSN occasionally returns the full name only under a
    // previously-unseen short-coded field. If none of the named candidates
    // hit, pick the longest string value in the item that isn't the
    // ticker, SecId, or a lowercase search index. Names are reliably
    // longer than symbols / codes, so this heuristic is safe.
    const fallbackName = namedName
      ? undefined
      : findLongestNameField(item, symbol, extractedSecId);
    if (!namedName) {
      this.logger.warn(
        `MSN lookup item has no named-candidate name; symbol=${symbol}, fallback=${fallbackName || "(none)"}. Keys=[${Object.keys(item).join(",")}]`,
      );
    }
    const name = namedName || fallbackName || symbol;

    const securityTypeRaw = getField(
      item,
      "SecurityType",
      "securityType",
      "InstrumentType",
      "instrumentType",
      "Type",
      "type",
      "AssetType",
      "assetType",
      "Kind",
      "kind",
      "Category",
      "category",
      "Class",
      "class",
      "OS010", // MSN 2-letter instrument code (observed: FO = fund, ST = stock)
      "os010",
      "OS0IT",
      "os0IT",
    );

    const currency =
      getField(
        item,
        "Currency",
        "currency",
        "CurrencyCode",
        "currencyCode",
        "IsoCurrency",
        "isoCurrency",
        "TradingCurrency",
        "tradingCurrency",
        "BaseCurrency",
        "baseCurrency",
        "CUR",
        "cur",
        "OS0AP",
      ) ||
      // Fund entries often lack an explicit currency field but mark the
      // country with RT0EC / LS01Z / ExMicCode / locale. Infer from there.
      this.currencyFromCountryCode(item);

    return {
      symbol,
      name,
      exchange,
      securityType: this.mapMsnSecurityType(securityTypeRaw),
      currencyCode: currency || this.currencyFromExchange(exchange),
      provider: "msn",
      msnInstrumentId: extractedSecId || null,
    };
  }

  private preferredExchangePriority(
    msnExchange: string | undefined,
    preferred?: string[],
  ): number {
    if (!preferred || preferred.length === 0) return 0;
    if (!msnExchange) return preferred.length;
    const upper = msnExchange.toUpperCase();
    for (let i = 0; i < preferred.length; i++) {
      const expected = EXCHANGE_TO_MSN[preferred[i].toUpperCase()];
      if (expected && expected === upper) return i;
    }
    return preferred.length;
  }

  private mapMsnExchangeToMonize(
    msnExchange: string | undefined,
  ): string | null {
    if (!msnExchange) return null;
    const upper = msnExchange.toUpperCase();
    for (const [monize, msn] of Object.entries(EXCHANGE_TO_MSN)) {
      if (msn === upper) return monize;
    }
    return msnExchange;
  }

  /**
   * Last-resort exchange scan: look for any string value in the item that
   * matches a known MIC code (e.g. "XNAS", "XNYS", "XTSE"). Skips keys that
   * would obviously hold a ticker, SecId, name, or currency.
   */
  private scanExchangeCode(item: AutosuggestItem): string | null {
    const skip =
      /symbol|ticker|name|display|title|description|currency|type|kind|class|asset|short|long|id|sec/i;
    for (const [key, val] of Object.entries(item)) {
      if (skip.test(key)) continue;
      if (typeof val !== "string") continue;
      const trimmed = val.trim().toUpperCase();
      if (!/^X[A-Z]{3}$|^[A-Z]{4}$/.test(trimmed)) continue;
      const monize = this.mapMsnExchangeToMonize(trimmed);
      if (monize) return monize;
    }
    return null;
  }

  /**
   * Infer a trading currency from MSN's country-code fields when no explicit
   * currency field is populated (common for mutual fund entries).
   */
  private currencyFromCountryCode(item: AutosuggestItem): string | null {
    const code = (
      getField(
        item,
        "RT0EC",
        "LS01Z",
        "ExMicCode",
        "CountryCode",
        "countryCode",
      ) || ""
    ).toUpperCase();
    if (!code) {
      // `locale: "en-ca"` / "en-us" is a last resort.
      const locale = (getField(item, "locale", "Locale") || "").toUpperCase();
      const m = locale.match(/-([A-Z]{2})$/);
      if (!m) return null;
      return this.countryToCurrency(m[1]);
    }
    return this.countryToCurrency(code);
  }

  private countryToCurrency(country: string): string | null {
    const map: Record<string, string> = {
      CA: "CAD",
      US: "USD",
      GB: "GBP",
      UK: "GBP",
      AU: "AUD",
      DE: "EUR",
      FR: "EUR",
      IT: "EUR",
      ES: "EUR",
      NL: "EUR",
      JP: "JPY",
      HK: "HKD",
      CH: "CHF",
      SE: "SEK",
      NO: "NOK",
      DK: "DKK",
    };
    return map[country.toUpperCase()] || null;
  }

  private mapMsnSecurityType(msnType: string | undefined): string | null {
    if (!msnType) return null;
    const t = msnType.toUpperCase().trim();
    // MSN's 2-letter instrument codes observed in OS010:
    if (t === "FO") return "MUTUAL_FUND"; // open-end fund
    if (t === "ST") return "STOCK";
    if (t === "IX") return null; // index (not a holdable security)
    // ETF before MUTUAL_FUND because "exchange-traded fund" includes "fund".
    if (
      t.includes("ETF") ||
      t === "EXCHANGE TRADED FUND" ||
      t === "EXCHANGE-TRADED FUND" ||
      t.includes("ETP")
    ) {
      return "ETF";
    }
    if (t.includes("MUTUAL") || t === "FUND" || t === "MF" || t === "OEF") {
      return "MUTUAL_FUND";
    }
    if (t.includes("BOND") || t.includes("FIXED INCOME")) return "BOND";
    if (t.includes("OPTION") || t === "OPT") return "OPTION";
    if (t.includes("CRYPT") || t === "DIGITAL CURRENCY") return "CRYPTO";
    if (
      t === "ST" ||
      t === "CS" || // common stock
      t === "PS" || // preferred stock
      t === "ADR" ||
      t.includes("STOCK") ||
      t.includes("EQUITY") ||
      t.includes("SHARE")
    ) {
      return "STOCK";
    }
    return null;
  }

  private currencyFromExchange(exchange: string | null): string | null {
    if (!exchange) return null;
    const map: Record<string, string> = {
      TSX: "CAD",
      "TSX-V": "CAD",
      TSXV: "CAD",
      CSE: "CAD",
      NEO: "CAD",
      LSE: "GBP",
      LONDON: "GBP",
      ASX: "AUD",
      FRANKFURT: "EUR",
      XETRA: "EUR",
      PARIS: "EUR",
      TOKYO: "JPY",
      HKEX: "HKD",
      "HONG KONG": "HKD",
    };
    return map[exchange.toUpperCase()] || "USD";
  }

  // ─── Quote fetch ─────────────────────────────────────────────────────────

  async fetchQuote(
    symbol: string,
    exchange: string | null,
    opts?: QuoteProviderOptions,
  ): Promise<QuoteResult | null> {
    this.logger.log(
      `MSN fetchQuote entered for ${symbol}/${exchange ?? "(none)"} (suppliedId=${opts?.instrumentId ?? "(none)"})`,
    );
    let instrumentId =
      opts?.instrumentId ||
      (await this.resolveInstrumentId(
        symbol,
        exchange,
        opts?.preferredExchanges,
      ));
    if (!instrumentId) {
      this.logger.warn(
        `MSN fetchQuote: no instrument id resolved for ${symbol}/${exchange ?? "(none)"}`,
      );
      return null;
    }

    // Pro-active upgrade: if the stored ID is in the FullInstrument form
    // (e.g. "F0CAN05MQP"), the Quotes endpoint will 404. Re-resolve via
    // autosuggest BEFORE the first call so we don't waste a round trip on
    // a known-bad request. The autosuggest result populates the SecId-style
    // short form (e.g. "a1xzim").
    if (looksLikeFullInstrument(instrumentId)) {
      this.logger.log(
        `MSN fetchQuote: stored id "${instrumentId}" looks like FullInstrument; re-resolving via autosuggest before calling Quotes`,
      );
      const refreshed = await this.resolveInstrumentId(
        symbol,
        exchange,
        opts?.preferredExchanges,
      );
      if (refreshed && refreshed !== instrumentId) {
        this.logger.log(
          `MSN fetchQuote: upgraded id ${instrumentId} → ${refreshed} for ${symbol}`,
        );
        instrumentId = refreshed;
      } else if (!refreshed) {
        this.logger.warn(
          `MSN fetchQuote: autosuggest returned no SecId for ${symbol}; will still try ${instrumentId}`,
        );
      }
    }

    this.logger.log(
      `MSN fetchQuote: using instrumentId=${instrumentId} for ${symbol}`,
    );

    // Strategy 1 — direct quote endpoint. May or may not work depending on
    // MSN's surface; if it does, prefer it because it carries open/high/low.
    const direct = await this.tryDirectQuote(instrumentId, symbol, opts);
    if (direct) {
      // Stamp the resolved id on the result so the caller can persist any
      // upgrade (FullInstrument → SecId) back to the Security row.
      direct.msnResolvedInstrumentId = instrumentId;
      return direct;
    }

    // Strategy 2 — fall back to the chart-timeseries endpoint with a short
    // range and use the most recent point. The chart endpoint is the same
    // one used by fetchHistorical, so if backfill works for an instrument,
    // on-demand refresh works too.
    const fromChart = await this.quoteFromChart(instrumentId, symbol, opts);
    if (fromChart) return fromChart;

    this.logger.warn(
      `MSN fetchQuote: no price data via direct or chart endpoints for ${symbol} (id=${instrumentId})`,
    );
    return null;
  }

  private async tryDirectQuote(
    instrumentId: string,
    symbol: string,
    opts: QuoteProviderOptions | undefined,
  ): Promise<QuoteResult | null> {
    if (!this.apiKey) {
      this.logger.error(
        `MSN Quotes skipped for ${symbol} (id=${instrumentId}): MSN_API_KEY env var is not set.`,
      );
      return null;
    }

    // Endpoint reverse-engineered from MSMoneyQuotes.exe v3.0. activityId is
    // a fresh GUID per request.
    const params = new URLSearchParams({
      apikey: this.apiKey,
      activityId: randomUUID(),
      ocid: "finance-utils-peregrine",
      cm: "en-us",
      it: "app",
      ids: instrumentId,
      wrapodata: "false",
    });
    const url = `${QUOTES_URL}?${params.toString()}`;
    const data = await this.httpGetJson<unknown>(url, {
      // MSMoneyQuotes.exe spoofs this exact User-Agent.
      "User-Agent": "FinanceWindows/4.29.10701",
    });

    // The response structure can be:
    //   [ { ...instrument fields... }, ... ]
    //   { stocks: [ ... ] }
    //   { data: [ { stocks: [ ... ] } ] }
    const instruments = extractMarketInstruments(data, instrumentId);
    if (!instruments.length) {
      this.logger.warn(
        `MSN Quotes for ${symbol} (id=${instrumentId}) returned no instruments. Body keys=${data && typeof data === "object" ? Object.keys(data as Record<string, unknown>).join(",") : "(no body)"}`,
      );
      return null;
    }
    const item = instruments[0];

    const price = parseNumberMaybe(item.price ?? item.Price ?? item.lastPrice);
    if (price == null || Number.isNaN(price)) {
      this.logger.warn(
        `MSN Quotes for ${symbol} (id=${instrumentId}) had no usable price; falling back to chart. Item keys=${Object.keys(item).join(",")}`,
      );
      return null;
    }

    const open = parseNumberMaybe(
      item.priceDayOpen ?? item.PriceDayOpen ?? item.Open ?? item.open,
    );
    const high = parseNumberMaybe(
      item.priceDayHigh ?? item.PriceDayHigh ?? item.High ?? item.high,
    );
    const low = parseNumberMaybe(
      item.priceDayLow ?? item.PriceDayLow ?? item.Low ?? item.low,
    );
    const volume = parseNumberMaybe(
      item.accumulatedVolume ??
        item.AccumulatedVolume ??
        item.Volume ??
        item.volume,
    );
    const currency = (item.currency ?? item.Currency ?? undefined) as
      | string
      | undefined;
    const time =
      typeof item.timeLastTraded === "string"
        ? Math.floor(Date.parse(item.timeLastTraded) / 1000)
        : typeof item.timeLastUpdated === "string"
          ? Math.floor(Date.parse(item.timeLastUpdated) / 1000)
          : undefined;

    const shouldConvertGbx =
      isGbxCurrency(currency) ||
      (currency == null && isGbxCurrency(opts?.currencyCode ?? undefined));
    const convert = (v: number | undefined): number | undefined =>
      v !== undefined && shouldConvertGbx ? convertGbxToGbp(v) : v;

    this.logger.log(
      `MSN Quotes ${symbol} (id=${instrumentId}): price=${price} currency=${currency ?? "(none)"}`,
    );

    return {
      symbol: symbol.toUpperCase(),
      regularMarketPrice: convert(price),
      regularMarketOpen: convert(open),
      regularMarketDayHigh: convert(high),
      regularMarketDayLow: convert(low),
      regularMarketVolume: volume,
      regularMarketTime: time,
      provider: "msn",
    };
  }

  /**
   * Build a current-price QuoteResult by hitting the chart-timeseries endpoint
   * and reading the most recent OHLCV row. Same endpoint as fetchHistorical
   * so any instrument that backfills correctly also refreshes correctly.
   */
  private async quoteFromChart(
    instrumentId: string,
    symbol: string,
    opts: QuoteProviderOptions | undefined,
  ): Promise<QuoteResult | null> {
    const prices = await this.fetchHistorical(symbol, null, "5d", {
      ...opts,
      instrumentId,
    });
    if (!prices || prices.length === 0) return null;

    const latest = prices[prices.length - 1];
    if (latest.close == null || Number.isNaN(latest.close)) return null;

    this.logger.log(
      `MSN fetchQuote ${symbol} (id=${instrumentId}) via chart: close=${latest.close} on ${latest.date.toISOString().slice(0, 10)}`,
    );

    return {
      symbol: symbol.toUpperCase(),
      regularMarketPrice: latest.close,
      regularMarketOpen: latest.open ?? undefined,
      regularMarketDayHigh: latest.high ?? undefined,
      regularMarketDayLow: latest.low ?? undefined,
      regularMarketVolume: latest.volume ?? undefined,
      regularMarketTime: Math.floor(latest.date.getTime() / 1000),
      provider: "msn",
    };
  }

  // ─── Historical fetch ────────────────────────────────────────────────────

  async fetchHistorical(
    symbol: string,
    exchange: string | null,
    range: string = "max",
    opts?: QuoteProviderOptions,
  ): Promise<HistoricalPrice[] | null> {
    const instrumentId =
      opts?.instrumentId ||
      (await this.resolveInstrumentId(
        symbol,
        exchange,
        opts?.preferredExchanges,
      ));
    if (!instrumentId) return null;

    const msnRange = mapRangeToMsn(range);
    const url = `${CHART_URL}?id=${encodeURIComponent(instrumentId)}&ohlcv=true&timeFrame=${encodeURIComponent(msnRange)}`;
    const data = await this.httpGetJson<MsnChartResponse>(url);
    const series = data?.series || data?.Series || [];
    if (!Array.isArray(series) || series.length === 0) {
      this.logger.warn(
        `MSN fetchHistorical: empty series for ${symbol} (id=${instrumentId}, range=${msnRange}). Body keys=${data ? Object.keys(data).join(",") : "(no body)"}`,
      );
      return null;
    }
    this.logger.debug(
      `MSN fetchHistorical: ${series.length} point(s) for ${symbol} (range=${msnRange})`,
    );

    const currency = data?.currency || data?.Currency;
    const shouldConvertGbx =
      isGbxCurrency(currency) ||
      (currency == null && isGbxCurrency(opts?.currencyCode ?? undefined));
    const convert = (v: number | null | undefined): number | null => {
      if (v == null) return null;
      return shouldConvertGbx ? convertGbxToGbp(v) : v;
    };

    const prices: HistoricalPrice[] = [];
    for (const pt of series) {
      const close = pt.close ?? pt.Close;
      if (close == null || Number.isNaN(close)) continue;
      const tsRaw = pt.time ?? pt.Time ?? pt.date ?? pt.Date;
      const date = parseMsnDate(tsRaw);
      if (!date) continue;
      prices.push({
        date,
        open: convert(pt.open ?? pt.Open),
        high: convert(pt.high ?? pt.High),
        low: convert(pt.low ?? pt.Low),
        close: shouldConvertGbx ? convertGbxToGbp(close) : close,
        // MSN doesn't expose a dividend-adjusted close in the chart series.
        adjClose: null,
        volume: pt.volume ?? pt.Volume ?? null,
      });
    }

    prices.sort((a, b) => a.date.getTime() - b.date.getTime());
    return prices.length > 0 ? prices : null;
  }

  // ─── Sector / ETF data (best effort) ─────────────────────────────────────

  async fetchStockSectorInfo(
    symbol: string,
    exchange: string | null,
    opts?: QuoteProviderOptions,
  ): Promise<StockSectorInfo | null> {
    const instrumentId =
      opts?.instrumentId ||
      (await this.resolveInstrumentId(
        symbol,
        exchange,
        opts?.preferredExchanges,
      ));
    if (!instrumentId) return null;

    // Scrape the stockdetails page and read the embedded JSON. MSN's public
    // surface for sector data is limited and may not be available for all
    // security types.
    const url = `${STOCK_DETAILS_PAGE}/fi-${encodeURIComponent(instrumentId)}`;
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Referer: REFERER,
          Accept: "text/html",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const html = await response.text();
      const sector = matchInText(html, /"sector"\s*:\s*"([^"]+)"/i);
      const industry = matchInText(html, /"industry"\s*:\s*"([^"]+)"/i);
      if (!sector && !industry) return { sector: null, industry: null };
      return { sector, industry };
    } catch (error) {
      this.logger.warn(
        `MSN Finance sector fetch for ${symbol} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * MSN's public APIs do not expose ETF sector weightings in a stable shape.
   * Return null so the registry can fall back to Yahoo.
   */
  async fetchEtfSectorWeightings(): Promise<EtfSectorWeighting[] | null> {
    return null;
  }

  // ─── Utility methods ─────────────────────────────────────────────────────

  getTradingDate(quote: QuoteResult): Date {
    return getTradingDateFromQuote(quote);
  }
}

// ─── Pure helpers (not on the class so they can be unit-tested directly) ────

interface MsnQuoteItem {
  symbol?: string;
  Symbol?: string;
  price?: number;
  Price?: number;
  lastPrice?: number;
  LastPrice?: number;
  open?: number;
  Open?: number;
  regularMarketOpen?: number;
  dayHigh?: number;
  DayHigh?: number;
  high?: number;
  High?: number;
  dayLow?: number;
  DayLow?: number;
  low?: number;
  Low?: number;
  volume?: number;
  Volume?: number;
  currency?: string;
  Currency?: string;
  time?: number | string;
  Time?: number | string;
  lastTradeTime?: number | string;
  LastTradeTime?: number | string;
}

interface ExtractedQuote {
  symbol: string | undefined;
  price: number | undefined;
  open: number | undefined;
  high: number | undefined;
  low: number | undefined;
  volume: number | undefined;
  currency: string | undefined;
  time: number | undefined;
}

function extractQuoteFields(item: MsnQuoteItem): ExtractedQuote {
  return {
    symbol: item.symbol || item.Symbol,
    price:
      item.price ?? item.Price ?? item.lastPrice ?? item.LastPrice ?? undefined,
    open: item.open ?? item.Open ?? item.regularMarketOpen ?? undefined,
    high: item.dayHigh ?? item.DayHigh ?? item.high ?? item.High ?? undefined,
    low: item.dayLow ?? item.DayLow ?? item.low ?? item.Low ?? undefined,
    volume: item.volume ?? item.Volume ?? undefined,
    currency: item.currency || item.Currency,
    time: normalizeTimestamp(
      item.time ?? item.Time ?? item.lastTradeTime ?? item.LastTradeTime,
    ),
  };
}

interface MsnChartPoint {
  time?: number | string;
  Time?: number | string;
  date?: string;
  Date?: string;
  open?: number;
  Open?: number;
  high?: number;
  High?: number;
  low?: number;
  Low?: number;
  close?: number;
  Close?: number;
  volume?: number;
  Volume?: number;
}

interface MsnChartResponse {
  series?: MsnChartPoint[];
  Series?: MsnChartPoint[];
  currency?: string;
  Currency?: string;
}

function mapRangeToMsn(range: string): string {
  switch (range.toLowerCase()) {
    case "1d":
      return "1D";
    case "5d":
      return "5D";
    case "1mo":
    case "1m":
      return "1M";
    case "6mo":
    case "6m":
      return "6M";
    case "ytd":
      return "YTD";
    case "5y":
      return "5Y";
    case "max":
    case "all":
      return "MAX";
    case "1y":
    default:
      return "1Y";
  }
}

function parseMsnDate(raw: unknown): Date | null {
  if (raw == null) return null;
  if (typeof raw === "number") {
    // Assume seconds if small, milliseconds if large.
    const ms = raw > 1e12 ? raw : raw * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  if (typeof raw === "string") {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  return null;
}

function normalizeTimestamp(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "number") {
    return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
  }
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) return undefined;
    return Math.floor(ms / 1000);
  }
  return undefined;
}

/**
 * Pull instrument records out of a Quotes response. Tolerates the three
 * shapes Bing's endpoint has used: a bare array, `{ stocks: [...] }`, or
 * `{ data: [ { stocks: [...] } ] }`. Filters by SecId when one's known so we
 * don't pick up an unrelated row.
 */
function extractMarketInstruments(
  payload: unknown,
  preferSecId: string | null,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const push = (raw: unknown) => {
    if (raw && typeof raw === "object") {
      out.push(raw as Record<string, unknown>);
    }
  };
  if (Array.isArray(payload)) {
    payload.forEach(push);
  } else if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.stocks)) p.stocks.forEach(push);
    else if (Array.isArray(p.Stocks)) p.Stocks.forEach(push);
    else if (Array.isArray(p.value)) p.value.forEach(push);
    else if (Array.isArray(p.data)) {
      for (const d of p.data) {
        if (d && typeof d === "object") {
          const inner = (d as Record<string, unknown>).stocks;
          if (Array.isArray(inner)) inner.forEach(push);
          else push(d);
        }
      }
    }
  }

  if (preferSecId && out.length > 1) {
    const exact = out.find((r) => {
      const id = (r.SecId ?? r.secId ?? r.id) as string | undefined;
      return id === preferSecId;
    });
    if (exact) return [exact, ...out.filter((r) => r !== exact)];
  }
  return out;
}

/**
 * Detect MSN's "FullInstrument" identifier shape (e.g. "F18068765888",
 * "F0CAN05MQP") so we can re-resolve to a SecId. SecIds are 5–8 lowercase
 * alphanumerics (e.g. "a1xzim", "bb36yc"); FullInstrument starts with an
 * uppercase letter and is typically 7+ chars with mixed case.
 */
function looksLikeFullInstrument(id: string): boolean {
  if (!id) return false;
  // SecIds are short, lowercase, all alphanumeric — anything that doesn't fit
  // that pattern is treated as a FullInstrument-style ID.
  return !/^[a-z0-9]{4,8}$/.test(id);
}

function parseNumberMaybe(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function matchInText(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m?.[1] ?? null;
}

// Exported for unit tests.
export const msnInternals = {
  extractQuoteFields,
  mapRangeToMsn,
  parseMsnDate,
  normalizeTimestamp,
  EXCHANGE_TO_MSN,
};
