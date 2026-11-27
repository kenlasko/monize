/**
 * The category type, and the one way to read it (INV-CATEGORY-003,
 * INV-CATEGORY-004, `docs/specs/transfer-categories.md`).
 *
 * A category is Income, Expense or Transfer, and `categoryType` is the only
 * statement of it (the legacy `isIncome` flag is gone, #2478). "Expense" is the
 * expense type, never "not income": a Transfer category is neither, so every
 * read goes through these helpers. `src/lib/category-type.guard.test.ts` fails a
 * new raw read.
 */
export const CATEGORY_TYPES = ['income', 'expense', 'transfer'] as const;

export type CategoryType = (typeof CATEGORY_TYPES)[number];

/** What a category says about its type. */
export interface CategoryTypeSource {
  categoryType: CategoryType;
}

export function categoryTypeOf(category: CategoryTypeSource): CategoryType {
  return category.categoryType;
}

/**
 * The type, or `undefined` when the value carries none (a stored value of
 * unknown type). A filter that collapses a whole type into a pseudo-id counts
 * only categories of a known type.
 */
export function categoryTypeOrUndefined(category: {
  categoryType?: CategoryType | null;
}): CategoryType | undefined {
  return category.categoryType ?? undefined;
}

export function isIncomeCategory(category: CategoryTypeSource): boolean {
  return categoryTypeOf(category) === 'income';
}

export function isExpenseCategory(category: CategoryTypeSource): boolean {
  return categoryTypeOf(category) === 'expense';
}

export function isTransferCategory(category: CategoryTypeSource): boolean {
  return categoryTypeOf(category) === 'transfer';
}

/**
 * The signed amount a typed value takes under the category's type: income
 * positive, expense negative. A Transfer category has no automatic sign (the
 * sign of a transfer leg is its direction, and no category type restricts the
 * sign of an amount), so the value is returned exactly as typed.
 */
export function signByCategoryType(category: CategoryTypeSource, value: number): number {
  const type = categoryTypeOf(category);
  if (type === 'transfer') return value;
  return type === 'income' ? Math.abs(value) : -Math.abs(value);
}

/**
 * What holds a category (INV-CATEGORY-001, `docs/specs/transfer-categories.md`
 * section 1): a transfer row (a transfer, a split's transfer line, their
 * scheduled forms) or a category row (an ordinary row, a split's category
 * line, their scheduled forms).
 */
export type CategoryHolder = 'transfer' | 'category';

/** A transfer takes a category of any type; a category row only Income or Expense. */
export function categoryFitsHolder(category: CategoryTypeSource, holder: CategoryHolder): boolean {
  return holder === 'transfer' || !isTransferCategory(category);
}

/**
 * The categories a picker for `holder` offers: on a transfer every type,
 * Transfer categories first; elsewhere Income and Expense only. The order
 * within each group is the input's.
 */
export function categoriesForHolder<T extends CategoryTypeSource>(
  categories: readonly T[],
  holder: CategoryHolder,
): T[] {
  if (holder === 'category') return categories.filter((c) => !isTransferCategory(c));
  return [...categories.filter(isTransferCategory), ...categories.filter((c) => !isTransferCategory(c))];
}
