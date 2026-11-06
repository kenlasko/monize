import { FIAT_MONEY_DECIMALS, roundToDecimals, sumMoney } from './format';

/**
 * Every figure here is a report's, converted to the reporting currency, and a
 * coin is never the reporting currency (`docs/specs/money-precision.md`
 * decision 3), so the sums are at the fiat four places, stated rather than
 * defaulted.
 */
const REPORTING_MONEY_DECIMALS = FIAT_MONEY_DECIMALS;

/**
 * The Balance view of the income reports
 * (`docs/specs/report-tag-key-breakdown.md` section 10.9).
 *
 * Balance is the money that came in minus the money that went out of the chosen
 * scope, counting the tagged transfers that crossed its boundary:
 *
 *   balance        = income + taggedInflows - expenses - taggedOutflows
 *   balancePercent = balance / (income + taggedInflows) * 100
 *
 * It is a figure of its own and never written back into `income`, `expenses` or
 * `net`: a tagged transfer is still not income (INV-REPORT-003). Every surface
 * that shows a Balance (chart, tooltip, cards, table, CSV) reads it here, so no
 * component restates the formula.
 */
export type BalanceAmount = number | null | undefined;

export interface TaggedBalanceInput {
  income: BalanceAmount;
  expenses: BalanceAmount;
  taggedInflows: BalanceAmount;
  taggedOutflows: BalanceAmount;
}

export interface TaggedBalance {
  /** Null when an input is unknown. */
  balance: number | null;
  /** Two decimals; null when the balance is unknown or nothing came in. */
  balancePercent: number | null;
}

const UNKNOWN: TaggedBalance = { balance: null, balancePercent: null };

const isKnown = (value: BalanceAmount): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Sums in integer units (`sumMoney`) and divides once. The percentage is over
 * what came in; when that is not positive there is no base to divide by, so it
 * is unknown rather than 0 or infinite.
 */
export function taggedBalance(input: TaggedBalanceInput): TaggedBalance {
  const { income, expenses, taggedInflows, taggedOutflows } = input;
  if (
    !isKnown(income) ||
    !isKnown(expenses) ||
    !isKnown(taggedInflows) ||
    !isKnown(taggedOutflows)
  ) {
    return UNKNOWN;
  }
  const received = sumMoney([income, taggedInflows], REPORTING_MONEY_DECIMALS);
  const balance = sumMoney([received, -expenses, -taggedOutflows], REPORTING_MONEY_DECIMALS) || 0;
  const balancePercent =
    received > 0 ? roundToDecimals((balance / received) * 100, 2) : null;
  return { balance, balancePercent };
}

export interface BalanceCompleteness {
  missingCurrencies: string[];
  excludedCount: number;
}

export interface TaggedBalanceWindow extends TaggedBalance, BalanceCompleteness {
  /** True only when every component of the figure is known. */
  complete: boolean;
}

/**
 * The window's Balance. The known amounts give the subtotal; the figure is a
 * total only when the All totals are known AND the active bucket is complete
 * (`docs/financial-calculation-contract.md` s.1.3). Otherwise `complete` is
 * false, the percentage is withheld (a rate over a subtotal says nothing), and
 * the combined completeness is what `PartialTotal` names.
 */
export function taggedBalanceWindow(
  amounts: TaggedBalanceInput,
  allTotalsKnown: boolean,
  all: BalanceCompleteness,
  bucket: BalanceCompleteness,
): TaggedBalanceWindow {
  const missingCurrencies = [...new Set([...all.missingCurrencies, ...bucket.missingCurrencies])];
  const excludedFromParts = all.excludedCount + bucket.excludedCount;
  const complete =
    allTotalsKnown && missingCurrencies.length === 0 && excludedFromParts === 0;
  const excludedCount =
    !complete && excludedFromParts === 0 && missingCurrencies.length === 0
      ? 1
      : excludedFromParts;
  const { balance, balancePercent } = taggedBalance(amounts);
  return {
    balance,
    balancePercent: complete ? balancePercent : null,
    complete,
    missingCurrencies,
    excludedCount,
  };
}

/**
 * One period's chart/table fields in the Balance view. The period's own income
 * and expenses go through `taggedBalance`; a period the active bucket has no
 * row for had no tagged transfer in it, which is a known zero. Balance is
 * rounded to whole units like the other chart series, the percentage keeps its
 * two decimals.
 */
export function periodBalanceFields(
  period: { income: number; expenses: number },
  flows: { taggedInflows: number; taggedOutflows: number } | undefined,
): { Balance?: number; BalancePercent: number | null } {
  const { balance, balancePercent } = taggedBalance({
    income: period.income,
    expenses: period.expenses,
    taggedInflows: flows ? flows.taggedInflows : 0,
    taggedOutflows: flows ? flows.taggedOutflows : 0,
  });
  return {
    ...(balance === null ? {} : { Balance: Math.round(balance) }),
    BalancePercent: balancePercent,
  };
}

export interface TaggedFundsInput {
  income: BalanceAmount;
  taggedInflows: BalanceAmount;
  taggedOutflows: BalanceAmount;
}

export interface TaggedFunds {
  /** What crossed the scope boundary under the value: inflows minus outflows. Null when unknown. */
  netTagged: number | null;
  /** `income + netTagged`; null when an input is unknown. */
  availableFunds: number | null;
}

/**
 * The funding figure of the other reports
 * (`docs/specs/report-tag-key-breakdown.md` section 11.1): the money available
 * to spend over a window or a month, the regular income plus what the tagged
 * transfers brought across the scope boundary.
 *
 *   netTagged      = taggedInflows - taggedOutflows
 *   availableFunds = income + netTagged
 *
 * Integer units (`sumMoney`), no division. A figure of its own: never written
 * into `income` or any category or budget total (INV-REPORT-003).
 */
export function taggedFunds(input: TaggedFundsInput): TaggedFunds {
  const { income, taggedInflows, taggedOutflows } = input;
  if (!isKnown(taggedInflows) || !isKnown(taggedOutflows)) {
    return { netTagged: null, availableFunds: null };
  }
  const netTagged = sumMoney([taggedInflows, -taggedOutflows], REPORTING_MONEY_DECIMALS) || 0;
  if (!isKnown(income)) return { netTagged, availableFunds: null };
  return { netTagged, availableFunds: sumMoney([income, netTagged], REPORTING_MONEY_DECIMALS) || 0 };
}
