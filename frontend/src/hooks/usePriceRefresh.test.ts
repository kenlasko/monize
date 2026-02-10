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
    getPortfolioSummary: vi.fn(),
    refreshSelectedPrices: vi.fn(),
  },
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
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

  it('triggerManualRefresh refreshes prices', async () => {
    vi.mocked(investmentsApi.getPortfolioSummary).mockResolvedValue({
      holdings: [{ securityId: 's-1', quantity: 10 }],
    } as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 1, failed: 0, totalSecurities: 1, skipped: 0, results: [], lastUpdated: '',
    });

    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    expect(investmentsApi.getPortfolioSummary).toHaveBeenCalled();
    expect(investmentsApi.refreshSelectedPrices).toHaveBeenCalledWith(['s-1']);
    expect(toast.success).toHaveBeenCalled();
  });

  it('shows error toast on failure', async () => {
    vi.mocked(investmentsApi.getPortfolioSummary).mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    expect(toast.error).toHaveBeenCalledWith('Failed to refresh prices');
  });

  it('shows toast when no securities', async () => {
    vi.mocked(investmentsApi.getPortfolioSummary).mockResolvedValue({
      holdings: [],
    } as any);

    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    expect(toast.success).toHaveBeenCalledWith('No securities to update');
  });

  it('shows error toast when some prices fail', async () => {
    vi.mocked(investmentsApi.getPortfolioSummary).mockResolvedValue({
      holdings: [{ securityId: 's-1', quantity: 10 }],
    } as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 1, failed: 1, totalSecurities: 2, skipped: 0, results: [], lastUpdated: '',
    });

    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    expect(toast.error).toHaveBeenCalled();
  });

  it('deduplicates security IDs', async () => {
    vi.mocked(investmentsApi.getPortfolioSummary).mockResolvedValue({
      holdings: [
        { securityId: 's-1', quantity: 10 },
        { securityId: 's-1', quantity: 5 },
      ],
    } as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 1, failed: 0, totalSecurities: 1, skipped: 0, results: [], lastUpdated: '',
    });

    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    expect(investmentsApi.refreshSelectedPrices).toHaveBeenCalledWith(['s-1']);
  });

  it('calls onRefreshComplete callback', async () => {
    const onRefreshComplete = vi.fn();
    vi.mocked(investmentsApi.getPortfolioSummary).mockResolvedValue({
      holdings: [{ securityId: 's-1', quantity: 10 }],
    } as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 1, failed: 0, totalSecurities: 1, skipped: 0, results: [], lastUpdated: '',
    });

    const { result } = renderHook(() => usePriceRefresh({ onRefreshComplete }));
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    expect(onRefreshComplete).toHaveBeenCalled();
  });
});
