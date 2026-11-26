/**
 * The category type, and the one way to read it (INV-CATEGORY-003,
 * INV-CATEGORY-004, `docs/specs/transfer-categories.md`).
 *
 * A category is Income, Expense or Transfer. The API's `isIncome` is the
 * previous release's flag, read-only and true only for Income: reading it as
 * "is it spending?" counts a Transfer category as spending, so every read goes
 * through these helpers. `src/lib/category-type.guard.test.ts` fails a new raw
 * read.
 */
export const CATEGORY_TYPES = ['income', 'expense', 'transfer'] as const;

export type CategoryType = (typeof CATEGORY_TYPES)[number];

/** What a category says about its type: the type, or, for a value built before the type existed, the legacy flag. */
export interface CategoryTypeSource {
  categoryType?: CategoryType | null;
  isIncome?: boolean | null;
}

export function categoryTypeOf(category: CategoryTypeSource): CategoryType {
  // income-flag-ok: the one place the legacy flag is read, as a fallback
  return category.categoryType ?? (category.isIncome === true ? 'income' : 'expense');
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
 * The signed amount a typed magnitude takes under the category's type: income
 * positive, expense negative. A Transfer category has no automatic sign (the
 * sign of a transfer leg is its direction), so the magnitude is returned as
 * typed.
 */
export function signByCategoryType(category: CategoryTypeSource, absolute: number): number {
  const type = categoryTypeOf(category);
  if (type === 'transfer') return absolute;
  return type === 'income' ? absolute : -absolute;
}
