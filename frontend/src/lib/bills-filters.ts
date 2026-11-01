import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { Payee } from '@/types/payee';
import { Account } from '@/types/account';

/** Which kind of schedule the list shows: every one, bills only, or deposits only. */
export type BillsTypeFilter = 'all' | 'bills' | 'deposits';

export interface BillsFilterState {
  nameSearch: string;
  selectedPayeeIds: string[];
  selectedAccountIds: string[];
  selectedCategoryIds: string[];
}

export const EMPTY_BILLS_FILTER_STATE: BillsFilterState = {
  nameSearch: '',
  selectedPayeeIds: [],
  selectedAccountIds: [],
  selectedCategoryIds: [],
};

/** Minimal payee shape needed to populate the filter dropdown. */
export type BillsPayeeOption = Pick<Payee, 'id' | 'name'>;

/**
 * Build the distinct list of payees referenced by a set of scheduled
 * transactions, sorted alphabetically. Used to populate the payee filter
 * dropdown without an extra API call.
 */
export function derivePayeesFromScheduledTransactions(
  transactions: ScheduledTransaction[],
): BillsPayeeOption[] {
  const byId = new Map<string, BillsPayeeOption>();
  transactions.forEach((t) => {
    if (!t.payeeId || byId.has(t.payeeId)) return;
    const name = t.payeeName || t.payee?.name || 'Unknown payee';
    byId.set(t.payeeId, { id: t.payeeId, name });
  });
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether a scheduled transaction matches the selected category filters.
 * Mirrors the Transactions category filter semantics (TransactionSearchUtil):
 * real category IDs match the top-level category or any split; the special
 * "uncategorized" pseudo-ID matches records with no category that are neither
 * transfers nor splits; "transfer" matches transfer records; "income" and
 * "expense" match a record whose category, or any split's category, is of
 * that type. The selected conditions are OR-ed together.
 */
function scheduledTransactionMatchesCategories(
  t: ScheduledTransaction,
  selectedCategoryIds: string[],
): boolean {
  const realIds: string[] = [];
  let wantUncategorized = false;
  let wantTransfer = false;
  const wantTypes: boolean[] = [];
  for (const id of selectedCategoryIds) {
    if (id === 'uncategorized') wantUncategorized = true;
    else if (id === 'transfer') wantTransfer = true;
    else if (id === 'income') wantTypes.push(true);
    else if (id === 'expense') wantTypes.push(false);
    else realIds.push(id);
  }

  if (realIds.length > 0) {
    const topMatch = !!t.categoryId && realIds.includes(t.categoryId);
    const splitMatch = (t.splits || []).some(
      (sp) => !!sp.categoryId && realIds.includes(sp.categoryId),
    );
    if (topMatch || splitMatch) return true;
  }
  if (wantTypes.length > 0) {
    const isIncome = (c: { isIncome: boolean } | null | undefined) =>
      c ? wantTypes.includes(c.isIncome) : false;
    if (isIncome(t.category) || (t.splits || []).some((sp) => isIncome(sp.category))) {
      return true;
    }
  }
  if (wantUncategorized && t.categoryId == null && !t.isTransfer && !t.isSplit) {
    return true;
  }
  if (wantTransfer && t.isTransfer) {
    return true;
  }
  return false;
}

/**
 * Apply the Bills & Deposits filters (name, payee, account, category) to a
 * list of scheduled transactions. Filtering is client-side and immutable.
 */
export function filterScheduledTransactions(
  transactions: ScheduledTransaction[],
  filters: BillsFilterState,
): ScheduledTransaction[] {
  const name = filters.nameSearch.trim().toLowerCase();

  return transactions.filter((t) => {
    if (name && !(t.name || '').toLowerCase().includes(name)) {
      return false;
    }

    if (
      filters.selectedAccountIds.length > 0 &&
      !filters.selectedAccountIds.includes(t.accountId)
    ) {
      return false;
    }

    if (filters.selectedPayeeIds.length > 0) {
      if (!t.payeeId || !filters.selectedPayeeIds.includes(t.payeeId)) {
        return false;
      }
    }

    if (
      filters.selectedCategoryIds.length > 0 &&
      !scheduledTransactionMatchesCategories(t, filters.selectedCategoryIds)
    ) {
      return false;
    }

    return true;
  });
}

/**
 * The subset of accounts that are actually referenced by the given scheduled
 * transactions, sorted alphabetically. Keeps the Accounts filter dropdown
 * scoped to accounts used in Bills & Deposits.
 */
export function deriveAccountsFromScheduledTransactions(
  transactions: ScheduledTransaction[],
  accounts: Account[],
): Account[] {
  const usedIds = new Set(transactions.map((t) => t.accountId));
  return accounts
    .filter((a) => usedIds.has(a.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function countActiveBillsFilters(filters: BillsFilterState): number {
  let count = 0;
  if (filters.nameSearch.trim()) count++;
  if (filters.selectedPayeeIds.length > 0) count++;
  if (filters.selectedAccountIds.length > 0) count++;
  if (filters.selectedCategoryIds.length > 0) count++;
  return count;
}
