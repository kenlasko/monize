/**
 * The category type, and the one way to read it (INV-CATEGORY-003,
 * INV-CATEGORY-004, `docs/specs/transfer-categories.md`).
 *
 * A category is Income, Expense or Transfer. `categories.is_income` is the
 * previous release's flag: a trigger keeps it equal to `type = 'income'` for one
 * release, the API still returns it, and nothing in `src/` reads it to decide
 * what a category is. "Expense" is `type = 'expense'`, never "not income": a
 * Transfer category is neither, and a reader written as `!isIncome` counts it as
 * spending.
 */
export const CATEGORY_TYPES = ["income", "expense", "transfer"] as const;

export type CategoryType = (typeof CATEGORY_TYPES)[number];

/** What a request or a stored row may say about a category's type. */
export function isCategoryType(value: unknown): value is CategoryType {
  return (
    typeof value === "string" &&
    (CATEGORY_TYPES as readonly string[]).includes(value)
  );
}

interface HasCategoryType {
  readonly categoryType: CategoryType;
}

export function isIncomeCategory(category: HasCategoryType): boolean {
  return category.categoryType === "income";
}

export function isExpenseCategory(category: HasCategoryType): boolean {
  return category.categoryType === "expense";
}

export function isTransferCategory(category: HasCategoryType): boolean {
  return category.categoryType === "transfer";
}

/**
 * The type a category written with only the legacy flag means: a source that
 * knows nothing of Transfer categories (a QIF file, a Money file, a seed) says
 * Income or Expense.
 */
export function categoryTypeFromIncomeFlag(
  isIncome: boolean | null | undefined,
): CategoryType {
  return isIncome === true ? "income" : "expense";
}

/**
 * The legacy flag a type implies, written beside the type so a pod of the
 * previous release reads the same answer. Only a writer uses this.
 */
export function incomeFlagOfType(type: CategoryType): boolean {
  return type === "income";
}

/** The `category_type` of `alias` is `type`, as a SQL predicate. */
export function categoryTypeIs(alias: string, type: CategoryType): string {
  return `${alias}.category_type = '${type}'`;
}
