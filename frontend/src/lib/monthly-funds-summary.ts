import { taggedBalance } from './tagged-balance';
import { findFundingBucket, fundingCompleteness } from './tagged-funding';
import { periodKeyOf, type BreakdownPeriod } from './breakdown-period';
import { sumMoney } from './format';
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
 * Expenses answer for the same window. Each month goes through `taggedBalance`,
 * the one Balance formula. A month the answer does not cover is unknown, never
 * 0; a month the chosen bucket has no row for had no tagged transfer, which is
 * a known zero. Under a gap (a missing rate) Balance is a subtotal and Balance %
 * is withheld.
 *
 * A yearly summary (`period` 'year', `months` holding `YYYY` keys) sums the
 * answer's months that fall in each year before the one Balance formula runs:
 * a year is known when the answer covers at least one of its months, and its
 * figures are those months' totals.
 */
export function monthlyFundsSummary(
  response: IncomeVsExpensesResponse,
  tagValue: string,
  months: readonly string[],
  period: BreakdownPeriod = 'month',
): MonthlyFundsSummary {
  const bucket = findFundingBucket(response, tagValue);
  const { complete, missingCurrencies } = fundingCompleteness(response, tagValue);

  const flowsByKey = new Map<string, { taggedInflows: number[]; taggedOutflows: number[] }>();
  for (const d of bucket?.data ?? []) {
    const key = periodKeyOf(d.period, period);
    const prev = flowsByKey.get(key) ?? { taggedInflows: [], taggedOutflows: [] };
    flowsByKey.set(key, {
      taggedInflows: [...prev.taggedInflows, d.taggedInflows],
      taggedOutflows: [...prev.taggedOutflows, d.taggedOutflows],
    });
  }
  const itemsByKey = new Map<string, { income: number[]; expenses: number[] }>();
  for (const d of response.data) {
    const key = periodKeyOf(d.period, period);
    const prev = itemsByKey.get(key) ?? { income: [], expenses: [] };
    itemsByKey.set(key, {
      income: [...prev.income, d.income],
      expenses: [...prev.expenses, d.expenses],
    });
  }

  const columns = months.map<MonthlyFundsColumn>((month) => {
    const parts = itemsByKey.get(month);
    if (!parts) {
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
    const income = sumMoney(parts.income);
    const expenses = sumMoney(parts.expenses);
    const taggedInflows = flows ? sumMoney(flows.taggedInflows) : 0;
    const taggedOutflows = flows ? sumMoney(flows.taggedOutflows) : 0;
    const { balance, balancePercent } = taggedBalance({
      income,
      expenses,
      taggedInflows,
      taggedOutflows,
    });
    return {
      month,
      known: true,
      income,
      taggedInflows,
      expenses,
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
