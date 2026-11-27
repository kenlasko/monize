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

/**
 * What a category says about its type: the type itself, or, for a value built
 * before the type existed (a fixture, a row of the previous release's shape),
 * the legacy flag. This is the one place the flag is read.
 */
export interface CategoryTypeSource {
  readonly categoryType?: CategoryType | null;
  readonly isIncome?: boolean | null;
}

/** The type of a category, from its type or, failing that, its legacy flag. */
export function categoryTypeOf(category: CategoryTypeSource): CategoryType {
  return category.categoryType ?? categoryTypeFromIncomeFlag(category.isIncome);
}

/**
 * `categoryTypeOf`, or `undefined` when there is no category (an uncategorized
 * row) or its type is unknown: a stored value with neither a type nor a legacy
 * flag. A report then falls back to the sign of the movement, as it does for an
 * uncategorized row, and never reads the unknown as an expense.
 */
export function categoryTypeOfOrUndefined(
  category: CategoryTypeSource | null | undefined,
): CategoryType | undefined {
  if (!category) return undefined;
  if (category.categoryType == null && category.isIncome == null) {
    return undefined;
  }
  return categoryTypeOf(category);
}

export function isIncomeCategory(category: CategoryTypeSource): boolean {
  return categoryTypeOf(category) === "income";
}

export function isExpenseCategory(category: CategoryTypeSource): boolean {
  return categoryTypeOf(category) === "expense";
}

export function isTransferCategory(category: CategoryTypeSource): boolean {
  return categoryTypeOf(category) === "transfer";
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
