import type { SortDirection } from '@/hooks/useSortableTable';

/** A column of the wizard's category and transfer tables. */
export type WizardSortField = 'name' | 'median' | 'amount';

/**
 * A table's sort. `default` is the order the table opens in (the analysis
 * order, expenses by suggested amount) until a header is pressed.
 */
export interface WizardTableSort {
  field: WizardSortField | 'default';
  direction: SortDirection;
}

export const DEFAULT_WIZARD_SORT: WizardTableSort = { field: 'default', direction: 'desc' };

/** Pressing the active column flips it; another column starts ascending. */
export function nextWizardSort(prev: WizardTableSort, field: WizardSortField): WizardTableSort {
  return prev.field === field
    ? { field, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
    : { field, direction: 'asc' };
}

const PATH_SEPARATOR = ': ';

/** "Parent: Child" as its two parts; a top-level name has no child. */
function splitCategoryPath(name: string): { parent: string; child: string | null } {
  const at = name.indexOf(PATH_SEPARATOR);
  if (at === -1) return { parent: name, child: null };
  return { parent: name.slice(0, at), child: name.slice(at + PATH_SEPARATOR.length) };
}

/**
 * Orders "Parent: Child" names so every subcategory sits directly under its
 * parent: parents compare first, the parent's own row leads its group, and
 * children compare within it. A plain string compare would put a top-level
 * "Taxes Owing" between "Taxes" and "Taxes: Federal", because collation
 * orders the space before the ": " separator.
 * `direction` reverses the parents and the children, never the parent's lead.
 */
export function compareCategoryPaths(a: string, b: string, direction: SortDirection = 'asc'): number {
  const sign = direction === 'asc' ? 1 : -1;
  const pa = splitCategoryPath(a);
  const pb = splitCategoryPath(b);
  const byParent = pa.parent.localeCompare(pb.parent);
  if (byParent !== 0) return sign * byParent;
  if (pa.child === null || pb.child === null) {
    if (pa.child === pb.child) return 0;
    return pa.child === null ? -1 : 1;
  }
  return sign * pa.child.localeCompare(pb.child);
}

export interface WizardSortAccessors<T> {
  name: (row: T) => string;
  median: (row: T) => number;
  /** The amount typed for a selected row; null while the row is not selected. */
  amount: (row: T) => number | null;
}

/**
 * The rows in the table's sort order, as a new array; the same array under the
 * default order. A row with no amount sorts last in either direction, and ties
 * fall back to the category order.
 */
export function sortWizardRows<T>(
  rows: readonly T[],
  sort: WizardTableSort,
  accessors: WizardSortAccessors<T>,
): readonly T[] {
  if (sort.field === 'default') return rows;
  const sign = sort.direction === 'asc' ? 1 : -1;
  const byName = (a: T, b: T) => compareCategoryPaths(accessors.name(a), accessors.name(b));

  if (sort.field === 'name') {
    return [...rows].sort((a, b) =>
      compareCategoryPaths(accessors.name(a), accessors.name(b), sort.direction),
    );
  }

  const value = sort.field === 'median' ? accessors.median : accessors.amount;
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null || vb === null) {
      if (va === vb) return byName(a, b);
      return va === null ? 1 : -1;
    }
    return va !== vb ? sign * (va - vb) : byName(a, b);
  });
}
