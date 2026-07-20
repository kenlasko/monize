import apiClient from './api';
import { dedupe, invalidateCache } from './apiCache';

export interface ExchangeRate {
  id: number;
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  rateDate: string;
  source: string;
}

export interface CurrencyInfo {
  code: string;
  name: string;
  symbol: string;
  decimalPlaces: number;
  isActive: boolean;
  isSystem: boolean;
  createdAt: string;
}

export interface CreateCurrencyData {
  code: string;
  name: string;
  symbol: string;
  decimalPlaces?: number;
  isActive?: boolean;
}

export interface UpdateCurrencyData {
  name?: string;
  symbol?: string;
  decimalPlaces?: number;
  isActive?: boolean;
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

  refreshRates: async () => {
    invalidateCache('exchange-rates:');
    const response = await apiClient.post('/currencies/exchange-rates/refresh');
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
