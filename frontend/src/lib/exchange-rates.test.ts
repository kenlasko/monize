import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { exchangeRatesApi } from './exchange-rates';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

describe('exchangeRatesApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getLatestRates fetches /currencies/exchange-rates', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ rate: 1.36 }] });
    const result = await exchangeRatesApi.getLatestRates();
    expect(apiClient.get).toHaveBeenCalledWith('/currencies/exchange-rates');
    expect(result).toHaveLength(1);
  });

  it('getRateHistory fetches with date params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await exchangeRatesApi.getRateHistory('2025-01-01', '2025-01-31');
    expect(apiClient.get).toHaveBeenCalledWith('/currencies/exchange-rates/history', {
      params: { startDate: '2025-01-01', endDate: '2025-01-31' },
    });
  });

  it('refreshRates posts to /currencies/exchange-rates/refresh', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { updated: 5 } });
    const result = await exchangeRatesApi.refreshRates();
    expect(apiClient.post).toHaveBeenCalledWith('/currencies/exchange-rates/refresh');
    expect(result.updated).toBe(5);
  });

  it('getCurrencies fetches /currencies', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ code: 'USD' }] });
    const result = await exchangeRatesApi.getCurrencies();
    expect(apiClient.get).toHaveBeenCalledWith('/currencies');
    expect(result).toHaveLength(1);
  });
});
