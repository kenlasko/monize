/**
 * The category type, and the one way to read it (INV-CATEGORY-003,
 * INV-CATEGORY-004, `docs/specs/transfer-categories.md`).
 *
 * A category is Income, Expense or Transfer, and `categories.category_type` is
 * the only statement of it (the legacy `is_income` flag was dropped, #2478).
 * "Expense" is `type = 'expense'`, never "not income": a Transfer category is
 * neither, and a reader written as "not income" counts it as spending.
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

/** What a category says about its type. */
export interface CategoryTypeSource {
  readonly categoryType: CategoryType;
}

/** The type of a category. */
export function categoryTypeOf(category: CategoryTypeSource): CategoryType {
  return category.categoryType;
}

/**
 * `categoryTypeOf`, or `undefined` when there is no category (an uncategorized
 * row) or its type is unknown: a stored value read without its type. A report
 * then falls back to the sign of the movement, as it does for an uncategorized
 * row, and never reads the unknown as an expense.
 */
export function categoryTypeOfOrUndefined(
  category: { readonly categoryType?: CategoryType | null } | null | undefined,
): CategoryType | undefined {
  return category?.categoryType ?? undefined;
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
 * The type a source that knows only an income/expense flag means: a QIF file, a
 * Money file or a seed says Income or Expense, never Transfer.
 */
export function categoryTypeFromIncomeFlag(
  isIncome: boolean | null | undefined,
): CategoryType {
  return isIncome === true ? "income" : "expense";
}

/** The `category_type` of `alias` is `type`, as a SQL predicate. */
export function categoryTypeIs(alias: string, type: CategoryType): string {
  return `${alias}.category_type = '${type}'`;
}
