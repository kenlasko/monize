import apiClient from './api';
import {
  dedupe,
  invalidateBalanceCaches,
  invalidateCache,
  invalidateScheduledFxReadModel,
} from './apiCache';
import type { CurrencyKind } from './currency-kind';

export { CURRENCY_KINDS, type CurrencyKind } from './currency-kind';

export interface ExchangeRate {
  id: number;
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  rateDate: string;
  source: string;
}

/**
 * The exchange rate providers a deployment can name in `FX_PROVIDERS`, mirrored
 * from the backend's `FX_PROVIDER_NAMES`
 * (`backend/src/currencies/providers/fx-provider.interface.ts`) and held to it
 * by a contract test. The labels are this client's translations, keyed by name.
 */
export const FX_PROVIDER_NAMES = ['frankfurter', 'yahoo'] as const;

export type FxProviderName = (typeof FX_PROVIDER_NAMES)[number];

export function isFxProviderName(name: string): name is FxProviderName {
  return (FX_PROVIDER_NAMES as readonly string[]).includes(name);
}

/**
 * The providers the server's chain always carries after the configured ones and
 * which are never an `FX_PROVIDERS` token, mirrored from the backend's
 * `PAIR_PROVIDER_NAMES` (same file as above) and held to it by the same
 * contract test. Kept apart so `FX_PROVIDER_NAMES` stays the list an operator
 * can configure.
 */
export const PAIR_PROVIDER_NAMES = ['crypto'] as const;

export type PairProviderName = (typeof PAIR_PROVIDER_NAMES)[number];

/** Any provider the status endpoint may report, configured or always present. */
export type RateProviderName = FxProviderName | PairProviderName;

/** Whether this client has a label for `name` (`page.providers.names.<name>`). */
export function isRateProviderName(name: string): name is RateProviderName {
  return isFxProviderName(name) || (PAIR_PROVIDER_NAMES as readonly string[]).includes(name);
}

/** One configured provider: `name` identifies it, `source` is the slug its rows carry. */
export interface FxProviderDescription {
  name: string;
  source: string;
}

/** `providers` is in the order the server asks them. */
export interface ExchangeRateStatus {
  lastUpdated: string | null;
  providers: FxProviderDescription[];
}


export interface CurrencyInfo {
  code: string;
  name: string;
  symbol: string;
  decimalPlaces: number;
  isActive: boolean;
  isSystem: boolean;
  createdAt: string;
  kind: CurrencyKind;
  /**
   * The Yahoo `<COIN>-<FIAT>` pair a `CRYPTO` currency is priced from (`BTC-EUR`);
   * always null on a `FIAT` row, and null on a coin no provider quotes, which
   * leaves it without an exchange rate.
   */
  quoteSymbol: string | null;
}

export interface CreateCurrencyData {
  code: string;
  name: string;
  symbol: string;
  decimalPlaces?: number;
  isActive?: boolean;
  kind?: CurrencyKind;
  quoteSymbol?: string | null;
}

export interface UpdateCurrencyData {
  name?: string;
  symbol?: string;
  decimalPlaces?: number;
  isActive?: boolean;
  /** Refused by the server (`currencies.kindInUse`) once anything references the code. */
  kind?: CurrencyKind;
  quoteSymbol?: string | null;
}

export interface CurrencyLookupResult {
  code: string;
  name: string;
  symbol: string;
  decimalPlaces: number;
}

export interface CurrencyUsage {
  [code: string]: { accounts: number; securities: number };
}

/**
 * What the server already stores for one currency pair, in days.
 *
 * `observations` counts calendar days rather than rows: either stored direction
 * of a pair is evidence about the same day, and rows written before the pair was
 * collapsed to one orientation still hold a day twice.
 */
export interface RateCoverage {
  from: string;
  to: string;
  earliestDate: string | null;
  latestDate: string | null;
  observations: number;
}

