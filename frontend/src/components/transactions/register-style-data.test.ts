import { describe, it, expect } from 'vitest';
import {
  balanceRulePercents,
  netByDate,
  pageTotals,
  previousDay,
  registerGroupLabel,
} from './register-style-data';

const rows = [
  { id: 'a', transactionDate: '2024-01-16', amount: 200 },
  { id: 'b', transactionDate: '2024-01-15', amount: -50 },
  { id: 'c', transactionDate: '2024-01-15', amount: -25.1 },
  { id: 'v', transactionDate: '2024-01-15', amount: -999, status: 'VOID' as never },
];

describe('register style data', () => {
  it('nets each date and skips rows that move no money', () => {
    const net = netByDate(rows, new Map(), 2);
    expect(net.get('2024-01-15')).toBe(-75.1);
    expect(net.get('2024-01-16')).toBe(200);
  });

  it('totals payments, deposits and the difference', () => {
    expect(pageTotals(rows, new Map(), 2)).toEqual({
      payments: 75.1,
      deposits: 200,
      net: 124.9,
      count: 4,
    });
  });

  it('uses a filtered split total where the list supplies one', () => {
    expect(pageTotals([rows[1]], new Map([['b', -10]]), 2).payments).toBe(10);
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
