import { GroupedTotal, TransactionSummary } from '@/types/transaction';

/**
 * The active Transactions-page filters a payee/category info widget must
 * honour so its stats reconcile with the list and the chart. Deliberately
 * excludes the widget's own entity id -- each widget injects that itself.
 */
export interface WidgetFilterParams {
  accountIds?: string[];
  startDate?: string;
  endDate?: string;
  tagIds?: string[];
  search?: string;
  amountFrom?: number;
  amountTo?: number;
}

export interface DisplayCurrencyStrategy {
  /** The currency every widget figure is rendered in. */
  displayCurrency: string;
  /**
   * True when the result spans several currencies, so every figure is the
   * server's conversion into `displayCurrency` (each row at its own settled
   * rate or the market rate on its own date, issue #2106). Converting a
   * lifetime total at today's rate on the client read a currency's move as a
   * change in what the category cost.
   */
  converted: boolean;
}

/**
 * Pick the widget's display currency from a summary's per-currency buckets:
 * a single-currency result renders natively, a multi-currency result reads
 * the server's conversion into the reporting currency (naively summing across
 * currencies would produce a meaningless figure).
 */
export function buildDisplayCurrencyStrategy(
  summary: TransactionSummary | null,
  defaultCurrency: string,
): DisplayCurrencyStrategy {
  const currencies = Object.keys(summary?.byCurrency ?? {});
  if (currencies.length === 1) {
    return { displayCurrency: currencies[0], converted: false };
  }
  return {
    displayCurrency: summary?.converted?.currency ?? defaultCurrency,
    converted: true,
  };
}

/**
 * One row's figure in the display currency: its own total when the result is
 * single-currency, otherwise the server's `convertedTotal`, or `null` when the
 * server had no rate for it (or sent no conversion). Never the row's own amount
 * under another currency's symbol.
 */
export function inDisplayCurrency(
  strategy: DisplayCurrencyStrategy,
  row: { total: number; convertedTotal?: number | null },
): number | null {
  return strategy.converted ? (row.convertedTotal ?? null) : row.total;
}

/** Headline figures reduced to the display currency. */
export function summarizeInDisplayCurrency(
  summary: TransactionSummary,
  strategy: DisplayCurrencyStrategy,
): {
  income: number;
  expenses: number;
  net: number;
  missingCurrencies: string[];
  /**
   * Transactions whose currency converted, so they contribute to income/expenses.
   * The denominator for an average, so it stays over the transactions the figure
   * actually sums rather than the full count (which includes excluded ones).
   */
  includedTransactionCount: number;
  /**
   * Transactions dropped because their currency has no rate. The component count
   * a partial-total marker reports -- the number of amounts left out, not the
   * number of distinct currencies.
   */
  excludedTransactionCount: number;
} {
  const buckets = Object.entries(summary.byCurrency ?? {});
  if (!strategy.converted || buckets.length <= 1) {
    return {
      income: summary.totalIncome,
      expenses: summary.totalExpenses,
      net: summary.netCashFlow,
      missingCurrencies: [],
      includedTransactionCount: summary.transactionCount,
      excludedTransactionCount: 0,
    };
  }
  // The server's conversion. A bucket with no rate is excluded and named, so
  // the caller can label the figures as partial rather than presenting a short
  // total as the whole; with no conversion at all, every bucket is unknown.
  const converted = summary.converted;
  if (!converted) {
    return {
      income: 0,
      expenses: 0,
      net: 0,
      missingCurrencies: buckets.map(([currency]) => currency).sort(),
      includedTransactionCount: 0,
      excludedTransactionCount: summary.transactionCount,
    };
  }
  return {
    income: converted.knownIncome,
    expenses: converted.knownExpenses,
    net: converted.knownIncome - converted.knownExpenses,
    missingCurrencies: converted.missingCurrencies,
    includedTransactionCount: converted.includedTransactionCount,
    excludedTransactionCount: converted.excludedTransactionCount,
  };
}

/**
 * The single headline figure for a summary scoped to one category: what it
 * cost (an expense category) or what it brought in (an income category), net
 * of the movements filed against it in the other direction.
 *
 * `totalExpenses` alone is the gross debit total, and a credit filed against
 * an expense category -- a refund, a return, a chargeback -- is a debit that
 * came back. Reporting the gross puts a figure on screen that disagrees with
 * the register's own balance for the same filter, which is issue #1125. Both
 * halves come from the same summary, so the netting is within one category and
 * never across two.
 *
 * Only for a surface that shows ONE figure. `PayeeInfoWidget` prints the
 * credits it received on their own line beside the spend, and netting them
 * into the headline there would count them twice.
 */
export function netEntityTotal(
  totals: { income: number; expenses: number },
  isIncome: boolean,
): number {
  return isIncome ? totals.income - totals.expenses : totals.expenses - totals.income;
}

export interface AggregatedGroupRow {
  id: string | null;
  name: string | null;
  /**
   * Total in the display currency, or `null` when one of the rows making it up
   * had no rate. A row whose total cannot be worked out is shown as unknown, not
   * as the sum of the parts that happened to convert.
   */
  total: number | null;
  count: number;
}

/**
 * Collapse per-currency grouped rows into one row per entity id, with
 * totals converted to the display currency. Sorted by absolute total,
 * largest first.
 */
export function aggregateGroupedTotals(
  rows: GroupedTotal[],
  strategy: DisplayCurrencyStrategy,
): AggregatedGroupRow[] {
  const byId = new Map<string | null, AggregatedGroupRow>();
  for (const row of rows) {
    const existing = byId.get(row.id);
    const converted = inDisplayCurrency(strategy, row);
    if (existing) {
      byId.set(row.id, {
        ...existing,
        name: existing.name ?? row.name,
        // Unknown wins: once a currency in this row could not be converted, the
        // row's total is unknown however many others did convert.
        total:
          existing.total === null || converted === null
            ? null
            : existing.total + converted,
        count: existing.count + row.count,
      });
    } else {
      byId.set(row.id, {
        id: row.id,
        name: row.name,
        total: converted,
        count: row.count,
      });
    }
  }
  // Unknown totals sort last: they are not "small", they are unranked.
  return [...byId.values()].sort((a, b) => {
    if (a.total === null && b.total === null) return 0;
    if (a.total === null) return 1;
    if (b.total === null) return -1;
    return Math.abs(b.total) - Math.abs(a.total);
  });
}