/**
 * One stored observation, stated in the direction the panel shows.
 *
 * `rate` is units of `to` per 1 unit of `from`, and `null` where the stored row
 * cannot be stated that way at all -- it renders as unknown, never as 0 or 1.
 * `inverted` says the row is stored the other way round and this figure is its
 * reciprocal (INV-FX-003), which is why the same date can read differently from
 * a raw look at the table.
 */
export interface StoredRate {
  rateDate: string;
  rate: number | null;
  source: string | null;
  inverted: boolean;
}

/** Newest date first, one entry per date, bounded by the server's `limit`. */
export interface StoredRateList {
  from: string;
  to: string;
  rates: StoredRate[];
  truncated: boolean;
  limit: number;
}

/**
 * The outcome of one "fill the gaps in rate history" request.
 *
 * `usedFrom` is the first date the reader's own data uses the currency, and
 * `null` when nothing does, which is the one case that fetches nothing at all.
 * `windowsRemaining` above zero means a bound stopped the fill early and
 * pressing again has work to do. `providerHasNothingBefore` is a statement
 * about the provider's history rather than a failure: asking again will not
 * change it. A provider that did not answer arrives as a rejected request
 * (503), never as a zero.
 */
export interface RateGapFill {
  from: string;
  to: string;
  usedFrom: string | null;
  spanEnd: string;
  /**
   * Days in the span no stored rate can convert at all, on the server's
   * 45-day carry-forward bound. Often zero while `sparseDays` is large: a
   * history holding one observation a month converts every date and prices
   * almost none of them on their own day.
   */
  unresolvableDays: number;
  /** Days in the span with no observation within ten days -- what the fill is for. */
  sparseDays: number;
  windowsPlanned: number;
  windowsFetched: number;
  windowsSkipped: number;
  windowsUnanswered: number;
  windowsRemaining: number;
  stored: number;
  earliestDate: string | null;
  providerHasNothingBefore: string | null;
}

