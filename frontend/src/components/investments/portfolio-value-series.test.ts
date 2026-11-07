import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadPortfolioValueSeries } from './portfolio-value-series';

const getInvestmentsDaily = vi.fn();
const getIntradayValue = vi.fn();
vi.mock('@/lib/net-worth', () => ({
  netWorthApi: { getInvestmentsDaily: (...a: unknown[]) => getInvestmentsDaily(...a) },
}));
vi.mock('@/lib/investments', () => ({
  investmentsApi: { getIntradayValue: (...a: unknown[]) => getIntradayValue(...a) },
}));

const day = (date: string, value: number, securitiesValue: number, extra = {}) => ({
  date,
  value,
  securitiesValue,
  ...extra,
});

describe('loadPortfolioValueSeries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('plots the securities alone, from daily closes over a daily window', async () => {
    getInvestmentsDaily.mockResolvedValue([day('2026-11-01', 1250, 1000), day('2026-11-02', 1300.55, 1050.55)]);
    const series = await loadPortfolioValueSeries({ range: '1y', start: '2025-11-06', end: '2026-11-06', accountIds: 'a,b' });
    expect(getInvestmentsDaily).toHaveBeenCalledWith({
      startDate: '2025-11-06',
      endDate: '2026-11-06',
      accountIds: 'a,b',
    });
    expect(series.points).toEqual([
      { at: '2026-11-01', value: 1000, intraday: false },
      { at: '2026-11-02', value: 1050.55, intraday: false },
    ]);
  });

  it('samples each month end over a long window, and asks from the beginning for All', async () => {
    getInvestmentsDaily.mockResolvedValue([]);
    await loadPortfolioValueSeries({ range: 'all', start: '', end: '2026-11-06' });
    expect(getInvestmentsDaily).toHaveBeenCalledWith({
      startDate: undefined,
      endDate: '2026-11-06',
      accountIds: undefined,
      sampling: 'monthEnd',
    });
  });

  it('leaves a point it could not price or convert as a gap', async () => {
    getInvestmentsDaily.mockResolvedValue([
      day('2026-11-01', 10, 8, { pricesComplete: false }),
      day('2026-11-02', 10, 8, { fxComplete: false }),
      day('2026-11-03', 10, 8, { cashComplete: false }),
    ]);
    const series = await loadPortfolioValueSeries({ range: '5y', start: '2021-11-06', end: '2026-11-06' });
    expect(series.points.map((p) => p.value)).toEqual([null, null, 8]);
  });

  it('draws intraday bars for a short window', async () => {
    getIntradayValue.mockResolvedValue({
      points: [{ timestamp: '2026-11-06T14:30:00Z', value: 900, securitiesValue: 800 }],
      fallbackToDaily: false,
    });
    const series = await loadPortfolioValueSeries({ range: '1d', start: '2026-11-05', end: '2026-11-06' });
    expect(getIntradayValue).toHaveBeenCalledWith({ range: '1d', accountIds: undefined });
    expect(series).toEqual({
      points: [{ at: '2026-11-06T14:30:00Z', value: 800, intraday: true }],
      intradayUnavailable: false,
    });
  });

  it('says a single day cannot be drawn when a holding has no intraday prices', async () => {
    getIntradayValue.mockResolvedValue({ points: [], fallbackToDaily: true });
    const series = await loadPortfolioValueSeries({ range: '1d', start: '2026-11-05', end: '2026-11-06' });
    expect(series).toEqual({ points: [], intradayUnavailable: true });
    expect(getInvestmentsDaily).not.toHaveBeenCalled();
  });

  it('falls back to daily closes for a longer intraday window, and when the intraday request fails', async () => {
    getInvestmentsDaily.mockResolvedValue([day('2026-11-01', 5, 4)]);
    getIntradayValue.mockResolvedValueOnce({ points: [], fallbackToDaily: true });
    const fallback = await loadPortfolioValueSeries({ range: '1w', start: '2026-10-30', end: '2026-11-06' });
    expect(fallback.points).toEqual([{ at: '2026-11-01', value: 4, intraday: false }]);

    getIntradayValue.mockRejectedValueOnce(new Error('down'));
    const failed = await loadPortfolioValueSeries({ range: 'mtd', start: '2026-10-31', end: '2026-11-06' });
    expect(failed.points).toEqual([{ at: '2026-11-01', value: 4, intraday: false }]);
  });
});
