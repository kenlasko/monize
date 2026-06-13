import apiClient from './api';
import { Account } from '@/types/account';
import {
  PortfolioSummary,
  AssetAllocation,
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
  SecurityPrice,
  SecurityTransactionHistory,
} from '@/types/investment';
import { getCached, setCache, invalidateCache } from './apiCache';

export const investmentsApi = {
  // Get portfolio summary
  getPortfolioSummary: async (accountIds?: string[]): Promise<PortfolioSummary> => {
    const cacheKey = `investments:summary:${accountIds?.join(',') || 'all'}`;
    const cached = getCached<PortfolioSummary>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<PortfolioSummary>('/portfolio/summary', {
      params: accountIds && accountIds.length > 0 ? { accountIds: accountIds.join(',') } : undefined,
    });
    setCache(cacheKey, response.data, 60_000);
    return response.data;
  },

  // Get asset allocation
  getAssetAllocation: async (accountIds?: string[]): Promise<AssetAllocation> => {
    const cacheKey = `investments:allocation:${accountIds?.join(',') || 'all'}`;
    const cached = getCached<AssetAllocation>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<AssetAllocation>('/portfolio/allocation', {
      params: accountIds && accountIds.length > 0 ? { accountIds: accountIds.join(',') } : undefined,
    });
    setCache(cacheKey, response.data, 60_000);
    return response.data;
  },

  // Get all investment accounts
  getInvestmentAccounts: async (): Promise<Account[]> => {
    const cacheKey = 'investments:accounts';
    const cached = getCached<Account[]>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<Account[]>('/portfolio/accounts');
    setCache(cacheKey, response.data);
    return response.data;
  },

  // Intraday portfolio value series (1D / 1W / 1M ranges).
  // Bypasses apiCache; the chart caches in sessionStorage instead so a manual
  // Refresh can selectively invalidate just the intraday entries.
  getIntradayValue: async (params: {
    range: '1d' | '1w' | '1m';
    accountIds?: string;
    displayCurrency?: string;
  }): Promise<{
    points: Array<{ timestamp: string; value: number }>;
    interval: '1m' | '2m' | '5m' | '15m' | '30m' | '60m' | '90m';
    currency: string;
    range: '1d' | '1w' | '1m';
    fetchedAt: string;
    skippedSymbols: string[];
    failedSymbols: string[];
    fallbackToDaily: boolean;
  }> => {
    const response = await apiClient.get('/portfolio/intraday-value', { params });
    return response.data;
  },

  // Get top movers (daily price changes)
  getTopMovers: async (): Promise<TopMover[]> => {
    const cacheKey = 'investments:topMovers';
    const cached = getCached<TopMover[]>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<TopMover[]>('/portfolio/top-movers');
    setCache(cacheKey, response.data, 60_000);
    return response.data;
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
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }): Promise<PaginatedInvestmentTransactions> => {
    const response = await apiClient.get<PaginatedInvestmentTransactions>(
      '/investment-transactions',
      { params },
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
    invalidateCache('investments:');
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
    invalidateCache('investments:');
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
    invalidateCache('investments:');
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
    invalidateCache('investments:');
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
    const cached = getCached<FavouriteSecurityQuote[]>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<FavouriteSecurityQuote[]>('/securities/favourites');
    setCache(cacheKey, response.data, 60_000);
    return response.data;
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

  // Create security
  createSecurity: async (data: CreateSecurityData): Promise<Security> => {
    const response = await apiClient.post<Security>('/securities', data);
    return response.data;
  },

  // Update security
  updateSecurity: async (id: string, data: Partial<CreateSecurityData>): Promise<Security> => {
    const response = await apiClient.patch<Security>(`/securities/${id}`, data);
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
    provider?: 'yahoo' | 'msn' | 'auto',
  ): Promise<
    Array<{
      symbol: string;
      name: string;
      exchange: string | null;
      securityType: string | null;
      currencyCode: string | null;
      provider?: 'yahoo' | 'msn';
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
    invalidateCache('investments:');
    return response.data;
  },

  // Force-refresh historical prices for a single security across the full
  // period the user has held it, overwriting existing rows.
  backfillSecurityPrices: async (
    securityId: string,
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
      { timeout: 120_000 },
    );
    invalidateCache('investments:');
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
  getSecurityPrices: async (securityId: string, limit = 365): Promise<SecurityPrice[]> => {
    const cacheKey = `investments:prices:${securityId}:${limit}`;
    const cached = getCached<SecurityPrice[]>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<SecurityPrice[]>(`/securities/${securityId}/prices`, {
      params: { limit },
    });
    setCache(cacheKey, response.data, 60_000);
    return response.data;
  },

  // Create a manual price entry for a security
  createSecurityPrice: async (securityId: string, data: CreateSecurityPriceData): Promise<SecurityPrice> => {
    const response = await apiClient.post<SecurityPrice>(`/securities/${securityId}/prices`, data);
    invalidateCache('investments:prices:');
    return response.data;
  },

  // Update a price entry
  updateSecurityPrice: async (securityId: string, priceId: number, data: Partial<CreateSecurityPriceData>): Promise<SecurityPrice> => {
    const response = await apiClient.patch<SecurityPrice>(`/securities/${securityId}/prices/${priceId}`, data);
    invalidateCache('investments:prices:');
    return response.data;
  },

  // Delete a price entry
  deleteSecurityPrice: async (securityId: string, priceId: number): Promise<void> => {
    await apiClient.delete(`/securities/${securityId}/prices/${priceId}`);
    invalidateCache('investments:prices:');
  },

  // Get sector weightings
  getSectorWeightings: async (accountIds?: string[], securityIds?: string[]): Promise<SectorWeightingResult> => {
    const params: Record<string, string> = {};
    if (accountIds && accountIds.length > 0) params.accountIds = accountIds.join(',');
    if (securityIds && securityIds.length > 0) params.securityIds = securityIds.join(',');
    const cacheKey = `investments:sectorWeightings:${params.accountIds || 'all'}:${params.securityIds || 'all'}`;
    const cached = getCached<SectorWeightingResult>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<SectorWeightingResult>('/portfolio/sector-weightings', {
      params: Object.keys(params).length > 0 ? params : undefined,
    });
    setCache(cacheKey, response.data, 60_000);
    return response.data;
  },
};
