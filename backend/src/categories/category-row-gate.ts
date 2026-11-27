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
const gates = new WeakMap<
  EntityManager,
  Map<string, Promise<CategoryRowFit>>
>();

/**
 * What a category row may make of `categoryId`: `fits` (the person's Income
 * or Expense category), `transfer` (the person's Transfer category, which
 * goes only on a transfer), or `none` (no category, or one that is not the
 * person's or is gone).
 */
export type CategoryRowFit = "fits" | "transfer" | "none";

export async function categoryRowFit(
  manager: EntityManager,
  userId: string,
  categoryId: string | null | undefined,
): Promise<CategoryRowFit> {
  if (!categoryId) return "none";
  let cache = gates.get(manager);
  if (!cache) {
    cache = new Map();
    gates.set(manager, cache);
  }
  let fit = cache.get(categoryId);
  if (fit === undefined) {
    fit = (async () => {
      const category = await manager.findOne(Category, {
        where: { id: categoryId, userId },
      });
      if (category == null) return "none";
      return isTransferCategory(category) ? "transfer" : "fits";
    })();
    cache.set(categoryId, fit);
  }
  return fit;
}

/**
 * `categoryId` when a category row may hold it, otherwise `null`: no category,
 * a category that is not the person's, or a Transfer category.
 */
export async function categoryIdForCategoryRow(
  manager: EntityManager,
  userId: string,
  categoryId: string | null | undefined,
): Promise<string | null> {
  return (await categoryRowFit(manager, userId, categoryId)) === "fits"
    ? (categoryId as string)
    : null;
}
