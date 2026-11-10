import { describe, it, expect } from 'vitest';
import {
  aggregateGroupedTotals,
  buildDisplayCurrencyStrategy,
  inDisplayCurrency,
  summarizeInDisplayCurrency,
  type DisplayCurrencyStrategy,
} from './widget-shared';
import type { TransactionSummary } from '@/types/transaction';

const summary = (
  byCurrency: TransactionSummary['byCurrency'],
  converted?: TransactionSummary['converted'],
): TransactionSummary => {
  const buckets = Object.values(byCurrency ?? {});
  return {
    totalIncome: buckets.reduce((s, b) => s + b.totalIncome, 0),
    totalExpenses: buckets.reduce((s, b) => s + b.totalExpenses, 0),
    netCashFlow: buckets.reduce((s, b) => s + b.netCashFlow, 0),
    transactionCount: buckets.reduce((s, b) => s + b.transactionCount, 0),
    byCurrency,
    converted,
  } as TransactionSummary;
};

const native = (displayCurrency: string): DisplayCurrencyStrategy => ({
  displayCurrency,
  converted: false,
});
const converted = (displayCurrency: string): DisplayCurrencyStrategy => ({
  displayCurrency,
  converted: true,
});

describe('buildDisplayCurrencyStrategy', () => {
  it('renders a single-currency result natively', () => {
    const result = buildDisplayCurrencyStrategy(
      summary({ USD: { totalIncome: 1, totalExpenses: 2, netCashFlow: -1, transactionCount: 1 } }),
      'CAD',
    );
    expect(result).toEqual({ displayCurrency: 'USD', converted: false });
  });

  it("reads several currencies in the server's reporting currency", () => {
    const result = buildDisplayCurrencyStrategy(
      summary(
        {
          CAD: { totalIncome: 0, totalExpenses: 2, netCashFlow: -2, transactionCount: 1 },
          USD: { totalIncome: 0, totalExpenses: 2, netCashFlow: -2, transactionCount: 1 },
        },
        {
          currency: 'EUR',
          totalIncome: 0,
          totalExpenses: 3,
          netCashFlow: -3,
          knownIncome: 0,
          knownExpenses: 3,
          includedTransactionCount: 2,
          excludedTransactionCount: 0,
          missingCurrencies: [],
        },
      ),
      'CAD',
    );
    expect(result).toEqual({ displayCurrency: 'EUR', converted: true });
  });
});

describe('summarizeInDisplayCurrency', () => {
  it('passes a single-currency summary through with the full transaction count', () => {
    const result = summarizeInDisplayCurrency(
      summary({
        CAD: { totalIncome: 100, totalExpenses: 800, netCashFlow: -700, transactionCount: 20 },
      }),
      native('CAD'),
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

  it("takes the server's per-date conversion, not a sum at today's rate (issue #2106)", () => {
    const result = summarizeInDisplayCurrency(
      summary(
        {
          CAD: { totalIncome: 100, totalExpenses: 200, netCashFlow: -100, transactionCount: 5 },
          USD: { totalIncome: 50, totalExpenses: 30, netCashFlow: 20, transactionCount: 3 },
        },
        {
          currency: 'CAD',
          totalIncome: 165,
          totalExpenses: 240,
          netCashFlow: -75,
          knownIncome: 165,
          knownExpenses: 240,
          includedTransactionCount: 8,
          excludedTransactionCount: 0,
          missingCurrencies: [],
        },
      ),
      converted('CAD'),
    );
    expect(result).toEqual({
      income: 165,
      expenses: 240,
      net: -75,
      missingCurrencies: [],
      includedTransactionCount: 8,
      excludedTransactionCount: 0,
    });
  });

  it('carries the excluded bucket, its currency and its transaction count', () => {
    const result = summarizeInDisplayCurrency(
      summary(
        {
          CAD: { totalIncome: 100, totalExpenses: 200, netCashFlow: -100, transactionCount: 10 },
          EUR: { totalIncome: 999, totalExpenses: 999, netCashFlow: 0, transactionCount: 5 },
        },
        {
          currency: 'CAD',
          totalIncome: null,
          totalExpenses: null,
          netCashFlow: null,
          knownIncome: 100,
          knownExpenses: 200,
          includedTransactionCount: 10,
          excludedTransactionCount: 5,
          missingCurrencies: ['EUR'],
        },
      ),
      converted('CAD'),
    );
    expect(result.income).toBe(100);
    expect(result.expenses).toBe(200);
    expect(result.net).toBe(-100);
    expect(result.missingCurrencies).toEqual(['EUR']);
    expect(result.includedTransactionCount).toBe(10);
    // Five EUR transactions were dropped -- the component count, not one per currency.
    expect(result.excludedTransactionCount).toBe(5);
  });

  it('reports every bucket unknown when the server sent no conversion', () => {
    const result = summarizeInDisplayCurrency(
      summary({
        CAD: { totalIncome: 100, totalExpenses: 200, netCashFlow: -100, transactionCount: 2 },
        USD: { totalIncome: 0, totalExpenses: 50, netCashFlow: -50, transactionCount: 1 },
      }),
      converted('CAD'),
    );
    expect(result).toEqual({
      income: 0,
      expenses: 0,
      net: 0,
      missingCurrencies: ['CAD', 'USD'],
      includedTransactionCount: 0,
      excludedTransactionCount: 3,
    });
  });
});

describe('inDisplayCurrency and aggregateGroupedTotals', () => {
  it("reads a row's own total natively and the server's conversion otherwise", () => {
    expect(inDisplayCurrency(native('CAD'), { total: 10, convertedTotal: 99 })).toBe(10);
    expect(inDisplayCurrency(converted('CAD'), { total: 10, convertedTotal: 13 })).toBe(13);
    expect(inDisplayCurrency(converted('CAD'), { total: 10, convertedTotal: null })).toBeNull();
    // No conversion is unknown, never the row's own amount under another symbol.
    expect(inDisplayCurrency(converted('CAD'), { total: 10 })).toBeNull();
  });

  it("sums a group's converted rows and leaves a group with an unknown part unknown", () => {
    const rows = aggregateGroupedTotals(
      [
        { id: 'a', name: 'A', currencyCode: 'CAD', total: -100, count: 2, convertedTotal: -100 },
        { id: 'a', name: 'A', currencyCode: 'USD', total: -100, count: 1, convertedTotal: -130 },
        { id: 'b', name: 'B', currencyCode: 'JPY', total: -5000, count: 1, convertedTotal: null },
      ],
      converted('CAD'),
    );
    expect(rows).toEqual([
      { id: 'a', name: 'A', total: -230, count: 3 },
      { id: 'b', name: 'B', total: null, count: 1 },
    ]);
  });
});
