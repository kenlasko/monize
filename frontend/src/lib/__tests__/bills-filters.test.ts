import { describe, it, expect } from 'vitest';
import {
  filterScheduledTransactions,
  derivePayeesFromScheduledTransactions,
  deriveAccountsFromScheduledTransactions,
  countActiveBillsFilters,
  EMPTY_BILLS_FILTER_STATE,
  BillsFilterState,
} from '../bills-filters';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { Account } from '@/types/account';

// Minimal scheduled transaction for filtering tests. Only the fields the
// filter helpers read are meaningful; the rest are filled enough to satisfy
// consumers and cast to the full type (as the codebase does elsewhere).
function makeTransaction(
  overrides: Partial<ScheduledTransaction>,
): ScheduledTransaction {
  return {
    id: overrides.id ?? 'id',
    userId: 'user',
    name: 'Bill',
    accountId: 'acct-1',
    categoryId: null,
    payeeId: null,
    amount: -10,
    frequency: 'MONTHLY',
    startDate: '2026-01-01',
    nextDueDate: '2026-06-01',
    isActive: true,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  } as ScheduledTransaction;
}

const filters = (overrides: Partial<BillsFilterState>): BillsFilterState => ({
  ...EMPTY_BILLS_FILTER_STATE,
  ...overrides,
});

describe('filterScheduledTransactions', () => {
  const netflix = makeTransaction({
    id: 'a',
    name: 'Netflix Subscription',
    accountId: 'acct-1',
    payeeId: 'payee-netflix',
    categoryId: 'cat-entertainment',
  });
  const rent = makeTransaction({
    id: 'b',
    name: 'Monthly Rent',
    accountId: 'acct-2',
    payeeId: 'payee-landlord',
    categoryId: 'cat-housing',
  });
  const salary = makeTransaction({
    id: 'c',
    name: 'Paycheck',
    accountId: 'acct-1',
    payeeId: null,
    categoryId: 'cat-income',
    amount: 2000,
  });
  const all = [netflix, rent, salary];

  it('returns everything when no filters are active', () => {
    expect(filterScheduledTransactions(all, EMPTY_BILLS_FILTER_STATE)).toEqual(all);
  });

  it('filters by name (case-insensitive substring on the name field)', () => {
    const result = filterScheduledTransactions(all, filters({ nameSearch: 'net' }));
    expect(result).toEqual([netflix]);
  });

  it('trims whitespace-only name searches', () => {
    const result = filterScheduledTransactions(all, filters({ nameSearch: '   ' }));
    expect(result).toEqual(all);
  });

  it('filters by account', () => {
    const result = filterScheduledTransactions(
      all,
      filters({ selectedAccountIds: ['acct-2'] }),
    );
    expect(result).toEqual([rent]);
  });

  it('filters by payee and excludes transactions without a payee', () => {
    const result = filterScheduledTransactions(
      all,
      filters({ selectedPayeeIds: ['payee-netflix', 'payee-landlord'] }),
    );
    expect(result).toEqual([netflix, rent]);
  });

  it('filters by category', () => {
    const result = filterScheduledTransactions(
      all,
      filters({ selectedCategoryIds: ['cat-housing'] }),
    );
    expect(result).toEqual([rent]);
  });

  it('matches a category found in splits', () => {
    const split = makeTransaction({
      id: 'd',
      name: 'Combined',
      categoryId: null,
      splits: [
        {
          id: 's1',
          scheduledTransactionId: 'd',
          categoryId: 'cat-housing',
          category: null,
          transferAccountId: null,
          transferAccount: null,
          amount: -5,
          memo: null,
          createdAt: '2026-01-01',
        },
      ],
    });
    const result = filterScheduledTransactions(
      [...all, split],
      filters({ selectedCategoryIds: ['cat-housing'] }),
    );
    expect(result).toEqual([rent, split]);
  });

  it('combines multiple filters with AND semantics', () => {
    const result = filterScheduledTransactions(
      all,
      filters({ selectedAccountIds: ['acct-1'], nameSearch: 'pay' }),
    );
    expect(result).toEqual([salary]);
  });

  it('does not mutate the input array', () => {
    const input = [...all];
    filterScheduledTransactions(input, filters({ nameSearch: 'net' }));
    expect(input).toEqual(all);
  });
});

