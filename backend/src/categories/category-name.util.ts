import { isTransferCategory } from "./category-type.util";
import { EntityManager } from "typeorm";
import { Category } from "./entities/category.entity";
import { escapeRegExp } from "../common/escape-regexp.util";
import { suggestClosestNames } from "../common/name-suggestions.util";

/**
 * One definition of how a category is named to, and named by, an LLM.
 *
 * Two categories may share a leaf name -- "Cell Phone" under both "Bills" and
 * "Business" is the ordinary case, not an edge case -- so the leaf name alone
 * identifies nothing. Everything an AI or MCP tool shows the user therefore
 * carries the parent ({@link qualifiedCategoryName}), and everything a tool
 * accepts back is resolved through {@link resolveCategoryNamePaths}, which
 * refuses an ambiguous name instead of picking a winner.
 *
 * The pair is the point: a name we emit must resolve back to the category we
 * emitted it for. `category-name.util.spec.ts` asserts exactly that round trip
 * over a tree with duplicate leaf names, because the two halves were previously
 * written four times between them and disagreed -- the resolver accepted
 * `"Business:Cell Phone"` and `"Business : Cell Phone"` but not
 * `"Business: Cell Phone"`, the one spelling the tool descriptions and error
 * messages tell the model to use. That miss fell through to a last-segment
 * fallback which returned *the other* "Cell Phone", and since the results were
 * labelled with the bare leaf name, nothing downstream could show that the
 * wrong category had been read.
 */

/** Separator between a parent and its child in a qualified name. */
export const CATEGORY_PATH_SEPARATOR = ": ";

/** Label for a transaction or split with no category at all. */
export const UNCATEGORIZED_LABEL = "Uncategorized";

/**
 * Label for a row that *has* a category whose name could not be resolved --
 * a row deleted between the aggregate and the name lookup, say. Distinct from
 * {@link UNCATEGORIZED_LABEL} on purpose: "the user filed this nowhere" and
 * "we could not read what they filed it under" are different facts, and
 * folding the second into the first reports a filing error the user did not
 * make.
 */
export const UNKNOWN_CATEGORY_LABEL = "Unknown category";

/**
 * Separators a model may type between parent and child, longest first so `->`
 * is consumed before the `>` inside it.
 */
const INPUT_SEPARATORS = ["->", ":", "/", ">"];

const SEPARATOR_PATTERN = new RegExp(
  `\\s*(?:${INPUT_SEPARATORS.map(escapeRegExp).join("|")})\\s*`,
  "g",
);

/** Lowercase, trim, collapse runs of whitespace. */
const norm = (value: string): string =>
  value.toLowerCase().trim().replace(/\s+/g, " ");

/**
 * A comparison key that ignores which separator was typed and how it was
 * spaced: `Business: Cell Phone`, `business:cell phone` and
 * `Business -> Cell Phone` all become `business:cell phone`.
 */
export const canonicalCategoryPath = (value: string): string =>
  norm(value).replace(SEPARATOR_PATTERN, ":");

/**
 * The name shown for a category anywhere a model or a user reads one:
 * `"Business: Cell Phone"` for a child, `"Business"` for a top-level category.
 */
export function qualifiedCategoryName(
  name: string,
  parentName?: string | null,
): string {
  return parentName ? `${parentName}${CATEGORY_PATH_SEPARATOR}${name}` : name;
}

/** The minimum a category must expose to be named and resolved. */
export interface CategoryNameRef {
  id: string;
  name: string;
  parentId?: string | null;
}

/**
 * Build `id -> qualified name` for a set of categories. Callers that hold
 * rows already (an entity list, a raw query) use this rather than a second
 * database round trip.
 */
export function qualifiedNamesById(
  categories: readonly CategoryNameRef[],
): Map<string, string> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  return new Map(
    categories.map((c) => [
      c.id,
      qualifiedCategoryName(
        c.name,
        c.parentId ? (byId.get(c.parentId)?.name ?? null) : null,
      ),
    ]),
  );
}

/**
 * Load every category the user owns as `id -> qualified name`.
 *
 * Takes an `EntityManager` rather than being a service method so any service
 * can qualify names without a new injection edge (CLAUDE.md bans the repository
 * injection that would otherwise tempt a second copy of this query).
 */
export async function loadQualifiedCategoryNames(
  m: EntityManager,
  userId: string,
  options: {
    /**
     * `"category"`: only the categories a category row or line may hold,
     * Income and Expense (INV-CATEGORY-001), for a list offered to choose
     * from. A child's name still names its parent.
     */
    readonly holder?: "category";
  } = {},
): Promise<Map<string, string>> {
  const categories = await m.getRepository(Category).find({
    where: { userId },
    select: ["id", "name", "parentId", "categoryType"],
  });
  const qualified = qualifiedNamesById(categories);
  if (options.holder !== "category") return qualified;
  const transfer = new Set(
    categories.filter((c) => isTransferCategory(c)).map((c) => c.id),
  );
  return new Map([...qualified].filter(([id]) => !transfer.has(id)));
}

/**
 * "Did you mean" candidates for a name that resolved to nothing, as qualified
 * names the caller can send straight back.
 *
 * Scored against both the qualified name and the bare leaf, because a typo
 * lands in either half: "Grocries" is a near-miss on the leaf of
 * "Food: Groceries" but nowhere near the qualified string, and "Buisness: Cell
 * Phone" is the reverse. Suggesting a bare leaf would be worse than useless
 * here -- it is exactly the ambiguous form the resolver refuses.
 */
