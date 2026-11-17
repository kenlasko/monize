import { describe, it, expect } from 'vitest';
import { Account } from '@/types/account';
import { chartColors } from '@/lib/chart-colors';
import {
  isCreditAccount,
  utilizationColour,
  computeCreditRows,
  computeCreditTotals,
} from './credit-utilization';

const account = (overrides: Partial<Account>): Account =>
  ({
    id: 'a1',
    name: 'Card',
    accountType: 'CREDIT_CARD',
    accountSubType: 'NONE',
    currencyCode: 'USD',
    currentBalance: -500,
    creditLimit: 2000,
    isClosed: false,
    ...overrides,
  }) as unknown as Account;

// Identity converter for tests (no FX).
const noConvert = (v: number) => v;

describe('isCreditAccount', () => {
  it('accepts credit cards and lines of credit with a positive limit', () => {
    expect(isCreditAccount(account({}))).toBe(true);
    expect(isCreditAccount(account({ accountType: 'LINE_OF_CREDIT' }))).toBe(true);
  });

  it('rejects non-credit account types', () => {
    expect(isCreditAccount(account({ accountType: 'CHEQUING' }))).toBe(false);
  });

  it('rejects accounts without a positive limit', () => {
    expect(isCreditAccount(account({ creditLimit: 0 }))).toBe(false);
    expect(isCreditAccount(account({ creditLimit: null }))).toBe(false);
  });

  it('rejects a closed account at zero', () => {
    expect(isCreditAccount(account({ isClosed: true, currentBalance: 0 }))).toBe(false);
  });

  it('keeps a closed card that still owes a balance', () => {
    expect(isCreditAccount(account({ isClosed: true, currentBalance: -500 }))).toBe(true);
  });

  it('keeps a closed card owing a balance whatever limit it recorded', () => {
    expect(
      isCreditAccount(account({ isClosed: true, currentBalance: -500, creditLimit: null })),
    ).toBe(true);
  });

  it('rejects a closed card holding a credit, which is owed to the user, not drawn', () => {
    expect(isCreditAccount(account({ isClosed: true, currentBalance: 50 }))).toBe(false);
  });
});

describe('utilizationColour', () => {
  it('maps thresholds to income/warning/expense colours', () => {
    expect(utilizationColour(10)).toBe(chartColors.income);
    expect(utilizationColour(50)).toBe(chartColors.warning);
    expect(utilizationColour(90)).toBe(chartColors.expense);
    expect(utilizationColour(30)).toBe(chartColors.warning);
    expect(utilizationColour(75)).toBe(chartColors.expense);
  });
});

describe('computeCreditRows', () => {
  it('derives used/available/utilization from balance magnitude', () => {
    const rows = computeCreditRows([account({})], noConvert, 'USD');
    expect(rows[0]).toMatchObject({
      limit: 2000,
      used: 500,
      available: 1500,
      utilizationPercent: 25,
    });
  });

  it('treats a zero limit as zero utilization without dividing by zero', () => {
    const rows = computeCreditRows(
      [account({ creditLimit: 0, currentBalance: -100 })],
      noConvert,
      'USD',
    );
    expect(rows[0].utilizationPercent).toBe(0);
  });

  it('counts a closed card owing a balance at a zero limit, fully used', () => {
    const rows = computeCreditRows(
      [account({ isClosed: true, creditLimit: 2000, currentBalance: -250 })],
      noConvert,
      'USD',
    );
    expect(rows[0]).toMatchObject({
      limit: 0,
      used: 250,
      available: -250,
      utilizationPercent: 100,
    });
  });
});

describe('computeCreditTotals', () => {
  it('sums rows and computes overall utilization', () => {
    const rows = computeCreditRows(
      [
        account({ id: 'a', creditLimit: 1000, currentBalance: -500 }),
        account({ id: 'b', creditLimit: 1000, currentBalance: -100 }),
      ],
      noConvert,
      'USD',
    );
    const totals = computeCreditTotals(rows);
    expect(totals).toEqual({
      limit: 2000,
      used: 600,
      available: 1400,
      utilizationPercent: 30,
      missingCurrencies: [],
      excludedCount: 0,
    });
  });

  it('adds a closed card\'s balance to used credit but nothing to the limit', () => {
    const rows = computeCreditRows(
      [
        account({ id: 'open', creditLimit: 1000, currentBalance: -250 }),
        account({ id: 'closed', isClosed: true, creditLimit: 5000, currentBalance: -250 }),
      ],
      noConvert,
      'USD',
    );
    const totals = computeCreditTotals(rows);
    expect(totals).toMatchObject({
      limit: 1000,
      used: 500,
      available: 500,
      utilizationPercent: 50,
    });
  });

  it('reads only closed cards owing a balance as fully used, not 0%', () => {
    const rows = computeCreditRows(
      [account({ id: 'closed', isClosed: true, creditLimit: 5000, currentBalance: -250 })],
      noConvert,
      'USD',
    );
    expect(computeCreditTotals(rows)).toMatchObject({
      limit: 0,
      used: 250,
      utilizationPercent: 100,
    });
  });

  it('returns zero utilization for an empty set', () => {
    expect(computeCreditTotals([])).toEqual({
      limit: 0,
      used: 0,
      available: 0,
      utilizationPercent: 0,
      missingCurrencies: [],
      excludedCount: 0,
    });
  });

  /**
   * A row with no rate to the display currency used to be counted as a zero
   * limit with a zero balance, which *improves* the utilisation figure this
   * module exists to warn about: 90% drawn on an unconvertible card disappeared
   * from the ratio entirely rather than being reported as unmeasured.
   */
  it('excludes an unconvertible row and names its currency', () => {
    const rows = computeCreditRows(
      [
        account({ id: 'a', creditLimit: 1000, currentBalance: -300, currencyCode: 'USD' }),
        account({ id: 'b', creditLimit: 1000, currentBalance: -900, currencyCode: 'EUR' }),
      ],
      // Knows USD only.
      (value, from) => (from === 'USD' ? value : null),
      'USD',
    );
    const totals = computeCreditTotals(rows);

    expect(totals.limit).toBe(1000);
    expect(totals.used).toBe(300);
    expect(totals.utilizationPercent).toBe(30);
    expect(totals.missingCurrencies).toEqual(['EUR']);
    expect(totals.excludedCount).toBe(1);
  });

  // Utilisation is a ratio inside one currency, so it needs no rate and stays
  // known even when the money figures do not.
  it('keeps a row percentage when its money figures are unknown', () => {
    const rows = computeCreditRows(
      [account({ id: 'b', creditLimit: 1000, currentBalance: -900, currencyCode: 'EUR' })],
      () => null,
      'USD',
    );
    expect(rows[0].utilizationPercent).toBe(90);
    expect(rows[0].limit).toBeNull();
    expect(rows[0].used).toBeNull();
  });
});
