import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { payeesApi, payeeInUseHref } from './payees';
import { invalidateCache, setCache, getCached, clearAllCache } from './apiCache';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('./apiCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./apiCache')>()),
  invalidateCache: vi.fn(),
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
    expect(apiClient.get).toHaveBeenCalledWith('/payees', { params: {} });
    expect(result).toHaveLength(1);
  });

  it('getAll fetches /payees with status filter', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'p-1' }] });
    const result = await payeesApi.getAll('active');
    expect(apiClient.get).toHaveBeenCalledWith('/payees', { params: { status: 'active' } });
    expect(result).toHaveLength(1);
  });

  it('getAll asks for usage counts only with withUsage', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await payeesApi.getAll('all', { withUsage: true });
    expect(apiClient.get).toHaveBeenCalledWith('/payees', { params: { status: 'all', usage: true } });
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

  it('applyCategorySuggestions posts assignments wrapped in object', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { updated: 5 } });
    const assignments = [{ payeeId: 'p-1', categoryId: 'c-1' }];
    const result = await payeesApi.applyCategorySuggestions(assignments);
    expect(apiClient.post).toHaveBeenCalledWith('/payees/category-suggestions/apply', { assignments });
    expect(result.updated).toBe(5);
  });

  it('applyCategorySuggestions batches large arrays in chunks of 500', async () => {
    vi.mocked(apiClient.post)
      .mockResolvedValueOnce({ data: { updated: 500 } })
      .mockResolvedValueOnce({ data: { updated: 200 } });

    const assignments = Array.from({ length: 700 }, (_, i) => ({
      payeeId: `p-${i}`,
      categoryId: `c-${i}`,
    }));
    const result = await payeesApi.applyCategorySuggestions(assignments);

    expect(apiClient.post).toHaveBeenCalledTimes(2);
    expect(apiClient.post).toHaveBeenNthCalledWith(1, '/payees/category-suggestions/apply', {
      assignments: assignments.slice(0, 500),
    });
    expect(apiClient.post).toHaveBeenNthCalledWith(2, '/payees/category-suggestions/apply', {
      assignments: assignments.slice(500),
    });
    expect(result.updated).toBe(700);
  });

  it('getDeactivationPreview fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await payeesApi.getDeactivationPreview({ maxTransactions: 5, monthsUnused: 12 });
    expect(apiClient.get).toHaveBeenCalledWith('/payees/deactivation/preview', {
      params: { maxTransactions: 5, monthsUnused: 12 },
    });
  });

  it('deactivatePayees posts payeeIds', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { deactivated: 3 } });
    const result = await payeesApi.deactivatePayees(['p-1', 'p-2', 'p-3']);
    expect(apiClient.post).toHaveBeenCalledWith('/payees/deactivation/apply', {
      payeeIds: ['p-1', 'p-2', 'p-3'],
    });
    expect(result.deactivated).toBe(3);
  });

  it('deactivatePayees batches large arrays in chunks of 500', async () => {
    vi.mocked(apiClient.post)
      .mockResolvedValueOnce({ data: { deactivated: 500 } })
      .mockResolvedValueOnce({ data: { deactivated: 100 } });

    const payeeIds = Array.from({ length: 600 }, (_, i) => `p-${i}`);
    const result = await payeesApi.deactivatePayees(payeeIds);

    expect(apiClient.post).toHaveBeenCalledTimes(2);
    expect(apiClient.post).toHaveBeenNthCalledWith(1, '/payees/deactivation/apply', {
      payeeIds: payeeIds.slice(0, 500),
    });
    expect(apiClient.post).toHaveBeenNthCalledWith(2, '/payees/deactivation/apply', {
      payeeIds: payeeIds.slice(500),
    });
    expect(result.deactivated).toBe(600);
  });

  it('reactivatePayee posts to /payees/:id/reactivate', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'p-1', isActive: true } });
    const result = await payeesApi.reactivatePayee('p-1');
    expect(apiClient.post).toHaveBeenCalledWith('/payees/p-1/reactivate');
    expect(result.isActive).toBe(true);
  });

  it('findInactiveByName fetches /payees/inactive/match', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'p-1', name: 'Old Store' } });
    const result = await payeesApi.findInactiveByName('Old Store');
    expect(apiClient.get).toHaveBeenCalledWith('/payees/inactive/match', { params: { name: 'Old Store' } });
    expect(result!.name).toBe('Old Store');
  });

  it('getAliases fetches aliases for a payee', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await payeesApi.getAliases('p-1');
    expect(apiClient.get).toHaveBeenCalledWith('/payees/p-1/aliases');
  });

  it('getAllAliases fetches all aliases', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await payeesApi.getAllAliases();
    expect(apiClient.get).toHaveBeenCalledWith('/payees/aliases');
  });

  it('createAlias posts to /payees/aliases', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'a-1' } });
    await payeesApi.createAlias({ payeeId: 'p-1', alias: 'GroceryStore' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/payees/aliases', {
      payeeId: 'p-1',
      alias: 'GroceryStore',
    });
  });

  it('deleteAlias removes an alias', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await payeesApi.deleteAlias('a-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/payees/aliases/a-1');
  });

  it('mergePayees posts merge data', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { merged: 1 } });
    await payeesApi.mergePayees({ sourceId: 'p-1', targetId: 'p-2' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/payees/merge', {
      sourceId: 'p-1',
      targetId: 'p-2',
    });
  });

  it('lookupContact posts the name to /payees/lookup-contact with the abort signal', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { reason: 'none', suggestion: null },
    });
    const controller = new AbortController();
    const result = await payeesApi.lookupContact('Acme', undefined, controller.signal);
    expect(apiClient.post).toHaveBeenCalledWith(
      '/payees/lookup-contact',
      { name: 'Acme' },
      { signal: controller.signal },
    );
    expect(result.reason).toBe('none');
  });

  it('lookupContact sends the context the caller already holds beside the name', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { reason: 'none', suggestion: null },
    });
    await payeesApi.lookupContact('Acme', { address: 'Toronto', notes: 'the Dundas branch' });
    expect(apiClient.post).toHaveBeenCalledWith(
      '/payees/lookup-contact',
      { name: 'Acme', address: 'Toronto', notes: 'the Dundas branch' },
      { signal: undefined },
    );
  });

  it('lookupContactForPayee posts to /payees/:id/lookup-contact and drops no cache', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { reason: 'ok', suggestions: [{ label: null, phone: '+1 416 555 0100' }] },
    });
    const result = await payeesApi.lookupContactForPayee('p-1');
    expect(apiClient.post).toHaveBeenCalledWith('/payees/p-1/lookup-contact');
    expect(result.suggestions).toHaveLength(1);
    // Nothing was written, so nothing cached is stale.
    expect(invalidateCache).not.toHaveBeenCalledWith('payees:');
  });
});

