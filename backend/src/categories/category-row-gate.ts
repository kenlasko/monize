import { EntityManager } from "typeorm";
import { Category } from "./entities/category.entity";
import { isTransferCategory } from "./category-type.util";

/**
 * Where a stored setting is applied to a category row, a Transfer category is
 * skipped as if the setting were empty: the row is written uncategorized and
 * nothing is refused (`docs/specs/transfer-categories.md` section 3). A setting
 * can hold one only when a pod of the previous release wrote it during a
 * rollout; this release refuses it at the write (`category-fit.ts`).
 *
 * One lookup per category per manager, so an import of thousands of rows asks
 * the database once for each distinct default.
 */
const gates = new WeakMap<EntityManager, Map<string, Promise<boolean>>>();

/**
 * `categoryId` when a category row may hold it, otherwise `null`: no category,
 * a category that is not the person's, or a Transfer category.
 */
export async function categoryIdForCategoryRow(
  manager: EntityManager,
  userId: string,
  categoryId: string | null | undefined,
): Promise<string | null> {
  if (!categoryId) return null;
  let cache = gates.get(manager);
  if (!cache) {
    cache = new Map();
    gates.set(manager, cache);
  }
  let usable = cache.get(categoryId);
  if (usable === undefined) {
    usable = (async () => {
      const category = await manager.findOne(Category, {
        where: { id: categoryId, userId },
      });
      return category == null || !isTransferCategory(category);
    })();
    cache.set(categoryId, usable);
  }
  return (await usable) ? categoryId : null;
}
