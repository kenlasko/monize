import type { CategoryType } from "../categories/category-type.util";
import { Category } from "../categories/entities/category.entity";

/**
 * A mock `Category` repository for the fit helper
 * (`src/categories/category-fit.ts`), registered with
 * `createScopedDbMocks([[Category, categoryFitRepoMock()]])`.
 *
 * `findOne` answers `fitCategory`'s read (`where: { id, userId }`) and `find`
 * `fitCategories`' (`where: { id: In([...]), userId }`) with a category of the
 * requested id, owned by the requested user, of the type `types` names (an
 * Expense category otherwise), as the real reads do for a category the person
 * owns. An id listed in `missing` has no row.
 */
export function categoryFitRepoMock(
  types: Readonly<Record<string, CategoryType>> = {},
  missing: readonly string[] = [],
): { find: jest.Mock; findOne: jest.Mock } {
  const row = (id: string, userId: unknown) => ({
    id,
    userId,
    name: id,
    categoryType: types[id] ?? "expense",
    isIncome: (types[id] ?? "expense") === "income",
  });
  return {
    findOne: jest.fn(
      async (options?: { where?: { id?: string; userId?: unknown } }) => {
        const id = options?.where?.id;
        return id && !missing.includes(id)
          ? row(id, options?.where?.userId)
          : null;
      },
    ),
    find: jest.fn(
      async (options?: { where?: { id?: unknown; userId?: unknown } }) => {
        const ids = (options?.where?.id as { value?: unknown })?.value;
        return (Array.isArray(ids) ? (ids as string[]) : [])
          .filter((id) => !missing.includes(id))
          .map((id) => row(id, options?.where?.userId));
      },
    ),
  };
}

/**
 * A `manager.find` implementation that answers `find(Category, ...)` from
 * `categories` (the `fitCategories` read) and everything else with `rest`.
 */
export function answerCategoryFinds(
  categories: { find: jest.Mock },
  rest: (entity: unknown, options: unknown) => unknown = async () => [],
): (entity: unknown, options: unknown) => unknown {
  return (entity, options) =>
    entity === Category ? categories.find(options) : rest(entity, options);
}

/**
 * A `manager.findOne` implementation that answers `findOne(Category, ...)` from
 * `categories` (the `fitCategory` and `categoryIdForCategoryRow` read) and
 * everything else with `rest`.
 */
export function answerCategoryFindOne(
  categories: { findOne: jest.Mock },
  rest: (entity: unknown, options: unknown) => unknown = async () => null,
): (entity: unknown, options: unknown) => unknown {
  return (entity, options) =>
    entity === Category ? categories.findOne(options) : rest(entity, options);
}
