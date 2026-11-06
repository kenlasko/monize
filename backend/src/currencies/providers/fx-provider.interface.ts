/**
 * The exchange rate providers a deployment can draw rates from, as one list.
 *
 * This array is the single source of truth: the `FxProviderName` union is
 * derived from it, `resolveFxProviders` admits exactly these tokens from
 * `FX_PROVIDERS`, and the frontend's label list is held to it by a contract
 * test. Adding a provider means one adapter file, one entry here and one line
 * in `.env.example` (`docs/specs/exchange-rate-providers.md`, section 4).
 */
export const FX_PROVIDER_NAMES = ["frankfurter", "yahoo"] as const;

export type FxProviderName = (typeof FX_PROVIDER_NAMES)[number];

/**
 * The providers the chain always carries, after whatever `FX_PROVIDERS`
 * names, and which are never a token of it (`docs/specs/crypto-accounts.md`,
 * decision 5). Kept apart from `FX_PROVIDER_NAMES` so the configuration parser
 * keeps refusing them and the frontend's list of configurable names stays the
 * list an operator can write; the status endpoint's `describe()` reports them
 * beside the configured ones.
 */
export const PAIR_PROVIDER_NAMES = ["crypto"] as const;

export type PairProviderName = (typeof PAIR_PROVIDER_NAMES)[number];

/** The name of any provider the chain may hold, configured or always present. */
export type RateProviderName = FxProviderName | PairProviderName;

/** One dated observation: multiply an amount in `from` by `rate` to get `to`. */
export interface FxObservation {
  from: string;
  to: string;
  /** YYYY-MM-DD, the day the provider says the rate was struck. */
  date: string;
  rate: number;
}

/**
 * One source of exchange rates. A provider observes; it never resolves a rate
 * for a date (`resolveFxRate` does) and never orients a row (`canonicalRateRow`
 * does), so an observation comes back in whichever orientation the provider
 * answered and the writer stores it in the pair's one orientation.
 *
 * Every method keeps "did not answer" (`null`) apart from "answered, nothing
 * there" (an empty map, an empty array): the chain passes the first to the
 * next provider and may remember the second, and conflating them is how an
 * outage gets recorded as an empty window (INV-FX-005).
 */
export interface FxRateProvider {
  readonly name: RateProviderName;
  /** The `exchange_rates.source` slug this provider's rows carry. Stable: it is read back by the UI. */
  readonly source: string;
  /** Whether the provider quotes this code at all. Answered from a cached list, never one call per pair. */
  carries(code: string): Promise<boolean>;
  /**
   * Optional: whether this provider is the only one that may price a pair with
   * `code` on either side (a coin, INV-CRYPTO-002). A pair one of whose codes
   * some provider claims is asked of the claiming providers only, and a
   * claiming provider is asked about no other pair, so a fiat provider whose
   * `carries` cannot enumerate (Yahoo's is always true) is never asked for a
   * coin, and the coin provider never answers for, or masks an outage of, a
   * fiat pair. Answered from the same cached list as `carries`. A provider
   * that cannot read that list rejects rather than answering `false`, here and
   * in `carries`: the chain then asks nobody about the pair and reports it
   * unanswered, where a `false` would route a coin to a fiat provider.
   */
  claims?(code: string): Promise<boolean>;
  /**
   * The latest published rate of `base` against each of `quotes`.
   * `null`: no answer. A quote absent from the map: answered, no rate for it.
   * Observations may come back in either orientation.
   */
  fetchLatest(
    base: string,
    quotes: readonly string[],
  ): Promise<ReadonlyMap<string, FxObservation> | null>;
  /**
   * Daily observations dated within [start, end] inclusive, either orientation.
   * `null`: no answer. `[]`: answered, nothing in the window.
   */
  fetchDailySeries(
    from: string,
    to: string,
    start: string,
    end: string,
  ): Promise<FxObservation[] | null>;
  /** Optional: an intraday quote. Only a provider with a live market feed implements it. */
  fetchLive?(from: string, to: string): Promise<FxObservation | null>;
  /** Optional: whether the provider knows this code (a lookup aid, B5). `null`: no answer. */
  verifyCurrency?(code: string): Promise<boolean | null>;
  /** Optional: a free-text search resolving to a code (a lookup aid, B5). */
  searchCurrency?(query: string): Promise<string | null>;
}
