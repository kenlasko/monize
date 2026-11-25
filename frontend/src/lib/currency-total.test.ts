import { describe, it, expect } from 'vitest';
import { absoluteTotal, sumConverted, combineTotals, isComplete, reportTotal } from './currency-total';

interface Row {
  amount: number;
  currency: string;
}

/** A rate table that knows only USD->CAD, so anything else is unconvertible. */
const convert = (amount: number, currency: string): number | null => {
  if (currency === 'CAD') return amount;
  if (currency === 'USD') return amount * 1.35;
  return null;
};

const rows = (...items: [number, string][]): Row[] =>
  items.map(([amount, currency]) => ({ amount, currency }));

const sum = (items: Row[]) =>
  sumConverted(
    items,
    (r) => r.amount,
    (r) => r.currency,
    convert,
  );

describe('sumConverted', () => {
  describe('rounds once, after the components are added (issue #2384)', () => {
    const eur = (amount: number, currency: string): number | null =>
      currency === 'EUR' ? amount * 1.2474 : currency === 'USD' ? amount : null;
    const sumEur = (items: Row[]) =>
      sumConverted(
        items,
        (r) => r.amount,
        (r) => r.currency,
        eur,
      );

    it('reads two 124.752474 components as 249.5049, as the server does', () => {
      // Each rounds to 124.7525 alone; rounded one by one they summed to
      // 249.5050, a ten-thousandth off the server's FxAggregate.
      expect(sumEur(rows([100.01, 'EUR'], [100.01, 'EUR'])).value).toBe(249.5049);
    });

    it('lets components under a ten-thousandth add up to one', () => {
      const total = sumEur(rows([0.00004, 'USD'], [0.00004, 'USD'], [0.00004, 'USD']));
      expect(total.value).toBe(0.0001);
    });

    it('rounds a negative midpoint away from zero', () => {
      expect(sumEur(rows([-0.00005, 'USD'])).value).toBe(-0.0001);
    });

    it("rounds once at a coin's eight places", () => {
      // 0.000000004 BTC three times is 0.000000012, which reads 0.00000001.
      const btc = sumConverted(
        rows([0.000000004, 'BTC'], [0.000000004, 'BTC'], [0.000000004, 'BTC']),
        (r) => r.amount,
        (r) => r.currency,
        (amount) => amount,
        8,
      );
      expect(btc.value).toBe(0.00000001);
    });

    it('cancels a large amount and its negation exactly', () => {
      expect(sumEur(rows([300000000000.03, 'USD'], [-300000000000.03, 'USD'])).value).toBe(0);
    });
  });

  it('adds converted components and reports the total complete', () => {
    const total = sum(rows([100, 'CAD'], [100, 'USD']));
    expect(total.value).toBe(235);
    expect(total.missingCurrencies).toEqual([]);
    expect(isComplete(total)).toBe(true);
  });

  // The audit's reproduction, in accumulator form: a 100.00 USD account with no
  // rate used to contribute 100.00 to a CAD total. It now contributes nothing and
  // says so, which is what lets the caller mark the figure as a subtotal.
  it('excludes an unconvertible component and names its currency', () => {
    const total = sum(rows([20_000, 'CAD'], [100_000, 'EUR']));
    expect(total.value).toBe(20_000);
    expect(total.missingCurrencies).toEqual(['EUR']);
    expect(total.excludedCount).toBe(1);
    expect(isComplete(total)).toBe(false);
  });

  it('names each missing currency once, however many rows use it', () => {
    const total = sum(rows([1, 'EUR'], [2, 'EUR'], [3, 'GBP']));
    expect(total.missingCurrencies).toEqual(['EUR', 'GBP']);
    expect(total.excludedCount).toBe(3);
  });

  // A non-finite component is an upstream value failure, not a zero and not a
  // missing rate: it is excluded by count, but its currency (which may have a
  // perfectly good rate) is not named.
  it('excludes a NaN component without naming its currency', () => {
    const total = sum(rows([Number.NaN, 'CAD'], [10, 'CAD']));
    expect(total.value).toBe(10);
    expect(total.missingCurrencies).toEqual([]);
    expect(total.excludedCount).toBe(1);
  });

  it('is complete and zero for no components at all', () => {
    const total = sum([]);
    expect(total.value).toBe(0);
    expect(isComplete(total)).toBe(true);
  });

  // A genuine zero balance is a known state and must not look like a missing one.
  it('treats a real zero as a known component', () => {
    const total = sum(rows([0, 'USD']));
    expect(total.value).toBe(0);
    expect(isComplete(total)).toBe(true);
  });

  // A component excluded with no currency to name (an unpriced holding) still
  // makes the total incomplete, even though missingCurrencies is empty.
  it('is incomplete when a component was excluded without a currency', () => {
    expect(isComplete({ value: 100, missingCurrencies: [], excludedCount: 1 })).toBe(false);
  });

  it('accumulates at storage precision rather than drifting', () => {
    const total = sum(rows([0.1, 'CAD'], [0.2, 'CAD']));
    expect(total.value).toBe(0.3);
  });
});

