import { describe, it, expect, vi } from 'vitest';
import {
  balanceByDate,
  balanceRulePercents,
  netByDate,
  pageTotals,
  previousDay,
  registerGroupLabel,
  pageReportingCurrency,
  totalsCurrency,
} from './register-style-data';

const rows = [
  { id: 'a', transactionDate: '2024-01-16', amount: 200, currencyCode: 'CAD' },
  { id: 'b', transactionDate: '2024-01-15', amount: -50, currencyCode: 'CAD' },
  { id: 'c', transactionDate: '2024-01-15', amount: -25.1, currencyCode: 'CAD' },
  { id: 'v', transactionDate: '2024-01-15', amount: -999, status: 'VOID' as never, currencyCode: 'EUR' },
];

describe('register style data', () => {
  it('closes each date on the balance beside its newest row, in either direction', () => {
    // The walk's answer for a newest-first page under a balance of 1000.
    const balances = new Map([
      ['a', 1000],
      ['b', 800],
      ['c', 850],
      ['v', 875.1],
    ]);
    const desc = balanceByDate(rows, balances, 'desc');
    expect(desc.get('2024-01-16')).toBe(1000);
    expect(desc.get('2024-01-15')).toBe(800);
    const asc = balanceByDate([...rows].reverse(), balances, 'asc');
    expect([...asc.entries()]).toEqual([
      ['2024-01-16', 1000],
      ['2024-01-15', 800],
    ]);
  });

  it('leaves a date out when its newest row has no balance, rather than closing it on another', () => {
    const closing = balanceByDate(rows, new Map([['c', 850]]), 'desc');
    expect(closing.has('2024-01-15')).toBe(false);
    expect(balanceByDate(rows, new Map(), 'desc').size).toBe(0);
  });

  it('nets each date and skips rows that move no money', () => {
    const net = netByDate(rows, new Map(), 'USD');
    expect(net.get('2024-01-15')?.total.value).toBe(-75.1);
    expect(net.get('2024-01-15')?.currency).toBe('CAD');
    expect(net.get('2024-01-16')?.total.value).toBe(200);
  });

  it('totals payments, deposits and the difference in the page currency', () => {
    const totals = pageTotals(rows, new Map(), 'USD');
    expect(totals.currency).toBe('CAD');
    expect(totals.payments).toMatchObject({ value: 75.1, missingCurrencies: [], excludedCount: 0 });
    expect(totals.deposits).toMatchObject({ value: 200, missingCurrencies: [], excludedCount: 0 });
    expect(totals.net).toMatchObject({ value: 124.9, missingCurrencies: [], excludedCount: 0 });
    expect(totals.count).toBe(4);
  });

  it('uses a filtered split total where the list supplies one', () => {
    expect(pageTotals([rows[1]], new Map([['b', -10]]), 'USD').payments.value).toBe(10);
  });

  it('converts a mixed-currency page at the factor each row carries before summing', () => {
    const mixed = [
      // Two USD rows struck on days the dollar stood at different rates.
      { id: 'u', transactionDate: '2024-01-15', amount: -100, currencyCode: 'USD', reportingCurrencyCode: 'CAD', reportingRate: 1.5 },
      { id: 'k', transactionDate: '2024-01-15', amount: -30, currencyCode: 'CAD', reportingCurrencyCode: 'CAD', reportingRate: 1 },
      { id: 'd', transactionDate: '2024-01-15', amount: 10, currencyCode: 'USD', reportingCurrencyCode: 'CAD', reportingRate: 1.25 },
    ];
    const totals = pageTotals(mixed, new Map(), 'CAD');
    expect(totals.currency).toBe('CAD');
    // 150 + 30, never 100 + 30 in two currencies.
    expect(totals.payments.value).toBe(180);
    expect(totals.deposits.value).toBe(12.5);
    expect(totals.net.value).toBe(-167.5);
    expect(netByDate(mixed, new Map(), 'CAD').get('2024-01-15')).toMatchObject({
      total: { value: -167.5, missingCurrencies: [], excludedCount: 0 },
      currency: 'CAD',
    });
  });

  // Deposits of 1.005 read 1.01 and payments of 1.004 read 1.00 at CAD's two
  // places, so the difference of the two readings is 0.01 where the net,
  // 0.001, reads 0.00; at four places the net was 0.001, a figure the footer
  // then rounded again (issue #2413).
  it('nets the two sides before rounding, once at the currency\'s places', () => {
    const mixed = [
      { id: 'c1', transactionDate: '2024-01-15', amount: 1, currencyCode: 'CAD' },
      { id: 'c2', transactionDate: '2024-01-15', amount: -1, currencyCode: 'CAD' },
      { id: 'u1', transactionDate: '2024-01-15', amount: 0.0125, currencyCode: 'USD', reportingCurrencyCode: 'CAD', reportingRate: 0.4 },
      { id: 'u2', transactionDate: '2024-01-15', amount: -0.01, currencyCode: 'USD', reportingCurrencyCode: 'CAD', reportingRate: 0.4 },
    ];
    const totals = pageTotals(mixed, new Map(), 'CAD');
    expect(totals.deposits.value).toBe(1.01);
    expect(totals.payments.value).toBe(1);
    expect(totals.net.value).toBe(0);
  });

  it('leaves out and names a currency with no rate rather than adding it unconverted', () => {
    const mixed = [
      { id: 'k', transactionDate: '2024-01-15', amount: -30, currencyCode: 'CAD' },
      // The server found no rate; a row the server never stamped is as unknown.
      { id: 'j', transactionDate: '2024-01-15', amount: -5000, currencyCode: 'JPY', reportingCurrencyCode: 'CAD', reportingRate: null },
      { id: 'e', transactionDate: '2024-01-15', amount: -10, currencyCode: 'EUR' },
    ];
    const totals = pageTotals(mixed, new Map(), 'CAD');
    expect(totals.payments).toMatchObject({ value: 30, missingCurrencies: ['JPY', 'EUR'], excludedCount: 2 });
    expect(totals.net.missingCurrencies).toEqual(['JPY', 'EUR']);
    expect(netByDate(mixed, new Map(), 'CAD').get('2024-01-15')?.total.excludedCount).toBe(2);
  });

  it('never applies a factor stamped for another currency', () => {
    const mixed = [
      { id: 'k', transactionDate: '2024-01-15', amount: -30, currencyCode: 'CAD' },
      { id: 'u', transactionDate: '2024-01-15', amount: -100, currencyCode: 'USD', reportingCurrencyCode: 'EUR', reportingRate: 0.9 },
    ];
    expect(pageTotals(mixed, new Map(), 'CAD').payments.missingCurrencies).toEqual(['USD']);
  });

  it('sums in the reporting currency the server stamped, else the reader default', () => {
    expect(pageReportingCurrency([{}, { reportingCurrencyCode: 'EUR' }], 'CAD')).toBe('EUR');
    expect(pageReportingCurrency([{}], 'CAD')).toBe('CAD');
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

  it('builds one day formatter per locale and year form, however many groups it labels', () => {
    const spy = vi.spyOn(Intl, 'DateTimeFormat');
    try {
      for (let day = 1; day <= 28; day++) {
        registerGroupLabel(`2024-02-${String(day).padStart(2, '0')}`, 'fr', '2024-06-01');
        registerGroupLabel(`2023-02-${String(day).padStart(2, '0')}`, 'fr', '2024-06-01');
      }
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
      expect(registerGroupLabel('2024-01-16', 'fr', '2024-06-01')).toBe('mardi 16 janvier');
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to the ISO date when the locale is refused', () => {
    expect(registerGroupLabel('2024-01-16', 'not a locale!!', '2024-06-01')).toBe('2024-01-16');
    expect(registerGroupLabel('2024-01-17', 'not a locale!!', '2024-06-01')).toBe('2024-01-17');
  });
});
