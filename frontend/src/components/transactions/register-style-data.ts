import { rowAffectsBalance, type RunningBalanceRow } from '@/lib/running-balance';
import type { SortDirection } from '@/hooks/useSortableTable';
import { getDecimalPlacesForCurrency } from '@/lib/format';
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
    // Rounded once, at the places the register shows `currency` in.
    getDecimalPlacesForCurrency(currency),
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

/** Each date's closing balance, and the date whose close lies on another page. */
export interface DayClosingBalances {
  balances: Map<string, number>;
  /**
   * The page's newest date when a newer page exists: its last rows may sit on
   * that page, so the balance beside its newest row here can be a mid-day
   * one. It is withheld and named, never printed as the day's close.
   */
  continuedDate: string | null;
}

/**
 * The balance at the end of each date on the page, for the date group's
 * right-hand figure on a phone (issue #2486): the running balance beside the
 * date's newest row, which is the balance after everything that date moved.
 *
 * It reads `walkRunningBalances`' answer and never derives one. That walk runs
 * newest row first, so the newest row of a date is its first row on a
 * newest-first page and its last on an oldest-first one. A date whose newest
 * row has no balance is absent: unknown, never zero.
 *
 * A page is a slice of the register, and a date can straddle the break. Only
 * the page's NEWEST date can have rows past this page's newer edge (an older
 * date's later rows are all above it on this page), so when `hasNewerPage`
 * that date is reported in `continuedDate` instead of closed.
 */
export function balanceByDate(
  rows: readonly { id: string; transactionDate: string }[],
  runningBalances: ReadonlyMap<string, number>,
  direction: SortDirection,
  hasNewerPage = false,
): DayClosingBalances {
  const newestFirst = direction === 'asc' ? [...rows].reverse() : rows;
  const continuedDate = hasNewerPage ? (newestFirst[0]?.transactionDate ?? null) : null;
  const seen = new Set<string>();
  const balances = new Map<string, number>();
  for (const row of newestFirst) {
    if (seen.has(row.transactionDate)) continue;
    seen.add(row.transactionDate);
    if (row.transactionDate === continuedDate) continue;
    const balance = runningBalances.get(row.id);
    if (balance !== undefined) balances.set(row.transactionDate, balance);
  }
  return { balances, continuedDate };
}

/**
 * Whether the register holds rows newer than this page's newest: the page
 * before on a newest-first register, the page after on an oldest-first one.
 * An unpaged register has neither.
 */
export function hasNewerPage(
  direction: SortDirection,
  currentPage: number | undefined,
  totalPages: number | undefined,
): boolean {
  if (currentPage === undefined || totalPages === undefined) return false;
  return direction === 'asc' ? currentPage < totalPages : currentPage > 1;
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
  return {
    currency,
    payments,
    deposits,
    // The two sides' exact sums netted, then rounded once.
    net: combineTotals([deposits, payments], [1, -1]),
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

/**
 * One formatter per (locale, with year), built on first use: a register page
 * asks for a label per date group on every render, and an Intl formatter is
 * costly to construct. `null` records a locale the runtime refused.
 */
const groupLabelFormatters = new Map<string, Intl.DateTimeFormat | null>();

function groupLabelFormatter(locale: string | undefined, withYear: boolean): Intl.DateTimeFormat | null {
  const key = `${locale ?? ''}|${withYear ? 'y' : ''}`;
  let formatter = groupLabelFormatters.get(key);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat(locale, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        ...(withYear ? { year: 'numeric' } : {}),
        timeZone: 'UTC',
      });
    } catch {
      formatter = null;
    }
    groupLabelFormatters.set(key, formatter);
  }
  return formatter;
}

/** "Wednesday, November 11", in the reader's language; the year only when it is not this one. */
export function registerGroupLabel(date: string, locale: string | undefined, today: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const when = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  const formatter = groupLabelFormatter(locale, !sameYear);
  if (!formatter) return date;
  try {
    return formatter.format(when);
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
