import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { categoriesApi } from './categories';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('categoriesApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create posts to /categories', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'cat-1' } });
    const result = await categoriesApi.create({ name: 'Food' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/categories', { name: 'Food' });
    expect(result.id).toBe('cat-1');
  });

  it('getAll fetches /categories', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'cat-1' }] });
    const result = await categoriesApi.getAll();
    expect(apiClient.get).toHaveBeenCalledWith('/categories');
    expect(result).toHaveLength(1);
  });

  it('getById fetches /categories/:id', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'cat-1' } });
    await categoriesApi.getById('cat-1');
    expect(apiClient.get).toHaveBeenCalledWith('/categories/cat-1');
  });

  it('update patches /categories/:id', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'cat-1' } });
    await categoriesApi.update('cat-1', { name: 'Updated' } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/categories/cat-1', { name: 'Updated' });
  });

  it('delete calls DELETE /categories/:id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await categoriesApi.delete('cat-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/categories/cat-1');
  });
});
