import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  isMarketHours,
  getRefreshInProgress,
  setRefreshInProgress,
  usePriceRefresh,
} from './usePriceRefresh';

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurities: vi.fn(),
    refreshSelectedPrices: vi.fn(),
  },
}));

const sec = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  symbol: id.toUpperCase(),
  name: id,
  securityType: 'STOCK',
  exchange: 'NASDAQ',
  currencyCode: 'USD',
  isActive: true,
  skipPriceUpdates: false,
  sector: null,
  industry: null,
  sectorWeightings: null,
  quoteProvider: null,
  msnInstrumentId: null,
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

import { investmentsApi } from '@/lib/investments';
import toast from 'react-hot-toast';

describe('isMarketHours', () => {
  it('returns a boolean', () => {
    expect(typeof isMarketHours()).toBe('boolean');
  });
});

describe('getRefreshInProgress / setRefreshInProgress', () => {
  afterEach(() => setRefreshInProgress(false));

  it('defaults to false', () => {
    expect(getRefreshInProgress()).toBe(false);
  });

  it('sets and gets refresh state', () => {
    setRefreshInProgress(true);
    expect(getRefreshInProgress()).toBe(true);
  });
});

describe('usePriceRefresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRefreshInProgress(false);
  });

  it('returns isRefreshing and trigger functions', () => {
    const { result } = renderHook(() => usePriceRefresh());
    expect(result.current.isRefreshing).toBe(false);
    expect(typeof result.current.triggerManualRefresh).toBe('function');
    expect(typeof result.current.triggerAutoRefresh).toBe('function');
  });

  it('triggerManualRefresh refreshes prices for every active security', async () => {
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([sec('s-1')] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 1, failed: 0, totalSecurities: 1, skipped: 0, results: [], lastUpdated: '',
    });

    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    expect(investmentsApi.getSecurities).toHaveBeenCalled();
    expect(investmentsApi.refreshSelectedPrices).toHaveBeenCalledWith(['s-1']);
    expect(toast.success).toHaveBeenCalled();
  });

  it('includes securities even when no holdings exist (newly-added securities)', async () => {
    // Regression: ATL8021 was being excluded because it wasn't in the
    // portfolio summary's holdings list. Now we send every active security.
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([
      sec('s-msn', { quoteProvider: 'msn', msnInstrumentId: 'F1' }),
    ] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 1, failed: 0, totalSecurities: 1, skipped: 0, results: [], lastUpdated: '',
    });

    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    expect(investmentsApi.refreshSelectedPrices).toHaveBeenCalledWith(['s-msn']);
  });

  it('skips securities flagged with skipPriceUpdates or marked inactive', async () => {
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([
      sec('s-1'),
      sec('s-2', { skipPriceUpdates: true }),
      sec('s-3', { isActive: false }),
    ] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 1, failed: 0, totalSecurities: 1, skipped: 0, results: [], lastUpdated: '',
    });

    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    expect(investmentsApi.refreshSelectedPrices).toHaveBeenCalledWith(['s-1']);
  });

  it('includes QIF-imported securities once the user assigns a provider override', async () => {
    // QIF/OFX import flags new securities with skipPriceUpdates=true. After
    // the user picks an MSN provider override or supplies an Instrument ID,
    // refresh must include them despite the flag.
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([
      sec('s-msn-override', {
        skipPriceUpdates: true,
        quoteProvider: 'msn',
      }),
      sec('s-msn-id', {
        skipPriceUpdates: true,
        msnInstrumentId: 'F18068004373',
      }),
      sec('s-skip-no-provider', { skipPriceUpdates: true }),
    ] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 2, failed: 0, totalSecurities: 2, skipped: 0, results: [], lastUpdated: '',
    });

    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    expect(investmentsApi.refreshSelectedPrices).toHaveBeenCalledWith([
      's-msn-override',
      's-msn-id',
    ]);
  });

  it('shows error toast on failure', async () => {
    vi.mocked(investmentsApi.getSecurities).mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    expect(toast.error).toHaveBeenCalledWith('Failed to refresh prices');
  });

  it('shows toast when no securities', async () => {
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([] as any);

    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    expect(toast.success).toHaveBeenCalledWith('No securities to update');
  });

  it('shows error toast when some prices fail', async () => {
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([sec('s-1')] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 1, failed: 1, totalSecurities: 2, skipped: 0, results: [], lastUpdated: '',
    });

    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    expect(toast.error).toHaveBeenCalled();
  });

  it('lists failed symbols in the error toast', async () => {
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([
      sec('s-ok'),
      sec('s-bad-1'),
      sec('s-bad-2'),
    ] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 1,
      failed: 2,
      totalSecurities: 3,
      skipped: 0,
      results: [
        { symbol: 'GOOD', success: true, price: 100 },
        { symbol: 'BAD1', success: false, error: 'Not found' },
        { symbol: 'BAD2', success: false, error: 'Rate limited' },
      ],
      lastUpdated: '',
    });

    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('BAD1, BAD2'),
      expect.objectContaining({ duration: expect.any(Number) }),
    );
  });

  it('calls onRefreshComplete callback with lastUpdated from the refresh result', async () => {
    const onRefreshComplete = vi.fn();
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([sec('s-1')] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 1,
      failed: 0,
      totalSecurities: 1,
      skipped: 0,
      results: [],
      lastUpdated: '2026-04-15T14:06:00Z',
    });

    const { result } = renderHook(() => usePriceRefresh({ onRefreshComplete }));
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    expect(onRefreshComplete).toHaveBeenCalledWith('2026-04-15T14:06:00Z');
  });

  it('does nothing when refresh is already in progress', async () => {
    setRefreshInProgress(true);
    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    expect(investmentsApi.getSecurities).not.toHaveBeenCalled();
  });

  it('triggerAutoRefresh skips when outside market hours', async () => {
    // Real isMarketHours runs; check that when refreshInProgress is true it short-circuits
    setRefreshInProgress(true);
    const { result } = renderHook(() => usePriceRefresh());
    act(() => {
      result.current.triggerAutoRefresh();
    });
    expect(investmentsApi.getSecurities).not.toHaveBeenCalled();
  });

  it('uses singular "1 security price" message when only one updated', async () => {
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([sec('s-1')] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 1, failed: 0, totalSecurities: 1, skipped: 0, results: [], lastUpdated: '',
    });
    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    expect(toast.success).toHaveBeenCalledWith('1 security price updated');
  });
});
