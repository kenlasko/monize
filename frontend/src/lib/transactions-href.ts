import type { SpecialCategoryFilterId } from '@/lib/categoryUtils';

/**
 * What a drill-down from a report into Transactions filters by. `categoryId`
 * is a category's id or one of the `SPECIAL_CATEGORY_FILTER_IDS` pseudo-ids
 * (`uncategorized`, `transfer`, ...); `categoryType` asks for every category of
 * one type, which `useTransactionFilters` reads ahead of `categoryId`.
 * `targetTransactionId` lands on the page holding that row and flashes it.
 */
export interface TransactionsHrefOptions {
  categoryId?: string | SpecialCategoryFilterId | null;
  categoryIds?: readonly string[];
  accountIds?: readonly string[];
  payeeIds?: readonly string[];
  tagIds?: readonly string[];
  search?: string;
  startDate?: string;
  endDate?: string;
  categoryType?: 'income' | 'expense';
  targetTransactionId?: string;
  /** Overrides the stored Show Accounts toggle so a named closed account is not pruned. */
  accountStatus?: 'all';
}

/**
 * The Transactions URL a report links to, in the parameters
 * `useTransactionFilters` reads: `categoryId`, `categoryType`, `categoryIds`,
 * `accountIds`, `payeeIds`, `tagIds` (lists comma-separated), `search`,
 * `startDate`, `endDate`, `targetTransactionId`, `accountStatus`. An absent or
 * empty value is left out, since any parameter at all replaces the reader's
 * stored filters.
 */
export function buildTransactionsHref(options: TransactionsHrefOptions): string {
  const params = new URLSearchParams();
  const setList = (key: string, values: readonly string[] | undefined) => {
    if (values && values.length > 0) params.set(key, values.join(','));
  };
  if (options.categoryType) params.set('categoryType', options.categoryType);
  if (options.categoryId) params.set('categoryId', options.categoryId);
  setList('categoryIds', options.categoryIds);
  setList('accountIds', options.accountIds);
  if (options.accountStatus) params.set('accountStatus', options.accountStatus);
  setList('payeeIds', options.payeeIds);
  setList('tagIds', options.tagIds);
  if (options.search) params.set('search', options.search);
  if (options.startDate) params.set('startDate', options.startDate);
  if (options.endDate) params.set('endDate', options.endDate);
  if (options.targetTransactionId) params.set('targetTransactionId', options.targetTransactionId);
  const query = params.toString();
  return query ? `/transactions?${query}` : '/transactions';
}
