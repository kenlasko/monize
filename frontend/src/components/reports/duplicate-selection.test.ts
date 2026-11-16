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
    expect(extraCopyIds(group('g', 'high', [tx('a'), tx('b', 'RECONCILED'), tx('c')]))).toEqual(['a', 'c']);
  });

  it('never ticks a second reconciled copy, which would refuse the whole delete', () => {
    expect(
      extraCopyIds(group('g', 'high', [tx('a', 'RECONCILED'), tx('b', 'RECONCILED'), tx('c')])),
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
    const after = withDuplicatesAt(groups, 'very_high', before);
    expect([...after].sort()).toEqual(['b', 'c']);
    // The caller's set is never mutated.
    expect([...before]).toEqual(['c']);
  });

  it('adds nothing for a level with no groups', () => {
    expect(withDuplicatesAt(groups, 'low', new Set()).size).toBe(0);
  });
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
