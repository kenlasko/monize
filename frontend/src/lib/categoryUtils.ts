import { Category } from '@/types/category';
import {
  categoriesForHolder,
  categoryTypeOrUndefined,
  isTransferCategory,
  signByCategoryType,
  type CategoryHolder,
} from '@/lib/category-type';
import type { MultiSelectOption } from '@/components/ui/MultiSelect';

interface CategoryOption {
  value: string;
  label: string;
}

/**
 * Build a hierarchical list of category options with proper indentation
 * for use in Select/Combobox components
 */
export function buildCategoryTree(
  categories: Category[],
  excludeIds: Set<string> = new Set()
): Array<{ category: Category; level: number }> {
  const buildTree = (
    parentId: string | null = null,
    level: number = 0
  ): Array<{ category: Category; level: number }> => {
    return categories
      .filter((c) => c.parentId === parentId && !excludeIds.has(c.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((cat) => [
        { category: cat, level },
        ...buildTree(cat.id, level + 1),
      ]);
  };

  return buildTree();
}

/**
 * Convert categories to hierarchical select options
 */
export function getCategorySelectOptions(
  categories: Category[],
  options?: {
    includeEmpty?: boolean;
    emptyLabel?: string;
    excludeIds?: Set<string>;
    includeUncategorized?: boolean;
    includeTransfers?: boolean;
  }
): CategoryOption[] {
  const {
    includeEmpty = false,
    emptyLabel = 'Uncategorized',
    excludeIds = new Set<string>(),
    includeUncategorized = false,
    includeTransfers = false,
  } = options || {};

  // Build a map for quick parent lookups
  const categoryMap = new Map(categories.map((c) => [c.id, c]));

  // Get full path label for a category (e.g., "Parent: Child")
  const getFullLabel = (category: Category): string => {
    if (category.parentId) {
      const parent = categoryMap.get(category.parentId);
      if (parent) {
        return `${parent.name}: ${category.name}`;
      }
    }
    return category.name;
  };

  const tree = buildCategoryTree(categories, excludeIds);

  const categoryOptions = tree.map(({ category }) => ({
    value: category.id,
    label: getFullLabel(category),
  }));

  const result: CategoryOption[] = [];

  if (includeEmpty) {
    result.push({ value: '', label: emptyLabel });
  }

  if (includeUncategorized) {
    result.push({ value: 'uncategorized', label: 'Uncategorized' });
  }

  if (includeTransfers) {
    result.push({ value: 'transfer', label: 'Transfers' });
  }

  return [...result, ...categoryOptions];
}

/**
 * `getCategorySelectOptions` for a picker that writes onto `holder`
 * (INV-CATEGORY-001): on a transfer every type, Transfer categories first;
 * elsewhere Income and Expense only. Each group keeps its own tree order.
 */
export function getCategorySelectOptionsFor(
  categories: Category[],
  holder: CategoryHolder,
  options?: Parameters<typeof getCategorySelectOptions>[1],
): CategoryOption[] {
  const fitting = categoriesForHolder(categories, holder);
  if (holder === 'category') return getCategorySelectOptions(fitting, options);
  // The pseudo entries the options ask for (empty, uncategorized), then each
  // group as a tree of its own; a child's label names its parent from the
  // whole list.
  const head = getCategorySelectOptions([], options);
  const group = (list: Category[]) =>
    getCategorySelectOptions(list).map((option) => ({
      ...option,
      label: categoryPathLabel(categories, option.value) ?? option.label,
    }));
  return [
    ...head,
    ...group(fitting.filter(isTransferCategory)),
    ...group(fitting.filter((c) => !isTransferCategory(c))),
  ];
}

/**
 * The options a category picker on a row of `holder` offers, in tree order
 * with "Parent: Child" labels (INV-CATEGORY-001): on a transfer every type,
 * Transfer categories first; elsewhere Income and Expense only. `toOption`
 * adds what a picker shows beside the label (an icon).
 */
export function buildCategoryPickerOptions<T>(
  categories: Category[],
  holder: CategoryHolder,
  toOption: (category: Category, label: string) => T,
): T[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const group = (list: Category[]) =>
    buildCategoryTree(list).map(({ category }) => {
      const parent = category.parentId ? byId.get(category.parentId) : undefined;
      return toOption(category, parent ? `${parent.name}: ${category.name}` : category.name);
    });
  const fitting = categoriesForHolder(categories, holder);
  if (holder === 'category') return group(fitting);
  return [...group(fitting.filter(isTransferCategory)), ...group(fitting.filter((c) => !isTransferCategory(c)))];
}

/** "Parent: Child" for a category by id, read from the whole list. */
function categoryPathLabel(categories: Category[], id: string): string | undefined {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const category = byId.get(id);
  if (!category) return undefined;
  const parent = category.parentId ? byId.get(category.parentId) : undefined;
  return parent ? `${parent.name}: ${category.name}` : category.name;
}

/**
 * Build a map of category ID to effective (inherited) color.
 * Used by components that display categories from DB joins
 * (e.g., transaction lists, payee lists) which don't include
 * the computed effectiveColor field.
 */
export function buildCategoryColorMap(
  categories: Category[],
): Map<string, string | null> {
  return new Map(
    categories.map((c) => [c.id, c.effectiveColor ?? c.color]),
  );
}

/**
 * The icon sibling of {@link buildCategoryColorMap}, for the same reason: a
 * transaction's joined category row carries its own `icon` but not the
 * inherited one, so a child filed under an icon-bearing parent would show a
 * pill with no glyph beside a list row that has one.
 */
export function buildCategoryIconMap(
  categories: Category[],
): Map<string, string | null> {
  return new Map(categories.map((c) => [c.id, c.effectiveIcon ?? c.icon]));
}

/**
 * Build a map of category ID to its full hierarchical label
 * ("Parent: Child", or just the name for a top-level category). Useful for
 * surfaces that only hold a transaction's own category row (the list query
 * does not join the parent) but want to show the full path -- e.g. the
 * transaction action sheet.
 */
export function buildCategoryLabelMap(
  categories: Category[],
): Map<string, string> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  return new Map(
    categories.map((c) => {
      const parent = c.parentId ? byId.get(c.parentId) : null;
      return [c.id, parent ? `${parent.name}: ${c.name}` : c.name];
    }),
  );
}

/**
 * Every category id in a category's subtree, itself included. The backend
 * expands descendants for its own queries; this is the client-side twin for
 * predicates that run over locally-held rows (scheduled transactions, say).
 */
export function buildDescendantIdSet(
  categories: Category[],
  categoryId: string,
): Set<string> {
  const ids = new Set<string>([categoryId]);
  let added = true;
  while (added) {
    added = false;
    for (const c of categories) {
      if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) {
        ids.add(c.id);
        added = true;
      }
    }
  }
  return ids;
}

