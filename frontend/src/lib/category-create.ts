import { categoriesApi } from './categories';
import type { CategoryType } from '@/lib/category-type';
import { delegationApi } from './delegation';
import { Category } from '@/types/category';

/**
 * Turning text typed into a picker into a category happens on five surfaces:
 * the transaction form's category field and each of its split lines, the
 * scheduled transaction form and its splits, and the asset-value category on
 * the account form. The rules below -- title casing, and the `Parent: Child`
 * shorthand that creates or reuses a parent -- had been written out inline
 * three times, and the scheduled form's copy had neither, so `travel: hotels`
 * became a child of Travel in one field and a single flat category literally
 * named "Travel: Hotels" in another.
 *
 * `createCategoryFromInput` is the only place typed text becomes a category,
 * on either ledger it can land on -- `categoriesApi.create` for the caller's
 * own, `delegationApi.createJointCategory` for the owner of a joint account.
 * The guard in `src/test/ui-conventions.test.ts` fails on a second call site
 * for either, outside the categories page's own full create form.
 *
 * It lives beside `categories.ts` rather than inside it for two reasons: that
 * module is a typed axios wrapper (`docs/frontend/api-and-cache.md`) and this is
 * multi-request orchestration over it, and roughly thirty suites replace
 * `@/lib/categories` wholesale with a mock -- a helper defined in the mocked
 * module would vanish with it, while one that *imports* it runs against
 * whatever `categoriesApi` the test installed.
 */

/** Capitalize the first letter of each word. */
export function toTitleCase(str: string): string {
  return str
    .toLowerCase()
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export interface CreatedCategory {
  /** The category the user asked for -- the child, when `Parent: Child` was typed. */
  category: Category;
  /**
   * Every category actually created, parent first. Callers append this to their
   * own category list so both rows appear in the picker, not only the child.
   */
  created: Category[];
  /** The parent's name when one applies, so a caller can name it in a toast. */
  parentName?: string;
  /** `Parent: Child` when nested, otherwise the category's own name. */
  displayName: string;
}

export interface CreateCategoryFromInputOptions {
  /** Passed through to the API for the created leaf category. */
  type?: CategoryType;
  /**
   * A joint account whose OWNER's ledger the category belongs on. A joint
   * transaction is the owner's row and may only carry the owner's category
   * ids, so text typed into that register's picker cannot go through
   * `categoriesApi.create` -- that writes to the caller's own ledger, which
   * put an id the owner does not own on the form. Set this and every create
   * below (the `Parent: Child` parent included) goes to the owner instead,
   * gated server-side on the delegation's categories-can-create capability.
   */
  jointAccountId?: string;
}

/**
 * Create a category from text typed into a picker.
 *
 * Returns `null` for blank input -- that is "nothing to do", not a failure.
 * API errors propagate; the caller owns the toast, because the surfaces differ
 * in which catalog their copy lives in.
 */
export async function createCategoryFromInput(
  name: string,
  categories: Category[],
  options: CreateCategoryFromInputOptions = {},
): Promise<CreatedCategory | null> {
  if (!name.trim()) return null;

  // One decision, made once: every create in this call lands on the same
  // ledger. Choosing per request could put a `Parent: Child` pair astride two.
  const createCategory = options.jointAccountId
    ? (data: { name: string; parentId?: string; type?: CategoryType }) =>
        delegationApi.createJointCategory(options.jointAccountId!, data)
    : categoriesApi.create;

  let categoryName = toTitleCase(name.trim());
  let parentId: string | undefined;
  let parentName: string | undefined;
  const created: Category[] = [];

  // "Parent: Child" creates (or reuses) the parent, then the child under it.
  if (categoryName.includes(':')) {
    const parts = categoryName.split(':').map((p) => p.trim());
    if (parts.length === 2 && parts[0] && parts[1]) {
      const typedParentName = toTitleCase(parts[0]);
      const childName = toTitleCase(parts[1]);

      // Match an existing top-level category case-insensitively; a child
      // category cannot itself be a parent.
      let parentCategory = categories.find(
        (c) => c.name.toLowerCase() === typedParentName.toLowerCase() && !c.parentId,
      );

      if (!parentCategory) {
        parentCategory = await createCategory({ name: typedParentName });
        created.push(parentCategory);
      }

      parentId = parentCategory.id;
      // The existing category's own name, not the typed casing.
      parentName = parentCategory.name;
      categoryName = childName;
    }
  }

  const category = await createCategory({
    name: categoryName,
    parentId,
    ...(options.type !== undefined ? { type: options.type } : {}),
  });
  created.push(category);

  return {
    category,
    created,
    parentName,
    displayName: parentName ? `${parentName}: ${categoryName}` : categoryName,
  };
}
