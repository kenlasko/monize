import apiClient from './api';

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
    const response = await apiClient.get<ExchangeRate[]>('/currencies/exchange-rates');
    return response.data;
  },

  getRateHistory: async (startDate?: string, endDate?: string): Promise<ExchangeRate[]> => {
    const response = await apiClient.get<ExchangeRate[]>('/currencies/exchange-rates/history', {
      params: { startDate, endDate },
    });
    return response.data;
  },

  refreshRates: async () => {
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