describe('derivePayeesFromScheduledTransactions', () => {
  it('returns distinct payees sorted by name', () => {
    const transactions = [
      makeTransaction({ id: '1', payeeId: 'p-z', payeeName: 'Zebra Co' }),
      makeTransaction({ id: '2', payeeId: 'p-a', payee: { id: 'p-a', name: 'Acme' } as ScheduledTransaction['payee'] }),
      makeTransaction({ id: '3', payeeId: 'p-z', payeeName: 'Zebra Co' }),
      makeTransaction({ id: '4', payeeId: null }),
    ];
    const payees = derivePayeesFromScheduledTransactions(transactions);
    expect(payees.map((p) => p.name)).toEqual(['Acme', 'Zebra Co']);
    expect(payees.map((p) => p.id)).toEqual(['p-a', 'p-z']);
  });

  it('falls back to a placeholder when no name is available', () => {
    const payees = derivePayeesFromScheduledTransactions([
      makeTransaction({ id: '1', payeeId: 'p-x' }),
    ]);
    expect(payees).toEqual([{ id: 'p-x', name: 'Unknown payee' }]);
  });
});

describe('countActiveBillsFilters', () => {
  it('counts each active filter group once', () => {
    expect(countActiveBillsFilters(EMPTY_BILLS_FILTER_STATE)).toBe(0);
    expect(
      countActiveBillsFilters(
        filters({
          nameSearch: 'rent',
          selectedPayeeIds: ['p1'],
          selectedAccountIds: ['a1', 'a2'],
          selectedCategoryIds: ['c1'],
        }),
      ),
    ).toBe(4);
  });
});

describe('filterScheduledTransactions - special categories', () => {
  it('matches uncategorized records (no category, not transfer or split)', () => {
    const uncat = makeTransaction({ id: 'u', categoryId: null });
    const withCat = makeTransaction({ id: 'c', categoryId: 'cat-1' });
    const transfer = makeTransaction({ id: 't', categoryId: null, isTransfer: true });
    const split = makeTransaction({ id: 's', categoryId: null, isSplit: true });
    const result = filterScheduledTransactions(
      [uncat, withCat, transfer, split],
      filters({ selectedCategoryIds: ['uncategorized'] }),
    );
    expect(result.map((t) => t.id)).toEqual(['u']);
  });

  it('matches transfer records', () => {
    const transfer = makeTransaction({ id: 't', isTransfer: true });
    const normal = makeTransaction({ id: 'n' });
    const result = filterScheduledTransactions(
      [transfer, normal],
      filters({ selectedCategoryIds: ['transfer'] }),
    );
    expect(result.map((t) => t.id)).toEqual(['t']);
  });

  it('matches a category type through the record or any split', () => {
    const salary = makeTransaction({
      id: 'inc',
      categoryId: 'cat-salary',
      category: { id: 'cat-salary', categoryType: 'income' as const } as any,
    });
    const rent = makeTransaction({
      id: 'exp',
      categoryId: 'cat-rent',
      category: { id: 'cat-rent', categoryType: 'expense' as const } as any,
    });
    const split = makeTransaction({
      id: 'split',
      categoryId: null,
      isSplit: true,
      splits: [{ categoryId: 'cat-bonus', category: { id: 'cat-bonus', categoryType: 'income' as const } }] as any,
    });
    const uncat = makeTransaction({ id: 'u', categoryId: null });
    const income = filterScheduledTransactions(
      [salary, rent, split, uncat],
      filters({ selectedCategoryIds: ['income'] }),
    );
    expect(income.map((t) => t.id).sort()).toEqual(['inc', 'split']);
    const expense = filterScheduledTransactions(
      [salary, rent, split, uncat],
      filters({ selectedCategoryIds: ['expense'] }),
    );
    expect(expense.map((t) => t.id)).toEqual(['exp']);
  });

  it('ORs special pseudo-categories with real category IDs', () => {
    const transfer = makeTransaction({ id: 't', isTransfer: true });
    const rent = makeTransaction({ id: 'r', categoryId: 'cat-housing' });
    const other = makeTransaction({ id: 'o', categoryId: 'cat-food' });
    const result = filterScheduledTransactions(
      [transfer, rent, other],
      filters({ selectedCategoryIds: ['transfer', 'cat-housing'] }),
    );
    expect(result.map((t) => t.id).sort()).toEqual(['r', 't']);
  });
});

describe('deriveAccountsFromScheduledTransactions', () => {
  const accounts = [
    { id: 'acc-1', name: 'Zeta' } as Account,
    { id: 'acc-2', name: 'Alpha' } as Account,
    { id: 'acc-3', name: 'Unused' } as Account,
  ];

  it('returns only accounts referenced by the schedules, sorted by name', () => {
    const txns = [
      makeTransaction({ id: '1', accountId: 'acc-1' }),
      makeTransaction({ id: '2', accountId: 'acc-2' }),
      makeTransaction({ id: '3', accountId: 'acc-1' }),
    ];
    const result = deriveAccountsFromScheduledTransactions(txns, accounts);
    expect(result.map((a) => a.id)).toEqual(['acc-2', 'acc-1']);
  });

  it('returns an empty array when there are no schedules', () => {
    expect(deriveAccountsFromScheduledTransactions([], accounts)).toEqual([]);
  });
});
