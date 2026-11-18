import {
  MappedCategories,
  MappedCategory,
} from "../../mny/model/mny-import-model";
import { KmyAccount, KmyRawFile } from "../model/kmy-raw";
import { AccountTree, KMY_TYPE, isCategoryType } from "./kmy-account-tree";

/**
 * Spec 5.4: income and expense accounts become categories at full depth;
 * an equity account used outside a folded opening balance becomes a top-level
 * income-type category. `fullName` is the chain of account ordinals joined by
 * `/` (an import-local identity the writer never displays), so a name that
 * contains `:` cannot collide with a path.
 */

function categoryName(account: KmyAccount): string {
  return account.name.trim() || `Category ${account.ordinal}`;
}

/** Category ancestors of an account, root first. */
function categoryChain(tree: AccountTree, account: KmyAccount): KmyAccount[] {
  return [
    ...tree
      .ancestors(account.id)
      .filter((ancestor) => isCategoryType(ancestor.type))
      .reverse(),
    account,
  ];
}

export interface MapKmyCategoriesInput {
  readonly raw: KmyRawFile;
  readonly tree: AccountTree;
  /**
   * Handles (account ordinals) a written row, leg, trade or selected bill
   * references; null imports every income and expense account.
   */
  readonly referenced: ReadonlySet<number> | null;
  /** Equity accounts (by ordinal) some written row uses as a category. */
  readonly equityUsed: ReadonlySet<number>;
}

export function mapKmyCategories(
  input: MapKmyCategoriesInput,
): MappedCategories {
  const { raw, tree, referenced, equityUsed } = input;
  const accounts = raw.accounts.filter(
    (account) => !account.isStandard && isCategoryType(account.type),
  );
  const wanted = new Set<number>();
  for (const account of accounts) {
    if (referenced === null || referenced.has(account.ordinal)) {
      for (const link of categoryChain(tree, account)) {
        wanted.add(link.ordinal);
      }
    }
  }

  const chosen: { account: KmyAccount; chain: KmyAccount[] }[] = accounts
    .filter((account) => wanted.has(account.ordinal))
    .map((account) => ({ account, chain: categoryChain(tree, account) }));
  chosen.sort(
    (a, b) =>
      a.chain.length - b.chain.length || a.account.ordinal - b.account.ordinal,
  );

  const categories: MappedCategory[] = chosen.map(({ account, chain }) => {
    const path = chain.map((link) => link.ordinal).join("/");
    return {
      handle: account.ordinal,
      parentName:
        chain.length > 1
          ? chain
              .slice(0, -1)
              .map((link) => link.ordinal)
              .join("/")
          : null,
      name: categoryName(account),
      fullName: path,
      isIncome: account.type === KMY_TYPE.INCOME,
    };
  });

  for (const account of raw.accounts) {
    if (
      !account.isStandard &&
      account.type === KMY_TYPE.EQUITY &&
      equityUsed.has(account.ordinal)
    ) {
      categories.push({
        handle: account.ordinal,
        parentName: null,
        name: categoryName(account),
        fullName: String(account.ordinal),
        isIncome: true,
      });
    }
  }

  return {
    categories,
    byHandle: new Map(
      categories.map((category) => [category.handle, category]),
    ),
    skipped: accounts.length - chosen.length,
    warnings: [],
  };
}
