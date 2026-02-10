import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { netWorthApi } from './net-worth';

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

  it('recalculate posts to /net-worth/recalculate', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { success: true } });
    const result = await netWorthApi.recalculate();
    expect(apiClient.post).toHaveBeenCalledWith('/net-worth/recalculate');
    expect(result.success).toBe(true);
  });
});
