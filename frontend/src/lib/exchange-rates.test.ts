import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  exchangeRatesApi,
  FX_PROVIDER_NAMES,
  PAIR_PROVIDER_NAMES,
  isFxProviderName,
  isRateProviderName,
} from './exchange-rates';
import en from '@/i18n/messages/en/currencies.json';
import { scheduledTransactionsApi } from './scheduled-transactions';
import { invalidateCache, setCache, getCached, clearAllCache } from './apiCache';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('exchangeRatesApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCache('exchange-rates:');
    // The scheduled read model is cached across modules; clear it so one test's
    // populated `scheduled:all` cannot serve the next.
    invalidateCache('scheduled:');
  });

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

    it('returns cached result on second call without hitting the API', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: [{ rate: 1.36 }] });
      const first = await exchangeRatesApi.getLatestRates();
      expect(apiClient.get).toHaveBeenCalledTimes(1);
      vi.clearAllMocks();
      const second = await exchangeRatesApi.getLatestRates();
      expect(apiClient.get).not.toHaveBeenCalled();
      expect(second).toEqual(first);
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

  describe('getRateCoverage', () => {
    it('fetches the stored coverage for a code', async () => {
      const coverage = {
        from: 'EUR',
        to: 'PLN',
        earliestDate: '2026-01-02',
        latestDate: '2026-09-16',
        observations: 180,
      };
      vi.mocked(apiClient.get).mockResolvedValue({ data: coverage });

      const result = await exchangeRatesApi.getRateCoverage('EUR');

      expect(apiClient.get).toHaveBeenCalledWith(
        '/currencies/exchange-rates/coverage',
        { params: { code: 'EUR' } },
      );
      expect(result).toEqual(coverage);
    });

    // Not deduped: the dialog re-reads it immediately after a fill wrote rows,
    // and a cached answer would report the history it just replaced.
    it('asks the server again on a second call', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: { observations: 0 } });

      await exchangeRatesApi.getRateCoverage('EUR');
      await exchangeRatesApi.getRateCoverage('EUR');

      expect(apiClient.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('getStoredRates', () => {
    it('fetches the stored rates for a code', async () => {
      const listing = {
        from: 'EUR',
        to: 'PLN',
        rates: [
          {
            rateDate: '2026-09-16',
            rate: 4.3,
            source: 'yahoo_finance',
            inverted: false,
          },
        ],
        truncated: false,
        limit: 2000,
      };
      vi.mocked(apiClient.get).mockResolvedValue({ data: listing });

      const result = await exchangeRatesApi.getStoredRates('EUR');

      expect(apiClient.get).toHaveBeenCalledWith(
        '/currencies/exchange-rates/stored',
        { params: { code: 'EUR' } },
      );
      expect(result).toEqual(listing);
    });

    it('asks the server again on a second call', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: { rates: [] } });

      await exchangeRatesApi.getStoredRates('EUR');
      await exchangeRatesApi.getStoredRates('EUR');

      expect(apiClient.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('fillRateGaps', () => {
    it('posts the code and returns the fill summary', async () => {
      const fill = {
        from: 'EUR',
        to: 'PLN',
        usedFrom: '2026-01-01',
        spanEnd: '2026-09-17',
        unresolvableDays: 260,
        windowsPlanned: 1,
        windowsFetched: 1,
        windowsSkipped: 0,
        windowsUnanswered: 0,
        windowsRemaining: 0,
        stored: 240,
        earliestDate: '2025-12-18',
        providerHasNothingBefore: null,
      };
      vi.mocked(apiClient.post).mockResolvedValue({ data: fill });

      const result = await exchangeRatesApi.fillRateGaps('EUR');

      expect(apiClient.post).toHaveBeenCalledWith(
        '/currencies/exchange-rates/fill-gaps',
        { code: 'EUR' },
      );
      expect(result).toEqual(fill);
    });

    it('drops the cached rate reads so a dated lookup sees the new rows', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: [{ rate: 1.36 }] });
      await exchangeRatesApi.getLatestRates();
      expect(apiClient.get).toHaveBeenCalledTimes(1);

      vi.mocked(apiClient.post).mockResolvedValue({ data: { stored: 240 } });
      await exchangeRatesApi.fillRateGaps('EUR');

      await exchangeRatesApi.getLatestRates();
      expect(apiClient.get).toHaveBeenCalledTimes(2);
    });

    it('leaves the cache alone when the request fails', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: [{ rate: 1.36 }] });
      await exchangeRatesApi.getLatestRates();
      vi.mocked(apiClient.post).mockRejectedValue(new Error('503'));

      await expect(exchangeRatesApi.fillRateGaps('EUR')).rejects.toThrow();

      await exchangeRatesApi.getLatestRates();
      expect(apiClient.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('getRateStatus', () => {
    it('fetches /currencies/exchange-rates/status with the providers in order', async () => {
      const status = {
        lastUpdated: '2026-10-12T00:00:00.000Z',
        providers: [
          { name: 'frankfurter', source: 'frankfurter' },
          { name: 'yahoo', source: 'yahoo_finance' },
        ],
      };
      vi.mocked(apiClient.get).mockResolvedValue({ data: status });
      const result = await exchangeRatesApi.getRateStatus();
      expect(apiClient.get).toHaveBeenCalledWith('/currencies/exchange-rates/status');
      expect(result).toEqual(status);
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

    // Issue #1167 close-out: the scheduled read model carries FX-derived forecast
    // fields resolved from these rate snapshots, so a successful refresh must
    // invalidate `scheduled:all` -- otherwise Bills keeps projecting the pre-refresh
    // rate for up to the 120s TTL while posting already resolves the new one. This
    // asserts the actual stale-read behaviour (a second GET), not merely that
    // invalidateCache was called.
    it('invalidates the scheduled forecast read model after a successful refresh', async () => {
      vi.mocked(apiClient.get).mockResolvedValueOnce({
        data: [{ id: 'st-1', investmentForecastExchangeRate: 1.5 }],
      });
      const first = await scheduledTransactionsApi.getAll();
      expect(first[0].investmentForecastExchangeRate).toBe(1.5);
      expect(apiClient.get).toHaveBeenCalledTimes(1);

      // Cached within TTL: no second backend call yet.
      await scheduledTransactionsApi.getAll();
      expect(apiClient.get).toHaveBeenCalledTimes(1);

      vi.mocked(apiClient.post).mockResolvedValue({ data: { updated: 3 } });
      await exchangeRatesApi.refreshRates();

      vi.mocked(apiClient.get).mockResolvedValueOnce({
        data: [{ id: 'st-1', investmentForecastExchangeRate: 1.35 }],
      });
      const refreshed = await scheduledTransactionsApi.getAll();

      expect(apiClient.get).toHaveBeenCalledTimes(2);
      expect(apiClient.get).toHaveBeenLastCalledWith('/scheduled-transactions');
      expect(refreshed[0].investmentForecastExchangeRate).toBe(1.35);
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

  describe('getCurrencyCatalog', () => {
    it('fetches the known-currency catalog from /currencies/catalog', async () => {
      vi.mocked(apiClient.get).mockResolvedValue({
        data: [{ code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2 }],
      });
      const result = await exchangeRatesApi.getCurrencyCatalog();
      expect(apiClient.get).toHaveBeenCalledWith('/currencies/catalog');
      expect(result[0].symbol).toBe('$');
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

/**
 * The provider names are a hand-written copy of the backend's
 * `FX_PROVIDER_NAMES`, and nothing compiles the two against each other. A name
 * the server can configure but the client does not know would show as a bare
 * token on the Currencies page, so this reads the backend file and compares.
 */
describe('FX_PROVIDER_NAMES', () => {
  const BACKEND_PROVIDERS = resolve(
    __dirname,
    '../../../backend/src/currencies/providers/fx-provider.interface.ts',
  );

  function parseBackendNames(constant = 'FX_PROVIDER_NAMES'): string[] {
    const source = readFileSync(BACKEND_PROVIDERS, 'utf8');
    const list = source.match(new RegExp(`export const ${constant} = \\[([^\\]]*)\\] as const`));
    if (!list) {
      throw new Error(
        `${constant} not found in the backend source -- this guard has lost its subject`,
      );
    }
    return [...list[1].matchAll(/["']([a-z0-9_-]+)["']/g)].map((m) => m[1]);
  }

  it('parses the backend lists it is checked against', () => {
    expect(parseBackendNames().length).toBeGreaterThan(0);
    expect(parseBackendNames('PAIR_PROVIDER_NAMES').length).toBeGreaterThan(0);
  });

  it('names exactly the providers the backend declares', () => {
    expect([...FX_PROVIDER_NAMES].sort()).toEqual(parseBackendNames().sort());
  });

  it('names exactly the always-present providers the backend declares, apart from the configurable ones', () => {
    expect([...PAIR_PROVIDER_NAMES].sort()).toEqual(parseBackendNames('PAIR_PROVIDER_NAMES').sort());
    for (const name of PAIR_PROVIDER_NAMES) {
      expect(isFxProviderName(name)).toBe(false);
    }
  });

  it('carries a label for every provider the status endpoint may report', () => {
    const labels = en.page.providers.names as Record<string, string>;
    const names = [...parseBackendNames(), ...parseBackendNames('PAIR_PROVIDER_NAMES')];
    expect(names.filter((name) => !labels[name])).toEqual([]);
    expect(Object.keys(labels).sort()).toEqual([...names].sort());
  });

  it('isFxProviderName admits the mirrored names only', () => {
    expect(isFxProviderName('frankfurter')).toBe(true);
    expect(isFxProviderName('yahoo')).toBe(true);
    expect(isFxProviderName('yahoo_finance')).toBe(false);
  });

  it('isRateProviderName admits the configurable and the always-present names', () => {
    expect(isRateProviderName('yahoo')).toBe(true);
    expect(isRateProviderName('crypto')).toBe(true);
    expect(isRateProviderName('yahoo_crypto')).toBe(false);
  });
});

describe('exchangeRatesApi valuation caches (INV-CACHE-001)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCache();
    setCache('investments:summary:all', { totalPortfolioValue: 1 });
    setCache('accounts:all:false', [{ id: 'a' }]);
  });

  const expectDropped = () => {
    expect(getCached('investments:summary:all')).toBeUndefined();
    expect(getCached('accounts:all:false')).toBeUndefined();
  };

  it('refreshRates drops the converted totals', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: {} });
    await exchangeRatesApi.refreshRates();
    expectDropped();
  });

  it('fillRateGaps drops the converted totals', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: {} });
    await exchangeRatesApi.fillRateGaps('EUR');
    expectDropped();
  });
});
