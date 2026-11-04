import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@/test/render';
import { useSecurityPeriodResults } from './useSecurityPeriodResults';
import { netWorthApi } from '@/lib/net-worth';
import type { SecurityPeriodResults } from '@/types/net-worth';

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: { getInvestmentsSecurityPeriodResults: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const RESULTS: SecurityPeriodResults = {
  currency: 'CAD',
  startDate: '2026-08-31',
  endDate: '2026-09-17',
  reasons: [],
  securities: [],
  unattributedPnl: 0,
};

const base = {
  startDate: '2026-08-31',
  periodStartDate: '2026-09-01',
  endDate: '2026-09-17',
};

describe('useSecurityPeriodResults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(netWorthApi.getInvestmentsSecurityPeriodResults).mockResolvedValue(RESULTS);
  });

  it('names a preset window and reports it ready', async () => {
    const { result } = renderHook(() =>
      useSecurityPeriodResults({ ...base, range: '1y', accountIds: 'a1', displayCurrency: 'USD' }),
    );
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.results).toBe(RESULTS);
    expect(netWorthApi.getInvestmentsSecurityPeriodResults).toHaveBeenCalledWith({
      period: '1y',
      accountIds: 'a1',
      displayCurrency: 'USD',
    });
  });

  it('dates a range with no preset, measured from the prior close', async () => {
    renderHook(() => useSecurityPeriodResults({ ...base, range: 'mtd' }));
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsSecurityPeriodResults).toHaveBeenCalledWith({
        startDate: '2026-09-01',
        endDate: '2026-09-17',
        baselineDate: '2026-08-31',
        accountIds: undefined,
        displayCurrency: undefined,
      }),
    );
  });

  it('reports a failed request as an error, never as empty rows', async () => {
    vi.mocked(netWorthApi.getInvestmentsSecurityPeriodResults).mockRejectedValue(new Error('x'));
    const { result } = renderHook(() => useSecurityPeriodResults({ ...base, range: '1y' }));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.results).toBeNull();
  });

  it('asks nothing while skipped or before a dated window has a start', () => {
    renderHook(() => useSecurityPeriodResults({ ...base, range: '1y', skip: true }));
    renderHook(() => useSecurityPeriodResults({ ...base, periodStartDate: '', range: 'custom' }));
    expect(netWorthApi.getInvestmentsSecurityPeriodResults).not.toHaveBeenCalled();
  });

  it('never shows one window\'s rows under another', async () => {
    const { result, rerender } = renderHook(
      ({ range }) => useSecurityPeriodResults({ ...base, range }),
      { initialProps: { range: '1y' } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    vi.mocked(netWorthApi.getInvestmentsSecurityPeriodResults).mockReturnValue(new Promise(() => {}));
    rerender({ range: '1m' });
    expect(result.current).toEqual({ results: null, status: 'loading' });
  });
});
