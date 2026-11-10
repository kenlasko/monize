import { EntityManager } from "typeorm";
import { addDaysYMD } from "../common/date-utils";
import { returnedRows } from "../common/db/query-result";
import { MONEY_DECIMALS, roundMoney } from "../common/round.util";
import { PayrollDeductionRule } from "./entities/payroll-deduction-rule.entity";
import {
  CATEGORY_DEDUCTION_ROWS_SQL,
  remainingRoom,
} from "./payroll-deduction-cap";
import {
  anniversaryInYear,
  DeductionPeriod,
  deductionPeriod,
} from "./payroll-deduction-period";
import {
  figuresForPeriod,
  RuleWithPeriods,
} from "./payroll-deduction-rule-periods";

/**
 * The payroll deductions report (docs/specs/payroll-deductions.md section 10):
 * per ruled category, the selected year's period summarised, paycheque by
 * paycheque, and every period the ledger holds. Every figure is a sum over
 * `CATEGORY_DEDUCTION_ROWS_SQL`, the rows the cap's paid figure sums, so the
 * report's current period agrees with the Payroll Deductions page and with
 * what the next posting caps against (INV-PAYROLL-003).
 */

/**
 * The years the report answers for, a year being the one a period starts
 * in. The query DTO accepts only these, so every year the report offers
 * (`availableYears`, the history) stays inside them: a transaction date has
 * no such bound, and a mistyped year 9999 row would otherwise put a year on
 * the picker the route refuses, and walk thousands of empty periods.
 */
export const PAYROLL_REPORT_MIN_YEAR = 1900;
export const PAYROLL_REPORT_MAX_YEAR = 2100;

/** The window the report reads: the whole ledger inside the reportable years. */
export const REPORT_EARLIEST_DATE = `${PAYROLL_REPORT_MIN_YEAR}-01-01`;
export const REPORT_LATEST_DATE = `${PAYROLL_REPORT_MAX_YEAR}-12-31`;

/** One period's collected total for one category, in its currency. */
export interface PayrollReportPeriodTotal {
  periodStart: string;
  periodEnd: string;
  /** The negation of the signed sum of the category's rows in the currency. */
  paidToDate: number;
  /** Rows of the category in the period in another currency, not converted. */
  foreignCurrencyRows: number;
  /** Transactions with a row of the category in the currency. */
  paycheques: number;
  /** `paidToDate` over `paycheques`; `null` when no paycheque deducted. */
  averagePerPaycheque: number | null;
  /** Whether the period contains today, so its total is still growing. */
  isCurrent: boolean;
}

/** The selected year's period with the rule's ceiling beside it. */
export interface PayrollReportCategorySummary extends PayrollReportPeriodTotal {
  /**
   * The lowest maximum among the category's rules for this period, which is
   * the one that binds. `null` for a closed period a rule recorded no figure
   * for (docs/specs/payroll-deductions.md section 11).
   */
  yearlyMaximum: number | null;
  /** Room left under `yearlyMaximum`; `null` whenever the maximum is. */
  remaining: number | null;
  /** `paidToDate` as a percentage of a positive maximum, else `null`. */
  percentOfMaximum: number | null;
  /** The date of the paycheque that brought the total to the maximum. */
  maximumReachedOn: string | null;
}

/** One ruled category and currency, as every bill that caps it shares it. */
export interface PayrollReportCategory {
  /** `categoryId|currencyCode`, the key `PayrollReportPaycheque.amounts` uses. */
  key: string;
  categoryId: string;
  categoryName: string;
  currencyCode: string;
  /** The anchor the periods are anniversaries of (the earliest rule's). */
  resetDate: string;
  billNames: string[];
  summary: PayrollReportCategorySummary;
  /** Every period from the latest with a row back to the earliest, newest first. */
  history: PayrollReportPeriodTotal[];
}

