import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { tagsApi } from './tags';
import { invalidateCache, setCache, getCached, clearAllCache } from './apiCache';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('tagsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCache('tags:');
  });

  it('create posts to /tags', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 't-1', name: 'biz' } });
    const result = await tagsApi.create({ name: 'biz' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/tags', { name: 'biz' });
    expect(result.id).toBe('t-1');
  });

  it('getAll fetches /tags', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 't-1' }] });
    const result = await tagsApi.getAll();
    expect(apiClient.get).toHaveBeenCalledWith('/tags');
    expect(result).toHaveLength(1);
  });

  it('getAll caches results', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 't-1' }] });
    await tagsApi.getAll();
    await tagsApi.getAll();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('getById fetches /tags/:id', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 't-1' } });
    await tagsApi.getById('t-1');
    expect(apiClient.get).toHaveBeenCalledWith('/tags/t-1');
  });

  it('update patches /tags/:id', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 't-1' } });
    await tagsApi.update('t-1', { name: 'updated' } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/tags/t-1', { name: 'updated' });
  });

  it('delete calls DELETE /tags/:id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await tagsApi.delete('t-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/tags/t-1');
  });

  it('getTransactionCount fetches count for one tag', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: 5 });
    const result = await tagsApi.getTransactionCount('t-1');
    expect(apiClient.get).toHaveBeenCalledWith('/tags/t-1/transaction-count');
    expect(result).toBe(5);
  });

  it('getDeleteImpact fetches the per-kind counts for one tag', async () => {
    const impact = { transactions: 1, transactionSplits: 0, scheduledTransactions: 2, scheduledSplits: 0, securities: 0, rules: 0, customReports: 0 };
    vi.mocked(apiClient.get).mockResolvedValue({ data: impact });
    const result = await tagsApi.getDeleteImpact('t-1');
    expect(apiClient.get).toHaveBeenCalledWith('/tags/t-1/delete-impact');
    expect(result).toEqual(impact);
  });

  it('getAllTransactionCounts fetches all counts', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { 't-1': 5, 't-2': 3 } });
    const result = await tagsApi.getAllTransactionCounts();
    expect(apiClient.get).toHaveBeenCalledWith('/tags/transaction-counts');
    expect(result['t-1']).toBe(5);
  });

  it('getUsage fetches /tags/usage on every call', async () => {
    const usage = { 't-1': { lastUsed: '2026-09-30', count: 4 } };
    vi.mocked(apiClient.get).mockResolvedValue({ data: usage });
    expect(await tagsApi.getUsage()).toEqual(usage);
    await tagsApi.getUsage();
    expect(apiClient.get).toHaveBeenCalledWith('/tags/usage');
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });
});

describe('tagsApi derived caches (INV-CACHE-001)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCache();
    setCache('investments:allocation-by-tag:all', { rows: [] });
    setCache('investments:tag-keys:all', ['k']);
  });

  it('update drops the portfolio tag allocation caches', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 't-1' } });
    await tagsApi.update('t-1', { name: 'x' } as any);
    expect(getCached('investments:allocation-by-tag:all')).toBeUndefined();
    expect(getCached('investments:tag-keys:all')).toBeUndefined();
  });

  it('delete drops the portfolio tag allocation caches', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await tagsApi.delete('t-1');
    expect(getCached('investments:allocation-by-tag:all')).toBeUndefined();
    expect(getCached('investments:tag-keys:all')).toBeUndefined();
  });
});
