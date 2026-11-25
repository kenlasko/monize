import { taggedBalance } from './tagged-balance';
import { findFundingBucket, fundingCompleteness } from './tagged-funding';
import type { IncomeVsExpensesResponse } from '@/types/built-in-reports';

export interface MonthlyFundsColumn {
  /** The column key: `YYYY-MM`, or `YYYY` in a yearly summary. */
  month: string;
  /** False when the funding answer has no row for the month: every figure is unknown. */
  known: boolean;
  income: number | null;
  taggedInflows: number | null;
  expenses: number | null;
  taggedOutflows: number | null;
  balance: number | null;
  balancePercent: number | null;
}

export interface MonthlyFundsSummary {
  columns: MonthlyFundsColumn[];
  /** Any shown month moved tagged money out: only then is the row worth a line. */
  showOutflows: boolean;
  /** False when a missing rate left a figure out: Balance is a subtotal. */
  complete: boolean;
  missingCurrencies: string[];
}

/**
 * The per-month Balance block under the Monthly Breakdown table
 * (`docs/specs/report-tag-key-breakdown.md` section 11.5), from the Income vs
 * Expenses answer for the same window, asked for in the table's own period
 * (`bucket` month or year). Every figure is the server's: each period's
 * income, expenses and tagged flows, and its Balance and Balance %, which the
 * server folds from the four aggregates before it reads them. Built here from
 * the four readings, or a year from its twelve months' readings, a Balance sat
 * a unit off (issue #2413); a backend that predates the server's Balance gets
 * `taggedBalance` over the readings. A column the answer does not cover is
 * unknown, never 0; a period the chosen bucket has no row for had no tagged
 * transfer, which is a known zero. Under a gap (a missing rate) Balance is a
 * subtotal and Balance % is withheld.
 */
export function monthlyFundsSummary(
  response: IncomeVsExpensesResponse,
  tagValue: string,
  months: readonly string[],
): MonthlyFundsSummary {
  const bucket = findFundingBucket(response, tagValue);
  const { complete, missingCurrencies } = fundingCompleteness(response, tagValue);

  const flowsByKey = new Map((bucket?.data ?? []).map((d) => [d.period, d]));
  const itemsByKey = new Map(response.data.map((d) => [d.period, d]));

  const columns = months.map<MonthlyFundsColumn>((month) => {
    const item = itemsByKey.get(month);
    if (!item) {
      return {
        month,
        known: false,
        income: null,
        taggedInflows: null,
        expenses: null,
        taggedOutflows: null,
        balance: null,
        balancePercent: null,
      };
    }
    const flows = flowsByKey.get(month);
    const taggedInflows = flows?.taggedInflows ?? 0;
    const taggedOutflows = flows?.taggedOutflows ?? 0;
    const served = flows?.balance !== undefined;
    const fallback = taggedBalance({
      income: item.income,
      expenses: item.expenses,
      taggedInflows,
      taggedOutflows,
    });
    const balance = served ? flows.balance! : fallback.balance;
    const balancePercent = served ? (flows.balancePercent ?? null) : fallback.balancePercent;
    return {
      month,
      known: true,
      income: item.income,
      taggedInflows,
      expenses: item.expenses,
      taggedOutflows,
      balance,
      balancePercent: complete ? balancePercent : null,
    };
  });

  return {
    columns,
    showOutflows: columns.some((c) => c.taggedOutflows !== null && c.taggedOutflows !== 0),
    complete,
    missingCurrencies,
  };
}
