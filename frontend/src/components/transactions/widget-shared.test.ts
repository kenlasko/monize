import { describe, it, expect, vi } from 'vitest';
import {
  summarizeInDisplayCurrency,
  buildDisplayCurrencyStrategy,
  type DisplayCurrencyStrategy,
} from './widget-shared';
import type { TransactionSummary } from '@/types/transaction';

const summary = (byCurrency: TransactionSummary['byCurrency']): TransactionSummary => {
  const buckets = Object.values(byCurrency ?? {});
  return {
    totalIncome: buckets.reduce((s, b) => s + b.totalIncome, 0),
    totalExpenses: buckets.reduce((s, b) => s + b.totalExpenses, 0),
    netCashFlow: buckets.reduce((s, b) => s + b.netCashFlow, 0),
    transactionCount: buckets.reduce((s, b) => s + b.transactionCount, 0),
    byCurrency,
  } as TransactionSummary;
};

// A strategy that converts every currency 1:1 except the ones named, which have
// no rate (toDisplay returns null) -- the missing-rate case.
const strategyExcept = (
  displayCurrency: string,
  noRate: string[] = [],
): DisplayCurrencyStrategy => ({
  displayCurrency,
  toDisplay: (amount, fromCurrency) =>
    noRate.includes(fromCurrency) ? null : amount,
});

describe('summarizeInDisplayCurrency', () => {
  it('passes a single-currency summary through with the full transaction count', () => {
    const result = summarizeInDisplayCurrency(
      summary({
        CAD: { totalIncome: 100, totalExpenses: 800, netCashFlow: -700, transactionCount: 20 },
      }),
      strategyExcept('CAD'),
    );
    expect(result).toEqual({
      income: 100,
      expenses: 800,
      net: -700,
      missingCurrencies: [],
      includedTransactionCount: 20,
      excludedTransactionCount: 0,
    });
  });

  it('sums convertible buckets and counts every transaction when all convert', () => {
    const result = summarizeInDisplayCurrency(
      summary({
        CAD: { totalIncome: 100, totalExpenses: 200, netCashFlow: -100, transactionCount: 5 },
        USD: { totalIncome: 50, totalExpenses: 30, netCashFlow: 20, transactionCount: 3 },
      }),
      strategyExcept('CAD'),
    );
    expect(result.income).toBe(150);
    expect(result.expenses).toBe(230);
    expect(result.missingCurrencies).toEqual([]);
    expect(result.includedTransactionCount).toBe(8);
  });

  it('excludes an unconvertible bucket, names its currency, and counts only the included transactions', () => {
    // The EUR bucket has no rate: its income/expenses must not join the totals,
    // its currency is named, and the transaction count reflects only the
    // transactions actually summed -- not the full 15.
    const result = summarizeInDisplayCurrency(
      summary({
        CAD: { totalIncome: 100, totalExpenses: 200, netCashFlow: -100, transactionCount: 10 },
        EUR: { totalIncome: 999, totalExpenses: 999, netCashFlow: 0, transactionCount: 5 },
      }),
      strategyExcept('CAD', ['EUR']),
    );
    expect(result.income).toBe(100);
    expect(result.expenses).toBe(200);
    expect(result.net).toBe(-100);
    expect(result.missingCurrencies).toEqual(['EUR']);
    expect(result.includedTransactionCount).toBe(10);
    // Five EUR transactions were dropped -- the component count, not one per currency.
    expect(result.excludedTransactionCount).toBe(5);
  });
});

describe('server-valued reporting currency', () => {
 it('keeps date-valued headlines even when native buckets would convert differently today', () => {
  const convert=vi.fn().mockReturnValue(9999);
  const value: TransactionSummary={currency:'USD',fxComplete:true,totalIncome:100,totalExpenses:200,netCashFlow:-100,transactionCount:2,byCurrency:{EUR:{totalIncome:50,totalExpenses:100,netCashFlow:-50,transactionCount:2}}};
  const strategy=buildDisplayCurrencyStrategy(value,'USD',convert);
  expect(strategy.displayCurrency).toBe('USD');
  expect(summarizeInDisplayCurrency(value,strategy)).toMatchObject({income:100,expenses:200,net:-100,includedTransactionCount:2});
  expect(convert).not.toHaveBeenCalled();
 });
 it('does not label a conversion into a newly selected currency as the old report currency',()=>{
  const convert=vi.fn().mockReturnValue(99);
  const value={currency:'USD',fxComplete:true,totalIncome:0,totalExpenses:0,netCashFlow:0,transactionCount:0};
  const strategy=buildDisplayCurrencyStrategy(value,'EUR',convert);
  expect(strategy.toDisplay(5,'USD')).toBe(5);
  expect(strategy.toDisplay(5,'CAD')).toBeNull();expect(convert).not.toHaveBeenCalled();
 });
});
