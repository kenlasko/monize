import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  __resetPriceRefreshStateForTesting,
  getRefreshInProgress,
  holdAutomaticPriceRefresh,
  isAutomaticPriceRefreshDue,
  runAutomaticPriceRefresh,
} from './price-refresh-state';
import { subscribeAutoPriceRefresh } from './autoPriceRefreshSignal';
import { AUTO_PRICE_REFRESH_INTERVAL_MS } from './price-auto-refresh';

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurities: vi.fn(),
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
  quoteProvider: null,
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

describe('runAutomaticPriceRefresh', () => {
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

  it('refreshes only the securities whose market is trading, without a toast', async () => {
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([
      sec('aapl', NYSE_SESSION),
      sec('vod', {
        marketTimezone: 'Europe/London',
        marketOpenTime: '08:00:00',
        marketCloseTime: '16:30:00',
      }),
      sec('tse', {
        marketTimezone: 'Asia/Tokyo',
        marketOpenTime: '09:00:00',
        marketCloseTime: '15:30:00',
      }),
      sec('btc', { securityType: 'CRYPTO' }),
      sec('off', { ...NYSE_SESSION, skipPriceUpdates: true }),
      sec('edo', { securityType: 'BOND', bondProgramId: 'p-1' }),
    ] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 3, failed: 0, totalSecurities: 3, skipped: 0, results: [], lastUpdated: '',
    });

    await runAutomaticPriceRefresh();

    expect(investmentsApi.getSecurities).toHaveBeenCalledWith(false);
    expect(investmentsApi.refreshSelectedPrices).toHaveBeenCalledWith(['aapl', 'vod', 'btc']);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('tells the price surfaces when a quote was written', async () => {
    const heard = vi.fn();
    const unsubscribe = subscribeAutoPriceRefresh(heard);
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([sec('aapl', NYSE_SESSION)] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 1, failed: 0, totalSecurities: 1, skipped: 0, results: [], lastUpdated: '2026-07-30T14:00:01Z',
    });

    await runAutomaticPriceRefresh();

    expect(heard).toHaveBeenCalledWith('2026-07-30T14:00:01Z');
    unsubscribe();
  });

  it('tells nobody when nothing was written', async () => {
    const heard = vi.fn();
    const unsubscribe = subscribeAutoPriceRefresh(heard);
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([sec('aapl', NYSE_SESSION)] as any);
    vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
      updated: 0, failed: 1, totalSecurities: 1, skipped: 0,
      results: [{ symbol: 'AAPL', success: false, error: 'refused' }], lastUpdated: '',
    });

    await runAutomaticPriceRefresh();

    expect(heard).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('asks the server nothing when no market is open', async () => {
    // Saturday: only a coin would trade.
    vi.setSystemTime(new Date('2026-08-01T15:00:00Z'));
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([sec('aapl', NYSE_SESSION)] as any);

    await runAutomaticPriceRefresh();

    expect(investmentsApi.refreshSelectedPrices).not.toHaveBeenCalled();
  });

  it('runs at most once per interval, counting an attempt that found nothing open', async () => {
    vi.setSystemTime(new Date('2026-08-01T15:00:00Z'));
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([sec('aapl', NYSE_SESSION)] as any);

    await runAutomaticPriceRefresh();
    expect(isAutomaticPriceRefreshDue()).toBe(false);
    await runAutomaticPriceRefresh();
    expect(investmentsApi.getSecurities).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + AUTO_PRICE_REFRESH_INTERVAL_MS));
    expect(isAutomaticPriceRefreshDue()).toBe(true);
    await runAutomaticPriceRefresh();
    expect(investmentsApi.getSecurities).toHaveBeenCalledTimes(2);
  });

  it('logs a failure and never rejects', async () => {
    vi.mocked(investmentsApi.getSecurities).mockRejectedValue(new Error('offline'));

    await expect(runAutomaticPriceRefresh()).resolves.toBeUndefined();
    expect(toast.error).not.toHaveBeenCalled();
    expect(getRefreshInProgress()).toBe(false);
  });

  // A page loading its first figures holds the refresh: a reload landing
  // beside that first valuation would value the same history twice (#1888).
  describe('while a page loads its first figures', () => {
    it('starts nothing until the page releases its hold', async () => {
      vi.mocked(investmentsApi.getSecurities).mockResolvedValue([sec('aapl', NYSE_SESSION)] as any);
      vi.mocked(investmentsApi.refreshSelectedPrices).mockResolvedValue({
        updated: 0, failed: 0, totalSecurities: 1, skipped: 0, results: [], lastUpdated: '',
      });
      const release = holdAutomaticPriceRefresh();

      expect(isAutomaticPriceRefreshDue()).toBe(false);
      await runAutomaticPriceRefresh();
      expect(investmentsApi.getSecurities).not.toHaveBeenCalled();

      release();
      await runAutomaticPriceRefresh();
      expect(investmentsApi.getSecurities).toHaveBeenCalledTimes(1);
    });

    it('tells the price surfaces about a refresh that wrote meanwhile only once the page is in', async () => {
      const heard = vi.fn();
      const unsubscribe = subscribeAutoPriceRefresh(heard);
      let answer: (value: unknown) => void = () => {};
      vi.mocked(investmentsApi.getSecurities).mockResolvedValue([sec('aapl', NYSE_SESSION)] as any);
      vi.mocked(investmentsApi.refreshSelectedPrices).mockReturnValue(
        new Promise((resolve) => { answer = resolve; }) as any,
      );
      const running = runAutomaticPriceRefresh();
      // The reader opens a page while the refresh is on the wire.
      const release = holdAutomaticPriceRefresh();

      answer({ updated: 1, failed: 0, totalSecurities: 1, skipped: 0, results: [], lastUpdated: '2026-07-30T14:00:05Z' });
      await running;
      expect(heard).not.toHaveBeenCalled();

      release();
      expect(heard).toHaveBeenCalledTimes(1);
      expect(heard).toHaveBeenCalledWith('2026-07-30T14:00:05Z');
      unsubscribe();
    });

    it('waits for every page holding it, and counts a release once', async () => {
      const first = holdAutomaticPriceRefresh();
      const second = holdAutomaticPriceRefresh();

      first();
      first();
      expect(isAutomaticPriceRefreshDue()).toBe(false);

      second();
      expect(isAutomaticPriceRefreshDue()).toBe(true);
    });
  });
});