export const exchangeRatesApi = {
  // Exchange rates
  getLatestRates: async (): Promise<ExchangeRate[]> => {
    // Rates change at most daily; dedupe in-flight requests so a page that
    // mounts many components needing rates only makes one network round trip.
    return dedupe(
      'exchange-rates:latest',
      async () => {
        const response = await apiClient.get<ExchangeRate[]>('/currencies/exchange-rates');
        return response.data;
      },
      3_600_000, // 1 hour
    );
  },

  getRateHistory: async (startDate?: string, endDate?: string): Promise<ExchangeRate[]> => {
    const response = await apiClient.get<ExchangeRate[]>('/currencies/exchange-rates/history', {
      params: { startDate, endDate },
    });
    return response.data;
  },

  // Resolve the exchange rate for a specific currency pair and date (account
  // currency units per 1 unit of `from`). The backend applies carry-forward and
  // Yahoo backfill; it returns null when no rate can be determined. Deduped per
  // from:to:date so repeated form edits for the same day hit the network once.
  getRateForDate: async (from: string, to: string, date: string): Promise<number | null> => {
    if (from === to) return 1;
    return dedupe(
      `exchange-rates:rate:${from}:${to}:${date}`,
      async () => {
        const response = await apiClient.get<{ rate: number | null }>(
          '/currencies/exchange-rates/rate',
          { params: { from, to, date } },
        );
        return response.data.rate;
      },
      3_600_000, // 1 hour
    );
  },

  // Stored coverage for `code` against the caller's reporting currency. Not
  // deduped: the dialog reads it to show what is stored right now, and it
  // re-reads it immediately after an extension wrote rows.
  getRateCoverage: async (code: string): Promise<RateCoverage> => {
    const response = await apiClient.get<RateCoverage>('/currencies/exchange-rates/coverage', {
      params: { code },
    });
    return response.data;
  },

  // Every stored rate for `code` against the caller's reporting currency,
  // newest date first. Not deduped, for the same reason `getRateCoverage` is
  // not: the dialog re-reads it straight after a fill wrote rows, and a cached
  // answer would describe the history it just replaced. If it is ever cached,
  // its key must start with `exchange-rates:` so the invalidation below keeps
  // covering it.
  getStoredRates: async (code: string): Promise<StoredRateList> => {
    const response = await apiClient.get<StoredRateList>('/currencies/exchange-rates/stored', {
      params: { code },
    });
    return response.data;
  },

  // Fetch and store the rates this pair is missing between the first date the
  // reader's data uses the currency and today. Invalidates the cached rate
  // reads afterwards for the same reason `refreshRates` does: new rows change
  // what a dated lookup answers.
  fillRateGaps: async (code: string): Promise<RateGapFill> => {
    const response = await apiClient.post<RateGapFill>(
      '/currencies/exchange-rates/fill-gaps',
      { code },
    );
    invalidateCache('exchange-rates:');
    // A rate is a valuation input for every converted total.
    invalidateBalanceCaches();
    return response.data;
  },

  getRateStatus: async (): Promise<ExchangeRateStatus> => {
    const response = await apiClient.get<ExchangeRateStatus>('/currencies/exchange-rates/status');
    return response.data;
  },

  refreshRates: async () => {
    const response = await apiClient.post('/currencies/exchange-rates/refresh');
    // Invalidate AFTER the refresh succeeds. The scheduled read model's #1167
    // forecast fields are resolved from these snapshots, so a rate refresh makes
    // a cached `scheduled:all` stale (issue #1167 close-out); dropping it after
    // the POST also lets the generation-aware primitive obsolete any scheduled
    // read already in flight, rather than letting it repopulate the pre-refresh
    // value. Invalidating before the POST would leave that window open.
    invalidateCache('exchange-rates:');
    invalidateScheduledFxReadModel();
    // A rate is a valuation input for every converted total.
    invalidateBalanceCaches();
    return response.data;
  },

  // Currency CRUD
  getCurrencies: async (includeInactive?: boolean): Promise<CurrencyInfo[]> => {
    const response = await apiClient.get<CurrencyInfo[]>('/currencies', {
      params: includeInactive ? { includeInactive: true } : undefined,
    });
    return response.data;
  },

  createCurrency: async (data: CreateCurrencyData): Promise<CurrencyInfo> => {
    const response = await apiClient.post<CurrencyInfo>('/currencies', data);
    return response.data;
  },

  updateCurrency: async (code: string, data: UpdateCurrencyData): Promise<CurrencyInfo> => {
    const response = await apiClient.patch<CurrencyInfo>(`/currencies/${code}`, data);
    return response.data;
  },

  deactivateCurrency: async (code: string): Promise<CurrencyInfo> => {
    const response = await apiClient.post<CurrencyInfo>(`/currencies/${code}/deactivate`);
    return response.data;
  },

  activateCurrency: async (code: string): Promise<CurrencyInfo> => {
    const response = await apiClient.post<CurrencyInfo>(`/currencies/${code}/activate`);
    return response.data;
  },

  deleteCurrency: async (code: string): Promise<void> => {
    await apiClient.delete(`/currencies/${code}`);
  },

  // The catalog of known currencies (code, name, symbol, decimal places) used
  // to pick a currency before any are installed (e.g. at onboarding), since
  // currencies are created on demand rather than pre-seeded.
  getCurrencyCatalog: async (): Promise<CurrencyLookupResult[]> => {
    const response = await apiClient.get<CurrencyLookupResult[]>('/currencies/catalog');
    return response.data;
  },

  lookupCurrency: async (query: string): Promise<CurrencyLookupResult | null> => {
    const response = await apiClient.get<CurrencyLookupResult | null>('/currencies/lookup', {
      params: { q: query },
    });
    return response.data;
  },

  getCurrencyUsage: async (): Promise<CurrencyUsage> => {
    const response = await apiClient.get<CurrencyUsage>('/currencies/usage');
    return response.data;
  },
};