/** One transaction that deducted to a ruled category in the selected year. */
export interface PayrollReportPaycheque {
  transactionId: string;
  transactionDate: string;
  payeeName: string | null;
  currencyCode: string;
  /** Deducted magnitude by category key; a category it did not deduct is absent. */
  amounts: Record<string, number>;
  /** The row's amounts added up, in `currencyCode`. */
  total: number;
}

/** `GET /payroll-deductions/report?year=`. */
export interface PayrollDeductionReport {
  year: number;
  /** Every year a category's period starts in, the current year and `year`, newest first. */
  availableYears: number[];
  categories: PayrollReportCategory[];
  /** The selected year's paycheques, oldest first. */
  paycheques: PayrollReportPaycheque[];
  /**
   * What every category collected in the selected year, added up, in
   * `totalCurrencyCode`. `null` when the categories are in more than one
   * currency: amounts in different currencies are not added together.
   */
  total: number | null;
  totalCurrencyCode: string | null;
}

/** One transaction's rows of one category, summed. */
export interface DeductionTransaction {
  transactionId: string;
  transactionDate: string;
  payeeName: string | null;
  currencyCode: string;
  /** The magnitude deducted: the negation of the transaction's signed rows. */
  deducted: number;
}

/** What a group of rules on one category and currency needs to be reported. */
export interface PayrollReportGroup {
  categoryId: string;
  categoryName: string;
  currencyCode: string;
  resetDate: string;
  billNames: string[];
  /** Every rule on the category, whose figures per period the summary reads. */
  rules: RuleWithPeriods[];
}

const SCALE = 10 ** MONEY_DECIMALS;

function toUnits(value: number): number {
  return Math.round(value * SCALE);
}

function fromUnits(units: number): number {
  return roundMoney(units / SCALE);
}

function yearOf(ymd: string): number {
  return Number(ymd.slice(0, 4));
}

/**
 * The rules grouped by category and currency, in rule order: two paycheques
 * deducting to one category share one row, as paid is category-wide. Where
 * their maxima differ the lower binds, as in the page's year-to-date table
 * and the forecast's pooled room; the periods follow the earliest rule's
 * reset date, as `GET /payroll-deductions/history` does.
 */
export function groupReportRules(
  rules: readonly PayrollDeductionRule[],
): PayrollReportGroup[] {
  const groups = new Map<string, PayrollReportGroup>();
  for (const rule of rules) {
    const currencyCode = rule.scheduledTransaction?.currencyCode ?? "";
    const key = `${rule.categoryId}|${currencyCode}`;
    const billName = rule.scheduledTransaction?.name ?? "";
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        categoryId: rule.categoryId,
        categoryName: rule.category?.name ?? "",
        currencyCode,
        resetDate: rule.resetDate,
        billNames: [billName],
        rules: [rule],
      });
      continue;
    }
    if (!group.billNames.includes(billName)) group.billNames.push(billName);
    group.rules.push(rule);
  }
  return Array.from(groups.values());
}

/** Every transaction with a row of the category, any currency, oldest first. */
export async function queryDeductionTransactions(
  m: EntityManager,
  userId: string,
  categoryId: string,
): Promise<DeductionTransaction[]> {
  const rows = returnedRows<{
    transaction_id: string;
    transaction_date: string;
    payee_name: string | null;
    currency_code: string;
    amount: string;
  }>(
    await m.query(
      `SELECT x.transaction_id,
              TO_CHAR(x.transaction_date, 'YYYY-MM-DD') AS transaction_date,
              x.payee_name,
              x.currency_code,
              SUM(x.amount) AS amount
         FROM (${CATEGORY_DEDUCTION_ROWS_SQL}) x
        GROUP BY x.transaction_id, x.transaction_date, x.payee_name, x.currency_code
        ORDER BY x.transaction_date, MIN(x.created_at), x.transaction_id`,
      [userId, categoryId, REPORT_EARLIEST_DATE, REPORT_LATEST_DATE],
    ),
  );
  return rows.map((row) => ({
    transactionId: row.transaction_id,
    transactionDate: row.transaction_date,
    payeeName: row.payee_name,
    currencyCode: row.currency_code,
    deducted: roundMoney(-Number(row.amount)),
  }));
}

