import { BadRequestException } from "@nestjs/common";
import { EntityManager, In } from "typeorm";
import { lockCategoryOwnerShared } from "../common/db/locks";
import { tr } from "../i18n/translate";
import { Category } from "./entities/category.entity";
import { isTransferCategory } from "./category-type.util";

/** The 400 every refusal of a Transfer category on a category row answers. */
export function transferCategoryRefusal(name: string): BadRequestException {
  return new BadRequestException(
    tr(
      "errors.categories.transferCategoryOnCategoryRow",
      "{{ name }} is a Transfer category; it can go only on a transfer",
      { name },
    ),
  );
}

/**
 * A Transfer category goes only on a transfer (INV-CATEGORY-001, section 3 of
 * `docs/specs/transfer-categories.md`). These are the refusals of the
 * settings a later write copies onto a category row: a payee's default, an
 * asset account's asset category, a loan's interest and fee categories and a
 * payroll deduction rule. Each runs inside the transaction that would write the
 * setting, before the first write.
 *
 * The shared category-owner lock is taken first, so a concurrent type change
 * either finishes before the check reads the type or waits for this
 * transaction's commit.
 */
export async function assertCategoriesTakeCategoryRows(
  m: EntityManager,
  userId: string,
  categoryIds: readonly (string | null | undefined)[],
): Promise<void> {
  const ids = [
    ...new Set(categoryIds.filter((id): id is string => Boolean(id))),
  ];
  if (ids.length === 0) return;
  await lockCategoryOwnerShared(m, userId);
  const categories = await m
    .getRepository(Category)
    .find({ where: { id: In(ids), userId } });
  const transfer = categories.find(
    (category) => category != null && isTransferCategory(category),
  );
  if (transfer) {
    throw transferCategoryRefusal(transfer.name);
  }
}

/** One category: the same refusal, read with `findOne`. */
export async function assertCategoryTakesCategoryRow(
  m: EntityManager,
  userId: string,
  categoryId: string | null | undefined,
): Promise<void> {
  if (!categoryId) return;
  await lockCategoryOwnerShared(m, userId);
  const category = await m
    .getRepository(Category)
    .findOne({ where: { id: categoryId, userId } });
  if (category != null && isTransferCategory(category)) {
    throw transferCategoryRefusal(category.name);
  }
}
