import { describe, it, expect } from 'vitest';
import { periodBalanceFields, taggedBalance, taggedBalanceWindow, taggedFunds } from './tagged-balance';

const none = { missingCurrencies: [], excludedCount: 0 };

describe('taggedBalance', () => {
  it("matches the reporter's August 2026 example", () => {
    expect(
      taggedBalance({ income: 3279, expenses: 8486, taggedInflows: 4516, taggedOutflows: 0 }),
    ).toEqual({ balance: -691, balancePercent: -8.86 });
  });

  it('subtracts tagged outflows and divides by income plus tagged inflows', () => {
    expect(
      taggedBalance({ income: 1000, expenses: 400, taggedInflows: 500, taggedOutflows: 100 }),
    ).toEqual({ balance: 1000, balancePercent: 66.67 });
  });

  it('has no percentage when nothing came in, and keeps the balance', () => {
    expect(
      taggedBalance({ income: 0, expenses: 50, taggedInflows: 0, taggedOutflows: 0 }),
    ).toEqual({ balance: -50, balancePercent: null });
  });

  it('has no percentage over a negative base', () => {
    expect(
      taggedBalance({ income: 100, expenses: 0, taggedInflows: -300, taggedOutflows: 0 }).balancePercent,
    ).toBeNull();
  });

  it('does not drift on float sums', () => {
    // 0.1 + 0.2 - 0.3 is 5.55e-17 in floating point; in cents it is exactly 0.
    const result = taggedBalance({ income: 0.1, expenses: 0.3, taggedInflows: 0.2, taggedOutflows: 0 });
    expect(result.balance).toBe(0);
    expect(Object.is(result.balance, 0)).toBe(true);
    expect(result.balancePercent).toBe(0);
    expect(
      taggedBalance({ income: 1234.56, expenses: 0.07, taggedInflows: 0.01, taggedOutflows: 0.02 }).balance,
    ).toBe(1234.48);
  });

  it('is null, not zero, for an unknown or non-finite input', () => {
    const base = { income: 1, expenses: 1, taggedInflows: 1, taggedOutflows: 1 };
    for (const key of Object.keys(base) as (keyof typeof base)[]) {
      for (const bad of [null, undefined, NaN, Infinity]) {
        expect(taggedBalance({ ...base, [key]: bad })).toEqual({ balance: null, balancePercent: null });
      }
    }
  });
});

describe('taggedBalanceWindow', () => {
  const amounts = { income: 3279, expenses: 8486, taggedInflows: 4516, taggedOutflows: 0 };

  it('is a total when the All totals are known and the bucket is complete', () => {
    expect(taggedBalanceWindow(amounts, true, none, none)).toEqual({
      balance: -691,
      balancePercent: -8.86,
      complete: true,
      missingCurrencies: [],
      excludedCount: 0,
    });
  });

  it('is a subtotal without a percentage when the bucket is incomplete', () => {
    const result = taggedBalanceWindow(amounts, true, none, { missingCurrencies: ['JPY'], excludedCount: 2 });
    expect(result).toMatchObject({
      balance: -691,
      balancePercent: null,
      complete: false,
      missingCurrencies: ['JPY'],
      excludedCount: 2,
    });
  });

  it('is a subtotal when only the All totals are incomplete, naming each currency once', () => {
    const result = taggedBalanceWindow(
      amounts,
      false,
      { missingCurrencies: ['JPY', 'EUR'], excludedCount: 1 },
      { missingCurrencies: ['JPY'], excludedCount: 0 },
    );
    expect(result.complete).toBe(false);
    expect(result.missingCurrencies).toEqual(['JPY', 'EUR']);
    expect(result.excludedCount).toBe(1);
    expect(result.balancePercent).toBeNull();
  });

  it('never reports an incomplete figure as excluding nothing', () => {
    expect(taggedBalanceWindow(amounts, false, none, none).excludedCount).toBe(1);
  });
});

describe('periodBalanceFields', () => {
  it('rounds the balance to whole units and keeps the percentage', () => {
    expect(
      periodBalanceFields({ income: 3279, expenses: 8486 }, { taggedInflows: 4516, taggedOutflows: 0 }),
    ).toEqual({ Balance: -691, BalancePercent: -8.86 });
  });

  it('keeps the balance at money precision rather than whole units (issue #2412)', () => {
    expect(
      periodBalanceFields({ income: 10.6, expenses: 0.2 }, { taggedInflows: 0.4, taggedOutflows: 0.3 }),
    ).toEqual({ Balance: 10.5, BalancePercent: 95.45 });
  });

  it('treats a period with no flow row as a known zero of flows', () => {
    expect(periodBalanceFields({ income: 100, expenses: 40 }, undefined)).toEqual({
      Balance: 60,
      BalancePercent: 60,
    });
  });

  it('has no percentage for a period with nothing coming in', () => {
    expect(periodBalanceFields({ income: 0, expenses: 40 }, undefined)).toEqual({
      Balance: -40,
      BalancePercent: null,
    });
  });
});

describe('taggedFunds', () => {
  it("is income plus the net tagged inflow (the reporter's August)", () => {
    expect(taggedFunds({ income: 3279, taggedInflows: 4516, taggedOutflows: 0 })).toEqual({
      netTagged: 4516,
      availableFunds: 7795,
    });
  });

  it('nets outflows off, in integer cents', () => {
    expect(taggedFunds({ income: 0.1, taggedInflows: 0.2, taggedOutflows: 0 })).toEqual({
      netTagged: 0.2,
      availableFunds: 0.3,
    });
    expect(taggedFunds({ income: 100, taggedInflows: 50, taggedOutflows: 80 })).toEqual({
      netTagged: -30,
      availableFunds: 70,
    });
  });

  it('keeps a known zero distinct from unknown', () => {
    expect(taggedFunds({ income: 0, taggedInflows: 0, taggedOutflows: 0 })).toEqual({
      netTagged: 0,
      availableFunds: 0,
    });
    expect(taggedFunds({ income: null, taggedInflows: 5, taggedOutflows: 0 })).toEqual({
      netTagged: 5,
      availableFunds: null,
    });
    expect(taggedFunds({ income: 1, taggedInflows: undefined, taggedOutflows: 0 })).toEqual({
      netTagged: null,
      availableFunds: null,
    });
    expect(taggedFunds({ income: 1, taggedInflows: Number.NaN, taggedOutflows: 0 }).availableFunds).toBeNull();
  });
});