/** One direct-child bucket of a category rollup. `name` is null for the category itself. */
export interface SubcategoryShare {
  id: string;
  name: string | null;
  total: number;
  count: number;
  /** This bucket's share of the summed absolute totals, 0..1. */
  share: number;
}

/**
 * Roll per-leaf grouped totals up to a category's direct children; rows for
 * the category itself become a bucket with `name: null` ("This category").
 * Rows outside the subtree are dropped. Shares are of the summed absolute
 * total, so mixed-sign buckets still read as parts of a whole. Returns []
 * when the category has no children -- a rollup of one bucket says nothing.
 */
export function rollupToDirectChildren(
  rows: ReadonlyArray<{ id: string | null; total: number | null; count?: number }>,
  categories: Category[],
  categoryId: string,
): SubcategoryShare[] {
  const hasChildren = categories.some((c) => c.parentId === categoryId);
  if (!hasChildren) return [];

  const parentOf = new Map(categories.map((c) => [c.id, c.parentId]));
  const rollupTarget = (id: string | null): string | null => {
    if (!id) return null;
    let current: string | null = id;
    while (current) {
      if (current === categoryId) return categoryId;
      const parent: string | null = parentOf.get(current) ?? null;
      if (parent === categoryId) return current;
      current = parent;
    }
    return null;
  };

  const buckets = new Map<string, { total: number; count: number }>();
  for (const row of rows) {
    const target = rollupTarget(row.id);
    if (!target) continue;
    // An unconvertible row (no rate for its currency) is left out of the rollup
    // rather than counted at its unconverted face value, which would size the
    // share in the wrong currency.
    if (row.total === null) continue;
    const bucket = buckets.get(target) ?? { total: 0, count: 0 };
    buckets.set(target, {
      total: bucket.total + row.total,
      count: bucket.count + (row.count ?? 0),
    });
  }
  const grandTotal = [...buckets.values()].reduce(
    (sum, bucket) => sum + Math.abs(bucket.total),
    0,
  );
  if (grandTotal === 0) return [];

  const byId = new Map(categories.map((c) => [c.id, c]));
  return [...buckets.entries()]
    .map(([id, bucket]) => ({
      id,
      name: id === categoryId ? null : (byId.get(id)?.name ?? ''),
      total: bucket.total,
      count: bucket.count,
      share: Math.abs(bucket.total) / grandTotal,
    }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

/**
 * The category-filter pseudo-ids. "uncategorized" matches records with no
 * category (neither transfers nor splits); "transfer" matches transfer
 * records; "income" and "expense" match every category of that type. The
 * server resolves all four, so a type is never sent as an enumerated id list
 * (a few hundred UUIDs overflow the request line and the page URL).
 */
export const SPECIAL_CATEGORY_FILTER_IDS = ['uncategorized', 'transfer', 'income', 'expense'] as const;
export type SpecialCategoryFilterId = (typeof SPECIAL_CATEGORY_FILTER_IDS)[number];
export type SpecialCategoryFilterLabels = Record<SpecialCategoryFilterId, string>;

export function isSpecialCategoryFilterId(id: string): id is SpecialCategoryFilterId {
  return (SPECIAL_CATEGORY_FILTER_IDS as readonly string[]).includes(id);
}

/**
 * Build the category filter options used by the filter panels: the pseudo-ids
 * (labelled by the caller, see `useCategoryFilterLabels`) followed by the
 * category hierarchy (parents with their children nested), sorted
 * alphabetically at each level. Selecting a parent selects all of its
 * descendants (handled by MultiSelect).
 */
export function buildCategoryFilterOptions(
  categories: Category[],
  labels: SpecialCategoryFilterLabels,
): MultiSelectOption[] {
  const buildOptions = (parentId: string | null = null): MultiSelectOption[] =>
    categories
      .filter((c) => c.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((cat) => {
        const children = buildOptions(cat.id);
        return [
          {
            value: cat.id,
            label: cat.name,
            parentId: cat.parentId,
            children: children.length > 0 ? children : undefined,
          },
        ];
      });
  // A group rule under the last pseudo-id: the four above it filter by what a
  // record *is* (no category, a transfer, a whole type) and everything below
  // is a category you can pick. Marked on the option rather than drawn by the
  // caller so every panel using this list gets the same boundary; MultiSelect
  // drops the rule when a search has flattened the list or when nothing
  // follows it.
  const special = SPECIAL_CATEGORY_FILTER_IDS.map((id, index) => ({
    value: id,
    label: labels[id],
    separatorAfter: index === SPECIAL_CATEGORY_FILTER_IDS.length - 1,
  }));
  return [...special, ...buildOptions()];
}

/**
 * Collapse a category selection that covers a whole type into that type's
 * pseudo-id, and drop ids a present type pseudo-id already covers. Only a
 * type with at least one category collapses. Order is otherwise preserved;
 * a pseudo-id that was absent takes the place of the first id it replaces.
 * This is what keeps "Select All" (and a whole type ticked by hand) off the
 * wire as an id list.
 */
export function canonicalizeCategoryFilter(ids: string[], categories: Category[]): string[] {
  let result = ids;
  for (const pseudoId of ['income', 'expense'] as const) {
    // `income` and `expense` are types: a Transfer category is in neither.
    const typeIds = new Set(categories.filter((c) => categoryTypeOrUndefined(c) === pseudoId).map((c) => c.id));
    if (typeIds.size === 0) continue;
    const selected = new Set(result);
    const covered = selected.has(pseudoId) || [...typeIds].every((id) => selected.has(id));
    if (!covered) continue;
    let placed = selected.has(pseudoId);
    result = result.flatMap((id) => {
      if (id === pseudoId) return [id];
      if (!typeIds.has(id)) return [id];
      if (placed) return [];
      placed = true;
      return [pseudoId];
    });
  }
  return result;
}

/**
 * Resolve selected category filter IDs (including the pseudo-ids) to
 * Category-like records for chip display.
 */
export function resolveSelectedCategories(
  categoryIds: string[],
  categories: Category[],
  labels: SpecialCategoryFilterLabels,
): Category[] {
  return categoryIds
    .map((id) => {
      if (isSpecialCategoryFilterId(id)) return { id, name: labels[id], color: null } as Category;
      return categories.find((c) => c.id === id);
    })
    .filter((c): c is Category => c !== undefined);
}

/**
 * Signs a typed amount by the category's income/expense type, unless the
 * category has turned the automatic sign off (`effectiveAutoSign === false`)
 * or the edit is only a sign flip of the same absolute value the caller
 * already had (a manual override is respected). With no category the value
 * is returned as-is. An absent `effectiveAutoSign` (a stale shape) reads as
 * on, matching the behaviour before the per-category toggle existed.
 */
export function signAmountByCategory(
  value: number,
  reference: number | undefined,
  category: Pick<Category, 'categoryType' | 'isIncome' | 'effectiveAutoSign'> | undefined,
): number {
  const referenceAbs = reference !== undefined ? Math.abs(reference) : 0;
  const isJustSignChange = referenceAbs === Math.abs(value) && referenceAbs !== 0;
  if (isJustSignChange || !category) return value;
  if (category.effectiveAutoSign === false) return value;
  return signByCategoryType(category, value);
}
