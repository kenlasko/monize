import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { createCategoryFromInput, toTitleCase } from './category-create';
import type { Category } from '@/types/category';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('toTitleCase', () => {
  it('capitalizes each word and lowercases the rest', () => {
    expect(toTitleCase('pET sUPPLIES')).toBe('Pet Supplies');
  });
});

describe('createCategoryFromInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const cat = (over: Partial<Category>): Category =>
    ({ id: 'x', name: 'X', parentId: null, ...over }) as Category;

  it('returns null for blank input without calling the API', async () => {
    expect(await createCategoryFromInput('   ', [])).toBeNull();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('title-cases a plain name', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: cat({ id: 'new', name: 'Pet Supplies' }) });

    const result = await createCategoryFromInput('pet supplies', []);

    expect(apiClient.post).toHaveBeenCalledWith('/categories', {
      name: 'Pet Supplies',
      parentId: undefined,
    });
    expect(result?.displayName).toBe('Pet Supplies');
    expect(result?.created.map((c) => c.id)).toEqual(['new']);
    expect(result?.parentName).toBeUndefined();
  });

  it('creates the parent first for "Parent: Child" when no parent exists', async () => {
    vi.mocked(apiClient.post)
      .mockResolvedValueOnce({ data: cat({ id: 'parent', name: 'Travel' }) })
      .mockResolvedValueOnce({ data: cat({ id: 'child', name: 'Hotels', parentId: 'parent' }) });

    const result = await createCategoryFromInput('travel: hotels', []);

    expect(apiClient.post).toHaveBeenNthCalledWith(1, '/categories', { name: 'Travel' });
    expect(apiClient.post).toHaveBeenNthCalledWith(2, '/categories', {
      name: 'Hotels',
      parentId: 'parent',
    });
    // Both rows are returned so a caller's picker shows the parent as well.
    expect(result?.created.map((c) => c.id)).toEqual(['parent', 'child']);
    expect(result?.category.id).toBe('child');
    expect(result?.displayName).toBe('Travel: Hotels');
    expect(result?.parentName).toBe('Travel');
  });

  it('reuses an existing top-level parent, matched case-insensitively, and keeps its own casing', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: cat({ id: 'child', name: 'Hotels', parentId: 'existing' }),
    });
    const existing = [cat({ id: 'existing', name: 'TRAVEL', parentId: null })];

    const result = await createCategoryFromInput('travel: hotels', existing);

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith('/categories', {
      name: 'Hotels',
      parentId: 'existing',
    });
    // The stored parent's name, not the typed casing.
    expect(result?.parentName).toBe('TRAVEL');
    expect(result?.displayName).toBe('TRAVEL: Hotels');
    expect(result?.created.map((c) => c.id)).toEqual(['child']);
  });

  it('does not treat a subcategory as a possible parent', async () => {
    vi.mocked(apiClient.post)
      .mockResolvedValueOnce({ data: cat({ id: 'new-parent', name: 'Travel' }) })
      .mockResolvedValueOnce({ data: cat({ id: 'child', name: 'Hotels', parentId: 'new-parent' }) });
    // A category named Travel already exists, but it is itself a child.
    const existing = [cat({ id: 'sub', name: 'Travel', parentId: 'other' })];

    const result = await createCategoryFromInput('Travel: Hotels', existing);

    expect(apiClient.post).toHaveBeenNthCalledWith(1, '/categories', { name: 'Travel' });
    expect(result?.created.map((c) => c.id)).toEqual(['new-parent', 'child']);
  });

  it('leaves a name with more than one colon as a single flat category', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: cat({ id: 'new', name: 'A: B: C' }),
    });

    await createCategoryFromInput('a: b: c', []);

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith('/categories', {
      name: 'A: B: C',
      parentId: undefined,
    });
  });

  it('passes the type through only when the caller supplies it', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: cat({ id: 'new', name: 'Boat' }) });

    await createCategoryFromInput('boat', [], { type: 'expense' });

    expect(apiClient.post).toHaveBeenCalledWith('/categories', {
      name: 'Boat',
      parentId: undefined,
      type: 'expense',
    });
  });

  it('propagates an API failure so the caller can report it', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(new Error('boom'));
    await expect(createCategoryFromInput('Boat', [])).rejects.toThrow('boom');
  });

  // A joint transaction is the sharing owner's row and may only carry the
  // OWNER's category ids, so a category typed into that register's picker has
  // to be created on the owner's ledger. `/categories` creates on the
  // caller's, which is the id the owner does not own.
  describe('jointAccountId', () => {
    it("creates on the owner's ledger instead of the caller's", async () => {
      vi.mocked(apiClient.post).mockResolvedValue({
        data: cat({ id: 'owner-cat', name: 'Daycare' }),
      });

      const result = await createCategoryFromInput('daycare', [], {
        jointAccountId: 'acc-joint',
      });

      expect(apiClient.post).toHaveBeenCalledTimes(1);
      expect(apiClient.post).toHaveBeenCalledWith('/categories/joint/acc-joint', {
        name: 'Daycare',
        parentId: undefined,
      });
      expect(result?.category.id).toBe('owner-cat');
    });

    it("puts BOTH halves of a Parent: Child on the owner's ledger", async () => {
      vi.mocked(apiClient.post)
        .mockResolvedValueOnce({ data: cat({ id: 'owner-parent', name: 'Travel' }) })
        .mockResolvedValueOnce({
          data: cat({ id: 'owner-child', name: 'Hotels', parentId: 'owner-parent' }),
        });

      // A parent created on one ledger and a child on the other would leave the
      // pair astride two users' charts of accounts.
      const result = await createCategoryFromInput('travel: hotels', [], {
        jointAccountId: 'acc-joint',
      });

      expect(apiClient.post).toHaveBeenNthCalledWith(1, '/categories/joint/acc-joint', {
        name: 'Travel',
      });
      expect(apiClient.post).toHaveBeenNthCalledWith(2, '/categories/joint/acc-joint', {
        name: 'Hotels',
        parentId: 'owner-parent',
      });
      expect(result?.created.map((c) => c.id)).toEqual(['owner-parent', 'owner-child']);
    });

    it("reuses an existing OWNER parent rather than creating one", async () => {
      vi.mocked(apiClient.post).mockResolvedValue({
        data: cat({ id: 'owner-child', name: 'Hotels', parentId: 'owner-travel' }),
      });

      const result = await createCategoryFromInput(
        'travel: hotels',
        [cat({ id: 'owner-travel', name: 'Travel' })],
        { jointAccountId: 'acc-joint' },
      );

      expect(apiClient.post).toHaveBeenCalledTimes(1);
      expect(apiClient.post).toHaveBeenCalledWith('/categories/joint/acc-joint', {
        name: 'Hotels',
        parentId: 'owner-travel',
      });
      expect(result?.parentName).toBe('Travel');
    });
  });
});
