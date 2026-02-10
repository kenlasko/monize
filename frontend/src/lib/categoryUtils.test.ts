import { describe, it, expect } from 'vitest';
import { buildCategoryTree, getCategorySelectOptions } from './categoryUtils';
import { Category } from '@/types/category';

function makeCategory(overrides: Partial<Category> & { id: string; name: string }): Category {
  return {
    userId: 'user-1',
    parentId: null,
    parent: null,
    children: [],
    description: null,
    icon: null,
    color: null,
    isIncome: false,
    isSystem: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Category;
}

const groceries = makeCategory({ id: 'cat-1', name: 'Groceries' });
const dining = makeCategory({ id: 'cat-2', name: 'Dining' });
const food = makeCategory({ id: 'cat-3', name: 'Food' });
const fastFood = makeCategory({ id: 'cat-4', name: 'Fast Food', parentId: 'cat-3' });
const fineDining = makeCategory({ id: 'cat-5', name: 'Fine Dining', parentId: 'cat-3' });

describe('buildCategoryTree', () => {
  it('returns empty array for empty input', () => {
    expect(buildCategoryTree([])).toEqual([]);
  });

  it('returns flat categories sorted alphabetically', () => {
    const result = buildCategoryTree([groceries, dining]);
    expect(result).toEqual([
      { category: dining, level: 0 },
      { category: groceries, level: 0 },
    ]);
  });

  it('nests children under their parent at level 1', () => {
    const result = buildCategoryTree([food, fastFood, fineDining]);
    expect(result).toEqual([
      { category: food, level: 0 },
      { category: fastFood, level: 1 },
      { category: fineDining, level: 1 },
    ]);
  });

  it('excludes categories matching excludeIds', () => {
    const result = buildCategoryTree([food, fastFood, fineDining], new Set(['cat-4']));
    expect(result).toEqual([
      { category: food, level: 0 },
      { category: fineDining, level: 1 },
    ]);
  });

  it('sorts siblings alphabetically', () => {
    const z = makeCategory({ id: 'z', name: 'Zebra' });
    const a = makeCategory({ id: 'a', name: 'Apple' });
    const m = makeCategory({ id: 'm', name: 'Mango' });
    const result = buildCategoryTree([z, a, m]);
    expect(result.map((r) => r.category.name)).toEqual(['Apple', 'Mango', 'Zebra']);
  });
});

describe('getCategorySelectOptions', () => {
  it('returns options with value and label for flat categories', () => {
    const result = getCategorySelectOptions([groceries, dining]);
    expect(result).toEqual([
      { value: 'cat-2', label: 'Dining' },
      { value: 'cat-1', label: 'Groceries' },
    ]);
  });

  it('builds "Parent: Child" labels for nested categories', () => {
    const result = getCategorySelectOptions([food, fastFood, fineDining]);
    const labels = result.map((o) => o.label);
    expect(labels).toContain('Food');
    expect(labels).toContain('Food: Fast Food');
    expect(labels).toContain('Food: Fine Dining');
  });

  it('prepends empty option when includeEmpty is true', () => {
    const result = getCategorySelectOptions([groceries], { includeEmpty: true });
    expect(result[0]).toEqual({ value: '', label: 'Uncategorized' });
  });

  it('uses custom emptyLabel when provided', () => {
    const result = getCategorySelectOptions([groceries], {
      includeEmpty: true,
      emptyLabel: 'None',
    });
    expect(result[0]).toEqual({ value: '', label: 'None' });
  });

  it('prepends uncategorized option when includeUncategorized is true', () => {
    const result = getCategorySelectOptions([groceries], { includeUncategorized: true });
    expect(result[0]).toEqual({ value: 'uncategorized', label: 'Uncategorized' });
  });

  it('prepends transfers option when includeTransfers is true', () => {
    const result = getCategorySelectOptions([groceries], { includeTransfers: true });
    expect(result[0]).toEqual({ value: 'transfer', label: 'Transfers' });
  });

  it('excludes categories matching excludeIds', () => {
    const result = getCategorySelectOptions([groceries, dining], {
      excludeIds: new Set(['cat-1']),
    });
    expect(result).toEqual([{ value: 'cat-2', label: 'Dining' }]);
  });

  it('returns empty array for empty categories and no special options', () => {
    expect(getCategorySelectOptions([])).toEqual([]);
  });
});
