import { EntityManager } from "typeorm";
import {
  categoryFits,
  type CategoryHolder,
} from "../../../categories/category-fit";

/** The category maps a Money writer reads a row's category from. */
export interface MnyCategoryInput {
  /** Money `hcat` -> Monize category id. */
  readonly categoryIdByHandle: ReadonlyMap<number, string>;
  /**
   * The ids among `categoryIdByHandle` that are Transfer categories. Money
   * has no Transfer type and the importer creates none, but a file's
   * category is merged into an existing one of the same name and parent,
   * which a person may have made a Transfer category.
   */
  readonly transferCategoryIds?: ReadonlySet<string>;
}

/**
 * The category a Money row or line is written with (INV-CATEGORY-001): the
 * file's, when it fits what holds it. A transfer takes one of any type; a
 * category row or line that would land on a Transfer category is written
 * uncategorized, so the import is never refused whole by the database's
 * backstop for a merge the person did not choose row by row.
 */
export function fitMnyCategory(
  input: MnyCategoryInput,
  handle: number | null,
  holder: CategoryHolder,
): string | null {
  if (handle === null) return null;
  const id = input.categoryIdByHandle.get(handle) ?? null;
  if (id === null) return null;
  const categoryType = input.transferCategoryIds?.has(id)
    ? "transfer"
    : "expense";
  return categoryFits({ categoryType }, holder) ? id : null;
}

/** The Transfer categories among the ids a Money import will write. */
export async function transferCategoryIdsAmong(
  manager: EntityManager,
  userId: string,
  categoryIdByHandle: ReadonlyMap<number, string>,
): Promise<ReadonlySet<string>> {
  const ids = [...new Set(categoryIdByHandle.values())];
  if (ids.length === 0) return new Set();
  const rows = (await manager.query(
    `SELECT id FROM categories
      WHERE user_id = $1 AND category_type = 'transfer' AND id = ANY($2::uuid[])`,
    [userId, ids],
  )) as { id: string }[];
  return new Set(rows.map((row) => row.id));
}
