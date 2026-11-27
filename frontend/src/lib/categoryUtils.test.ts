import { describe, it, expect } from 'vitest';
import { buildCategoryTree, buildCategoryPickerOptions, getCategorySelectOptions, getCategorySelectOptionsFor, buildCategoryColorMap, buildCategoryLabelMap, buildDescendantIdSet, rollupToDirectChildren, buildCategoryFilterOptions, canonicalizeCategoryFilter, resolveSelectedCategories, SpecialCategoryFilterLabels, signAmountByCategory } from './categoryUtils';
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

describe('buildCategoryColorMap', () => {
  it('returns empty map for empty input', () => {
    const result = buildCategoryColorMap([]);
    expect(result.size).toBe(0);
  });

  it('maps category id to effectiveColor when available', () => {
    const cat = makeCategory({ id: 'c1', name: 'Food', color: null, effectiveColor: '#ef4444' });
    const result = buildCategoryColorMap([cat]);
    expect(result.get('c1')).toBe('#ef4444');
  });

  it('falls back to color when effectiveColor is null', () => {
    const cat = makeCategory({ id: 'c1', name: 'Food', color: '#3b82f6', effectiveColor: null });
    const result = buildCategoryColorMap([cat]);
    expect(result.get('c1')).toBe('#3b82f6');
  });

  it('returns null when both color and effectiveColor are null', () => {
    const cat = makeCategory({ id: 'c1', name: 'Food', color: null, effectiveColor: null });
    const result = buildCategoryColorMap([cat]);
    expect(result.get('c1')).toBeNull();
  });

  it('prefers effectiveColor over color', () => {
    const cat = makeCategory({ id: 'c1', name: 'Food', color: '#ef4444', effectiveColor: '#3b82f6' });
    const result = buildCategoryColorMap([cat]);
    expect(result.get('c1')).toBe('#3b82f6');
  });

  it('builds map for multiple categories', () => {
    const cats = [
      makeCategory({ id: 'c1', name: 'Food', color: '#ef4444', effectiveColor: '#ef4444' }),
      makeCategory({ id: 'c2', name: 'Transport', color: null, effectiveColor: '#3b82f6' }),
      makeCategory({ id: 'c3', name: 'Other', color: null, effectiveColor: null }),
    ];
    const result = buildCategoryColorMap(cats);
    expect(result.get('c1')).toBe('#ef4444');
    expect(result.get('c2')).toBe('#3b82f6');
    expect(result.get('c3')).toBeNull();
  });
});

describe('buildCategoryLabelMap', () => {
  it('returns the bare name for a top-level category', () => {
    const result = buildCategoryLabelMap([food]);
    expect(result.get('cat-3')).toBe('Food');
  });

  it('returns "Parent: Child" for a subcategory', () => {
    const result = buildCategoryLabelMap([food, fastFood, fineDining]);
    expect(result.get('cat-4')).toBe('Food: Fast Food');
    expect(result.get('cat-5')).toBe('Food: Fine Dining');
  });

  it('falls back to the bare name when the parent is not in the list', () => {
    const orphan = makeCategory({ id: 'cat-9', name: 'Snacks', parentId: 'missing' });
    const result = buildCategoryLabelMap([orphan]);
    expect(result.get('cat-9')).toBe('Snacks');
  });

  it('returns an empty map for no categories', () => {
    expect(buildCategoryLabelMap([]).size).toBe(0);
  });
});

describe('buildDescendantIdSet', () => {
  it('includes the category itself and every level of descendants', () => {
    const grandchild = makeCategory({ id: 'cat-6', name: 'Sushi', parentId: 'cat-5' });
    const result = buildDescendantIdSet([food, fastFood, fineDining, grandchild], 'cat-3');
    expect(result).toEqual(new Set(['cat-3', 'cat-4', 'cat-5', 'cat-6']));
  });

  it('returns only the category itself for a leaf', () => {
    expect(buildDescendantIdSet([food, fastFood], 'cat-4')).toEqual(new Set(['cat-4']));
  });

  it('ignores unrelated branches', () => {
    const result = buildDescendantIdSet([food, fastFood, groceries], 'cat-3');
    expect(result.has('cat-1')).toBe(false);
  });
});

