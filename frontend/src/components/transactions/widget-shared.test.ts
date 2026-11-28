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
  // As the server sends it: the top-level totals are null across currencies.
  const one = buckets.length <= 1;
  return {
    totalIncome: one ? buckets.reduce((s, b) => s + b.totalIncome, 0) : null,
    totalExpenses: one ? buckets.reduce((s, b) => s + b.totalExpenses, 0) : null,
    netCashFlow: one ? buckets.reduce((s, b) => s + b.netCashFlow, 0) : null,
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
          knownNet: -3,
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
      provisionalCount: 0,
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
          knownNet: -75,
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
      provisionalCount: 0,
    });
  });

  it("reads the server's net, rounded once, not the difference of its rounded sides (issue #2384)", () => {
    // 249.504948 in and 0.00005 out net 249.504898, which reads 249.5049;
    // the rounded sides, 249.5049 and 0.0001, differ by 249.5048.
    const result = summarizeInDisplayCurrency(
      summary(
        {
          EUR: { totalIncome: 200.02, totalExpenses: 0, netCashFlow: 200.02, transactionCount: 2 },
          USD: { totalIncome: 0, totalExpenses: 0.00005, netCashFlow: -0.00005, transactionCount: 1 },
        },
        {
          currency: 'USD',
          totalIncome: 249.5049,
          totalExpenses: 0.0001,
          netCashFlow: 249.5049,
          knownIncome: 249.5049,
          knownExpenses: 0.0001,
          knownNet: 249.5049,
          includedTransactionCount: 3,
          excludedTransactionCount: 0,
          missingCurrencies: [],
        },
      ),
      converted('USD'),
    );
    expect(result.net).toBe(249.5049);
  });

  it("reads a partial summary's known net, not the difference of its rounded sides (issue #2409)", () => {
    // 100.01 EUR in and 0.00004 EUR out at 1.2474 net 124.752424, which reads
    // 124.7524; the rounded sides, 124.7525 and 0, differ by 124.7525.
    const result = summarizeInDisplayCurrency(
      summary(
        {
          EUR: { totalIncome: 100.01, totalExpenses: 0.00004, netCashFlow: 100.00996, transactionCount: 2 },
          JPY: { totalIncome: 0, totalExpenses: 1000, netCashFlow: -1000, transactionCount: 1 },
        },
        {
          currency: 'CAD',
          totalIncome: null,
          totalExpenses: null,
          netCashFlow: null,
          knownIncome: 124.7525,
          knownExpenses: 0,
          knownNet: 124.7524,
          includedTransactionCount: 2,
          excludedTransactionCount: 1,
          missingCurrencies: ['JPY'],
        },
      ),
      converted('CAD'),
    );
    expect(result.net).toBe(124.7524);
    expect(result.missingCurrencies).toEqual(['JPY']);
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
          knownNet: -100,
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

  it("converts a period whose one bucket is a foreign currency (issue #2106)", () => {
    // The page displays USD; this year was spent only in EUR.
    const result = summarizeInDisplayCurrency(
      summary(
        { EUR: { totalIncome: 0, totalExpenses: 100, netCashFlow: -100, transactionCount: 2 } },
        {
          currency: 'USD',
          totalIncome: 0,
          totalExpenses: 110.1234,
          netCashFlow: -110.1234,
          knownIncome: 0,
          knownExpenses: 110.1234,
          knownNet: -110.1234,
          includedTransactionCount: 2,
          excludedTransactionCount: 0,
          missingCurrencies: [],
        },
      ),
      converted('USD'),
    );
    expect(result.expenses).toBe(110.1234);
    expect(result.net).toBe(-110.1234);
  });

  it('reads the converted block, never the null native totals, for two buckets even without a conversion strategy', () => {
    const result = summarizeInDisplayCurrency(
      summary(
        {
          USD: { totalIncome: 100, totalExpenses: 0, netCashFlow: 100, transactionCount: 1 },
          EUR: { totalIncome: 50, totalExpenses: 0, netCashFlow: 50, transactionCount: 1 },
        },
        {
          currency: 'USD',
          totalIncome: null,
          totalExpenses: null,
          netCashFlow: null,
          knownIncome: 100,
          knownExpenses: 0,
          knownNet: 100,
          includedTransactionCount: 1,
          excludedTransactionCount: 1,
          missingCurrencies: ['EUR'],
        },
      ),
      native('USD'),
    );
    expect(result.income).toBe(100);
    expect(result.missingCurrencies).toEqual(['EUR']);
    expect(result.excludedTransactionCount).toBe(1);
  });

  it('never reads a withheld (null) native total as zero: one bucket, no conversion', () => {
    const result = summarizeInDisplayCurrency(
      {
        totalIncome: null,
        totalExpenses: null,
        netCashFlow: null,
        transactionCount: 3,
        byCurrency: {
          USD: { totalIncome: 10, totalExpenses: 5, netCashFlow: 5, transactionCount: 3 },
        },
      } as TransactionSummary,
      native('USD'),
    );
    expect(result.missingCurrencies).toEqual(['USD']);
    expect(result.excludedTransactionCount).toBe(3);
    expect(result.includedTransactionCount).toBe(0);
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
      provisionalCount: 0,
    });
  });
});

describe('summarizeInDisplayCurrency: provisional amounts', () => {
  const cad = { totalIncome: 100, totalExpenses: 0, netCashFlow: 100, transactionCount: 1 };
  const usd = { totalIncome: 80, totalExpenses: 0, netCashFlow: 80, transactionCount: 1 };
  const conversion = (over: Partial<NonNullable<TransactionSummary['converted']>>) => ({
    currency: 'CAD',
    totalIncome: 180,
    totalExpenses: 0,
    netCashFlow: 180,
    knownIncome: 180,
    knownExpenses: 0,
    knownNet: 180,
    includedTransactionCount: 2,
    excludedTransactionCount: 0,
    missingCurrencies: [],
    ...over,
  });

  it('reads the native count on a single-currency summary', () => {
    const result = summarizeInDisplayCurrency(
      { ...summary({ CAD: cad }), provisionalCount: 1 },
      native('CAD'),
    );
    expect(result.provisionalCount).toBe(1);
  });

  it("reads the conversion's count, over the currencies that converted, on a converted summary", () => {
    const result = summarizeInDisplayCurrency(
      // The native count holds an estimate the conversion left out with its currency.
      { ...summary({ CAD: cad, USD: usd }, conversion({ provisionalCount: 1 })), provisionalCount: 2 },
      converted('CAD'),
    );
    expect(result.provisionalCount).toBe(1);
  });

  it('reads an absent count as 0', () => {
    expect(summarizeInDisplayCurrency(summary({ CAD: cad }), native('CAD')).provisionalCount).toBe(0);
    expect(
      summarizeInDisplayCurrency(summary({ CAD: cad, USD: usd }, conversion({})), converted('CAD')).provisionalCount,
    ).toBe(0);
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
