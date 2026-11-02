/**
 * The quote providers a security can be priced by, as one list.
 *
 * This array is the single source of truth: the `QuoteProviderName` union is
 * derived from it, and the DTO validators (`@IsIn(QUOTE_PROVIDER_NAMES)` on the
 * per-security override and the user default) and the database CHECK on
 * `quote_provider` / `default_quote_provider` all read the same set. Adding a
 * provider means one entry here plus the paired migration -- never a second
 * hand-written list of the same names that can drift out of step.
 */
export const QUOTE_PROVIDER_NAMES = [
  "yahoo",
  "msn",
  "lse",
  "deutsche_boerse",
  "html_table",
] as const;

export type QuoteProviderName = (typeof QUOTE_PROVIDER_NAMES)[number];

/**
 * Providers that read a page the security itself names, so they cannot be a
 * user's default: a security without that address would have nothing to read.
 */
export const PER_SECURITY_ONLY_PROVIDERS = ["html_table"] as const;

/** The providers a user may choose as the default for every security. */
export const DEFAULT_QUOTE_PROVIDER_NAMES = QUOTE_PROVIDER_NAMES.filter(
  (name) => !(PER_SECURITY_ONLY_PROVIDERS as readonly string[]).includes(name),
) as Exclude<QuoteProviderName, (typeof PER_SECURITY_ONLY_PROVIDERS)[number]>[];

export type DefaultQuoteProviderName =
  (typeof DEFAULT_QUOTE_PROVIDER_NAMES)[number];

export interface QuoteResult {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketOpen?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  regularMarketTime?: number;
  /**
   * IANA zone the instrument trades in, when the provider reports one. Read
   * from the instrument itself rather than mapped from the exchange code,
   * which can be an alias, a provider display name, or free text from an
   * import.
   */
  exchangeTimezone?: string | null;
  /**
   * The regular trading session for the day this quote came from, as epoch
   * seconds. Providers give the actual window, so a holiday or a half day is
   * reflected rather than assumed away.
   */
  regularSession?: { start: number; end: number } | null;
  provider?: QuoteProviderName;
  /**
   * The instrument's actual trading currency as reported by the provider
   * (GBX/GBp normalized to GBP). Authoritative — unlike a currency guessed from
   * the exchange, this is correct for non-local-currency listings (e.g. a
   * USD-denominated ETF on the LSE). May be absent if the provider doesn't
   * report it.
   */
  currencyCode?: string | null;
  /**
   * For MSN, the SecId actually used to fetch this quote. May differ from
   * the security's stored msnInstrumentId when the stored value was in the
   * legacy FullInstrument form and we re-resolved on the fly. Lets the
   * caller persist the upgraded ID back to the Security row.
   */
  msnResolvedInstrumentId?: string;
}

export type IntradayInterval =
  "1m" | "2m" | "5m" | "15m" | "30m" | "60m" | "90m";
export type IntradayRange = "1d" | "5d" | "1mo";

export interface IntradayPoint {
  /** Timestamp of the bar (UTC). */
  timestamp: Date;
  /**
   * Open price at the bar (in the security's currency, GBX-converted to GBP).
   * Optional / null when the provider doesn't expose per-bar opens. Consumers
   * use this for the first bar of the day so the chart's starting value
   * matches the day's official opening price rather than the first bar's
   * close.
   */
  open?: number | null;
  /** Close price at the bar (in the security's currency, GBX-converted to GBP). */
  close: number;
}

export interface HistoricalPrice {
  date: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  /**
   * Total-return adjusted close (split + dividend adjusted) when the
   * provider exposes one. null when the provider only returns raw closes.
   */
  adjClose: number | null;
  volume: number | null;
}

/**
 * A daily series together with what the provider said it is a series *of*.
 *
 * The bars themselves carry no currency, so a payload handed over as a bare
 * array can only be stored on trust: the same ticker listed on two exchanges
 * answers with two different sets of numbers and nothing distinguishes them.
 * The metadata is bundle-level because it describes the answer, not a bar --
 * a provider quotes one instrument in one currency for the whole window.
 */
