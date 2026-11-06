import { describe, it, expect } from 'vitest';
import {
  NET_WORTH_ACCOUNT_TYPE_ORDER,
  netWorthAccountTypeColor,
  netWorthAccountTypes,
  netWorthStackTop,
  NET_WORTH_LINE_COLOR,
} from './net-worth-account-types';
import { chartColors } from './chart-colors';

describe('netWorthAccountTypes', () => {
  it('lists every type any month holds, in stacking order', () => {
    expect(
      netWorthAccountTypes([
        { byAccountType: { MORTGAGE: -100, CHEQUING: 10 } },
        { byAccountType: { INVESTMENT: 50, CHEQUING: 12 } },
      ]),
    ).toEqual(['CHEQUING', 'INVESTMENT', 'MORTGAGE']);
  });

  it('leaves out a type that is zero in every month, but keeps one held in any month', () => {
    expect(
      netWorthAccountTypes([
        { byAccountType: { CHEQUING: 10, SAVINGS: 0, CREDIT_CARD: 0 } },
        { byAccountType: { CHEQUING: 12, SAVINGS: 0, CREDIT_CARD: -40 } },
      ]),
    ).toEqual(['CHEQUING', 'CREDIT_CARD']);
  });

  it('is empty when no month carries the breakdown', () => {
    expect(netWorthAccountTypes([{}, { byAccountType: undefined }])).toEqual([]);
  });
});

describe('netWorthAccountTypeColor', () => {
  it('gives every type its own colour', () => {
    const colours = NET_WORTH_ACCOUNT_TYPE_ORDER.map(netWorthAccountTypeColor);
    expect(new Set(colours).size).toBe(colours.length);
    expect(netWorthAccountTypeColor('OTHER')).toBe(chartColors.neutral);
  });

  it('draws what is held from the theme accent and what is owed from its expense colour', () => {
    expect(netWorthAccountTypeColor('CHEQUING')).toBe(chartColors.primary);
    expect(netWorthAccountTypeColor('CREDIT_CARD')).toBe(chartColors.expense);
    for (const type of ['SAVINGS', 'CASH', 'CRYPTO', 'INVESTMENT', 'ASSET'] as const) {
      expect(netWorthAccountTypeColor(type)).toMatch(/^color-mix\(in srgb, var\(--chart-primary\) \d+%, var\(--chart-surface\)\)$/);
    }
    for (const type of ['LINE_OF_CREDIT', 'LOAN', 'MORTGAGE'] as const) {
      expect(netWorthAccountTypeColor(type)).toMatch(/^color-mix\(in srgb, var\(--chart-expense\) \d+%, var\(--chart-surface\)\)$/);
    }
    // No literal colour: every step follows the active theme.
    for (const type of NET_WORTH_ACCOUNT_TYPE_ORDER) {
      expect(netWorthAccountTypeColor(type)).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
  });

  it('stacks a crypto wallet with what is held, after cash', () => {
    const order = [...NET_WORTH_ACCOUNT_TYPE_ORDER];
    expect(order.indexOf('CRYPTO')).toBe(order.indexOf('CASH') + 1);
    expect(order.indexOf('CRYPTO')).toBeLessThan(order.indexOf('CREDIT_CARD'));
  });

  it('keeps the net worth line off the accent the asset bars are drawn from', () => {
    expect(NET_WORTH_LINE_COLOR).not.toBe(chartColors.primary);
  });
});

describe('netWorthStackTop', () => {
  it('is what the asset types hold, owed amounts aside', () => {
    expect(
      netWorthStackTop({ netWorth: 60, byAccountType: { CHEQUING: 10, INVESTMENT: 200, MORTGAGE: -150 } }),
    ).toBe(210);
  });

  it('is zero for a month that only owes', () => {
    expect(netWorthStackTop({ netWorth: -150, byAccountType: { MORTGAGE: -150 } })).toBe(0);
  });

  it('is net worth for a month without the breakdown', () => {
    expect(netWorthStackTop({ netWorth: 42 })).toBe(42);
  });
});