describe('rollupToDirectChildren', () => {
  const grandchild = makeCategory({ id: 'cat-6', name: 'Sushi', parentId: 'cat-5' });
  const tree = [food, fastFood, fineDining, grandchild, groceries];

  it('rolls leaf rows up to direct children and buckets the category itself as name null', () => {
    const result = rollupToDirectChildren(
      [
        { id: 'cat-4', total: -100, count: 4 },
        // A grandchild's rows land in its direct-child ancestor.
        { id: 'cat-6', total: -60, count: 2 },
        { id: 'cat-5', total: -40, count: 1 },
        { id: 'cat-3', total: -50, count: 3 },
      ],
      tree,
      'cat-3',
    );
    expect(result).toEqual([
      { id: 'cat-4', name: 'Fast Food', total: -100, count: 4, share: 0.4 },
      { id: 'cat-5', name: 'Fine Dining', total: -100, count: 3, share: 0.4 },
      { id: 'cat-3', name: null, total: -50, count: 3, share: 0.2 },
    ]);
  });

  it('drops rows outside the subtree', () => {
    const result = rollupToDirectChildren(
      [
        { id: 'cat-4', total: -100, count: 4 },
        { id: 'cat-1', total: -999, count: 9 },
        { id: null, total: -50, count: 1 },
      ],
      tree,
      'cat-3',
    );
    expect(result).toEqual([
      { id: 'cat-4', name: 'Fast Food', total: -100, count: 4, share: 1 },
    ]);
  });

  it('returns [] for a category with no children', () => {
    expect(
      rollupToDirectChildren([{ id: 'cat-1', total: -100, count: 1 }], tree, 'cat-1'),
    ).toEqual([]);
  });

  it('returns [] when every bucket nets to zero', () => {
    const result = rollupToDirectChildren(
      [
        { id: 'cat-4', total: 50, count: 1 },
        { id: 'cat-4', total: -50, count: 1 },
      ],
      tree,
      'cat-3',
    );
    expect(result).toEqual([]);
  });
});

const labels: SpecialCategoryFilterLabels = {
  uncategorized: 'Uncategorized',
  transfer: 'Transfers',
  income: 'All income categories',
  expense: 'All expense categories',
};
const salary = makeCategory({ id: 'inc-1', name: 'Salary', isIncome: true });
const bonus = makeCategory({ id: 'inc-2', name: 'Bonus', isIncome: true, parentId: 'inc-1' });

describe('buildCategoryFilterOptions', () => {
  it('lists the four labelled pseudo-ids first, then the tree', () => {
    const result = buildCategoryFilterOptions([food, fastFood, salary], labels);
    expect(result.slice(0, 4)).toEqual([
      { value: 'uncategorized', label: 'Uncategorized', separatorAfter: false },
      { value: 'transfer', label: 'Transfers', separatorAfter: false },
      { value: 'income', label: 'All income categories', separatorAfter: false },
      { value: 'expense', label: 'All expense categories', separatorAfter: true },
    ]);
    expect(result.slice(4).map((o) => o.value)).toEqual(['cat-3', 'inc-1']);
    expect(result[4].children?.map((o) => o.value)).toEqual(['cat-4']);
  });

  it('closes the pseudo-id group after the last one, and nowhere else', () => {
    const result = buildCategoryFilterOptions([food, fastFood, salary], labels);
    // Exactly one boundary, on the last pseudo-id: everything above it filters
    // by what a record is, everything below is a category you can pick.
    expect(result.filter((o) => o.separatorAfter).map((o) => o.value)).toEqual(['expense']);
  });

  it('still marks the boundary when there are no categories to separate', () => {
    // The list is the four pseudo-ids and nothing else. The flag stays put;
    // MultiSelect is what declines to draw a rule under the last row.
    const result = buildCategoryFilterOptions([], labels);
    expect(result).toHaveLength(4);
    expect(result[3]).toMatchObject({ value: 'expense', separatorAfter: true });
  });
});

describe('resolveSelectedCategories', () => {
  it('renders every pseudo-id as a labelled chip and drops unknown ids', () => {
    const result = resolveSelectedCategories(
      ['income', 'cat-1', 'missing', 'transfer', 'expense', 'uncategorized'],
      [groceries],
      labels,
    );
    expect(result.map((c) => c.name)).toEqual([
      'All income categories', 'Groceries', 'Transfers', 'All expense categories', 'Uncategorized',
    ]);
  });
});

