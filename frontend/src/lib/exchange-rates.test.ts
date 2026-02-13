import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { exchangeRatesApi } from './exchange-rates';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('exchangeRatesApi', () => {
  beforeEach(() => vi.clearAllMocks());

  // --- Exchange rates ---

  describe('getLatestRates', () => {
    it('fetches /currencies/exchange-rates', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: [{ rate: 1.36 }] });
      const result = await exchangeRatesApi.getLatestRates();
      expect(apiClient.get).toHaveBeenCalledWith('/currencies/exchange-rates');
      expect(result).toHaveLength(1);
    });

    it('returns the full list of exchange rate objects', async () => {
      const mockRates = [
        { id: 1, fromCurrency: 'USD', toCurrency: 'EUR', rate: 0.92, rateDate: '2025-01-15', source: 'ecb' },
        { id: 2, fromCurrency: 'USD', toCurrency: 'GBP', rate: 0.79, rateDate: '2025-01-15', source: 'ecb' },
      ];
      vi.mocked(apiClient.get).mockResolvedValue({ data: mockRates });
      const result = await exchangeRatesApi.getLatestRates();
      expect(result).toEqual(mockRates);
    });

    it('returns empty array when no rates exist', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
      const result = await exchangeRatesApi.getLatestRates();
      expect(result).toEqual([]);
    });
  });

  describe('getRateHistory', () => {
    it('fetches with date params', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
      await exchangeRatesApi.getRateHistory('2025-01-01', '2025-01-31');
      expect(apiClient.get).toHaveBeenCalledWith('/currencies/exchange-rates/history', {
        params: { startDate: '2025-01-01', endDate: '2025-01-31' },
      });
    });

    it('fetches without params when none provided', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
      await exchangeRatesApi.getRateHistory();
      expect(apiClient.get).toHaveBeenCalledWith('/currencies/exchange-rates/history', {
        params: { startDate: undefined, endDate: undefined },
      });
    });

    it('returns rate history data', async () => {
      const mockHistory = [
        { id: 1, fromCurrency: 'USD', toCurrency: 'EUR', rate: 0.91, rateDate: '2025-01-01', source: 'ecb' },
        { id: 2, fromCurrency: 'USD', toCurrency: 'EUR', rate: 0.92, rateDate: '2025-01-15', source: 'ecb' },
      ];
      vi.mocked(apiClient.get).mockResolvedValue({ data: mockHistory });
      const result = await exchangeRatesApi.getRateHistory('2025-01-01', '2025-01-31');
      expect(result).toEqual(mockHistory);
      expect(result).toHaveLength(2);
    });

    it('fetches with only startDate', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
      await exchangeRatesApi.getRateHistory('2025-01-01');
      expect(apiClient.get).toHaveBeenCalledWith('/currencies/exchange-rates/history', {
        params: { startDate: '2025-01-01', endDate: undefined },
      });
    });
  });

  describe('refreshRates', () => {
    it('posts to /currencies/exchange-rates/refresh', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: { updated: 5 } });
      const result = await exchangeRatesApi.refreshRates();
      expect(apiClient.post).toHaveBeenCalledWith('/currencies/exchange-rates/refresh');
      expect(result.updated).toBe(5);
    });

    it('returns the response data from refresh', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ data: { updated: 0, message: 'No rates to update' } });
      const result = await exchangeRatesApi.refreshRates();
      expect(result.updated).toBe(0);
      expect(result.message).toBe('No rates to update');
    });
  });

  // --- Currency CRUD ---

  describe('getCurrencies', () => {
    it('fetches /currencies without includeInactive', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: [{ code: 'USD' }] });
      const result = await exchangeRatesApi.getCurrencies();
      expect(apiClient.get).toHaveBeenCalledWith('/currencies', { params: undefined });
      expect(result).toHaveLength(1);
    });

    it('passes includeInactive when true', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: [{ code: 'USD' }] });
      await exchangeRatesApi.getCurrencies(true);
      expect(apiClient.get).toHaveBeenCalledWith('/currencies', { params: { includeInactive: true } });
    });

    it('does not pass includeInactive when false', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
      await exchangeRatesApi.getCurrencies(false);
      expect(apiClient.get).toHaveBeenCalledWith('/currencies', { params: undefined });
    });
  });

  describe('createCurrency', () => {
    it('posts new currency to /currencies', async () => {
      const newCurrency = { code: 'BTC', name: 'Bitcoin', symbol: 'B', decimalPlaces: 8 };
      const mockResponse = { ...newCurrency, isActive: true, createdAt: '2025-01-15T00:00:00Z' };
      vi.mocked(apiClient.post).mockResolvedValue({ data: mockResponse });

      const result = await exchangeRatesApi.createCurrency(newCurrency);
      expect(apiClient.post).toHaveBeenCalledWith('/currencies', newCurrency);
      expect(result.code).toBe('BTC');
      expect(result.name).toBe('Bitcoin');
    });

    it('creates currency with minimal fields', async () => {
      const minCurrency = { code: 'XYZ', name: 'Test', symbol: 'X' };
      vi.mocked(apiClient.post).mockResolvedValue({ data: { ...minCurrency, decimalPlaces: 2, isActive: true, createdAt: '2025-01-15' } });

      const result = await exchangeRatesApi.createCurrency(minCurrency);
      expect(apiClient.post).toHaveBeenCalledWith('/currencies', minCurrency);
      expect(result.decimalPlaces).toBe(2);
    });

    it('creates currency with isActive set to false', async () => {
      const data = { code: 'OLD', name: 'Old Currency', symbol: 'O', isActive: false };
      vi.mocked(apiClient.post).mockResolvedValue({ data: { ...data, decimalPlaces: 2, createdAt: '2025-01-15' } });

      const result = await exchangeRatesApi.createCurrency(data);
      expect(apiClient.post).toHaveBeenCalledWith('/currencies', data);
      expect(result.isActive).toBe(false);
    });
  });

  describe('updateCurrency', () => {
    it('patches currency by code', async () => {
      const updates = { name: 'US Dollar Updated', symbol: '$' };
      const mockResponse = { code: 'USD', name: 'US Dollar Updated', symbol: '$', decimalPlaces: 2, isActive: true, createdAt: '2025-01-01' };
      vi.mocked(apiClient.patch).mockResolvedValue({ data: mockResponse });

      const result = await exchangeRatesApi.updateCurrency('USD', updates);
      expect(apiClient.patch).toHaveBeenCalledWith('/currencies/USD', updates);
      expect(result.name).toBe('US Dollar Updated');
    });

    it('updates only the symbol', async () => {
      const updates = { symbol: 'US$' };
      vi.mocked(apiClient.patch).mockResolvedValue({ data: { code: 'USD', name: 'US Dollar', symbol: 'US$', decimalPlaces: 2, isActive: true, createdAt: '2025-01-01' } });

      const result = await exchangeRatesApi.updateCurrency('USD', updates);
      expect(apiClient.patch).toHaveBeenCalledWith('/currencies/USD', updates);
      expect(result.symbol).toBe('US$');
    });

    it('updates decimalPlaces', async () => {
      const updates = { decimalPlaces: 4 };
      vi.mocked(apiClient.patch).mockResolvedValue({ data: { code: 'BTC', name: 'Bitcoin', symbol: 'B', decimalPlaces: 4, isActive: true, createdAt: '2025-01-01' } });

      const result = await exchangeRatesApi.updateCurrency('BTC', updates);
      expect(apiClient.patch).toHaveBeenCalledWith('/currencies/BTC', updates);
      expect(result.decimalPlaces).toBe(4);
    });
  });

  describe('activateCurrency', () => {
    it('posts to /currencies/:code/activate', async () => {
      const mockResponse = { code: 'EUR', name: 'Euro', symbol: 'E', decimalPlaces: 2, isActive: true, createdAt: '2025-01-01' };
      vi.mocked(apiClient.post).mockResolvedValue({ data: mockResponse });

      const result = await exchangeRatesApi.activateCurrency('EUR');
      expect(apiClient.post).toHaveBeenCalledWith('/currencies/EUR/activate');
      expect(result.isActive).toBe(true);
      expect(result.code).toBe('EUR');
    });
  });

  describe('deactivateCurrency', () => {
    it('posts to /currencies/:code/deactivate', async () => {
      const mockResponse = { code: 'EUR', name: 'Euro', symbol: 'E', decimalPlaces: 2, isActive: false, createdAt: '2025-01-01' };
      vi.mocked(apiClient.post).mockResolvedValue({ data: mockResponse });

      const result = await exchangeRatesApi.deactivateCurrency('EUR');
      expect(apiClient.post).toHaveBeenCalledWith('/currencies/EUR/deactivate');
      expect(result.isActive).toBe(false);
      expect(result.code).toBe('EUR');
    });
  });

  describe('deleteCurrency', () => {
    it('deletes currency by code', async () => {
      vi.mocked(apiClient.delete).mockResolvedValue({ data: undefined });

      await exchangeRatesApi.deleteCurrency('XYZ');
      expect(apiClient.delete).toHaveBeenCalledWith('/currencies/XYZ');
    });

    it('resolves without returning data', async () => {
      vi.mocked(apiClient.delete).mockResolvedValue({ data: undefined });

      const result = await exchangeRatesApi.deleteCurrency('OLD');
      expect(result).toBeUndefined();
    });
  });

  describe('lookupCurrency', () => {
    it('looks up currency with query param', async () => {
      const mockResult = { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2 };
      vi.mocked(apiClient.get).mockResolvedValue({ data: mockResult });

      const result = await exchangeRatesApi.lookupCurrency('dollar');
      expect(apiClient.get).toHaveBeenCalledWith('/currencies/lookup', {
        params: { q: 'dollar' },
      });
      expect(result).toEqual(mockResult);
    });

    it('returns null when currency not found', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: null });

      const result = await exchangeRatesApi.lookupCurrency('nonexistent');
      expect(apiClient.get).toHaveBeenCalledWith('/currencies/lookup', {
        params: { q: 'nonexistent' },
      });
      expect(result).toBeNull();
    });

    it('looks up by currency code', async () => {
      const mockResult = { code: 'GBP', name: 'British Pound', symbol: 'P', decimalPlaces: 2 };
      vi.mocked(apiClient.get).mockResolvedValue({ data: mockResult });

      const result = await exchangeRatesApi.lookupCurrency('GBP');
      expect(apiClient.get).toHaveBeenCalledWith('/currencies/lookup', {
        params: { q: 'GBP' },
      });
      expect(result?.code).toBe('GBP');
    });
  });

  describe('getCurrencyUsage', () => {
    it('fetches currency usage', async () => {
      const mockUsage = { USD: { accounts: 3, securities: 1 }, EUR: { accounts: 1, securities: 0 } };
      vi.mocked(apiClient.get).mockResolvedValue({ data: mockUsage });

      const result = await exchangeRatesApi.getCurrencyUsage();
      expect(apiClient.get).toHaveBeenCalledWith('/currencies/usage');
      expect(result.USD.accounts).toBe(3);
      expect(result.EUR.securities).toBe(0);
    });

    it('returns empty object when no currencies in use', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: {} });

      const result = await exchangeRatesApi.getCurrencyUsage();
      expect(result).toEqual({});
    });
  });
});
