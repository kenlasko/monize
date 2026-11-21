import { rowAffectsBalance, type RunningBalanceRow } from '@/lib/running-balance';
import { sumMoney, roundMoney } from '@/lib/format';

/**
 * Figures the Folio and Pebble register layouts draw around the rows. The
 * list computes them once and hands them to whichever renderer the UI style
 * picks; a renderer never derives a figure of its own. Nothing here is a
 * balance: running balances come from `walkRunningBalances` alone, and these
 * only read them.
 */

export interface RegisterStyleRow extends RunningBalanceRow {
  transactionDate: string;
}

/** The signed amount a row contributes: the filtered split total when a filter narrowed it. */
export function rowAmount(
  row: { id: string; amount: number | string },
  displayAmounts: ReadonlyMap<string, number>,
): number {
  return displayAmounts.get(row.id) ?? Number(row.amount);
}

/** The net movement of each date on the page, for a date group's right-hand figure. */
export function netByDate(
  rows: readonly RegisterStyleRow[],
  displayAmounts: ReadonlyMap<string, number>,
  decimals: number,
): Map<string, number> {
  const byDate = new Map<string, number[]>();
  for (const row of rows) {
    if (!rowAffectsBalance(row)) continue;
    const list = byDate.get(row.transactionDate) ?? [];
    list.push(rowAmount(row, displayAmounts));
    byDate.set(row.transactionDate, list);
  }
  const net = new Map<string, number>();
  for (const [date, amounts] of byDate) net.set(date, sumMoney(amounts, decimals));
  return net;
}

/** What the page paid out and took in, and the difference, for the Folio footer. */
export function pageTotals(
  rows: readonly RegisterStyleRow[],
  displayAmounts: ReadonlyMap<string, number>,
  decimals: number,
): { payments: number; deposits: number; net: number; count: number } {
  const out: number[] = [];
  const into: number[] = [];
  for (const row of rows) {
    if (!rowAffectsBalance(row)) continue;
    const amount = rowAmount(row, displayAmounts);
    if (amount < 0) out.push(-amount);
    else into.push(amount);
  }
  const payments = sumMoney(out, decimals);
  const deposits = sumMoney(into, decimals);
  return {
    payments,
    deposits,
    net: roundMoney(deposits - payments, decimals),
    count: rows.length,
  };
}

/**
 * Each row's balance as a share (0-100) of the largest balance magnitude on the
 * page: the width of the rule under a Folio register's balance.
 */
export function balanceRulePercents(balances: ReadonlyMap<string, number>): Map<string, number> {
  let max = 0;
  for (const balance of balances.values()) max = Math.max(max, Math.abs(balance));
  const out = new Map<string, number>();
  if (max <= 0) return out;
  for (const [id, balance] of balances) {
    out.set(id, Math.max(2, Math.round((Math.abs(balance) / max) * 100)));
  }
  return out;
}

/** "Wednesday, November 11", in the reader's language; the year only when it is not this one. */
export function registerGroupLabel(date: string, locale: string | undefined, today: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const when = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
      timeZone: 'UTC',
    }).format(when);
  } catch {
    return date;
  }
}

/** The calendar day before an ISO date, for "Yesterday". */
export function previousDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const when = new Date(Date.UTC(y, (m || 1) - 1, (d || 1) - 1));
  return when.toISOString().slice(0, 10);
}