describe('canonicalizeCategoryFilter', () => {
  const all = [groceries, food, fastFood, salary, bonus];

  it('collapses a selection of every category of a type into its pseudo-id, in place', () => {
    expect(canonicalizeCategoryFilter(['cat-1', 'inc-1', 'uncategorized', 'inc-2'], all))
      .toEqual(['cat-1', 'income', 'uncategorized']);
  });

  it('leaves a partial type as ids', () => {
    expect(canonicalizeCategoryFilter(['cat-1', 'inc-1'], all)).toEqual(['cat-1', 'inc-1']);
  });

  it('drops ids a present pseudo-id already covers', () => {
    expect(canonicalizeCategoryFilter(['inc-1', 'expense', 'cat-3', 'income'], all))
      .toEqual(['expense', 'income']);
  });

  it('turns Select All into the four pseudo-ids', () => {
    const everything = ['uncategorized', 'transfer', 'income', 'expense', ...all.map((c) => c.id)];
    expect(canonicalizeCategoryFilter(everything, all)).toEqual(['uncategorized', 'transfer', 'income', 'expense']);
  });

  it('never collapses a type that has no categories', () => {
    expect(canonicalizeCategoryFilter(['cat-1', 'cat-3', 'cat-4'], [groceries, food, fastFood]))
      .toEqual(['expense']);
    expect(canonicalizeCategoryFilter([], [groceries])).toEqual([]);
    expect(canonicalizeCategoryFilter(['cat-1'], [])).toEqual(['cat-1']);
  });
});

describe('signAmountByCategory', () => {
  const expense = { isIncome: false, effectiveAutoSign: true };
  const income = { isIncome: true, effectiveAutoSign: true };

  it('makes a typed amount negative for an expense category', () => {
    expect(signAmountByCategory(25, undefined, expense)).toBe(-25);
  });

  it('makes a typed amount positive for an income category', () => {
    expect(signAmountByCategory(-25, undefined, income)).toBe(25);
  });

  it('treats an absent effectiveAutoSign as on', () => {
    expect(signAmountByCategory(25, undefined, { isIncome: false } as never)).toBe(-25);
  });

  it('leaves the typed value unchanged when automatic sign is off', () => {
    expect(signAmountByCategory(25, undefined, { isIncome: false, effectiveAutoSign: false })).toBe(25);
    expect(signAmountByCategory(-25, undefined, { isIncome: true, effectiveAutoSign: false })).toBe(-25);
  });

  it('preserves a pure sign flip of the reference whatever the setting', () => {
    expect(signAmountByCategory(25, -25, expense)).toBe(25);
    expect(signAmountByCategory(-25, 25, income)).toBe(-25);
    expect(signAmountByCategory(25, -25, { isIncome: false, effectiveAutoSign: false })).toBe(25);
  });

  it('returns the value unchanged with no category', () => {
    expect(signAmountByCategory(25, undefined, undefined)).toBe(25);
    expect(signAmountByCategory(-25, 10, undefined)).toBe(-25);
  });
});

describe('getCategorySelectOptionsFor (INV-CATEGORY-001)', () => {
  const transfers = makeCategory({ id: 't', name: 'Transfers', categoryType: 'transfer' });
  const brokerage = makeCategory({ id: 't2', name: 'Brokerage', parentId: 't', categoryType: 'transfer' });
  const list = [groceries, transfers, brokerage, dining];

  it('offers a transfer every type, Transfer categories first, each with its path', () => {
    expect(getCategorySelectOptionsFor(list, 'transfer').map((o) => o.label)).toEqual([
      'Transfers',
      'Transfers: Brokerage',
      'Dining',
      'Groceries',
    ]);
  });

  it('offers a category row only Income and Expense, after the pseudo entries it asks for', () => {
    expect(
      getCategorySelectOptionsFor(list, 'category', { includeEmpty: true, emptyLabel: 'None' }).map((o) => o.value),
    ).toEqual(['', 'cat-2', 'cat-1']);
  });
});

describe('buildCategoryPickerOptions (INV-CATEGORY-001)', () => {
  const transfers = makeCategory({ id: 't', name: 'Transfers', categoryType: 'transfer' });
  const brokerage = makeCategory({ id: 't2', name: 'Brokerage', parentId: 't', categoryType: 'transfer' });
  const list = [groceries, transfers, brokerage, dining];
  const labels = (holder: 'transfer' | 'category') =>
    buildCategoryPickerOptions(list, holder, (_c, label) => label);

  it('lists a transfer every type, Transfer categories first', () => {
    expect(labels('transfer')).toEqual(['Transfers', 'Transfers: Brokerage', 'Dining', 'Groceries']);
  });

  it('lists a category row Income and Expense only', () => {
    expect(labels('category')).toEqual(['Dining', 'Groceries']);
  });
});