export function suggestQualifiedCategoryNames(
  categories: readonly CategoryNameRef[],
  input: string,
  limit = 3,
): string[] {
  const qualified = qualifiedNamesById(categories);
  const byQualified = suggestClosestNames(
    input,
    [...qualified.values()],
    limit,
  );
  const byLeaf = suggestClosestNames(
    input,
    categories.map((c) => c.name),
    limit,
  );
  const fromLeaves = byLeaf.flatMap((leaf) =>
    categories
      .filter((c) => c.name === leaf)
      .map((c) => qualified.get(c.id) as string),
  );
  return [...new Set([...byQualified, ...fromLeaves])].slice(0, limit);
}

/** Why a name did not become exactly one category. */
export type CategoryNameFailure = "unknown" | "ambiguous";

/** What one input name resolved to. */
export interface CategoryNameMatch {
  /** The name as the caller supplied it, for error messages. */
  input: string;
  /** The single category it identifies, or null when it identifies none or several. */
  id: string | null;
  failure?: CategoryNameFailure;
  /**
   * Qualified names of the categories the input could have meant. Populated for
   * an ambiguous input so the caller can tell the model which to pick, and
   * empty for an unknown one.
   */
  candidates: string[];
}

/**
 * Resolve category names -- bare (`"Groceries"`) or qualified
 * (`"Business: Cell Phone"`, any separator, any spacing) -- to exactly one
 * category each.
 *
 * An input matching several categories fails as `ambiguous` and carries the
 * qualified names it could have meant. Guessing is the behaviour this replaces:
 * a silently chosen "Cell Phone" reads back as data about a category the user
 * never asked about, and no amount of care further down can detect it.
 *
 * Precedence, most specific first:
 * 1. A category whose own name is exactly the input -- so a category literally
 *    named `"Investments: IKE"` still resolves to itself.
 * 2. A parent/child path, separator- and spacing-insensitive.
 * 3. The last segment alone (`"Food > Dining Out"` -> `"Dining Out"`), and only
 *    when that segment names exactly one category. This forgives a wrong or
 *    stale parent; it must never pick between two candidates, which is exactly
 *    what it used to do.
 */
export function resolveCategoryNamePaths<C extends CategoryNameRef>(
  categories: readonly C[],
  names: readonly string[],
  options: {
    /**
     * Chooses between several candidates of one tier (an exact name, a path,
     * the last segment): when exactly one of them is preferred, it is the
     * match. Never reaches into another tier, so a path that names a category
     * exactly wins over a preferred category of the same last segment.
     */
    readonly prefer?: (category: C) => boolean;
  } = {},
): CategoryNameMatch[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const qualified = qualifiedNamesById(categories);

  const byExactName = new Map<string, CategoryNameRef[]>();
  const byPath = new Map<string, CategoryNameRef[]>();
  const push = (
    map: Map<string, CategoryNameRef[]>,
    key: string,
    cat: CategoryNameRef,
  ) => {
    const existing = map.get(key);
    if (existing) existing.push(cat);
    else map.set(key, [cat]);
  };

  for (const cat of categories) {
    push(byExactName, norm(cat.name), cat);
    push(byPath, canonicalCategoryPath(cat.name), cat);
    const parent = cat.parentId ? byId.get(cat.parentId) : undefined;
    if (parent) {
      push(
        byPath,
        canonicalCategoryPath(qualifiedCategoryName(cat.name, parent.name)),
        cat,
      );
    }
  }

  const describe = (cats: readonly CategoryNameRef[]): string[] =>
    cats.map((c) => qualified.get(c.id) ?? c.name);

  // The one candidate of a tier, the one preferred among several, or none.
  const single = (cats: readonly CategoryNameRef[]): CategoryNameRef | null => {
    if (cats.length === 1) return cats[0];
    const { prefer } = options;
    if (cats.length < 2 || !prefer) return null;
    const preferred = cats.filter((c) => prefer(c as C));
    return preferred.length === 1 ? preferred[0] : null;
  };

  return names.map((input) => {
    const exact = byExactName.get(norm(input)) ?? [];
    const exactOne = single(exact);
    if (exactOne) {
      return { input, id: exactOne.id, candidates: [] };
    }

    const path = byPath.get(canonicalCategoryPath(input)) ?? [];
    const pathOne = single(path);
    if (pathOne) {
      return { input, id: pathOne.id, candidates: [] };
    }
    if (path.length > 1) {
      return {
        input,
        id: null,
        failure: "ambiguous",
        candidates: describe(path),
      };
    }
    if (exact.length > 1) {
      return {
        input,
        id: null,
        failure: "ambiguous",
        candidates: describe(exact),
      };
    }

    // Last-segment fallback, only when it is unambiguous.
    const canonical = canonicalCategoryPath(input);
    if (canonical.includes(":")) {
      const lastSegment = canonical.split(":").pop() ?? "";
      const leaf = lastSegment ? (byExactName.get(lastSegment) ?? []) : [];
      const leafOne = single(leaf);
      if (leafOne) {
        return { input, id: leafOne.id, candidates: [] };
      }
      if (leaf.length > 1) {
        return {
          input,
          id: null,
          failure: "ambiguous",
          candidates: describe(leaf),
        };
      }
    }

    return { input, id: null, failure: "unknown", candidates: [] };
  });
}
