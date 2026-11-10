export interface Category {
  id: string;
  userId: string;
  parentId: string | null;
  parent: Category | null;
  children: Category[];
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  /**
   * The colour and icon actually shown: this category's own, or the nearest
   * ancestor's when it sets none. Resolved server-side in one walk up the
   * ancestry so every surface inherits identically.
   */
  effectiveColor: string | null;
  effectiveIcon: string | null;
  /**
   * This category's own explicit automatic-sign choice, or `null` to inherit
   * from the nearest ancestor that has one (a root with none behaves as on).
   * Never forced to match a parent the way `isIncome` is.
   */
  autoSign: boolean | null;
  /** Resolved server-side by walking the ancestor chain; always a concrete boolean. */
  effectiveAutoSign: boolean;
  isIncome: boolean;
  isSystem: boolean;
  createdAt: string;
  transactionCount?: number;
}

/**
 * One account the category's transactions live in, in the account's own
 * currency. Mirrors the backend's CategoryAccountBreakdownRow.
 */
export interface CategoryAccountBreakdownRow {
  accountId: string;
  accountName: string;
  accountType: string;
  currencyCode: string;
  transactionCount: number;
  total: number;
  lastTransactionDate: string | null;
  /** The reporting currency `convertedTotal` is in. */
  convertedCurrency?: string;
  /** `total` converted by the server at each row's own rate or date; null without one. */
  convertedTotal?: number | null;
}

/**
 * The category's single largest contribution by absolute amount. For a split
 * transaction this is the matching split line's amount, not the parent's.
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
 * Lifetime facts computed over real (non-void, non-split-child) transactions
 * across the whole subtree -- this category plus all its descendants.
 */
export interface CategoryDetailStats {
  transactionCount: number;
  firstTransactionDate: string | null;
  lastTransactionDate: string | null;
  payeeCount: number;
  subcategoryCount: number;
}

/** The detail-page aggregate from GET /categories/:id/detail. */
export interface CategoryDetail {
  category: Category;
  stats: CategoryDetailStats;
  accounts: CategoryAccountBreakdownRow[];
  largestTransaction: CategoryLargestTransaction | null;
  defaultCategoryForPayees: { payeeId: string; payeeName: string }[];
}

export interface CreateCategoryData {
  name: string;
  parentId?: string;
  description?: string;
  icon?: string;
  color?: string;
  isIncome?: boolean;
  autoSign?: boolean | null;
}

export interface UpdateCategoryData extends Partial<CreateCategoryData> {}