describe('combineTotals', () => {
  it('subtracts values and keeps both totals complete', () => {
    const assets = sum(rows([100, 'CAD']));
    const liabilities = sum(rows([40, 'CAD']));
    const net = combineTotals([assets, liabilities], [1, -1]);
    expect(net.value).toBe(60);
    expect(isComplete(net)).toBe(true);
  });

  // Net worth built from a complete asset total and a partial liability total is
  // partial: the hole is in the difference too.
  it('inherits incompleteness from either side', () => {
    const assets = sum(rows([100, 'CAD']));
    const liabilities = sum(rows([40, 'CAD'], [5, 'EUR']));
    const net = combineTotals([assets, liabilities], [1, -1]);
    expect(net.value).toBe(60);
    expect(net.missingCurrencies).toEqual(['EUR']);
    expect(isComplete(net)).toBe(false);
  });

  // Each side's components round up on their own: assets of 0.00008 read
  // 0.0001 and liabilities of 0.00004 read 0.0000, so the difference of the
  // two readings was 0.0001 where the net, 0.00004, reads 0.0000 (issue #2413).
  it('nets the two exact sums and rounds once, not the two readings', () => {
    const assets = sum(rows([0.00004, 'CAD'], [0.00004, 'CAD']));
    const liabilities = sum(rows([0.00004, 'CAD']));
    expect(assets.value).toBe(0.0001);
    expect(liabilities.value).toBe(0);
    expect(combineTotals([assets, liabilities], [1, -1]).value).toBe(0);
  });

  it('nets at the places it is given, from the exact sums', () => {
    const at2 = (...items: [number, string][]) =>
      sumConverted(rows(...items), (r) => r.amount, (r) => r.currency, convert, 2);
    const deposits = at2([0.004, 'CAD'], [0.004, 'CAD']);
    const bills = at2([0.004, 'CAD']);
    expect(deposits.value).toBe(0.01);
    expect(bills.value).toBe(0);
    expect(combineTotals([deposits, bills], [1, -1]).value).toBe(0);
  });

  it('folds a total read off a response as its value', () => {
    const known = sum(rows([10.00006, 'CAD']));
    const server = reportTotal(2.5, { missingCurrencies: ['JPY'], excludedCount: 1 });
    const net = combineTotals([known, server], [1, -1]);
    expect(net.value).toBe(7.5001);
    expect(net.missingCurrencies).toEqual(['JPY']);
  });

  it('refuses a sign list that does not match its totals', () => {
    expect(() => combineTotals([sum(rows([1, 'CAD']))], [1, -1])).toThrow();
  });

  it('unions the missing currencies of both sides', () => {
    const assets = sum(rows([100, 'CAD'], [1, 'GBP']));
    const liabilities = sum(rows([40, 'CAD'], [5, 'EUR']));
    const net = combineTotals([assets, liabilities], [1, -1]);
    expect(net.missingCurrencies.sort()).toEqual(['EUR', 'GBP']);
    expect(net.excludedCount).toBe(2);
  });
});

describe('absoluteTotal', () => {
  it('negates a negative total exactly, so a net built from it rounds once', () => {
    const owed = absoluteTotal(sum(rows([-0.00004, 'CAD'], [-0.00004, 'CAD'])));
    expect(owed.value).toBe(0.0001);
    const held = sum(rows([0.00004, 'CAD']));
    // 0.00004 less 0.00008 is -0.00004, which reads 0.0000; the readings'
    // difference was -0.0001.
    expect(combineTotals([held, owed], [1, -1]).value).toBeCloseTo(0, 10);
  });

  it('keeps a total that is not negative as it is', () => {
    const total = sum(rows([5, 'CAD']));
    expect(absoluteTotal(total)).toBe(total);
  });
});

describe('reportTotal', () => {
  it('carries the response completeness beside the known value', () => {
    const total = reportTotal(50, { missingCurrencies: ['JPY'], excludedCount: 2 });
    expect(total).toEqual({ value: 50, missingCurrencies: ['JPY'], excludedCount: 2 });
    expect(isComplete(total)).toBe(false);
  });

  it('reads a response without the fields as complete', () => {
    expect(isComplete(reportTotal(50, {}))).toBe(true);
    expect(isComplete(reportTotal(50, null))).toBe(true);
  });
});
