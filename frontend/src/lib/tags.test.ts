import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { tagsApi } from './tags';
import { invalidateCache } from './apiCache';

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

  it('getAllTransactionCounts fetches all counts', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { 't-1': 5, 't-2': 3 } });
    const result = await tagsApi.getAllTransactionCounts();
    expect(apiClient.get).toHaveBeenCalledWith('/tags/transaction-counts');
    expect(result['t-1']).toBe(5);
  });
});
