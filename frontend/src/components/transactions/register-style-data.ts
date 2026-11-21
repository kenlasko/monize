import { rowAffectsBalance, type RunningBalanceRow } from '@/lib/running-balance';
import { moneyDecimalsForCurrency, roundMoney } from '@/lib/format';
import { combineTotals, sumConverted, type ConvertedTotal } from '@/lib/currency-total';

/**
 * Figures the Folio and Pebble register layouts draw around the rows. The
 * list computes them once and hands them to whichever renderer the UI style
 * picks; a renderer never derives a figure of its own. Nothing here is a
 * balance: running balances come from `walkRunningBalances` alone, and these
 * only read them.
 *
 * A figure that sums rows names the currency it is in. One account's register
 * is one currency and sums in it; an all-accounts page can hold several, so
 * each row is converted into the reporting currency at the factor the server
 * stamped on it (`reportingRate`: its own rate, or the market rate on its own
 * date) before it is added. A row with no factor is left out and reported
 * (`ConvertedTotal`), never added in its own currency and never converted
 * here at today's rate.
 */

export interface RegisterStyleRow extends RunningBalanceRow {
  transactionDate: string;
  currencyCode: string;
  reportingCurrencyCode?: string;
  reportingRate?: number | null;
}

/** A sum of rows and the currency it is in. */
export interface RegisterFigure {
  total: ConvertedTotal;
  currency: string;
}

/** The signed amount a row contributes: the filtered split total when a filter narrowed it. */
export function rowAmount(
  row: { id: string; amount: number | string },
  displayAmounts: ReadonlyMap<string, number>,
): number {
  return displayAmounts.get(row.id) ?? Number(row.amount);
}

/** The currency rows sum in: the one they share, or the reporting currency when they are mixed. */
export function totalsCurrency(
  rows: readonly { currencyCode: string }[],
  reportingCurrency: string,
): string {
  const first = rows[0]?.currencyCode;
  if (!first) return reportingCurrency;
  return rows.every((row) => row.currencyCode === first) ? first : reportingCurrency;
}

/** The reporting currency the server stamped on the page, else the reader's default. */
export function pageReportingCurrency(
  rows: readonly { reportingCurrencyCode?: string }[],
  defaultCurrency: string,
): string {
  return rows.find((row) => row.reportingCurrencyCode)?.reportingCurrencyCode ?? defaultCurrency;
}

/**
 * A row's amount in `currency`: itself in its own currency, else at the
 * server's factor into that currency; `null` when the row carries none.
 */
function rowAmountIn(row: RegisterStyleRow, amount: number, currency: string): number | null {
  if (row.currencyCode === currency) return amount;
  if (row.reportingCurrencyCode !== currency) return null;
  const rate = row.reportingRate;
  return typeof rate === 'number' && Number.isFinite(rate) ? amount * rate : null;
}

/** Convert and sum `items` into `currency`. */
function sumInto(
  items: readonly { row: RegisterStyleRow; amount: number }[],
  currency: string,
): ConvertedTotal {
  return sumConverted(
    items,
    (item) => item.amount,
    (item) => item.row.currencyCode,
    (amount, _from, item) => rowAmountIn(item.row, amount, currency),
    moneyDecimalsForCurrency(currency),
  );
}

/** The net movement of each date on the page, for a date group's right-hand figure. */
export function netByDate(
  rows: readonly RegisterStyleRow[],
  displayAmounts: ReadonlyMap<string, number>,
  reportingCurrency: string,
): Map<string, RegisterFigure> {
  const byDate = new Map<string, { row: RegisterStyleRow; amount: number }[]>();
  for (const row of rows) {
    if (!rowAffectsBalance(row)) continue;
    const list = byDate.get(row.transactionDate) ?? [];
    list.push({ row, amount: rowAmount(row, displayAmounts) });
    byDate.set(row.transactionDate, list);
  }
  const net = new Map<string, RegisterFigure>();
  for (const [date, items] of byDate) {
    const currency = totalsCurrency(
      items.map((item) => item.row),
      reportingCurrency,
    );
    net.set(date, { total: sumInto(items, currency), currency });
  }
  return net;
}

/** What the page paid out and took in, and the difference, for the Folio footer. */
export function pageTotals(
  rows: readonly RegisterStyleRow[],
  displayAmounts: ReadonlyMap<string, number>,
  reportingCurrency: string,
): {
  currency: string;
  payments: ConvertedTotal;
  deposits: ConvertedTotal;
  net: ConvertedTotal;
  count: number;
} {
  const moving = rows.filter(rowAffectsBalance);
  const currency = totalsCurrency(moving, reportingCurrency);
  const out: { row: RegisterStyleRow; amount: number }[] = [];
  const into: { row: RegisterStyleRow; amount: number }[] = [];
  for (const row of moving) {
    const amount = rowAmount(row, displayAmounts);
    if (amount < 0) out.push({ row, amount: -amount });
    else into.push({ row, amount });
  }
  const payments = sumInto(out, currency);
  const deposits = sumInto(into, currency);
  const decimals = moneyDecimalsForCurrency(currency);
  return {
    currency,
    payments,
    deposits,
    net: combineTotals([deposits, payments], ([d, p]) => roundMoney(d - p, decimals)),
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
