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
  }
): CategoryOption[] {
  const { includeEmpty = false, emptyLabel = 'Uncategorized', excludeIds = new Set() } = options || {};

  const tree = buildCategoryTree(categories, excludeIds);

  const categoryOptions = tree.map(({ category, level }) => ({
    value: category.id,
    label: `${'  '.repeat(level)}${level > 0 ? '└ ' : ''}${category.name}`,
  }));

  if (includeEmpty) {
    return [{ value: '', label: emptyLabel }, ...categoryOptions];
  }

  return categoryOptions;
}
