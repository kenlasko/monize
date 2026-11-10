import { Category } from "../entities/category.entity";

/**
 * One account the category's transactions live in. `total` is the signed sum
 * of the category's contributions in that account, in the account's own
 * currency -- accounts are single-currency, so no conversion happens here and
 * none should: display currency is a client concern.
 */
export interface CategoryAccountBreakdownRow {
  accountId: string;
  accountName: string;
  accountType: string;
  currencyCode: string;
  transactionCount: number;
  total: number;
  lastTransactionDate: string | null;
  /** The reader's reporting currency, which `convertedTotal` is in. */
  convertedCurrency: string;
  /**
   * `total` with each part at its own settled rate or the market rate on its
   * own date (issue #2106); null while a part has no admissible rate.
   */
  convertedTotal: number | null;
}

/**
 * The category's single largest contribution by absolute amount, linked from
 * the page. For a split transaction this is the matching split line's amount,
 * not the parent's -- the parent may carry other categories' money too.
 */
export interface CategoryLargestTransaction {
  id: string;
  transactionDate: string;
  amount: number;
  currencyCode: string;
  accountId: string;
  accountName: string;
  description: string | null;
  payeeName: string | null;
}

/**
 * Lifetime facts about the category's history. Every figure covers the whole
 * subtree (this category plus all descendants) and uses the analytics scope
 * (non-void, split children excluded, split lines matched individually) so the
 * counts agree with the register and the analytics endpoints the detail page
 * composes -- filtering the register by this category expands descendants too.
 */
export interface CategoryDetailStats {
  transactionCount: number;
  firstTransactionDate: string | null;
  lastTransactionDate: string | null;
  /** Distinct payees seen across the subtree's transactions. */
  payeeCount: number;
  /** Direct children only, not the whole subtree. */
  subcategoryCount: number;
}

/**
 * Everything the category detail page needs beyond what the generic,
 * category-filterable analytics endpoints already provide. Identity and facts
 * only: totals over time, payee breakdowns and subcategory shares stay on the
 * transactions analytics endpoints, which the page queries directly with
 * `categoryIds=[id]`.
 */
export interface CategoryDetailDto {
  category: Category & {
    effectiveColor: string | null;
    effectiveIcon: string | null;
    effectiveAutoSign: boolean;
  };
  stats: CategoryDetailStats;
  accounts: CategoryAccountBreakdownRow[];
  largestTransaction: CategoryLargestTransaction | null;
  /** Payees whose default category is exactly this category (not the subtree). */
  defaultCategoryForPayees: { payeeId: string; payeeName: string }[];
}
