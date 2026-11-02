import apiClient from './api';
import { Account } from '@/types/account';
import { TransactionStatus } from '@/types/transaction';
/**
 * Mirrors `BACKFILL_RANGES` in the backend's `backfill-prices-query.dto.ts`.
 * The server validates against its own allowlist; this keeps a caller from
 * sending a range the DTO would reject.
 */
export type BackfillRange = '1y' | '2y' | '5y' | '10y' | 'ytd' | 'max';
import {
  PortfolioSummary,
  AssetAllocation,
  DailyMovementsResponse,
  DailyMovementDetailResponse,
  InvestmentTransaction,
  CreateInvestmentTransactionData,
  Holding,
  RealizedGainEntry,
  CapitalGainEntry,
  Security,
  CreateSecurityData,
  CreateSecurityPriceData,
  PaginatedInvestmentTransactions,
  TopMover,
  FavouriteSecurityQuote,
  SectorWeightingResult,
  CountryWeightingResult,
  AssetClassWeightingResult,
  SecurityPrice,
  MarketIndex,
  PerformanceComparison,
  SecurityDocument,
  CreateSecurityDocumentData,
  SecurityNewsResult,
  SecurityTransactionHistory,
  SecurityDetail,
  InvestmentRegisterFilterOptions,
  PortfolioTagSummary,
  QuoteTablePreview,
} from '@/types/investment';
import { IntradayBreakdown } from '@/types/net-worth';
import type {
  BondInstrumentSummary,
  BondProgramSummary,
  BondRedemptionSplit,
  BondSeriesHoldings,
  BondExpectedSeries,
  BondSeriesOnSale,
  FetchBondSeriesResult,
  BondAssumption,
  BondHistory,
  BondOffer,
  BondPriceRecompute,
  BondRefreshProgress,
  SecurityBondScenarios,
  SecurityBondValuation,
} from '@/types/bond';
import {
  clearAllCache,
  dedupe,
  invalidateBalanceCaches,
  invalidateCache,
  invalidateScheduledFxReadModel,
} from './apiCache';
import { API_MAX_PAGE_LIMIT } from './api-page-limits';
import { PORTFOLIO_VALUATION_TIMEOUT_MS } from './constants';

/**
 * Two legs of one share transfer that the ledger never paired.
 *
 * A suggestion, never a conclusion: an unpaired TRANSFER_IN cannot take the
 * cost basis its source released, so that position reports its basis -- and the
 * gain over it -- as unknown. Which two rows are one transfer is a person's
 * call, so nothing links them until one is confirmed.
 */
export interface UnlinkedTransferPair {
  securityId: string;
  symbol: string | null;
  securityName: string | null;
  transactionDate: string;
  quantity: number;
  out: { transactionId: string; accountId: string; accountName: string };
  in: { transactionId: string; accountId: string; accountName: string };
}