interface PeriodAccumulator {
  periodStart: string;
  periodEnd: string;
  units: number;
  foreignCurrencyRows: number;
  paycheques: number;
}

function periodTotal(
  acc: PeriodAccumulator,
  today: string,
): PayrollReportPeriodTotal {
  const paidToDate = fromUnits(acc.units);
  return {
    periodStart: acc.periodStart,
    periodEnd: acc.periodEnd,
    paidToDate,
    foreignCurrencyRows: acc.foreignCurrencyRows,
    paycheques: acc.paycheques,
    averagePerPaycheque:
      acc.paycheques > 0 ? fromUnits(acc.units / acc.paycheques) : null,
    isCurrent: acc.periodStart <= today && today <= acc.periodEnd,
  };
}

/** The period of `resetDate` that starts in `year`. */
export function periodStartingIn(
  resetDate: string,
  year: number,
): DeductionPeriod {
  return deductionPeriod(resetDate, anniversaryInYear(resetDate, year));
}

/**
 * One category's report from its transactions: the period starting in
 * `year` with the ceiling beside it when that period has not closed, every
 * period from the latest holding a row (or the current one, if later) back
 * to the earliest, and the selected period's transactions in the category's
 * currency for the paycheque table.
 */
export function summariseReportCategory(
  group: PayrollReportGroup,
  transactions: readonly DeductionTransaction[],
  year: number,
  today: string,
): { category: PayrollReportCategory; selected: DeductionTransaction[] } {
  const byPeriod = new Map<string, PeriodAccumulator>();
  const accumulator = (date: string): PeriodAccumulator => {
    const period = deductionPeriod(group.resetDate, date);
    let acc = byPeriod.get(period.periodStart);
    if (!acc) {
      acc = {
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        units: 0,
        foreignCurrencyRows: 0,
        paycheques: 0,
      };
      byPeriod.set(period.periodStart, acc);
    }
    return acc;
  };

  const selectedPeriod = periodStartingIn(group.resetDate, year);
  const selected: DeductionTransaction[] = [];
  let earliest = today;
  let latest = today;
  for (const tx of transactions) {
    const acc = accumulator(tx.transactionDate);
    if (tx.transactionDate < earliest) earliest = tx.transactionDate;
    if (tx.transactionDate > latest) latest = tx.transactionDate;
    if (tx.currencyCode !== group.currencyCode) {
      acc.foreignCurrencyRows += 1;
      continue;
    }
    acc.units += toUnits(tx.deducted);
    acc.paycheques += 1;
    if (acc.periodStart === selectedPeriod.periodStart) selected.push(tx);
  }

  const history: PayrollReportPeriodTotal[] = [];
  const firstStart = deductionPeriod(group.resetDate, earliest).periodStart;
  let period = deductionPeriod(group.resetDate, latest);
  // A row early in the first reportable year can fall in a period that
  // started the year before (a mid-year reset); that period is not offered.
  while (
    period.periodStart >= firstStart &&
    yearOf(period.periodStart) >= PAYROLL_REPORT_MIN_YEAR
  ) {
    history.push(
      periodTotal(
        byPeriod.get(period.periodStart) ?? {
          ...period,
          units: 0,
          foreignCurrencyRows: 0,
          paycheques: 0,
        },
        today,
      ),
    );
    period = deductionPeriod(
      group.resetDate,
      addDaysYMD(period.periodStart, -1),
    );
  }

  const base = periodTotal(
    byPeriod.get(selectedPeriod.periodStart) ?? {
      ...selectedPeriod,
      units: 0,
      foreignCurrencyRows: 0,
      paycheques: 0,
    },
    today,
  );
  // Each period reads its own figures, the lowest maximum binding (spec
  // section 11). A closed period shows one only when every rule recorded a
  // figure for it: the rule's columns hold today's figure, not that year's.
  const figures = group.rules.map((r) =>
    figuresForPeriod(r, selectedPeriod.periodStart),
  );
  const closed = selectedPeriod.periodEnd < today;
  const yearlyMaximum =
    figures.length === 0 || (closed && figures.some((f) => !f.recorded))
      ? null
      : Math.min(...figures.map((f) => f.yearlyMaximum));
  let maximumReachedOn: string | null = null;
  if (yearlyMaximum !== null && yearlyMaximum > 0) {
    let units = 0;
    for (const tx of selected) {
      units += toUnits(tx.deducted);
      if (units >= toUnits(yearlyMaximum)) {
        maximumReachedOn = tx.transactionDate;
        break;
      }
    }
  }
  return {
    category: {
      key: `${group.categoryId}|${group.currencyCode}`,
      categoryId: group.categoryId,
      categoryName: group.categoryName,
      currencyCode: group.currencyCode,
      resetDate: group.resetDate,
      billNames: [...group.billNames],
      summary: {
        ...base,
        yearlyMaximum,
        remaining:
          yearlyMaximum === null
            ? null
            : remainingRoom(yearlyMaximum, base.paidToDate),
        percentOfMaximum:
          yearlyMaximum !== null && yearlyMaximum > 0
            ? roundMoney((base.paidToDate / yearlyMaximum) * 100)
            : null,
        maximumReachedOn,
      },
      history,
    },
    selected,
  };
}