describe('payeesApi recategorising writes drop budget caches (INV-CACHE-001)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCache();
    setCache('budgets:dashboard', { id: 'b' });
  });

  it('applyCategorySuggestions drops budgets:dashboard when transactions were backfilled', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { updated: 1, transactionsBackfilled: 2 },
    });
    await payeesApi.applyCategorySuggestions([{ payeeId: 'p-1', categoryId: 'c-1' }]);
    expect(getCached('budgets:dashboard')).toBeUndefined();
  });

  it('applyCategorySuggestions leaves budgets:dashboard when none were backfilled', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { updated: 1, transactionsBackfilled: 0 },
    });
    await payeesApi.applyCategorySuggestions([{ payeeId: 'p-1', categoryId: 'c-1' }]);
    expect(getCached('budgets:dashboard')).toEqual({ id: 'b' });
  });

  it('update drops budgets:dashboard when it categorised transactions', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({
      data: { id: 'p-1', transactionsCategorized: 3 },
    });
    await payeesApi.update('p-1', { defaultCategoryId: 'c-1' } as any);
    expect(getCached('budgets:dashboard')).toBeUndefined();
  });

  it('update leaves budgets:dashboard when it categorised nothing', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'p-1' } });
    await payeesApi.update('p-1', { name: 'X' } as any);
    expect(getCached('budgets:dashboard')).toEqual({ id: 'b' });
  });
});

describe('payeeInUseHref', () => {
  it.each([
    [{ kind: 'transactions', count: 1 }, '/transactions?payeeId=p1'],
    [{ kind: 'scheduledTransactions', count: 1 }, '/bills'],
    [{ kind: 'warranties', count: 1 }, '/warranties'],
    [{ kind: 'emailReceiptParsers', count: 1 }, '/settings/email-receipts'],
    [{ kind: 'loanOverpaymentPayee', count: 1, ids: ['a1'] }, '/accounts/a1'],
    [{ kind: 'loanOverpaymentPayee', count: 2, ids: ['a1', 'a2'] }, '/accounts'],
    [{ kind: 'sharedPeople', count: 1 }, '/shared-expenses'],
    [{ kind: 'sharedPostings', count: 1 }, '/shared-expenses'],
    [{ kind: 'rules', count: 1 }, '/rules'],
    [{ kind: 'unknown', count: 1 }, undefined],
  ])('links %o to %s', (entry, href) => {
    expect(payeeInUseHref('p1', entry)).toBe(href);
  });
});