export interface HistoricalSeries {
  prices: HistoricalPrice[];
  /**
   * The instrument's trading currency as the provider reports it for this
   * series, GBX/GBp normalized to GBP (the bars are converted to pounds with
   * it). `null` when the provider does not report one, which is a different
   * fact from a currency that disagrees: see `quote-currency.util.ts`.
   */
  currencyCode: string | null;
  /** The provider's own symbol for the series it answered with, when it names one. */
  symbol?: string | null;
  /** The exchange the provider says the series belongs to, when it names one. */
  exchange?: string | null;
}

export interface SecurityLookupResult {
  symbol: string;
  name: string;
  exchange: string | null;
  securityType: string | null;
  currencyCode: string | null;
  /** Provider that produced this result, if known. Never a page-reading provider: those do not search. */
  provider?: DefaultQuoteProviderName;
  /** MSN Financial Instrument ID, when the result came from MSN. */
  msnInstrumentId?: string | null;
}

export interface StockSectorInfo {
  sector: string | null;
  industry: string | null;
}

export interface EtfSectorWeighting {
  sector: string;
  weight: number;
}

export interface QuoteProviderOptions {
  instrumentId?: string;
  currencyCode?: string | null;
  /** User's top-N preferred exchanges, in priority order. Used for ambiguous lookups. */
  preferredExchanges?: string[];
  /** The page whose price table `html_table` reads (`securities.quote_url`). */
  quoteUrl?: string;
}

export interface QuoteProvider {
  readonly name: QuoteProviderName;

  fetchQuote(
    symbol: string,
    exchange: string | null,
    opts?: QuoteProviderOptions,
  ): Promise<QuoteResult | null>;

  /**
   * Daily bars for a named range, with the metadata that says which listing
   * they belong to.
   *
   * The series rather than a bare array because a price acceptance point has to
   * be able to refuse a payload whose currency is not the security's, and an
   * array cannot carry that. `null` means no answer; a series with an empty
   * `prices` means the provider answered with no bars in the window.
   */
  fetchHistoricalSeries(
    symbol: string,
    exchange: string | null,
    range?: string,
    opts?: QuoteProviderOptions,
  ): Promise<HistoricalSeries | null>;

  /**
   * Optional: fetch daily bars for an explicit date window rather than one of
   * the provider's named ranges.
   *
   * A named range is always anchored at *today*, so reaching a date years back
   * means downloading everything since. A window asks for the days that are
   * actually wanted, which is what lets a point-in-time report fill one month
   * of history for a security it could not price -- the same call shape the FX
   * fill uses. Providers whose chart API only accepts a named timeframe (MSN)
   * omit this, and callers fall back to the narrowest range that reaches the
   * date.
   */
  fetchHistoricalWindowSeries?(
    symbol: string,
    exchange: string | null,
    fromDate: Date,
    toDate: Date,
    opts?: QuoteProviderOptions,
  ): Promise<HistoricalSeries | null>;

  /**
   * Optional: fetch intraday price bars for a symbol. Used by the
   * "Portfolio Value Over Time" intraday view (1D / 1W / 1M ranges).
   * Providers that don't support intraday data may omit this method.
   */
  fetchIntradaySeries?(
    symbol: string,
    exchange: string | null,
    opts: { interval: IntradayInterval; range: IntradayRange },
    providerOpts?: QuoteProviderOptions,
  ): Promise<IntradayPoint[] | null>;

  lookupSecurity(
    query: string,
    preferredExchanges?: string[],
  ): Promise<SecurityLookupResult | null>;

  /**
   * Return every plausible match for the query, best first. Lets the UI show
   * a picker when multiple candidates share the ticker or when the query is
   * a name that matches several funds/securities.
   */
  lookupSecurityMany?(
    query: string,
    preferredExchanges?: string[],
  ): Promise<SecurityLookupResult[]>;

  fetchStockSectorInfo(
    symbol: string,
    exchange: string | null,
    opts?: QuoteProviderOptions,
  ): Promise<StockSectorInfo | null>;

  fetchEtfSectorWeightings(
    symbol: string,
    exchange: string | null,
    opts?: QuoteProviderOptions,
  ): Promise<EtfSectorWeighting[] | null>;

  getTradingDate(quote: QuoteResult): Date;

  /** MSN-specific; Yahoo returns null. Resolves the ticker to the provider's internal ID. */
  resolveInstrumentId?(
    symbol: string,
    exchange: string | null,
    preferredExchanges?: string[],
  ): Promise<string | null>;
}
