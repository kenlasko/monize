import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@/test/render';
import { usePriceRefresh } from './usePriceRefresh';
import {
  __resetPriceRefreshStateForTesting,
  getRefreshInProgress,
  isAutomaticPriceRefreshDue,
  runAutomaticPriceRefresh,
  setRefreshInProgress,
} from '@/lib/price-refresh-state';
import { subscribeAutoPriceRefresh } from '@/lib/autoPriceRefreshSignal';

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
  isFavourite: false,
  skipPriceUpdates: false,
  sector: null,
  industry: null,
  sectorWeightings: null,
  countryWeightings: null,
  assetWeightings: null,
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
    __resetPriceRefreshStateForTesting();
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

  it('limits refresh to scopeSecurityIds when provided', async () => {
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([
      sec('s-1'),
      sec('s-2'),
      sec('s-3'),
    ] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 2, failed: 0, totalSecurities: 2, skipped: 0, results: [], lastUpdated: '',
    });

    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh(['s-1', 's-3']);
    });
    expect(investmentsApi.refreshSelectedPrices).toHaveBeenCalledWith(['s-1', 's-3']);
  });

  it('shows the no-securities toast when scope filters out everything', async () => {
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([sec('s-1')] as any);

    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh(['s-99']);
    });
    expect(investmentsApi.refreshSelectedPrices).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('No securities to update');
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

  it('excludes a flagged security even with a provider override', async () => {
    // The flag is the user's "disable price updates" switch, and the backend's
    // isRefreshEligible() honours it alone; an override must not bypass it here.
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([
      sec('s-1'),
      sec('s-msn-override', {
        skipPriceUpdates: true,
        quoteProvider: 'msn',
      }),
      sec('s-msn-id', {
        skipPriceUpdates: true,
        msnInstrumentId: 'F18068004373',
      }),
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

  /**
   * A count of failures sends the reader nowhere: a currency mismatch is
   * repaired by correcting the security, not by refreshing again. The server
   * already says why, translated, so the toast carries it. INV-PRICE-001.
   */
  it('shows the server refusal reason in the error toast, once per distinct reason', async () => {
    const refusal =
      'Price update refused for AAPL: yahoo quotes it in GBP, but the security is recorded in USD.';
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([
      sec('s-bad-1'),
      sec('s-bad-2'),
    ] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 0,
      failed: 2,
      totalSecurities: 2,
      skipped: 0,
      results: [
        { symbol: 'AAPL', success: false, error: refusal },
        { symbol: 'AAPL', success: false, error: refusal },
      ],
      lastUpdated: '',
    });

    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    const message = vi.mocked(toast.error).mock.calls[0][0] as string;
    expect(message).toContain(refusal);
    expect(message.split(refusal).length - 1).toBe(1);
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

  it('does not reload the page when the refresh updated nothing', async () => {
    // The callback reloads the portfolio summary and the register, seconds of
    // server work. A refresh that wrote no price (market closed, every quote
    // refused) leaves both answers exactly as they were, and the reader saw the
    // page redraw for nothing.
    const onRefreshComplete = vi.fn();
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([sec('s-1')] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 0,
      failed: 0,
      totalSecurities: 1,
      skipped: 1,
      results: [],
      lastUpdated: '2026-04-15T14:06:00Z',
    });

    const { result } = renderHook(() => usePriceRefresh({ onRefreshComplete }));
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    expect(investmentsApi.refreshSelectedPrices).toHaveBeenCalled();
    expect(onRefreshComplete).not.toHaveBeenCalled();
  });

  it('still reloads when only some symbols failed but one was written', async () => {
    const onRefreshComplete = vi.fn();
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([
      sec('s-1'),
      sec('s-2'),
    ] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 1,
      failed: 1,
      totalSecurities: 2,
      skipped: 0,
      results: [{ symbol: 'S-2', success: false, error: 'no quote' }],
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

  it('triggerAutoRefresh does nothing while a refresh is in progress', async () => {
    setRefreshInProgress(true);
    const { result } = renderHook(() => usePriceRefresh());
    act(() => {
      result.current.triggerAutoRefresh();
    });
    expect(investmentsApi.getSecurities).not.toHaveBeenCalled();
  });

  it('triggerAutoRefresh runs the automatic refresh, not onRefreshComplete', async () => {
    // The automatic refresh reports through the signal every price surface
    // listens to; the page that started it listens too, so calling its
    // onRefreshComplete as well would reload it twice.
    const onRefreshComplete = vi.fn();
    const heard = vi.fn();
    const unsubscribe = subscribeAutoPriceRefresh(heard);
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([
      sec('btc', { securityType: 'CRYPTO' }),
    ] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 1, failed: 0, totalSecurities: 1, skipped: 0, results: [], lastUpdated: '2026-11-21T12:00:00Z',
    });

    const { result } = renderHook(() => usePriceRefresh({ onRefreshComplete }));
    await act(async () => {
      result.current.triggerAutoRefresh();
    });

    expect(investmentsApi.refreshSelectedPrices).toHaveBeenCalledWith(['btc']);
    expect(heard).toHaveBeenCalledWith('2026-11-21T12:00:00Z');
    expect(onRefreshComplete).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(result.current.isRefreshing).toBe(false);
    unsubscribe();
  });

  it('a click during an automatic refresh waits for it, then refreshes', async () => {
    // The automatic refresh shows nothing, so dropping the click (as a second
    // click during a manual refresh is) would leave the reader's Refresh
    // doing nothing at all.
    let finishAutomatic: (value: unknown) => void = () => {};
    vi.mocked(investmentsApi.getSecurities)
      .mockImplementationOnce(
        () => new Promise((resolve) => { finishAutomatic = resolve; }) as any,
      )
      .mockResolvedValue([sec('s-1')] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 1, failed: 0, totalSecurities: 1, skipped: 0, results: [], lastUpdated: '',
    });

    const { result } = renderHook(() => usePriceRefresh());
    let click: Promise<void> = Promise.resolve();
    await act(async () => {
      result.current.triggerAutoRefresh();
      click = result.current.triggerManualRefresh();
    });
    expect(result.current.isRefreshing).toBe(true);
    expect(investmentsApi.getSecurities).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishAutomatic([sec('s-1')]);
      await click;
    });

    expect(investmentsApi.getSecurities).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenCalledWith('1 security price updated');
    expect(result.current.isRefreshing).toBe(false);
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

describe('usePriceRefresh and the automatic interval', () => {
  // Thursday 2026-07-30, 14:00 UTC: 10:00 in New York, 15:00 in London.
  const DURING_NYSE = new Date('2026-07-30T14:00:00Z');
  const NYSE_SESSION = {
    marketTimezone: 'America/New_York',
    marketOpenTime: '09:30:00',
    marketCloseTime: '16:00:00',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetPriceRefreshStateForTesting();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DURING_NYSE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits out the interval after a manual refresh', async () => {
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([sec('aapl', NYSE_SESSION)] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 1, failed: 0, totalSecurities: 1, skipped: 0, results: [], lastUpdated: '',
    });
    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh();
    });
    vi.mocked(investmentsApi.getSecurities).mockClear();

    await runAutomaticPriceRefresh();

    expect(investmentsApi.getSecurities).not.toHaveBeenCalled();
  });

  it('does not wait out the interval after a manual refresh of a few securities', async () => {
    // One security refreshed from its own page leaves every other quote as
    // old as it was; restarting the interval would hold them back by up to
    // fifteen minutes more.
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([
      sec('aapl', NYSE_SESSION),
      sec('msft', NYSE_SESSION),
    ] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 1, failed: 0, totalSecurities: 1, skipped: 0, results: [], lastUpdated: '',
    });
    const { result } = renderHook(() => usePriceRefresh());
    await act(async () => {
      await result.current.triggerManualRefresh(['aapl']);
    });
    expect(isAutomaticPriceRefreshDue()).toBe(true);

    await runAutomaticPriceRefresh();

    expect(investmentsApi.refreshSelectedPrices).toHaveBeenLastCalledWith(['aapl', 'msft']);
  });

  it('holds the automatic refresh while the page says its first figures are loading', async () => {
    const { rerender, unmount } = renderHook(
      ({ holding }) => usePriceRefresh({ holdAutomaticRefresh: holding }),
      { initialProps: { holding: true } },
    );
    expect(isAutomaticPriceRefreshDue()).toBe(false);

    rerender({ holding: false });
    expect(isAutomaticPriceRefreshDue()).toBe(true);

    rerender({ holding: true });
    unmount();
    // A page left mid-load releases its hold.
    expect(isAutomaticPriceRefreshDue()).toBe(true);
  });
});
