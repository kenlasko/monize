import { SelectQueryBuilder } from "typeorm";

/**
 * SQL fragments for analytics queries that must attribute amounts and
 * categories to individual splits rather than the split parent.
 *
 * A split parent has `category_id = NULL` and `amount = SUM(splits)`,
 * so querying the parent row directly reports split transactions as
 * uncategorized and double-counts income/expense direction. The
 * caller must LEFT JOIN the splits (and optionally the split's
 * category) via `joinSplitsForAnalytics` before using these.
 */
export const SPLIT_CATEGORY_ID = "COALESCE(ts.categoryId, t.categoryId)";
export const SPLIT_AMOUNT = "COALESCE(ts.amount, t.amount)";
export const SPLIT_CATEGORY_NAME =
  "COALESCE(splitCat.name, cat.name, 'Uncategorized')";

/**
 * LEFT JOIN the splits table and the split's category, then exclude
 * transfer splits.
 *
 * Callers must use `t` as the transaction alias. Aliases `ts` and
 * `splitCat` are reserved for this helper.
 */
export function joinSplitsForAnalytics<T extends object>(
  qb: SelectQueryBuilder<T>,
): SelectQueryBuilder<T> {
  qb.leftJoin("t.splits", "ts");
  qb.leftJoin("ts.category", "splitCat");
  qb.andWhere("(ts.transferAccountId IS NULL OR ts.id IS NULL)");
  return qb;
}
