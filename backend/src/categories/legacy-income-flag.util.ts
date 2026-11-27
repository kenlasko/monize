import { categoryTypeFromIncomeFlag } from "./category-type.util";

/**
 * The type of a category snapshot written before the type existed, for the two
 * paths that replay one into today's schema: a backup restore and an
 * action-history undo (#2478, `docs/specs/transfer-categories.md` section 11).
 *
 * Up to 1.21.x a category carried only `is_income`; 1.22.0 wrote both (this
 * drop ships in the release after it). The
 * contract migration `20261127205950_categories_drop_is_income.sql` dropped the
 * flag, so a snapshot replayed as it stands would name a column that no longer
 * exists, and one carrying only the flag would come back as an Expense category
 * (the column default) even when it was an Income one.
 *
 * The answer is the backfill's: a stored type stands; a missing one is Income
 * when the flag is true and Expense otherwise (a source of that age knew no
 * third type). A snapshot with neither is not a whole row, so it is left
 * without a type (absent leaves the stored column alone on an update, and an
 * insert takes the default). A stored value is passed through unchecked, as
 * every other restored column is: the CHECK refuses a bad one.
 *
 * This module is the one place in `src/` that names the dropped flag on a
 * category: old backups and undo snapshots still carry it.
 */
function resolveType(
  row: Record<string, unknown>,
  typeKey: string,
  flagKey: string,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...row };
  const storedType = row[typeKey];
  if (storedType === null || storedType === undefined) {
    const flag = row[flagKey];
    if (flag === null || flag === undefined) {
      // No type to state: a null would refuse the NOT NULL column.
      delete resolved[typeKey];
    } else {
      resolved[typeKey] = categoryTypeFromIncomeFlag(flag === true);
    }
  }
  delete resolved[flagKey];
  return resolved;
}

/**
 * A backup's `categories` row (snake_case) with `category_type` resolved and
 * the dropped flag column removed. A new object; the input is not mutated.
 */
export function withResolvedCategoryTypeColumn(
  row: Record<string, unknown>,
): Record<string, unknown> {
  // income-flag-ok: the dropped column an old backup still carries
  return resolveType(row, "category_type", "is_income");
}

/**
 * An action-history category snapshot (camelCase) with `categoryType` resolved
 * and the dropped flag property removed. A new object; the input is not
 * mutated.
 */
export function withResolvedCategoryTypeProperty(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  // income-flag-ok: the dropped property an old undo snapshot still carries
  return resolveType(snapshot, "categoryType", "isIncome");
}
