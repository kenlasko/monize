import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useExchangeRates, buildRateMap, convertWithRateMap } from './useExchangeRates';

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn((selector: any) =>
    selector({ preferences: { defaultCurrency: 'CAD' } })
  ),
}));

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getLatestRates: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

import { exchangeRatesApi } from '@/lib/exchange-rates';

describe('useExchangeRates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads rates on mount', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([
      { id: 1, fromCurrency: 'USD', toCurrency: 'CAD', rate: 1.36, rateDate: '2025-01-15', source: 'test' },
    ]);
    const { result } = renderHook(() => useExchangeRates());
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rates).toHaveLength(1);
  });

  it('convert returns unconverted amount for same currency', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([]);
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.convert(100, 'CAD', 'CAD')).toBe(100);
  });

  it('convert uses direct rate', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([
      { id: 1, fromCurrency: 'USD', toCurrency: 'CAD', rate: 1.36, rateDate: '2025-01-15', source: 'test' },
    ]);
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.convert(100, 'USD', 'CAD')).toBeCloseTo(136, 1);
  });

  it('convert uses inverse rate', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([
      { id: 1, fromCurrency: 'USD', toCurrency: 'CAD', rate: 1.36, rateDate: '2025-01-15', source: 'test' },
    ]);
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.convert(136, 'CAD', 'USD')).toBeCloseTo(100, 0);
  });

  it('getRate returns 1 for same currency', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([]);
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.getRate('CAD', 'CAD')).toBe(1);
  });

  it('getRate returns null when no rate found', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([]);
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.getRate('USD', 'GBP')).toBeNull();
  });

  it('handles API error gracefully', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockRejectedValue(new Error('API error'));
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rates).toEqual([]);
  });
});

describe('buildRateMap', () => {
  it('builds lookup map from rates', () => {
    const map = buildRateMap([
      { id: 1, fromCurrency: 'USD', toCurrency: 'CAD', rate: 1.36, rateDate: '2025-01-15', source: 'test' },
    ]);
    expect(map.get('USD->CAD')).toBe(1.36);
  });
});

describe('convertWithRateMap', () => {
  const rateMap = new Map([['USD->CAD', 1.36]]);

  it('returns same amount for same currency', () => {
    expect(convertWithRateMap(100, 'CAD', 'CAD', rateMap)).toBe(100);
  });

  it('uses direct rate', () => {
    expect(convertWithRateMap(100, 'USD', 'CAD', rateMap)).toBeCloseTo(136);
  });

  it('uses inverse rate', () => {
    expect(convertWithRateMap(136, 'CAD', 'USD', rateMap)).toBeCloseTo(100, 0);
  });

  it('returns unconverted when no rate', () => {
    expect(convertWithRateMap(100, 'GBP', 'JPY', rateMap)).toBe(100);
  });
});