export const investmentsApi = {
  /** The transfers whose legs were never linked, over the given scope. */
  getUnlinkedTransferPairs: async (
    accountIds?: string[],
  ): Promise<UnlinkedTransferPair[]> => {
    const response = await apiClient.get<UnlinkedTransferPair[]>(
      '/investment-transactions/unlinked-transfer-pairs',
      {
        params: accountIds?.length
          ? { accountIds: accountIds.join(',') }
          : undefined,
      },
    );
    return response.data;
  },

  /**
   * Pair two legs the reader confirmed. The server re-checks every condition
   * before it writes, so a pair that has changed under the reader is refused
   * rather than forced.
   */
  linkTransferPair: async (params: {
    outTransactionId: string;
    inTransactionId: string;
  }): Promise<void> => {
    await apiClient.post(
      '/investment-transactions/link-transfer-pair',
      params,
    );
    // The pairing rewrote both holdings' stored basis.
    clearAllCache();
  },

  // Get portfolio summary
  getPortfolioSummary: async (accountIds?: string[]): Promise<PortfolioSummary> => {
    const cacheKey = `investments:summary:${accountIds?.join(',') || 'all'}`;
    return dedupe(cacheKey, async () => {
      const response = await apiClient.get<PortfolioSummary>('/portfolio/summary', {
        params: accountIds && accountIds.length > 0 ? { accountIds: accountIds.join(',') } : undefined,
        timeout: PORTFOLIO_VALUATION_TIMEOUT_MS,
      });
      return response.data;
    }, 60_000);
  },

  // Get asset allocation
  getAssetAllocation: async (accountIds?: string[]): Promise<AssetAllocation> => {
    const cacheKey = `investments:allocation:${accountIds?.join(',') || 'all'}`;
    return dedupe(cacheKey, async () => {
      const response = await apiClient.get<AssetAllocation>('/portfolio/allocation', {
        params: accountIds && accountIds.length > 0 ? { accountIds: accountIds.join(',') } : undefined,
      });
      return response.data;
    }, 60_000);
  },

  // Get portfolio "exposure by tag" allocation. Overlapping exposure: a
  // multi-tagged holding counts in full under each tag, so percentages can sum
  // to more than 100%.
  getAllocationByTag: async (accountIds?: string[]): Promise<AssetAllocation> => {
    const cacheKey = `investments:allocation-by-tag:${accountIds?.join(',') || 'all'}`;
    return dedupe(cacheKey, async () => {
      const response = await apiClient.get<AssetAllocation>('/portfolio/allocation/by-tag', {
        params: accountIds && accountIds.length > 0 ? { accountIds: accountIds.join(',') } : undefined,
      });
      return response.data;
    }, 60_000);
  },

  // What the portfolio's held securities are tagged with: the KEY:VALUE keys
  // (e.g. "country", "sector") for the aggregate-by-key chart, and whether any
  // holding carries a tag at all -- a portfolio tagged only with plain labels
  // has no keys but still has a by-tag grouping worth offering. Answered from
  // the holdings and their tags, without valuing the portfolio, so it is cheap
  // enough to fetch on mount.
  getPortfolioTagSummary: async (
    accountIds?: string[],
  ): Promise<PortfolioTagSummary> => {
    const cacheKey = `investments:tag-keys:${accountIds?.join(',') || 'all'}`;
    return dedupe(cacheKey, async () => {
      const response = await apiClient.get<PortfolioTagSummary>('/portfolio/tag-keys', {
        params:
          accountIds && accountIds.length > 0
            ? { accountIds: accountIds.join(',') }
            : undefined,
      });
      return response.data;
    }, 60_000);
  },

  // Get portfolio allocation aggregated by the value of one KEY:VALUE tag key
  // (e.g. key "country" -> a slice per country). Value-weighted; a mixed
  // holding tagged under several values counts in full under each.
  getAllocationByTagKey: async (
    key: string,
    accountIds?: string[],
  ): Promise<AssetAllocation> => {
    const cacheKey = `investments:allocation-by-tag-key:${key}:${accountIds?.join(',') || 'all'}`;
    return dedupe(cacheKey, async () => {
      const response = await apiClient.get<AssetAllocation>(
        '/portfolio/allocation/by-tag-key',
        {
          params: {
            key,
            ...(accountIds && accountIds.length > 0
              ? { accountIds: accountIds.join(',') }
              : {}),
          },
        },
      );
      return response.data;
    }, 60_000);
  },

  // Suggest a description and website for a security from the Yahoo provider
  // profile (advisory pre-fill for the "Fetch from Yahoo" button). Not cached.
  // `website` is null for funds, where Yahoo publishes no URL, and there is no
  // investor-relations address to suggest: no provider carries one.
  getSuggestedDescription: async (
    symbol: string,
    exchange?: string,
  ): Promise<{
    symbol: string;
    description: string | null;
    website: string | null;
  }> => {
    const response = await apiClient.get<{
      symbol: string;
      description: string | null;
      website: string | null;
    }>('/securities/profile-description', {
      params: { symbol, ...(exchange ? { exchange } : {}) },
    });
    return response.data;
  },

  // Get all investment accounts
  getInvestmentAccounts: async (): Promise<Account[]> => {
    const cacheKey = 'investments:accounts';
    return dedupe(cacheKey, async () => {
      const response = await apiClient.get<Account[]>('/portfolio/accounts');
      return response.data;
    });
  },

  // Intraday portfolio value series (1D / 1W / MTD / 1M ranges).
  // Bypasses apiCache; the chart caches in sessionStorage instead so a manual
  // Refresh can selectively invalidate just the intraday entries.
  getIntradayValue: async (params: {
    range: '1d' | '1w' | 'mtd' | '1m';
    accountIds?: string;
    displayCurrency?: string;
  }): Promise<{
    // `securitiesValue` is the INVESTED part of the bar -- the securities,
    // without the cash beside them. The investment charts plot it; `value` is
    // the whole scope and stays for anything that means the account.
    points: Array<{
      timestamp: string;
      value: number;
      securitiesValue?: number;
      /**
       * Three completeness bits, as on `DailyInvestmentValue`: `value` and
       * `securitiesValue` are SUBTOTALS on a bar where one is false. Optional
       * and read as `=== false`: an older backend sends none, which is no
       * information.
       */
      fxComplete?: boolean;
      pricesComplete?: boolean;
      cashComplete?: boolean;
      /**
       * Set on a session's closing point, the daily series' figure for the
       * day, including the point a 1W / 1M series opens on. Absent on a bar.
       */
      sessionClose?: true;
    }>;
    interval: '1m' | '2m' | '5m' | '15m' | '30m' | '60m' | '90m';
    currency: string;
    range: '1d' | '1w' | 'mtd' | '1m';
    fetchedAt: string;
    skippedSymbols: string[];
    failedSymbols: string[];
    fallbackToDaily: boolean;
    /** Completeness over every point; optional, read as `=== false`. */
    fxComplete?: boolean;
    pricesComplete?: boolean;
    valuationComplete?: boolean;
    /** `"CCY->DISPLAY"` for each pair with no rate at any bar. */
    missingRatePairs?: string[];
    /** The securities behind `pricesComplete: false`. */
    unpricedSecurityIds?: string[];
  }> => {
    const response = await apiClient.get('/portfolio/intraday-value', { params });
    return response.data;
  },

  // Per-security intraday breakdown (1D / 1W / 1M ranges) for the Portfolio
  // Value Over Time report's "by security" view. Carries the same availability
  // metadata as getIntradayValue so the caller can apply identical fallback
  // handling. Backend caches for 60s; not cached in sessionStorage here.
  getIntradayBreakdown: async (params: {
    range: '1d' | '1w' | 'mtd' | '1m';
    accountIds?: string;
    displayCurrency?: string;
  }): Promise<IntradayBreakdown> => {
    const response = await apiClient.get<IntradayBreakdown>(
      '/portfolio/intraday-breakdown',
      { params },
    );
    return response.data;
  },

  // Get top movers (daily price changes)
  getTopMovers: async (): Promise<TopMover[]> => {
    const cacheKey = 'investments:topMovers';
    return dedupe(cacheKey, async () => {
      const response = await apiClient.get<TopMover[]>('/portfolio/top-movers');
      return response.data;
    }, 60_000);
  },

  // Get all holdings
  getHoldings: async (accountId?: string): Promise<Holding[]> => {
    const response = await apiClient.get<Holding[]>('/holdings', {
      params: accountId ? { accountId } : undefined,
    });
    return response.data;
  },

  // Rebuild all holdings from transaction history. Useful for fixing data
  // after imports or split-ratio corrections leave holdings out of sync
  // with the transaction log.
  rebuildHoldings: async (): Promise<{
    holdingsCreated: number;
    holdingsUpdated: number;
    holdingsDeleted: number;
  }> => {
    const response = await apiClient.post<{
      holdingsCreated: number;
      holdingsUpdated: number;
      holdingsDeleted: number;
    }>('/holdings/rebuild');
    invalidateCache('investments:');
    return response.data;
  },

  // Holding state for (account, security) replayed as of a date. Used by
  // the SPLIT form to show the user what their position looked like just
  // before the split was applied, rather than the live holdings.
  getHoldingAt: async (params: {
    accountId: string;
    securityId: string;
    asOfDate: string;
    excludeTransactionId?: string;
  }): Promise<{ quantity: number; averageCost: number }> => {
    const response = await apiClient.get<{
      quantity: number;
      averageCost: number;
    }>('/holdings/at', { params });
    return response.data;
  },

  // Get investment transactions with pagination
  getTransactions: async (params?: {
    accountIds?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
    symbol?: string;
    action?: string;
  }): Promise<PaginatedInvestmentTransactions> => {
    const response = await apiClient.get<PaginatedInvestmentTransactions>(
      '/investment-transactions',
      { params },
    );
    return response.data;
  },

  /**
   * Every investment transaction matching the filter, walked a page at a time.
   *
   * The counterpart to `transactionsApi.getAllPages`, and it exists for the
   * same reason: `GET /investment-transactions` rejects a `limit` above
   * {@link API_MAX_PAGE_LIMIT} with a 400 rather than clamping it, so a caller
   * that wants more than one page walks the pages. Reaching for a bigger
   * `limit` produces a request the server refuses, which every caller here
   * degrades into an empty list -- a figure that reads as a confident zero.
   *
   * Prefer narrowing the query (`action`, `symbol`, a date range) over walking
   * a whole register client-side; use this when the filtered set can still run
   * past one page.
   */
  // The portfolio's market movement per calendar day, net of the reader's own
  // contributions, for the calendar's Daily change layer. Under the
  // `investments:` prefix so a write drops it with everything else derived from
  // the ledger.
  getDailyMovements: async (params: {
    startDate: string;
    endDate: string;
    accountIds?: string;
    displayCurrency?: string;
  }): Promise<DailyMovementsResponse> => {
    const cacheKey = `investments:daily-movements:${params.startDate}:${params.endDate}:${params.accountIds ?? ''}:${params.displayCurrency ?? ''}`;
    return dedupe(
      cacheKey,
      async () => {
        const response = await apiClient.get<DailyMovementsResponse>(
          '/portfolio/daily-movements',
          { params },
        );
        return response.data;
      },
      30_000,
    );
  },

  // One day of that layer, broken down by security.
  getDailyMovementDetail: async (params: {
    date: string;
    accountIds?: string;
    displayCurrency?: string;
  }): Promise<DailyMovementDetailResponse> => {
    const cacheKey = `investments:daily-movements:detail:${params.date}:${params.accountIds ?? ''}:${params.displayCurrency ?? ''}`;
    return dedupe(
      cacheKey,
      async () => {
        const response = await apiClient.get<DailyMovementDetailResponse>(
          '/portfolio/daily-movements/detail',
          { params },
        );
        return response.data;
      },
      30_000,
    );
  },

  getAllTransactionPages: async (
    params?: {
      accountIds?: string;
      startDate?: string;
      endDate?: string;
      symbol?: string;
      action?: string;
    } & { pageSize?: number },
  ): Promise<InvestmentTransaction[]> => {
    const MAX_PAGES = 5000;
    const { pageSize = API_MAX_PAGE_LIMIT, ...rest } = params ?? {};
    const all: InvestmentTransaction[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore && page <= MAX_PAGES) {
      const result = await investmentsApi.getTransactions({
        ...rest,
        page,
        limit: pageSize,
      });
      // Defend against a backend that reports hasMore=true on an empty page;
      // without new rows there is nothing left to fetch.
      if (result.data.length === 0) break;
      all.push(...result.data);
      hasMore = result.pagination.hasMore;
      page++;
    }
    return all;
  },

  /**
   * The investment actions the given accounts' rows actually use -- what the
   * register's Action picker offers, rather than the whole twenty-odd
   * vocabulary.
   */
  getRegisterFilterOptions: async (
    accountIds?: string[],
  ): Promise<InvestmentRegisterFilterOptions> => {
    const response = await apiClient.get<InvestmentRegisterFilterOptions>(
      '/investment-transactions/filter-options',
      { params: accountIds?.length ? { accountIds: accountIds.join(',') } : {} },
    );
    return response.data;
  },

  // Get realized gains per SELL transaction (proper cost basis via replay)
  getRealizedGains: async (params?: {
    accountIds?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<RealizedGainEntry[]> => {
    const response = await apiClient.get<RealizedGainEntry[]>(
      '/investment-transactions/realized-gains',
      { params },
    );
    return response.data;
  },

  // Per-period capital gain breakdown (realized + unrealized) by security.
  getCapitalGains: async (params: {
    accountIds?: string;
    startDate: string;
    endDate: string;
    granularity?: 'month' | 'day';
  }): Promise<CapitalGainEntry[]> => {
    const response = await apiClient.get<CapitalGainEntry[]>(
      '/investment-transactions/capital-gains',
      { params },
    );
    return response.data;
  },

  // Create investment transaction
  createTransaction: async (
    data: CreateInvestmentTransactionData,
  ): Promise<InvestmentTransaction> => {
    const response = await apiClient.post<InvestmentTransaction>(
      '/investment-transactions',
      data,
    );
    invalidateBalanceCaches();
    return response.data;
  },

  // Transfer a security between two investment accounts, preserving cost
  // basis. Creates both legs (TRANSFER_OUT in source, TRANSFER_IN in
  // destination) atomically on the backend.
  transferSecurity: async (data: {
    fromAccountId: string;
    toAccountId: string;
    securityId: string;
    transactionDate: string;
    quantity: number;
    costPerShare: number;
    description?: string;
  }): Promise<{
    transferOut: InvestmentTransaction;
    transferIn: InvestmentTransaction;
  }> => {
    const response = await apiClient.post<{
      transferOut: InvestmentTransaction;
      transferIn: InvestmentTransaction;
    }>('/investment-transactions/transfer-security', data);
    invalidateBalanceCaches();
    return response.data;
  },

  // Update investment transaction
  updateTransaction: async (
    id: string,
    // destinationAccountId is only used when editing a security-transfer leg,
    // to reroute the paired leg's account.
    data: Partial<CreateInvestmentTransactionData> & {
      destinationAccountId?: string;
    },
  ): Promise<InvestmentTransaction> => {
    const response = await apiClient.patch<InvestmentTransaction>(
      `/investment-transactions/${id}`,
      data,
    );
    invalidateBalanceCaches();
    return response.data;
  },

  // Update only the status of an investment transaction (the register's
  // click-to-cycle path). Crossing the VOID boundary moves holdings and the
  // linked cash balance server-side, so the balance caches are invalidated
  // exactly as transactionsApi.updateStatus does.
  updateStatus: async (
    id: string,
    status: TransactionStatus,
  ): Promise<InvestmentTransaction> => {
    const response = await apiClient.patch<InvestmentTransaction>(
      `/investment-transactions/${id}/status`,
      { status },
    );
    invalidateBalanceCaches();
    return response.data;
  },

  // Get a single investment transaction by ID
  getTransaction: async (id: string): Promise<InvestmentTransaction> => {
    const response = await apiClient.get<InvestmentTransaction>(
      `/investment-transactions/${id}`,
    );
    return response.data;
  },

  // Full transaction history for a security with running share totals and the
  // accounts (including closed) it was used in.
  getSecurityTransactionHistory: async (
    securityId: string,
  ): Promise<SecurityTransactionHistory> => {
    const response = await apiClient.get<SecurityTransactionHistory>(
      `/investment-transactions/security/${securityId}/history`,
    );
    return response.data;
  },

  // Delete investment transaction
  deleteTransaction: async (id: string): Promise<void> => {
    await apiClient.delete(`/investment-transactions/${id}`);
    invalidateBalanceCaches();
  },

  // Get all securities
  getSecurities: async (includeInactive = false): Promise<Security[]> => {
    const response = await apiClient.get<Security[]>('/securities', {
      params: includeInactive ? { includeInactive: true } : undefined,
    });
    return response.data;
  },

  // Get favourite securities with latest price and daily change (for the dashboard widget)
  getFavouriteSecurities: async (): Promise<FavouriteSecurityQuote[]> => {
    const cacheKey = 'investments:favouriteSecurities';
    return dedupe(cacheKey, async () => {
      const response = await apiClient.get<FavouriteSecurityQuote[]>('/securities/favourites');
      return response.data;
    }, 60_000);
  },

  // Toggle a security's favourite flag. Invalidates the cached favourites list
  // so the dashboard widget reflects the change on next load.
  setSecurityFavourite: async (id: string, isFavourite: boolean): Promise<Security> => {
    const response = await apiClient.patch<Security>(`/securities/${id}`, { isFavourite });
    invalidateCache('investments:favouriteSecurities');
    return response.data;
  },

  // Get a single security by ID
  getSecurity: async (id: string): Promise<Security> => {
    const response = await apiClient.get<Security>(`/securities/${id}`);
    return response.data;
  },

  // The security plus its position, per-account breakdown and lifetime totals,
  // for the security detail page. Deliberately uncached: it is the page's
  // primary data, and a stale position after a trade would be misleading.
  getSecurityDetail: async (id: string): Promise<SecurityDetail> => {
    const response = await apiClient.get<SecurityDetail>(`/securities/${id}/detail`);
    return response.data;
  },

  // Country names for the manual ETF/fund allocation picker: canonical list
  // plus any custom countries the user has saved, base-currency country first.
  getCountryOptions: async (): Promise<string[]> => {
    const response = await apiClient.get<string[]>('/securities/country-options');
    return response.data;
  },

  // Asset-class names for the manual ETF/fund allocation picker: exactly the
  // free-text classes the user has already saved on a security.
  getAssetOptions: async (): Promise<string[]> => {
    const response = await apiClient.get<string[]>('/securities/asset-options');
    return response.data;
  },

  // Remove an asset class from the picker list. It is also dropped from every
  // security that used it; the freed weight becomes part of that security's
  // computed "Other" remainder rather than being re-apportioned.
  deleteAssetOption: async (
    name: string,
  ): Promise<{ name: string; removedFrom: number }> => {
    const response = await apiClient.delete<{ name: string; removedFrom: number }>(
      '/securities/asset-options',
      { params: { name } },
    );
    return response.data;
  },

  // Create security
  createSecurity: async (data: CreateSecurityData): Promise<Security> => {
    const response = await apiClient.post<Security>('/securities', data);
    // A link to a bond program makes the server write engine prices.
    if (data.bondProgramId !== undefined) invalidateCache('investments:');
    return response.data;
  },

  // Update security
  updateSecurity: async (id: string, data: Partial<CreateSecurityData>): Promise<Security> => {
    const response = await apiClient.patch<Security>(`/securities/${id}`, data);
    // Issue #1167: the scheduled-transaction read model (`scheduled:all`) carries
    // server-derived, current-settlement-pair FX fields
    // (investmentForecastExchangeRate / investmentForecastAmount) whose
    // correctness depends on the referenced security's CURRENT currency. A
    // currency edit keeping the same security id makes that cached payload
    // semantically stale, so drop it -- otherwise the forecast keeps projecting
    // the old pair's rate for up to the 120s TTL while posting already resolves
    // the new pair. Invalidate on every update rather than diffing currencyCode:
    // an occasional extra scheduled refetch is far cheaper than silently gaining
    // an un-invalidated branch here later. One semantic helper shared with the
    // account-update and rate-refresh paths.
    invalidateScheduledFxReadModel();
    // A security's currency, type and tags feed every valuation and weighting,
    // and linking or unlinking a bond program rewrites its stored prices.
    invalidateBalanceCaches();
    return response.data;
  },

  // Deactivate security
  deactivateSecurity: async (id: string): Promise<Security> => {
    const response = await apiClient.post<Security>(`/securities/${id}/deactivate`);
    return response.data;
  },

  // Activate security
  activateSecurity: async (id: string): Promise<Security> => {
    const response = await apiClient.post<Security>(`/securities/${id}/activate`);
    return response.data;
  },

  // Delete security (only if no holdings or transactions reference it)
  deleteSecurity: async (id: string): Promise<void> => {
    await apiClient.delete(`/securities/${id}`);
  },

  // Get security IDs that have investment transactions
  getUsedSecurityIds: async (): Promise<string[]> => {
    const response = await apiClient.get<string[]>('/securities/used');
    return response.data;
  },

  // Search securities
  searchSecurities: async (query: string): Promise<Security[]> => {
    const response = await apiClient.get<Security[]>('/securities/search', {
      params: { q: query },
    });
    return response.data;
  },

  /** Read a web page's price table the way the html_table provider will; stores nothing. */
  previewQuoteTable: async (url: string): Promise<QuoteTablePreview> => {
    const response = await apiClient.post<QuoteTablePreview>('/quote-tables/preview', {
      url,
    });
    return response.data;
  },

  // Lookup security info from Yahoo Finance
  lookupSecurity: async (
    query: string,
    preferredExchanges?: string[],
    provider?: 'yahoo' | 'msn' | 'auto',
  ): Promise<{
    symbol: string;
    name: string;
    exchange: string | null;
    securityType: string | null;
    currencyCode: string | null;
    provider?: 'yahoo' | 'msn';
    msnInstrumentId?: string | null;
  } | null> => {
    const params: Record<string, string> = { q: query };
    if (preferredExchanges && preferredExchanges.length > 0) {
      params.exchanges = preferredExchanges.join(',');
    }
    if (provider) {
      params.provider = provider;
    }
    const response = await apiClient.get('/securities/lookup', {
      params,
    });
    return response.data;
  },

  lookupSecurityCandidates: async (
    query: string,
    preferredExchanges?: string[],
    provider?: 'yahoo' | 'msn' | 'lse' | 'deutsche_boerse' | 'auto',
  ): Promise<
    Array<{
      symbol: string;
      name: string;
      exchange: string | null;
      securityType: string | null;
      currencyCode: string | null;
      provider?: 'yahoo' | 'msn' | 'lse' | 'deutsche_boerse';
      msnInstrumentId?: string | null;
    }>
  > => {
    const params: Record<string, string> = { q: query };
    if (preferredExchanges && preferredExchanges.length > 0) {
      params.exchanges = preferredExchanges.join(',');
    }
    if (provider) {
      params.provider = provider;
    }
    const response = await apiClient.get('/securities/lookup/candidates', {
      params,
    });
    return response.data || [];
  },

  // Refresh all security prices from Yahoo Finance
  refreshPrices: async (): Promise<{
    totalSecurities: number;
    updated: number;
    failed: number;
    skipped: number;
    results: Array<{
      symbol: string;
      success: boolean;
      price?: number;
      error?: string;
    }>;
    lastUpdated: string;
  }> => {
    // The default 10s axios timeout is too short for this endpoint -- it
    // hits Yahoo Finance once per active security and can easily exceed
    // 10s for larger catalogs. Give it 2 minutes.
    const response = await apiClient.post('/securities/prices/refresh', undefined, {
      timeout: 120_000,
    });
    invalidateCache('investments:');
    return response.data;
  },

  // Refresh prices for specific securities only
  refreshSelectedPrices: async (securityIds: string[]): Promise<{
    totalSecurities: number;
    updated: number;
    failed: number;
    skipped: number;
    results: Array<{
      symbol: string;
      success: boolean;
      price?: number;
      error?: string;
    }>;
    lastUpdated: string;
  }> => {
    const response = await apiClient.post(
      '/securities/prices/refresh/selected',
      { securityIds },
      { timeout: 120_000 },
    );
    // Only when a price was actually written. A refresh that updated nothing
    // (market closed, every quote refused, nothing eligible) leaves every
    // cached investments answer true, and dropping them makes the page pay for
    // a valuation it already had.
    if (response.data?.updated > 0) invalidateCache('investments:');
    return response.data;
  },

  // Force-refresh historical prices for a single security across the full
  // period the user has held it, overwriting existing rows.
  //
  // `range` asks for a fixed history window instead ('5y', 'max', ...), which
  // also drops the holding-period clip: without it the write stops at the first
  // transaction date, so a security bought recently can hold no history from
  // before the purchase — which is what a backtest or the GEM report needs.
  backfillSecurityPrices: async (
    securityId: string,
    range?: BackfillRange,
  ): Promise<{
    symbol: string;
    success: boolean;
    pricesLoaded?: number;
    error?: string;
    provider?: string;
  }> => {
    // Hits the quote provider for the security's full history, so give it the
    // same generous timeout as the bulk refresh endpoints.
    const response = await apiClient.post(
      `/securities/${securityId}/prices/backfill`,
      undefined,
      { timeout: 120_000, params: range ? { range } : undefined },
    );
    // Stored closes value every holding, same as a manual price write.
    invalidateBalanceCaches();
    return response.data;
  },

  // Get price update status
  getPriceStatus: async (): Promise<{ lastUpdated: string | null }> => {
    const response = await apiClient.get('/securities/prices/status');
    return response.data;
  },

  // Quote provider configuration status (e.g. whether MSN_API_KEY is set)
  getProviderStatus: async (): Promise<{
    yahoo: { ready: boolean };
    msn: { ready: boolean };
  }> => {
    const response = await apiClient.get<{
      yahoo: { ready: boolean };
      msn: { ready: boolean };
    }>('/securities/providers/status');
    return response.data;
  },

  // Get price history for a security
  getSecurityNews: async (securityId: string): Promise<SecurityNewsResult> => {
    const response = await apiClient.get<SecurityNewsResult>(
      `/securities/${securityId}/news`,
    );
    return response.data;
  },

  getSecurityDocuments: async (securityId: string): Promise<SecurityDocument[]> => {
    const response = await apiClient.get<SecurityDocument[]>(
      `/securities/${securityId}/documents`,
    );
    return response.data;
  },

  createSecurityDocument: async (
    securityId: string,
    data: CreateSecurityDocumentData,
  ): Promise<SecurityDocument> => {
    const response = await apiClient.post<SecurityDocument>(
      `/securities/${securityId}/documents`,
      data,
    );
    return response.data;
  },

  updateSecurityDocument: async (
    securityId: string,
    documentId: string,
    data: Partial<CreateSecurityDocumentData>,
  ): Promise<SecurityDocument> => {
    const response = await apiClient.patch<SecurityDocument>(
      `/securities/${securityId}/documents/${documentId}`,
      data,
    );
    return response.data;
  },

  deleteSecurityDocument: async (
    securityId: string,
    documentId: string,
  ): Promise<void> => {
    await apiClient.delete(`/securities/${securityId}/documents/${documentId}`);
  },

  /**
   * Stored closes for a security.
   *
   * Prefer a date window over a `limit`. The rows come back newest-first, so a
   * limit shorter than the history silently drops its oldest end -- which is
   * the opposite of what a chart asking for "the last five years" wants, and
   * invisible in the response. A windowed request returns the whole window.
   *
   * The window is part of the cache key: two different windows are two
   * different answers, and sharing an entry between them would serve one for
   * the other.
   */
  getSecurityPrices: async (
    securityId: string,
    options: { startDate?: string; endDate?: string; limit?: number } = {},
  ): Promise<SecurityPrice[]> => {
    const { startDate = '', endDate = '', limit } = options;
    const cacheKey = `investments:prices:${securityId}:${startDate}:${endDate}:${limit ?? ''}`;
    return dedupe(cacheKey, async () => {
      const response = await apiClient.get<SecurityPrice[]>(`/securities/${securityId}/prices`, {
        params: {
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
      });
      return response.data;
    }, 60_000);
  },

  /**
   * The benchmark catalog, with the history actually stored for each entry so
   * the picker can grey out an index that cannot yet be drawn.
   */
  getMarketIndexes: async (): Promise<MarketIndex[]> => {
    const cacheKey = 'investments:market-indexes';
    return dedupe(cacheKey, async () => {
      const response = await apiClient.get<MarketIndex[]>('/investments/performance/indexes');
      return response.data;
    }, 300_000);
  },

  /**
   * Cumulative percent return for securities and indexes over one window.
   *
   * Deliberately uncached: the response carries `excluded` and `status`, which
   * change as the provider backfills an index, and serving a stale "we could
   * not price this" is worse than a round trip.
   */
  getPerformanceComparison: async (params: {
    securityIds?: string[];
    indexCodes?: string[];
    startDate?: string;
    endDate?: string;
  }): Promise<PerformanceComparison> => {
    const response = await apiClient.get<PerformanceComparison>(
      '/investments/performance/comparison',
      {
        params: {
          ...(params.securityIds?.length ? { securityIds: params.securityIds.join(',') } : {}),
          ...(params.indexCodes?.length ? { indexCodes: params.indexCodes.join(',') } : {}),
          ...(params.startDate ? { startDate: params.startDate } : {}),
          ...(params.endDate ? { endDate: params.endDate } : {}),
        },
      },
    );
    return response.data;
  },

  // The catalog's programs, for the security form's program picker. Reference
  // data, identical for every user, so it is not cached per user here.
  listBondPrograms: async (): Promise<BondProgramSummary[]> => {
    const response = await apiClient.get<BondProgramSummary[]>('/bonds/programs');
    return response.data;
  },

  // The bond catalog's series, for the transaction form's series picker.
  // Reference data, identical for every user, so it is not cached per user here.
  listBondInstruments: async (): Promise<BondInstrumentSummary[]> => {
    const response = await apiClient.get<BondInstrumentSummary[]>('/bonds/instruments');
    return response.data;
  },

  // Reads a series from the official source into the catalog (or finds it
  // already stored). Reference data, so no per-user cache to invalidate.
  fetchBondSeries: async (
    countryCode: string,
    seriesCode: string,
  ): Promise<FetchBondSeriesResult> => {
    const response = await apiClient.post<FetchBondSeriesResult>(
      '/bonds/instruments/fetch',
      { countryCode, seriesCode },
    );
    return response.data;
  },

  // The series on sale today with what 100 of face value is worth at maturity.
  // Reference data plus the engine, identical for every user. `assume` replaces
  // the latest observation of a benchmark for every period that has not started
  // (`<benchmarkId>:<fraction>`), so it is part of the request, not a cache key.
  getBondOffer: async (
    countryCode: string,
    assume?: BondAssumption[],
  ): Promise<BondOffer> => {
    const params: Record<string, string> = { countryCode };
    if (assume && assume.length > 0) {
      params.assume = assume.map((a) => `${a.benchmarkId}:${a.value}`).join(',');
    }
    const response = await apiClient.get<BondOffer>('/bonds/offer', { params });
    return response.data;
  },

  // How the terms of a program (or of every program) changed from one sale
  // month to the next, with the months the catalog does not hold.
  getBondHistory: async (
    countryCode: string,
    programCode?: string,
  ): Promise<BondHistory> => {
    const params: Record<string, string> = { countryCode };
    if (programCode) params.programCode = programCode;
    const response = await apiClient.get<BondHistory>('/bonds/history', { params });
    return response.data;
  },

  // The open lots of a bond-linked security valued on `asOf` (the server's
  // today when omitted). Uncached: a trade or a price write changes it.
  // `assume` projects every period that has not started at that benchmark value.
  getSecurityBondValuation: async (
    securityId: string,
    asOf?: string,
    assume?: BondAssumption,
  ): Promise<SecurityBondValuation> => {
    const params: Record<string, string> = {};
    if (asOf) params.asOf = asOf;
    if (assume) params.assume = `${assume.benchmarkId}:${assume.value}`;
    const response = await apiClient.get<SecurityBondValuation>(
      `/bonds/securities/${securityId}/valuation`,
      { params: Object.keys(params).length > 0 ? params : undefined },
    );
    return response.data;
  },

  // The series the server would infer for a BUY/REINVEST of the security on
  // `date`; null when no stored series was on sale. Uncached: a fetch changes it.
  getBondSeriesOnSale: async (
    securityId: string,
    date: string,
  ): Promise<BondSeriesOnSale | null> => {
    const response = await apiClient.get<BondSeriesOnSale | null>(
      `/bonds/securities/${securityId}/series-on-sale`,
      { params: { date } },
    );
    return response.data ?? null;
  },

  // The series code a purchase on `date` would carry, by the grammar of the
  // security's program's country; nothing is fetched or stored.
  getExpectedBondSeries: async (
    securityId: string,
    date: string,
  ): Promise<BondExpectedSeries> => {
    const response = await apiClient.get<BondExpectedSeries>(
      `/bonds/securities/${securityId}/expected-series`,
      { params: { date } },
    );
    return response.data;
  },

  // What redeeming `quantity` bonds of a series out of an account on `date` pays,
  // split into returned principal and interest (the lots the removal takes, the
  // engine's figures). `excludeTransactionId` leaves the row being edited out. A
  // 400 carries the removal refusal as `errorCode`. Uncached: a trade changes it.
  getBondRedemptionSplit: async (
    securityId: string,
    params: {
      accountId: string;
      bondInstrumentId: string;
      date: string;
      quantity: number;
      excludeTransactionId?: string;
    },
  ): Promise<BondRedemptionSplit> => {
    const { excludeTransactionId, ...rest } = params;
    const response = await apiClient.get<BondRedemptionSplit>(
      `/bonds/securities/${securityId}/redemption-split`,
      { params: { ...rest, ...(excludeTransactionId ? { excludeTransactionId } : {}) } },
    );
    return response.data;
  },

  // The series (and quantities) the account holds of the security on `date`,
  // for a removal's series picker. `excludeTransactionId` leaves the row being
  // edited out. A 422 carries the lots refusal code. Uncached: a trade changes it.
  getBondSeriesHoldings: async (
    securityId: string,
    accountId: string,
    date: string,
    excludeTransactionId?: string,
  ): Promise<BondSeriesHoldings> => {
    const response = await apiClient.get<BondSeriesHoldings>(
      `/bonds/securities/${securityId}/series-holdings`,
      {
        params: {
          accountId,
          date,
          ...(excludeTransactionId ? { excludeTransactionId } : {}),
        },
      },
    );
    return response.data;
  },

  // The lots valued on `asOf` (the server's today when omitted) under each assumed value (fractions, 1 to 6) of the
  // benchmark, in one request. Uncached for the same reason as the valuation.
  getSecurityBondScenarios: async (
    securityId: string,
    benchmarkId: string,
    values: readonly string[],
    asOf?: string,
  ): Promise<SecurityBondScenarios> => {
    const response = await apiClient.get<SecurityBondScenarios>(
      `/bonds/securities/${securityId}/scenarios`,
      {
        params: {
          benchmarkId,
          values: values.join(','),
          ...(asOf ? { asOf } : {}),
        },
      },
    );
    return response.data;
  },

  // How far the server's synchronous fetch for a bond program has got. Polled
  // while a Refresh runs, so it is never cached.
  getBondRefreshProgress: async (programId: string): Promise<BondRefreshProgress> => {
    const response = await apiClient.get<BondRefreshProgress>(
      `/bonds/programs/${programId}/refresh-progress`,
    );
    return response.data;
  },

  // Write the bond engine's daily prices for a linked security. Drops the
  // cached investments answers only when a row was actually written or removed:
  // a recompute that agreed with what is stored changed nothing to re-read.
  recomputeSecurityBondPrices: async (
    securityId: string,
  ): Promise<BondPriceRecompute> => {
    const response = await apiClient.post<BondPriceRecompute>(
      `/bonds/securities/${securityId}/recompute`,
    );
    if (response.data?.written > 0 || response.data?.deleted > 0) {
      invalidateCache('investments:');
    }
    return response.data;
  },

  // Create a manual price entry for a security
  createSecurityPrice: async (securityId: string, data: CreateSecurityPriceData): Promise<SecurityPrice> => {
    const response = await apiClient.post<SecurityPrice>(`/securities/${securityId}/prices`, data);
    // A stored close values every holding, so every total is stale, not only the price reads.
    invalidateBalanceCaches();
    return response.data;
  },

  // Update a price entry
  updateSecurityPrice: async (securityId: string, priceId: number, data: Partial<CreateSecurityPriceData>): Promise<SecurityPrice> => {
    const response = await apiClient.patch<SecurityPrice>(`/securities/${securityId}/prices/${priceId}`, data);
    invalidateBalanceCaches();
    return response.data;
  },

  // Delete a price entry
  deleteSecurityPrice: async (securityId: string, priceId: number): Promise<void> => {
    await apiClient.delete(`/securities/${securityId}/prices/${priceId}`);
    invalidateBalanceCaches();
  },

  // Get sector weightings
  getSectorWeightings: async (accountIds?: string[], securityIds?: string[]): Promise<SectorWeightingResult> => {
    const params: Record<string, string> = {};
    if (accountIds && accountIds.length > 0) params.accountIds = accountIds.join(',');
    if (securityIds && securityIds.length > 0) params.securityIds = securityIds.join(',');
    const cacheKey = `investments:sectorWeightings:${params.accountIds || 'all'}:${params.securityIds || 'all'}`;
    return dedupe(cacheKey, async () => {
      const response = await apiClient.get<SectorWeightingResult>('/portfolio/sector-weightings', {
        params: Object.keys(params).length > 0 ? params : undefined,
      });
      return response.data;
    }, 60_000);
  },

  getCountryWeightings: async (accountIds?: string[], securityIds?: string[]): Promise<CountryWeightingResult> => {
    const params: Record<string, string> = {};
    if (accountIds && accountIds.length > 0) params.accountIds = accountIds.join(',');
    if (securityIds && securityIds.length > 0) params.securityIds = securityIds.join(',');
    const cacheKey = `investments:countryWeightings:${params.accountIds || 'all'}:${params.securityIds || 'all'}`;
    return dedupe(cacheKey, async () => {
      const response = await apiClient.get<CountryWeightingResult>('/portfolio/country-weightings', {
        params: Object.keys(params).length > 0 ? params : undefined,
      });
      return response.data;
    }, 60_000);
  },

  // Asset-class look-through: funds split by the manual asset allocation saved
  // on the security, everything else placed by security type.
  getAssetClassWeightings: async (accountIds?: string[], securityIds?: string[]): Promise<AssetClassWeightingResult> => {
    const params: Record<string, string> = {};
    if (accountIds && accountIds.length > 0) params.accountIds = accountIds.join(',');
    if (securityIds && securityIds.length > 0) params.securityIds = securityIds.join(',');
    const cacheKey = `investments:assetClassWeightings:${params.accountIds || 'all'}:${params.securityIds || 'all'}`;
    return dedupe(cacheKey, async () => {
      const response = await apiClient.get<AssetClassWeightingResult>('/portfolio/asset-class-weightings', {
        params: Object.keys(params).length > 0 ? params : undefined,
      });
      return response.data;
    }, 60_000);
  },
};
