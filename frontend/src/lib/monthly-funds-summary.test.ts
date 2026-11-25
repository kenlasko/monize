import { describe, it, expect } from 'vitest';
import { monthlyFundsSummary } from './monthly-funds-summary';
import type { IncomeVsExpensesResponse } from '@/types/built-in-reports';

const totals = { income: 3279, expenses: 8486, net: -5207, knownIncome: 3279, knownExpenses: 8486, knownNet: -5207 };
const item = (period: string, income: number, expenses: number) => ({
  period,
  periodStart: `${period}-01`,
  periodEnd: `${period}-28`,
  income,
  expenses,
  net: income - expenses,
});
const flow = (period: string, taggedInflows: number, taggedOutflows = 0) => ({
  ...item(period, 0, 0),
  taggedInflows,
  taggedOutflows,
});
const response = (over: Partial<IncomeVsExpensesResponse> = {}): IncomeVsExpensesResponse => ({
  data: [item('2026-07', 3000, 2000), item('2026-08', 3279, 8486)],
  totals,
  currency: 'CAD',
  missingCurrencies: [],
  excludedCount: 0,
  tagKey: 'scope',
  buckets: [
    {
      value: 'household',
      isUntagged: false,
      data: [flow('2026-07', 0), flow('2026-08', 4516)],
      totals,
      taggedInflows: 4516,
      taggedOutflows: 0,
      missingCurrencies: [],
      excludedCount: 0,
    },
  ],
  ...over,
});

describe('monthlyFundsSummary', () => {
  it("computes the reporter's August: 3,279 + 4,516 - 8,486 = -691, -8.86%", () => {
    const s = monthlyFundsSummary(response(), 'household', ['2026-07', '2026-08']);
    const aug = s.columns[1];
    expect(aug).toMatchObject({
      known: true,
      income: 3279,
      taggedInflows: 4516,
      expenses: 8486,
      taggedOutflows: 0,
      balance: -691,
      balancePercent: -8.86,
    });
    // A month with no tagged inflow is a plain income minus expenses.
    expect(s.columns[0]).toMatchObject({ balance: 1000, balancePercent: 33.33 });
    expect(s.complete).toBe(true);
    expect(s.showOutflows).toBe(false);
  });

  it('shows the outflows row only when a shown month has some', () => {
    const r = response();
    r.buckets![0].data = [flow('2026-07', 0, 300), flow('2026-08', 4516)];
    expect(monthlyFundsSummary(r, 'household', ['2026-07', '2026-08']).showOutflows).toBe(true);
    expect(monthlyFundsSummary(r, 'household', ['2026-08']).showOutflows).toBe(false);
  });

  it('reads a month the answer lacks as unknown, not zero', () => {
    const s = monthlyFundsSummary(response(), 'household', ['2026-08', '2026-09']);
    expect(s.columns[1]).toEqual({
      month: '2026-09',
      known: false,
      income: null,
      taggedInflows: null,
      expenses: null,
      taggedOutflows: null,
      balance: null,
      balancePercent: null,
    });
  });

  it('reads an absent bucket (or a month it has no row for) as known-zero flows', () => {
    const s = monthlyFundsSummary(response(), 'stall', ['2026-08']);
    expect(s.columns[0]).toMatchObject({ taggedInflows: 0, balance: -5207 });
    const r = response();
    r.buckets![0].data = [flow('2026-08', 4516)];
    expect(monthlyFundsSummary(r, 'household', ['2026-07']).columns[0]).toMatchObject({
      taggedInflows: 0,
      balance: 1000,
    });
  });

  it('withholds the percentage and reports the currencies under a gap', () => {
    const r = response({ missingCurrencies: ['EUR'], excludedCount: 1 });
    const s = monthlyFundsSummary(r, 'household', ['2026-08']);
    expect(s.complete).toBe(false);
    expect(s.missingCurrencies).toEqual(['EUR']);
    expect(s.columns[0].balance).toBe(-691);
    expect(s.columns[0].balancePercent).toBeNull();
  });

  it('is incomplete when the bucket lost a rate, or the All totals are null', () => {
    const r = response();
    r.buckets![0].missingCurrencies = ['GBP'];
    r.buckets![0].excludedCount = 1;
    expect(monthlyFundsSummary(r, 'household', ['2026-08']).complete).toBe(false);
    expect(
      monthlyFundsSummary(response({ totals: { ...totals, income: null } }), 'household', ['2026-08']).complete,
    ).toBe(false);
  });

  it("reads each year as the server answered it, the months folded there", () => {
    const year = (period: string, income: number, expenses: number) => ({
      ...item(period, income, expenses),
      periodStart: `${period}-01-01`,
      periodEnd: `${period}-12-31`,
    });
    const r = response({ data: [year('2025', 500, 100), year('2026', 6279, 10486)] });
    r.buckets![0].data = [{ ...year('2026', 0, 0), taggedInflows: 4516, taggedOutflows: 300 }];
    const s = monthlyFundsSummary(r, 'household', ['2025', '2026', '2027']);
    // 2026: 6279 + 4516 - 10486 - 300 = 9.
    expect(s.columns[1]).toMatchObject({
      month: '2026',
      known: true,
      income: 6279,
      taggedInflows: 4516,
      expenses: 10486,
      taggedOutflows: 300,
      balance: 9,
    });
    // A year in the answer with no tagged row has known-zero flows.
    expect(s.columns[0]).toMatchObject({ known: true, taggedInflows: 0, balance: 400 });
    // A year the answer does not cover is unknown, never zero.
    expect(s.columns[2]).toMatchObject({ known: false, income: null, balance: null });
    expect(s.showOutflows).toBe(true);
  });

  // The period's 0.015 of income, 0.005 of tagged inflows, 0.005 of expenses
  // and 0.004 of outflows read 0.02, 0.01, 0.01 and 0.00: a Balance of the four
  // readings was 0.02 where the server's, folded first, is 0.01 (issue #2413).
  it("reads the server's Balance and Balance %, not one of the four readings", () => {
    const r = response({ data: [item('2026-08', 0.02, 0.01)] });
    r.buckets![0].data = [{ ...flow('2026-08', 0.01, 0), balance: 0.01, balancePercent: 55 }];
    expect(monthlyFundsSummary(r, 'household', ['2026-08']).columns[0]).toMatchObject({
      balance: 0.01,
      balancePercent: 55,
    });
  });

  it('withholds the percentage when nothing came in', () => {
    const r = response({ data: [item('2026-08', 0, 100)] });
    r.buckets![0].data = [flow('2026-08', 0)];
    expect(monthlyFundsSummary(r, 'household', ['2026-08']).columns[0]).toMatchObject({
      balance: -100,
      balancePercent: null,
    });
  });
});