/**
 * The report from each group and its transactions: categories by name, the
 * selected year's paycheques merged across categories by transaction, oldest
 * first (the order the rows came in, which is the ledger's date order).
 */
export function assemblePayrollReport(
  entries: readonly {
    group: PayrollReportGroup;
    transactions: readonly DeductionTransaction[];
  }[],
  year: number,
  today: string,
): PayrollDeductionReport {
  const categories: PayrollReportCategory[] = [];
  const paycheques = new Map<
    string,
    PayrollReportPaycheque & { units: number; order: number }
  >();
  for (const { group, transactions } of entries) {
    const { category, selected } = summariseReportCategory(
      group,
      transactions,
      year,
      today,
    );
    categories.push(category);
    for (const tx of selected) {
      let row = paycheques.get(tx.transactionId);
      if (!row) {
        row = {
          transactionId: tx.transactionId,
          transactionDate: tx.transactionDate,
          payeeName: tx.payeeName,
          currencyCode: tx.currencyCode,
          amounts: {},
          total: 0,
          units: 0,
          order: paycheques.size,
        };
        paycheques.set(tx.transactionId, row);
      }
      row.amounts[category.key] = tx.deducted;
      row.units += toUnits(tx.deducted);
    }
  }
  categories.sort(
    (a, b) =>
      a.categoryName.localeCompare(b.categoryName) ||
      a.currencyCode.localeCompare(b.currencyCode),
  );

  const currencies = new Set(categories.map((c) => c.currencyCode));
  const single = currencies.size <= 1;
  const years = new Set<number>([yearOf(today), year]);
  for (const category of categories) {
    for (const period of category.history)
      years.add(yearOf(period.periodStart));
  }
  return {
    year,
    availableYears: Array.from(years).sort((a, b) => b - a),
    categories,
    paycheques: Array.from(paycheques.values())
      .sort(
        (a, b) =>
          a.transactionDate.localeCompare(b.transactionDate) ||
          a.order - b.order,
      )
      .map((row) => ({
        transactionId: row.transactionId,
        transactionDate: row.transactionDate,
        payeeName: row.payeeName,
        currencyCode: row.currencyCode,
        amounts: row.amounts,
        total: fromUnits(row.units),
      })),
    total: single
      ? fromUnits(
          categories.reduce((sum, c) => sum + toUnits(c.summary.paidToDate), 0),
        )
      : null,
    totalCurrencyCode: single ? (categories[0]?.currencyCode ?? null) : null,
  };
}
