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
  }) as Account;

// Identity converter for tests (no FX).
const noConvert = (v: number) => v;

describe('isCreditAccount', () => {
  it('accepts credit cards and lines of credit with a positive limit', () => {
    expect(isCreditAccount(account({}))).toBe(true);
    expect(isCreditAccount(account({ accountType: 'LINE_OF_CREDIT' }))).toBe(true);
  });

  it('rejects non-credit account types', () => {
    expect(isCreditAccount(account({ accountType: 'CHECKING' }))).toBe(false);
  });

  it('rejects accounts without a positive limit', () => {
    expect(isCreditAccount(account({ creditLimit: 0 }))).toBe(false);
    expect(isCreditAccount(account({ creditLimit: null }))).toBe(false);
  });

  it('rejects closed accounts', () => {
    expect(isCreditAccount(account({ isClosed: true }))).toBe(false);
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
    });
  });

  it('returns zero utilization for an empty set', () => {
    expect(computeCreditTotals([])).toEqual({
      limit: 0,
      used: 0,
      available: 0,
      utilizationPercent: 0,
    });
  });
});
