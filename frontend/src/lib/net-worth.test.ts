import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { netWorthApi } from './net-worth';
import { PORTFOLIO_VALUATION_TIMEOUT_MS } from './constants';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

describe('netWorthApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getMonthly fetches /net-worth/monthly', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ month: '2025-01' }] });
    const result = await netWorthApi.getMonthly();
    expect(apiClient.get).toHaveBeenCalledWith('/net-worth/monthly', { params: undefined });
    expect(result).toHaveLength(1);
  });

  it('getMonthly passes date params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await netWorthApi.getMonthly({ startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(apiClient.get).toHaveBeenCalledWith('/net-worth/monthly', {
      params: { startDate: '2025-01-01', endDate: '2025-12-31' },
    });
  });

  it('getInvestmentsMonthly fetches /net-worth/investments-monthly', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await netWorthApi.getInvestmentsMonthly({ accountIds: 'a1,a2' });
    expect(apiClient.get).toHaveBeenCalledWith('/net-worth/investments-monthly', {
      params: { accountIds: 'a1,a2' },
    });
  });

  it('getInvestmentsPeriodResults fetches /net-worth/investments-period-results', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { currency: 'CAD', asOf: '2026-09-17', periods: {} },
    });

    const result = await netWorthApi.getInvestmentsPeriodResults({
      periods: '1d,1y',
      accountIds: 'a1',
      displayCurrency: 'USD',
    });

    expect(apiClient.get).toHaveBeenCalledWith(
      '/net-worth/investments-period-results',
      {
        params: { periods: '1d,1y', accountIds: 'a1', displayCurrency: 'USD' },
        timeout: PORTFOLIO_VALUATION_TIMEOUT_MS,
      },
    );
    expect(result.asOf).toBe('2026-09-17');
  });

  // A since-inception period over decades of history outlives the client's 10 s
  // default; the read carries the valuation timeout (#1888).
  it('getInvestmentsPeriodResult fetches /net-worth/investments-period-result', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { currency: 'CAD' } });

    await netWorthApi.getInvestmentsPeriodResult({ period: 'all', accountIds: 'a1' });

    expect(apiClient.get).toHaveBeenCalledWith(
      '/net-worth/investments-period-result',
      {
        params: { period: 'all', accountIds: 'a1' },
        timeout: PORTFOLIO_VALUATION_TIMEOUT_MS,
      },
    );
    expect(PORTFOLIO_VALUATION_TIMEOUT_MS).toBeGreaterThan(10_000);
  });

  it('getInvestmentsSecurityPeriodResults fetches the per-security split of the same window', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { currency: 'CAD', securities: [] } });

    await netWorthApi.getInvestmentsSecurityPeriodResults({
      startDate: '2026-09-01',
      baselineDate: '2026-08-31',
      endDate: '2026-09-17',
    });

    expect(apiClient.get).toHaveBeenCalledWith(
      '/net-worth/investments-period-result/securities',
      {
        params: { startDate: '2026-09-01', baselineDate: '2026-08-31', endDate: '2026-09-17' },
        timeout: PORTFOLIO_VALUATION_TIMEOUT_MS,
      },
    );
  });

  it('recalculate posts to /net-worth/recalculate', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { success: true } });
    const result = await netWorthApi.recalculate();
    expect(apiClient.post).toHaveBeenCalledWith('/net-worth/recalculate');
    expect(result.success).toBe(true);
  });

  it('getInvestmentsDaily fetches /net-worth/investments-daily', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await netWorthApi.getInvestmentsDaily({ accountIds: 'a1', displayCurrency: 'CAD' });
    expect(apiClient.get).toHaveBeenCalledWith('/net-worth/investments-daily', {
      params: { accountIds: 'a1', displayCurrency: 'CAD' },
      timeout: PORTFOLIO_VALUATION_TIMEOUT_MS,
    });
  });

  it('getInvestmentsDaily passes no params when called without arguments', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await netWorthApi.getInvestmentsDaily();
    expect(apiClient.get).toHaveBeenCalledWith('/net-worth/investments-daily', {
      params: undefined,
      timeout: PORTFOLIO_VALUATION_TIMEOUT_MS,
    });
  });

  it('getInvestmentsBreakdown fetches /net-worth/investments-breakdown', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { granularity: 'monthly', currency: 'CAD', series: [], points: [] },
    });
    const result = await netWorthApi.getInvestmentsBreakdown({
      granularity: 'monthly',
      accountIds: 'a1',
      displayCurrency: 'CAD',
    });
    expect(apiClient.get).toHaveBeenCalledWith('/net-worth/investments-breakdown', {
      params: { granularity: 'monthly', accountIds: 'a1', displayCurrency: 'CAD' },
      timeout: PORTFOLIO_VALUATION_TIMEOUT_MS,
    });
    expect(result.granularity).toBe('monthly');
  });
});
