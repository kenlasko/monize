import { describe, it, expect } from 'vitest';
import { TransactionStatus } from '@/types/transaction';
import { walkRunningBalances, rowAffectsBalance } from './running-balance';
import type { RunningBalanceRow } from './running-balance';

/**
 * The numbers here are the design's worked examples, and the same ones the
 * backend's integration suite walks against a real ledger. The property they
 * exist for is one sentence: a row shows the same balance whichever way the
 * register runs.
 */

const row = (
  id: string,
  amount: number,
  overrides: Partial<RunningBalanceRow> = {},
): RunningBalanceRow => ({ id, amount, ...overrides });

describe('walkRunningBalances', () => {
  // Opening 1000; four debits of 10, the newest VOID. Projected 970.
  const A = row('A', -10);
  const B = row('B', -10);
  const C = row('C', -10);
  const D = row('D', -10, { status: TransactionStatus.VOID });

  it('walks a newest-first page down from its seed', () => {
    const page = walkRunningBalances([D, C], 970, 'desc');
    // The VOID row takes the balance of the row above it and moves nothing.
    expect(page.get('D')).toBe(970);
    expect(page.get('C')).toBe(970);
  });

  it('reverses an oldest-first page before walking it', () => {
    // Same two rows, same seed, arriving oldest-first.
    const page = walkRunningBalances([C, D], 970, 'asc');
    expect(page.get('D')).toBe(970);
    expect(page.get('C')).toBe(970);
  });

  it('gives a row the same balance on either sort, page for page', () => {
    // Page size 2 over the four rows. Newest-first: [D,C] seeded 970, [B,A]
    // seeded 980. Oldest-first: [A,B] seeded 980, [C,D] seeded 970 -- the
    // same seeds, because the seed is always the balance after the page's
    // NEWEST row.
    const descending = new Map([
      ...walkRunningBalances([D, C], 970, 'desc'),
      ...walkRunningBalances([B, A], 980, 'desc'),
    ]);
    const ascending = new Map([
      ...walkRunningBalances([A, B], 980, 'asc'),
      ...walkRunningBalances([C, D], 970, 'asc'),
    ]);

    expect(Object.fromEntries(ascending)).toEqual(
      Object.fromEntries(descending),
    );
    expect(descending.get('A')).toBe(990);
    expect(descending.get('B')).toBe(980);
    // The oldest row's balance is the opening balance plus that row.
    expect(descending.get('A')! - Number(A.amount)).toBe(1000);
  });

  it('never dips below zero on the day a transfer funded the purchase', () => {
    // Both rows share a created_at, so the register orders the credit first
    // chronologically -- which in a newest-first list puts it second.
    const credit = row('in', 2400);
    const debit = row('out', -2400);
    const descending = walkRunningBalances([debit, credit], 0, 'desc');
    const ascending = walkRunningBalances([credit, debit], 0, 'asc');

    expect(descending.get('out')).toBe(0);
    expect(descending.get('in')).toBe(2400);
    expect(Object.fromEntries(ascending)).toEqual(
      Object.fromEntries(descending),
    );
    expect(Math.min(...descending.values())).toBe(0);
  });

  it('counts a filtered split by what the page actually shows', () => {
    // A category filter returned one -40 line of a -100 split, so the Amount
    // column shows -40 and the balance has to move by -40 too.
    const split = row('split', -100);
    const other = row('other', -10);
    const displayAmounts = new Map([['split', -40]]);
    const balances = walkRunningBalances(
      [other, split],
      100,
      'desc',
      displayAmounts,
    );

    expect(balances.get('other')).toBe(100);
    expect(balances.get('split')).toBe(110);
  });

  it('gives a split child a balance without moving one', () => {
    const child = row('child', -60, { parentTransactionId: 'parent' });
    const balances = walkRunningBalances([child, row('x', -10)], 500, 'desc');
    expect(balances.get('child')).toBe(500);
    expect(balances.get('x')).toBe(500);
  });

  it('accumulates in integers, so a long page does not drift a cent', () => {
    // Fifty debits of 0.10 ending at zero: walking back up the page the
    // balance rises by exactly 0.10 a row. Summing floats gives 4.899999...
    // here, and a register is precisely where a reader would notice.
    const rows = Array.from({ length: 50 }, (_, index) =>
      row(`r${index}`, -0.1),
    );
    const balances = walkRunningBalances(rows, 0, 'desc');
    expect(balances.get('r49')).toBe(4.9);
    expect(balances.get('r1')).toBe(0.1);
  });

  it('walks a coin register at eight places, so a satoshi fee is not lost', () => {
    // A wallet at 0.00747493 after a -0.00502500 sale whose fee was 2,500 sats.
    const sale = row('sale', -0.005025);
    const coffee = row('coffee', -0.0004321);
    const buy = row('buy', 0.01249993);
    const balances = walkRunningBalances([sale, coffee, buy], 0.00704283, 'desc', undefined, 8);
    expect(balances.get('sale')).toBe(0.00704283);
    expect(balances.get('coffee')).toBe(0.01206783);
    expect(balances.get('buy')).toBe(0.01249993);
    // At the fiat four the same walk rounds each satoshi amount away.
    const fiat = walkRunningBalances([sale, coffee, buy], 0.00704283, 'desc');
    expect(fiat.get('coffee')).not.toBe(0.01206783);
  });

  it('stays exact at eight places above 2^53 units', () => {
    const balances = walkRunningBalances(
      [row('a', 0.00000001), row('b', 0.00000001)],
      20999999.99999999,
      'desc',
      undefined,
      8,
    );
    expect(balances.get('a')).toBe(20999999.99999999);
    expect(balances.get('b')).toBe(20999999.99999998);
  });

  it('returns nothing without a seed, rather than a balance of nothing', () => {
    // No balance is not a balance of zero: the cells render as unknown.
    expect(walkRunningBalances([A, B], undefined, 'desc').size).toBe(0);
    expect(walkRunningBalances([A, B], NaN, 'desc').size).toBe(0);
    expect(walkRunningBalances([], 100, 'desc').size).toBe(0);
  });

  it('leaves the caller’s array alone', () => {
    const page = [A, B, C];
    walkRunningBalances(page, 100, 'asc');
    expect(page).toEqual([A, B, C]);
  });
});

describe('rowAffectsBalance', () => {
  it('excludes a VOID row and a split child, and nothing else', () => {
    expect(rowAffectsBalance(row('a', -1))).toBe(true);
    expect(
      rowAffectsBalance(row('a', -1, { status: TransactionStatus.RECONCILED })),
    ).toBe(true);
    expect(
      rowAffectsBalance(row('a', -1, { status: TransactionStatus.VOID })),
    ).toBe(false);
    expect(rowAffectsBalance(row('a', -1, { parentTransactionId: 'p' }))).toBe(
      false,
    );
  });
});
