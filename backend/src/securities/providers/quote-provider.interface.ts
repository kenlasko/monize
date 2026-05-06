export type QuoteProviderName = "yahoo" | "msn";

export interface QuoteResult {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketOpen?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  regularMarketTime?: number;
  provider?: QuoteProviderName;
  /**
   * For MSN, the SecId actually used to fetch this quote. May differ from
   * the security's stored msnInstrumentId when the stored value was in the
   * legacy FullInstrument form and we re-resolved on the fly. Lets the
   * caller persist the upgraded ID back to the Security row.
   */
  msnResolvedInstrumentId?: string;
}

export type IntradayInterval = "1m" | "5m" | "15m";
export type IntradayRange = "1d" | "5d" | "1mo";

export interface IntradayPoint {
  /** Timestamp of the bar (UTC). */
  timestamp: Date;
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

export interface SecurityLookupResult {
  symbol: string;
  name: string;
  exchange: string | null;
  securityType: string | null;
  currencyCode: string | null;
  /** Provider that produced this result, if known. */
  provider?: QuoteProviderName;
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
}

export interface QuoteProvider {
  readonly name: QuoteProviderName;

  fetchQuote(
    symbol: string,
    exchange: string | null,
    opts?: QuoteProviderOptions,
  ): Promise<QuoteResult | null>;

  fetchHistorical(
    symbol: string,
    exchange: string | null,
    range?: string,
    opts?: QuoteProviderOptions,
  ): Promise<HistoricalPrice[] | null>;

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
