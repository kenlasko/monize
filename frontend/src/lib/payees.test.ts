import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { payeesApi } from './payees';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('payeesApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create posts to /payees', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'p-1' } });
    const result = await payeesApi.create({ name: 'Grocery' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/payees', { name: 'Grocery' });
    expect(result.id).toBe('p-1');
  });

  it('getAll fetches /payees', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'p-1' }] });
    const result = await payeesApi.getAll();
    expect(apiClient.get).toHaveBeenCalledWith('/payees');
    expect(result).toHaveLength(1);
  });

  it('getById fetches /payees/:id', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'p-1' } });
    await payeesApi.getById('p-1');
    expect(apiClient.get).toHaveBeenCalledWith('/payees/p-1');
  });

  it('update patches /payees/:id', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'p-1' } });
    await payeesApi.update('p-1', { name: 'Updated' } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/payees/p-1', { name: 'Updated' });
  });

  it('delete calls DELETE /payees/:id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await payeesApi.delete('p-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/payees/p-1');
  });

  it('search fetches /payees/search with query and limit', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await payeesApi.search('gro', 5);
    expect(apiClient.get).toHaveBeenCalledWith('/payees/search', { params: { q: 'gro', limit: 5 } });
  });

  it('search defaults limit to 10', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await payeesApi.search('gro');
    expect(apiClient.get).toHaveBeenCalledWith('/payees/search', { params: { q: 'gro', limit: 10 } });
  });

  it('autocomplete fetches /payees/autocomplete', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await payeesApi.autocomplete('gro');
    expect(apiClient.get).toHaveBeenCalledWith('/payees/autocomplete', { params: { q: 'gro' } });
  });

  it('getMostUsed fetches /payees/most-used', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await payeesApi.getMostUsed(5);
    expect(apiClient.get).toHaveBeenCalledWith('/payees/most-used', { params: { limit: 5 } });
  });

  it('getRecentlyUsed fetches /payees/recently-used', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await payeesApi.getRecentlyUsed();
    expect(apiClient.get).toHaveBeenCalledWith('/payees/recently-used', { params: { limit: 10 } });
  });

  it('getSummary fetches /payees/summary', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { totalPayees: 10 } });
    const result = await payeesApi.getSummary();
    expect(apiClient.get).toHaveBeenCalledWith('/payees/summary');
    expect(result.totalPayees).toBe(10);
  });

  it('getByCategory fetches /payees/by-category/:id', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await payeesApi.getByCategory('cat-1');
    expect(apiClient.get).toHaveBeenCalledWith('/payees/by-category/cat-1');
  });

  it('getCategorySuggestions fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await payeesApi.getCategorySuggestions({ minTransactions: 3, minPercentage: 80 } as any);
    expect(apiClient.get).toHaveBeenCalledWith('/payees/category-suggestions/preview', {
      params: { minTransactions: 3, minPercentage: 80, onlyWithoutCategory: true },
    });
  });

  it('applyCategorySuggestions posts assignments', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { updated: 5 } });
    const assignments = [{ payeeId: 'p-1', categoryId: 'c-1' }] as any;
    const result = await payeesApi.applyCategorySuggestions(assignments);
    expect(apiClient.post).toHaveBeenCalledWith('/payees/category-suggestions/apply', assignments);
    expect(result.updated).toBe(5);
  });
});
