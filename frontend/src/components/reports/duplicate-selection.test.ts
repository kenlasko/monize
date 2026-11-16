import { describe, it, expect } from 'vitest';
import type { DuplicateGroup, DuplicateTransactionItem } from '@/types/built-in-reports';
import {
  extraCopyIds,
  groupsFullySelected,
  keeperId,
  selectionInGroups,
  withDuplicatesAt,
} from './duplicate-selection';

function tx(id: string, status: string | null = 'UNRECONCILED'): DuplicateTransactionItem {
  return {
    id,
    transactionDate: '2025-02-01',
    amount: -10,
    currencyCode: 'CAD',
    accountId: 'acct-chequing',
    payeeName: 'Shop',
    description: null,
    accountName: 'Chequing',
    categoryId: null,
    categoryName: null,
    isSplit: false,
    status,
  };
}

function group(key: string, confidence: DuplicateGroup['confidence'], transactions: DuplicateTransactionItem[]): DuplicateGroup {
  return { key, confidence, transactions, reason: '', reasonCode: 'same_date_amount', windowDays: 1 };
}

describe('keeperId', () => {
  it('keeps the earliest copy when none is cleared or reconciled', () => {
    expect(keeperId(group('g', 'high', [tx('a'), tx('b'), tx('c', null)]))).toBe('a');
  });

  it('prefers a reconciled copy over a cleared one, and a cleared one over the earliest', () => {
    expect(keeperId(group('g', 'high', [tx('a'), tx('b', 'CLEARED'), tx('c', 'RECONCILED')]))).toBe('c');
    expect(keeperId(group('g', 'high', [tx('a'), tx('b', 'CLEARED'), tx('c', 'CLEARED')]))).toBe('b');
  });
});

describe('extraCopyIds', () => {
  it('is every member but the keeper, in group order', () => {
    expect(extraCopyIds(group('g', 'high', [tx('a'), tx('b', 'RECONCILED'), tx('c')]), false)).toEqual(['a', 'c']);
  });

  it('ticks the second copy of a fully reconciled pair, so every group keeps exactly one', () => {
    expect(extraCopyIds(group('g', 'very_high', [tx('a', 'RECONCILED'), tx('b', 'RECONCILED')]), false)).toEqual(['b']);
    expect(
      extraCopyIds(group('g', 'medium', [tx('a', 'RECONCILED'), tx('b', 'RECONCILED'), tx('c', 'RECONCILED')]), false),
    ).toEqual(['b', 'c']);
  });

  it('never ticks a reconciled copy under the lock, which would refuse the whole delete', () => {
    expect(
      extraCopyIds(group('g', 'high', [tx('a', 'RECONCILED'), tx('b', 'RECONCILED'), tx('c')]), true),
    ).toEqual(['c']);
  });
});

describe('withDuplicatesAt', () => {
  const groups = [
    group('vh', 'very_high', [tx('a'), tx('b')]),
    group('h', 'high', [tx('c'), tx('d')]),
  ];

  it("adds only that level's extra copies, keeping what was already ticked", () => {
    const before = new Set(['c']);
    const after = withDuplicatesAt(groups, 'very_high', before, false);
    expect([...after].sort()).toEqual(['b', 'c']);
    // The caller's set is never mutated.
    expect([...before]).toEqual(['c']);
  });

  it('adds nothing for a level with no groups', () => {
    expect(withDuplicatesAt(groups, 'low', new Set(), false).size).toBe(0);
  });

  it.each(['very_high', 'high', 'medium', 'low'] as const)(
    'leaves one copy of every %s group unticked and ticks the rest, whatever their status',
    (level) => {
      const atLevel = [
        group('open', level, [tx('o1'), tx('o2')]),
        group('reconciled', level, [tx('r1', 'RECONCILED'), tx('r2', 'RECONCILED')]),
        group('mixed', level, [tx('m1', 'CLEARED'), tx('m2', 'RECONCILED'), tx('m3', null)]),
      ];
      const after = withDuplicatesAt(atLevel, level, new Set(), false);
      for (const g of atLevel) {
        const ticked = g.transactions.filter((t) => after.has(t.id));
        expect(ticked).toHaveLength(g.transactions.length - 1);
      }
    },
  );
});

describe('selectionInGroups', () => {
  it('drops ids the current answer no longer lists', () => {
    const groups = [group('g', 'high', [tx('a'), tx('b')])];
    expect(selectionInGroups(groups, new Set(['b', 'gone']))).toEqual(['b']);
  });

  it('lists an id once even if two groups carry it', () => {
    const shared = tx('a');
    const groups = [group('g1', 'high', [shared, tx('b')]), group('g2', 'low', [shared, tx('c')])];
    expect(selectionInGroups(groups, new Set(['a']))).toEqual(['a']);
  });
});

describe('groupsFullySelected', () => {
  it('counts the groups whose every copy is ticked', () => {
    const groups = [group('g1', 'high', [tx('a'), tx('b')]), group('g2', 'high', [tx('c'), tx('d')])];
    expect(groupsFullySelected(groups, new Set(['a', 'b', 'c']))).toBe(1);
    expect(groupsFullySelected(groups, new Set())).toBe(0);
  });
});
