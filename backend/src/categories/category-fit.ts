import { BadRequestException, NotFoundException } from "@nestjs/common";
import { EntityManager, In } from "typeorm";
import { lockCategoryOwnerShared } from "../common/db/locks";
import { tr } from "../i18n/translate";
import { Category } from "./entities/category.entity";
import { CategoryTypeSource, isTransferCategory } from "./category-type.util";

/**
 * What holds a category (`docs/specs/transfer-categories.md` section 1):
 *
 * - `transfer`: a transfer row. A whole transfer leg, a split's transfer line
 *   and the row it links in the other account, a scheduled transfer, a
 *   scheduled split's transfer line, and an override of either.
 * - `category`: a category row. An ordinary row, a split's category line, a
 *   scheduled ordinary transaction, a scheduled split's category line, and an
 *   override of either.
 */
export type CategoryHolder = "transfer" | "category";

/**
 * Fits (section 3, INV-CATEGORY-001): a category of any type fits a transfer
 * row; only an Income or Expense category fits a category row. No category
 * always fits, so callers never ask about one.
 */
export function categoryFits(
  category: CategoryTypeSource,
  holder: CategoryHolder,
): boolean {
  return holder === "transfer" || !isTransferCategory(category);
}

/** The holder a whole row is: a transfer leg or an ordinary row. */
export function holderOfRow(row: {
  readonly isTransfer?: boolean | null;
}): CategoryHolder {
  return row.isTransfer === true ? "transfer" : "category";
}

/** The holder a split line is: a transfer line names the other account. */
export function holderOfSplitLine(line: {
  readonly transferAccountId?: string | null;
}): CategoryHolder {
  return line.transferAccountId ? "transfer" : "category";
}

/** The 400 every refusal of a Transfer category on a category row answers. */
export function transferCategoryRefusal(name: string): BadRequestException {
  return new BadRequestException(
    tr(
      "errors.categories.transferCategoryOnCategoryRow",
      // Interpolated here too: outside a request `tr` returns the fallback.
      `${name} is a Transfer category; it can go only on a transfer`,
      { name },
    ),
  );
}

/** The refusal of a category the person does not own, as most routes answer it. */
export function categoryNotFound(): NotFoundException {
  return new NotFoundException(
    tr("errors.transactions.categoryNotFound", "Category not found"),
  );
}

export interface FitCategoryOptions {
  /**
   * The error a category the person does not own answers. Defaults to the
   * 404 of the transaction routes; the transfer routes answer 400.
   */
  readonly notFound?: () => Error;
}

/**
 * The one check every write of a category onto a row goes through: the
 * category is the person's, and it fits what holds it (INV-CATEGORY-001).
 *
 * Runs inside the transaction that writes, before the first write
 * (`docs/financial-calculation-contract.md` section 7). On a category row the
 * shared category-owner lock is taken first, so a concurrent type change
 * either commits before the type is read or waits for this transaction's
 * commit (specification section 12); it is re-entrant, and the database
 * backstop takes it again and adds nothing. A transfer row takes a category of
 * any type, so no type change can make it stop fitting and it takes no lock:
 * the transfer writers lock their legs first, and an advisory lock after a row
 * lock is the order `common/db/locks.ts` forbids.
 *
 * Returns the category to write, or `null` when the request names none.
 */
export async function fitCategory(
  m: EntityManager,
  userId: string,
  categoryId: string | null | undefined,
  holder: CategoryHolder,
  options: FitCategoryOptions = {},
): Promise<Category | null> {
  if (!categoryId) return null;
  if (holder === "category") await lockCategoryOwnerShared(m, userId);
  const category = await m
    .getRepository(Category)
    .findOne({ where: { id: categoryId, userId } });
  if (!category) {
    throw (options.notFound ?? categoryNotFound)();
  }
  if (!categoryFits(category, holder)) {
    throw transferCategoryRefusal(category.name);
  }
  return category;
}

export interface FitCategoryLine {
  readonly categoryId?: string | null;
  readonly holder: CategoryHolder;
}

/**
 * `fitCategory` over many lines (a split's lines, a schedule's lines): one
 * read for every distinct category, a refusal naming the first that does not
 * fit. `notFound` receives the ids the person does not own.
 *
 * Returns the categories read, by id.
 */
export async function fitCategories(
  m: EntityManager,
  userId: string,
  lines: readonly FitCategoryLine[],
  options: { readonly notFound?: (ids: readonly string[]) => Error } = {},
): Promise<ReadonlyMap<string, Category>> {
  const ids = [
    ...new Set(
      lines
        .map((line) => line.categoryId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const byId = new Map<string, Category>();
  if (ids.length === 0) return byId;
  if (lines.some((line) => line.categoryId && line.holder === "category")) {
    await lockCategoryOwnerShared(m, userId);
  }
  const found = await m.find(Category, { where: { id: In(ids), userId } });
  for (const category of found) byId.set(category.id, category);
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw options.notFound
      ? options.notFound(missing)
      : new NotFoundException(
          tr(
            "errors.transactions.categoriesNotFound",
            `Categories not found: ${missing.join(", ")}`,
            { ids: missing.join(", ") },
          ),
        );
  }
  for (const line of lines) {
    const category = line.categoryId ? byId.get(line.categoryId) : undefined;
    if (category && !categoryFits(category, line.holder)) {
      throw transferCategoryRefusal(category.name);
    }
  }
  return byId;
}

/**
 * A Transfer category goes only on a transfer (INV-CATEGORY-001, section 3 of
 * `docs/specs/transfer-categories.md`). These are the refusals of the
 * settings a later write copies onto a category row: a payee's default, an
 * asset account's asset category, a loan's interest and fee categories and a
 * payroll deduction rule. Each runs inside the transaction that would write the
 * setting, before the first write. Ownership is the setting's own check.
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
