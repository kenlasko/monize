import { describe, it, expect } from 'vitest';
import {
  balanceRulePercents,
  netByDate,
  pageTotals,
  previousDay,
  registerGroupLabel,
  totalsCurrency,
  type RegisterConvert,
} from './register-style-data';

const rows = [
  { id: 'a', transactionDate: '2024-01-16', amount: 200, currencyCode: 'CAD' },
  { id: 'b', transactionDate: '2024-01-15', amount: -50, currencyCode: 'CAD' },
  { id: 'c', transactionDate: '2024-01-15', amount: -25.1, currencyCode: 'CAD' },
  { id: 'v', transactionDate: '2024-01-15', amount: -999, status: 'VOID' as never, currencyCode: 'EUR' },
];

// 1 USD = 1.5 CAD; no rate for JPY.
const convert: RegisterConvert = (amount, from, to) => {
  if (from === to) return amount;
  if (from === 'USD' && to === 'CAD') return amount * 1.5;
  return null;
};
const noRates: RegisterConvert = () => null;

describe('register style data', () => {
  it('nets each date and skips rows that move no money', () => {
    const net = netByDate(rows, new Map(), 'USD', noRates);
    expect(net.get('2024-01-15')?.total.value).toBe(-75.1);
    expect(net.get('2024-01-15')?.currency).toBe('CAD');
    expect(net.get('2024-01-16')?.total.value).toBe(200);
  });

  it('totals payments, deposits and the difference in the page currency', () => {
    const totals = pageTotals(rows, new Map(), 'USD', noRates);
    expect(totals.currency).toBe('CAD');
    expect(totals.payments).toEqual({ value: 75.1, missingCurrencies: [], excludedCount: 0 });
    expect(totals.deposits).toEqual({ value: 200, missingCurrencies: [], excludedCount: 0 });
    expect(totals.net).toEqual({ value: 124.9, missingCurrencies: [], excludedCount: 0 });
    expect(totals.count).toBe(4);
  });

  it('uses a filtered split total where the list supplies one', () => {
    expect(pageTotals([rows[1]], new Map([['b', -10]]), 'USD', noRates).payments.value).toBe(10);
  });

  it('converts a mixed-currency page into the default currency before summing', () => {
    const mixed = [
      { id: 'u', transactionDate: '2024-01-15', amount: -100, currencyCode: 'USD' },
      { id: 'k', transactionDate: '2024-01-15', amount: -30, currencyCode: 'CAD' },
      { id: 'd', transactionDate: '2024-01-15', amount: 10, currencyCode: 'USD' },
    ];
    const totals = pageTotals(mixed, new Map(), 'CAD', convert);
    expect(totals.currency).toBe('CAD');
    // 150 + 30, never 100 + 30 in two currencies.
    expect(totals.payments.value).toBe(180);
    expect(totals.deposits.value).toBe(15);
    expect(totals.net.value).toBe(-165);
    expect(netByDate(mixed, new Map(), 'CAD', convert).get('2024-01-15')).toEqual({
      total: { value: -165, missingCurrencies: [], excludedCount: 0 },
      currency: 'CAD',
    });
  });

  it('leaves out and names a currency with no rate rather than adding it unconverted', () => {
    const mixed = [
      { id: 'k', transactionDate: '2024-01-15', amount: -30, currencyCode: 'CAD' },
      { id: 'j', transactionDate: '2024-01-15', amount: -5000, currencyCode: 'JPY' },
    ];
    const totals = pageTotals(mixed, new Map(), 'CAD', convert);
    expect(totals.payments).toEqual({ value: 30, missingCurrencies: ['JPY'], excludedCount: 1 });
    expect(totals.net.missingCurrencies).toEqual(['JPY']);
    expect(netByDate(mixed, new Map(), 'CAD', convert).get('2024-01-15')?.total.excludedCount).toBe(1);
  });

  it('sums in the shared currency, or the default when rows are mixed', () => {
    expect(totalsCurrency([{ currencyCode: 'EUR' }, { currencyCode: 'EUR' }], 'CAD')).toBe('EUR');
    expect(totalsCurrency([{ currencyCode: 'EUR' }, { currencyCode: 'USD' }], 'CAD')).toBe('CAD');
    expect(totalsCurrency([], 'CAD')).toBe('CAD');
  });

  it('sizes a rule against the largest balance on the page', () => {
    const pct = balanceRulePercents(
      new Map([
        ['a', 1000],
        ['b', 500],
        ['c', 0],
      ]),
    );
    expect(pct.get('a')).toBe(100);
    expect(pct.get('b')).toBe(50);
    expect(pct.get('c')).toBe(2);
    expect(balanceRulePercents(new Map()).size).toBe(0);
  });

  it('names a day in the reader language, with the year only when it is not this one', () => {
    expect(registerGroupLabel('2024-01-16', 'en', '2024-06-01')).toBe('Tuesday, January 16');
    expect(registerGroupLabel('2023-01-16', 'en', '2024-06-01')).toBe('Monday, January 16, 2023');
    expect(previousDay('2024-03-01')).toBe('2024-02-29');
  });
});
