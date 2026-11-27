import { EntityManager, IsNull } from "typeorm";
import { categoryTypeFromIncomeFlag } from "../categories/category-type.util";
import { returnedRows } from "../common/db/query-result";
import { Category } from "../categories/entities/category.entity";

export interface CategoryToInsert {
  readonly userId: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly isIncome: boolean;
}

/**
 * Creates a category unless one with the same name and parent is already
 * there, and reports which of the two happened (INV-IMPORT-003).
 *
 * The callers' pre-checks are a fast path, not a guarantee: `UNIQUE(user_id,
 * name, parent_id)` is what decides, and an import runs as one long
 * transaction, so a unique violation does not merely fail one row -- it aborts
 * the whole import. A user creating "Auto:Fuel" by hand while a Money or QIF
 * import that also needs it is running was enough to lose the import.
 * `ON CONFLICT DO NOTHING` lets this insert lose and adopt the winner instead;
 * it still waits for a concurrent uncommitted insert of the same key, and only
 * the abort is removed.
 *
 * No conflict target, so it covers the constraint however it is spelled. The
 * constraint does not cover top-level categories (`parent_id` is NULL and NULL
 * never equals NULL), so two of those can still both be created; that is a
 * schema gap, not one this statement can close.
 *
 * The MNY writer (`writeCategories`) and the QIF importer
 * (`ImportService.findOrCreateCategoryDef`) call this;
 * `ImportEntityCreatorService.insertCategoryIfAbsent` is the CSV path's
 * earlier copy of the same statement.
 */
export async function insertCategoryIfAbsent(
  manager: EntityManager,
  category: CategoryToInsert,
): Promise<{ id: string; inserted: boolean }> {
  const { userId, name, parentId } = category;
  // The file says income or expense; no importer creates a Transfer category.
  const rows: unknown = await manager.query(
    `INSERT INTO categories (user_id, name, parent_id, category_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [userId, name, parentId, categoryTypeFromIncomeFlag(category.isIncome)], // income-flag-ok: the file's own flag
  );
  const insertedId = returnedRows<{ id: string }>(rows)[0]?.id;
  if (insertedId) {
    return { id: insertedId, inserted: true };
  }

  const existing = await manager.findOne(Category, {
    where: { userId, name, parentId: parentId ?? IsNull() },
    select: ["id"],
  });
  if (!existing) {
    throw new Error(
      `Category insert for "${name}" conflicted but no matching row exists`,
    );
  }
  return { id: existing.id, inserted: false };
}
