import { AccountType } from "../../../accounts/entities/account.entity";
import { KmyAccount } from "../model/kmy-raw";

/**
 * KMyMoney's account tree as the mapper needs it: the group of a type, the
 * hierarchy repair of reference 5.3 (`parentaccount` is the truth; a missing
 * parent means the standard root of the type's group) and walks up the result.
 */

export type AccountGroup =
  "asset" | "liability" | "income" | "expense" | "equity";

export const KMY_TYPE = {
  UNKNOWN: 0,
  CHECKING: 1,
  SAVINGS: 2,
  CASH: 3,
  CREDIT_CARD: 4,
  LOAN: 5,
  CERTIFICATE: 6,
  INVESTMENT: 7,
  MONEY_MARKET: 8,
  ASSET: 9,
  LIABILITY: 10,
  CURRENCY: 11,
  INCOME: 12,
  EXPENSE: 13,
  ASSET_LOAN: 14,
  STOCK: 15,
  EQUITY: 16,
} as const;

/** Monize account type of a KMyMoney asset/liability type (spec 5.2.1). */
export const MONIZE_TYPE: ReadonlyMap<number, AccountType> = new Map([
  [KMY_TYPE.CHECKING, AccountType.CHEQUING],
  [KMY_TYPE.SAVINGS, AccountType.SAVINGS],
  [KMY_TYPE.CASH, AccountType.CASH],
  [KMY_TYPE.CREDIT_CARD, AccountType.CREDIT_CARD],
  [KMY_TYPE.LOAN, AccountType.LOAN],
  [KMY_TYPE.CERTIFICATE, AccountType.SAVINGS],
  [KMY_TYPE.INVESTMENT, AccountType.INVESTMENT],
  [KMY_TYPE.MONEY_MARKET, AccountType.SAVINGS],
  [KMY_TYPE.ASSET, AccountType.ASSET],
  [KMY_TYPE.LIABILITY, AccountType.LOAN],
  [KMY_TYPE.CURRENCY, AccountType.ASSET],
  [KMY_TYPE.ASSET_LOAN, AccountType.ASSET],
]);

const STANDARD_ROOT: Record<AccountGroup, string> = {
  asset: "AStd::Asset",
  liability: "AStd::Liability",
  income: "AStd::Income",
  expense: "AStd::Expense",
  equity: "AStd::Equity",
};

/** The group of an account type (reference 5.2); `null` for type 0 and anything unrecognised. */
export function groupOfType(type: number): AccountGroup | null {
  switch (type) {
    case 1:
    case 2:
    case 3:
    case 6:
    case 7:
    case 8:
    case 9:
    case 11:
    case 14:
    case 15:
      return "asset";
    case 4:
    case 5:
    case 10:
      return "liability";
    case 12:
      return "income";
    case 13:
      return "expense";
    case 16:
      return "equity";
    default:
      return null;
  }
}

/** Types 1-11 and 14: an account money sits in (stock accounts excluded). */
export function isAssetOrLiability(type: number): boolean {
  const group = groupOfType(type);
  return (group === "asset" || group === "liability") && type !== 15;
}

export function isCategoryType(type: number): boolean {
  return type === KMY_TYPE.INCOME || type === KMY_TYPE.EXPENSE;
}

export interface AccountTree {
  readonly byId: ReadonlyMap<string, KmyAccount>;
  /** The repaired parent id, or null for a standard root or an account with no group. */
  parentOf(id: string): string | null;
  /** True for a standard root and for any account whose parent chain ends in one. */
  reachable(id: string): boolean;
  /** Ancestors, nearest first, standard roots excluded. */
  ancestors(id: string): KmyAccount[];
  /** The nearest ancestor (the account itself excluded) satisfying the predicate. */
  nearestAncestor(
    id: string,
    predicate: (account: KmyAccount) => boolean,
  ): KmyAccount | null;
}

export function isStandardId(id: string): boolean {
  return id.startsWith("AStd::");
}

export function buildAccountTree(accounts: readonly KmyAccount[]): AccountTree {
  const byId = new Map(accounts.map((account) => [account.id, account]));

  const parents = new Map<string, string | null>();
  for (const account of accounts) {
    if (account.isStandard) {
      parents.set(account.id, null);
      continue;
    }
    const declared = account.parentId;
    if (declared && (byId.has(declared) || isStandardId(declared))) {
      parents.set(account.id, declared);
      continue;
    }
    const group = groupOfType(account.type);
    parents.set(account.id, group === null ? null : STANDARD_ROOT[group]);
  }

  const reachableCache = new Map<string, boolean>();
  const reachable = (id: string): boolean => {
    const cached = reachableCache.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const seen = new Set<string>();
    let current: string | null = id;
    let result = false;
    while (current !== null) {
      if (isStandardId(current)) {
        result = true;
        break;
      }
      if (seen.has(current) || !byId.has(current)) {
        break;
      }
      seen.add(current);
      current = parents.get(current) ?? null;
    }
    reachableCache.set(id, result);
    return result;
  };

  const ancestors = (id: string): KmyAccount[] => {
    const chain: KmyAccount[] = [];
    const seen = new Set<string>([id]);
    let current = parents.get(id) ?? null;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const account = byId.get(current);
      if (!account || account.isStandard) {
        break;
      }
      chain.push(account);
      current = parents.get(current) ?? null;
    }
    return chain;
  };

  return {
    byId,
    parentOf: (id) => parents.get(id) ?? null,
    reachable,
    ancestors,
    nearestAncestor: (id, predicate) => ancestors(id).find(predicate) ?? null,
  };
}
