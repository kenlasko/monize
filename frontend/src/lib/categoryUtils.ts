import { Category } from '@/types/category';

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
