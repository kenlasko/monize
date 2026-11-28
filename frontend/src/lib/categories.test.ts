import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { categoriesApi } from './categories';
import { invalidateCache, setCache, getCached, clearAllCache } from './apiCache';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('categoriesApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCache('categories:');
  });

  it('create posts to /categories', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'cat-1' } });
    const result = await categoriesApi.create({ name: 'Food' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/categories', { name: 'Food' });
    expect(result.id).toBe('cat-1');
  });

  it('getAll fetches /categories', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'cat-1' }] });
    const result = await categoriesApi.getAll();
    expect(apiClient.get).toHaveBeenCalledWith('/categories', { params: undefined });
    expect(result).toHaveLength(1);
  });

  it('getAll asks for usage counts only with withUsage', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await categoriesApi.getAll({ withUsage: true });
    expect(apiClient.get).toHaveBeenCalledWith('/categories', { params: { usage: true } });
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

  it('delete with a target sends reassignTo, and null means uncategorized', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await categoriesApi.delete('cat-1', 'cat-2');
    expect(apiClient.delete).toHaveBeenCalledWith('/categories/cat-1', {
      params: { reassignTo: 'cat-2' },
    });
    await categoriesApi.delete('cat-1', null);
    expect(apiClient.delete).toHaveBeenCalledWith('/categories/cat-1', {
      params: { reassignTo: 'uncategorized' },
    });
  });

  it('delete calls DELETE /categories/:id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await categoriesApi.delete('cat-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/categories/cat-1');
  });

  it('getUsage fetches the count and what a reassign moves', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { count: 42, movableCount: 40 } });
    const result = await categoriesApi.getUsage('cat-1');
    expect(apiClient.get).toHaveBeenCalledWith('/categories/cat-1/transaction-count');
    expect(result).toEqual({ count: 42, movableCount: 40 });
  });

  it('reassignTransactions posts reassignment', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { transactionsUpdated: 5, splitsUpdated: 1 },
    });
    const result = await categoriesApi.reassignTransactions('cat-1', 'cat-2');
    expect(apiClient.post).toHaveBeenCalledWith('/categories/cat-1/reassign', {
      toCategoryId: 'cat-2',
    });
    expect(result.transactionsUpdated).toBe(5);
  });

  it('reassignTransactions accepts null toCategoryId', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { transactionsUpdated: 1, splitsUpdated: 0 },
    });
    await categoriesApi.reassignTransactions('cat-1', null);
    expect(apiClient.post).toHaveBeenCalledWith('/categories/cat-1/reassign', {
      toCategoryId: null,
    });
  });

  it('importDefaults posts to /categories/import-defaults', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { categoriesCreated: 10 } });
    const result = await categoriesApi.importDefaults();
    expect(apiClient.post).toHaveBeenCalledWith('/categories/import-defaults', {});
    expect(result.categoriesCreated).toBe(10);
  });

  it('importDefaults forwards the country and language', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { categoriesCreated: 10 } });
    await categoriesApi.importDefaults({ country: 'GB', language: 'fr' });
    expect(apiClient.post).toHaveBeenCalledWith('/categories/import-defaults', {
      country: 'GB',
      language: 'fr',
    });
  });

  it('getDefaultCountries fetches the supported country codes', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { countries: ['CA', 'GB', 'US'] } });
    const result = await categoriesApi.getDefaultCountries();
    expect(apiClient.get).toHaveBeenCalledWith('/categories/default-countries');
    expect(result).toEqual(['CA', 'GB', 'US']);
  });

  it('getAll returns cached result on second call without hitting the API', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'cat-1', name: 'Food' }] });
    const first = await categoriesApi.getAll();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    const second = await categoriesApi.getAll();
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(second).toEqual(first);
  });
});

describe('categoriesApi derived caches (INV-CACHE-001)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCache();
    setCache('budgets:dashboard', { id: 'b' });
    setCache('accounts:all:false', [{ id: 'a' }]);
  });

  it('reassignTransactions drops budgets:dashboard and accounts:', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { transactionsUpdated: 1, splitsUpdated: 0 },
    });
    await categoriesApi.reassignTransactions('cat-1', 'cat-2');
    expect(getCached('budgets:dashboard')).toBeUndefined();
    expect(getCached('accounts:all:false')).toBeUndefined();
  });

  it('update drops budgets:dashboard', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'cat-1' } });
    await categoriesApi.update('cat-1', { type: 'income' });
    expect(getCached('budgets:dashboard')).toBeUndefined();
  });

  it('delete drops budgets:dashboard', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await categoriesApi.delete('cat-1');
    expect(getCached('budgets:dashboard')).toBeUndefined();
  });
});
