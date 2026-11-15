import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { budgetsApi } from './budgets';
import { invalidateCache, invalidateBalanceCaches, getCached, clearAllCache } from './apiCache';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('budgetsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCache('budgets:');
  });

  it('create posts to /budgets', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'b-1' } });
    const result = await budgetsApi.create({ name: 'Monthly' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/budgets', { name: 'Monthly' });
    expect(result.id).toBe('b-1');
  });

  it('getAll fetches /budgets', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'b-1' }] });
    const result = await budgetsApi.getAll();
    expect(apiClient.get).toHaveBeenCalledWith('/budgets');
    expect(result).toHaveLength(1);
  });

  it('getAll returns cached value on second call', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'b-1' }] });
    await budgetsApi.getAll();
    await budgetsApi.getAll();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('getById fetches /budgets/:id', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'b-1' } });
    await budgetsApi.getById('b-1');
    expect(apiClient.get).toHaveBeenCalledWith('/budgets/b-1');
  });

  it('update patches /budgets/:id', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'b-1' } });
    await budgetsApi.update('b-1', { name: 'Updated' } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/budgets/b-1', { name: 'Updated' });
  });

  it('delete calls DELETE /budgets/:id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await budgetsApi.delete('b-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/budgets/b-1');
  });

  it('addCategory posts to /budgets/:id/categories', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'bc-1' } });
    await budgetsApi.addCategory('b-1', { categoryId: 'c-1', amount: 100 } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/budgets/b-1/categories', {
      categoryId: 'c-1',
      amount: 100,
    });
  });

  it('addTransferIncomeLine posts to /budgets/:id/categories/transfer-income', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'bc-2' } });
    await budgetsApi.addTransferIncomeLine('b-1', { transferAccountId: 'a-1', amount: 2000 });
    expect(apiClient.post).toHaveBeenCalledWith('/budgets/b-1/categories/transfer-income', {
      transferAccountId: 'a-1',
      amount: 2000,
    });
  });

  it('updateCategory patches a budget category', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'bc-1' } });
    await budgetsApi.updateCategory('b-1', 'bc-1', { amount: 200 } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/budgets/b-1/categories/bc-1', {
      amount: 200,
    });
  });

  it('removeCategory deletes a budget category', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await budgetsApi.removeCategory('b-1', 'bc-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/budgets/b-1/categories/bc-1');
  });

  it('bulkUpdateCategories posts to /bulk endpoint', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: [] });
    await budgetsApi.bulkUpdateCategories('b-1', [{ id: 'bc-1', amount: 50 }]);
    expect(apiClient.post).toHaveBeenCalledWith('/budgets/b-1/categories/bulk', {
      categories: [{ id: 'bc-1', amount: 50 }],
    });
  });

  it('generate posts to /budgets/generate', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { suggestions: [] } });
    await budgetsApi.generate({ months: 3 } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/budgets/generate', { months: 3 });
  });

  it('applyGenerated posts to /budgets/generate/apply', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'b-1' } });
    await budgetsApi.applyGenerated({ name: 'Generated' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/budgets/generate/apply', {
      name: 'Generated',
    });
  });

  it('getSummary fetches summary', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { spent: 100 } });
    await budgetsApi.getSummary('b-1');
    expect(apiClient.get).toHaveBeenCalledWith('/budgets/b-1/summary');
  });

  it('getVelocity fetches velocity', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { rate: 0.5 } });
    await budgetsApi.getVelocity('b-1');
    expect(apiClient.get).toHaveBeenCalledWith('/budgets/b-1/velocity');
  });

  it('getPeriods fetches periods', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await budgetsApi.getPeriods('b-1');
    expect(apiClient.get).toHaveBeenCalledWith('/budgets/b-1/periods');
  });

  it('getPeriodDetail fetches a single period', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'p-1' } });
    await budgetsApi.getPeriodDetail('b-1', 'p-1');
    expect(apiClient.get).toHaveBeenCalledWith('/budgets/b-1/periods/p-1');
  });

  it('closePeriod posts to close', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'p-1' } });
    await budgetsApi.closePeriod('b-1');
    expect(apiClient.post).toHaveBeenCalledWith('/budgets/b-1/periods/close');
  });

  it('getTrend fetches trend with default 6 months', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await budgetsApi.getTrend('b-1');
    expect(apiClient.get).toHaveBeenCalledWith('/budgets/b-1/reports/trend', {
      params: { months: 6 },
    });
  });

  it('getTrend uses custom months', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await budgetsApi.getTrend('b-1', 12);
    expect(apiClient.get).toHaveBeenCalledWith('/budgets/b-1/reports/trend', {
      params: { months: 12 },
    });
  });

  it('getCategoryTrend fetches category trend', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await budgetsApi.getCategoryTrend('b-1', 6, ['c-1', 'c-2']);
    expect(apiClient.get).toHaveBeenCalledWith('/budgets/b-1/reports/category-trend', {
      params: { months: 6, categoryIds: ['c-1', 'c-2'] },
    });
  });

  it('getHealthScore fetches health score', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { score: 85 } });
    await budgetsApi.getHealthScore('b-1');
    expect(apiClient.get).toHaveBeenCalledWith('/budgets/b-1/reports/health-score');
  });

  it('getSeasonalPatterns fetches patterns', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await budgetsApi.getSeasonalPatterns('b-1');
    expect(apiClient.get).toHaveBeenCalledWith('/budgets/b-1/reports/seasonal');
  });

  it('getFlexGroupStatus fetches flex groups', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await budgetsApi.getFlexGroupStatus('b-1');
    expect(apiClient.get).toHaveBeenCalledWith('/budgets/b-1/reports/flex-groups');
  });

  it('getDailySpending fetches daily spending', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await budgetsApi.getDailySpending('b-1');
    expect(apiClient.get).toHaveBeenCalledWith('/budgets/b-1/reports/daily-spending');
  });

  it('getSavingsRate fetches with default months', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await budgetsApi.getSavingsRate('b-1');
    expect(apiClient.get).toHaveBeenCalledWith('/budgets/b-1/reports/savings-rate', {
      params: { months: 12 },
    });
  });

  it('getHealthScoreHistory fetches with default months', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await budgetsApi.getHealthScoreHistory('b-1');
    expect(apiClient.get).toHaveBeenCalledWith('/budgets/b-1/reports/health-score-history', {
      params: { months: 12 },
    });
  });

  it('getDashboardSummary fetches dashboard data', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { spent: 50 } });
    await budgetsApi.getDashboardSummary();
    expect(apiClient.get).toHaveBeenCalledWith('/budgets/dashboard-summary');
  });

  it('getBuckets fetches /budgets/:id/buckets', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'bk-1' }] });
    const result = await budgetsApi.getBuckets('b-1');
    expect(apiClient.get).toHaveBeenCalledWith('/budgets/b-1/buckets');
    expect(result).toHaveLength(1);
  });

  it('createBucket posts to /budgets/:id/buckets', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'bk-1' } });
    const data = { name: 'Savings', targetType: 'PERCENT', targetValue: 20 } as const;
    const result = await budgetsApi.createBucket('b-1', data);
    expect(apiClient.post).toHaveBeenCalledWith('/budgets/b-1/buckets', data);
    expect(result.id).toBe('bk-1');
  });

  it('updateBucket patches /budgets/:id/buckets/:bucketId', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'bk-1' } });
    await budgetsApi.updateBucket('b-1', 'bk-1', { carryCap: null });
    expect(apiClient.patch).toHaveBeenCalledWith('/budgets/b-1/buckets/bk-1', {
      carryCap: null,
    });
  });

  it('deleteBucket calls DELETE /budgets/:id/buckets/:bucketId', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await budgetsApi.deleteBucket('b-1', 'bk-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/budgets/b-1/buckets/bk-1');
  });

  it('getBucketStatus fetches /budgets/:id/reports/bucket-status', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { buckets: [] } });
    await budgetsApi.getBucketStatus('b-1');
    expect(apiClient.get).toHaveBeenCalledWith('/budgets/b-1/reports/bucket-status');
  });

  it('getCategoryBudgetStatus returns empty object for empty input', async () => {
    const result = await budgetsApi.getCategoryBudgetStatus([]);
    expect(result).toEqual({});
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('getCategoryBudgetStatus posts sorted ids', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { 'c-2': {}, 'c-1': {} } });
    await budgetsApi.getCategoryBudgetStatus(['c-2', 'c-1']);
    expect(apiClient.post).toHaveBeenCalledWith('/budgets/category-budget-status', {
      categoryIds: ['c-2', 'c-1'],
    });
  });

  it('getCategoryBudgetStatus uses cache', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { 'c-1': {} } });
    await budgetsApi.getCategoryBudgetStatus(['c-1']);
    await budgetsApi.getCategoryBudgetStatus(['c-1']);
    expect(apiClient.post).toHaveBeenCalledTimes(1);
  });
});

describe('budgetsApi category status race (INV-CACHE-001)', () => {
  it('a late pre-invalidation response does not land in the cache', async () => {
    vi.clearAllMocks();
    clearAllCache();
    let resolveOld: (v: unknown) => void = () => {};
    vi.mocked(apiClient.post).mockImplementationOnce(
      () => new Promise((resolve) => { resolveOld = resolve; }),
    );
    const oldRead = budgetsApi.getCategoryBudgetStatus(['c1']);

    invalidateBalanceCaches();

    resolveOld({ data: { c1: { spent: 1 } } });
    await oldRead;

    expect(getCached('budgets:cat-status:c1')).toBeUndefined();
  });
});
