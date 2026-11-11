import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@/test/render';
import { useTwrSeries } from './useTwrSeries';
import { netWorthApi } from '@/lib/net-worth';
import type { PortfolioTwrSeries, PortfolioTwrSeriesByAccount } from '@/types/net-worth';

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getInvestmentsTwrSeries: vi.fn(),
    getInvestmentsTwrSeriesByAccount: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const EMPTY_RANGES = {
  prices: [],
  rates: [],
  cash: [],
  pricesTruncated: false,
  ratesTruncated: false,
  cashTruncated: false,
};

const PORTFOLIO: PortfolioTwrSeries = {
  currency: 'CAD',
  startDate: '2026-08-31',
  endDate: '2026-09-17',
  points: [{ date: '2026-08-31', returnPercent: 0 }],
  complete: true,
  reasons: [],
  incompleteRanges: EMPTY_RANGES as unknown as PortfolioTwrSeries['incompleteRanges'],
};

const BY_ACCOUNT: PortfolioTwrSeriesByAccount = {
  currency: 'CAD',
  startDate: '2026-08-31',
  endDate: '2026-09-17',
  accounts: [],
};

const base = {
  startDate: '2026-08-31',
  periodStartDate: '2026-09-01',
  endDate: '2026-09-17',
};

describe('useTwrSeries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(netWorthApi.getInvestmentsTwrSeries).mockResolvedValue(PORTFOLIO);
    vi.mocked(netWorthApi.getInvestmentsTwrSeriesByAccount).mockResolvedValue(BY_ACCOUNT);
  });

  it('names a preset window and answers the portfolio grouping', async () => {
    const { result } = renderHook(() =>
      useTwrSeries({
        ...base,
        range: '1y',
        groupBy: 'portfolio',
        accountIds: 'a1',
        displayCurrency: 'USD',
      }),
    );
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toEqual({ status: 'ready', groupBy: 'portfolio', series: PORTFOLIO });
    expect(netWorthApi.getInvestmentsTwrSeries).toHaveBeenCalledWith({
      period: '1y',
      displayCurrency: 'USD',
      accountIds: 'a1',
    });
    expect(netWorthApi.getInvestmentsTwrSeriesByAccount).not.toHaveBeenCalled();
  });

  it('answers the same object across renders while the request is unchanged', async () => {
    const { result, rerender } = renderHook(() => useTwrSeries({ ...base, range: '1y', groupBy: 'portfolio' }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('dates a range with no preset, measured from the prior close', async () => {
    renderHook(() => useTwrSeries({ ...base, range: 'mtd', groupBy: 'portfolio' }));
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsTwrSeries).toHaveBeenCalledWith({
        startDate: '2026-09-01',
        endDate: '2026-09-17',
        baselineDate: '2026-08-31',
        displayCurrency: undefined,
        accountIds: undefined,
      }),
    );
  });

  it('asks for one series per named account in the account grouping', async () => {
    const { result } = renderHook(() =>
      useTwrSeries({ ...base, range: '3m', groupBy: 'account', accountIds: 'a1,a2' }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toEqual({ status: 'ready', groupBy: 'account', series: BY_ACCOUNT });
    expect(netWorthApi.getInvestmentsTwrSeriesByAccount).toHaveBeenCalledWith({
      period: '3m',
      displayCurrency: undefined,
      accountIds: 'a1,a2',
    });
    expect(netWorthApi.getInvestmentsTwrSeries).not.toHaveBeenCalled();
  });

  it('asks nothing for the account grouping while no account is named', () => {
    const { result } = renderHook(() =>
      useTwrSeries({ ...base, range: '1y', groupBy: 'account' }),
    );
    expect(result.current.status).toBe('loading');
    expect(netWorthApi.getInvestmentsTwrSeriesByAccount).not.toHaveBeenCalled();
  });

  it('reports a failed request as an error, never as an empty line', async () => {
    vi.mocked(netWorthApi.getInvestmentsTwrSeries).mockRejectedValue(new Error('x'));
    const { result } = renderHook(() =>
      useTwrSeries({ ...base, range: '1y', groupBy: 'portfolio' }),
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.series).toBeNull();
  });

  it('asks nothing while skipped or before a dated window has a start', () => {
    renderHook(() => useTwrSeries({ ...base, range: '1y', groupBy: 'portfolio', skip: true }));
    renderHook(() =>
      useTwrSeries({ ...base, periodStartDate: '', range: 'custom', groupBy: 'portfolio' }),
    );
    expect(netWorthApi.getInvestmentsTwrSeries).not.toHaveBeenCalled();
  });

  it("never shows one request's line under another", async () => {
    const { result, rerender } = renderHook(
      ({ range }) => useTwrSeries({ ...base, range, groupBy: 'portfolio' }),
      { initialProps: { range: '1y' } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    vi.mocked(netWorthApi.getInvestmentsTwrSeries).mockReturnValue(new Promise(() => {}));
    rerender({ range: '1m' });
    expect(result.current).toEqual({ status: 'loading', series: null });
  });

  it('a change of grouping is a new request', async () => {
    const { result, rerender } = renderHook(
      ({ groupBy }: { groupBy: 'portfolio' | 'account' }) =>
        useTwrSeries({ ...base, range: '1y', groupBy, accountIds: 'a1' }),
      { initialProps: { groupBy: 'portfolio' as 'portfolio' | 'account' } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    vi.mocked(netWorthApi.getInvestmentsTwrSeriesByAccount).mockReturnValue(new Promise(() => {}));
    rerender({ groupBy: 'account' });
    expect(result.current).toEqual({ status: 'loading', series: null });
  });
});
