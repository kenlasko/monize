import { ReportingRead } from "../accruals/reporting-basis";
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Category } from "../categories/entities/category.entity";
import {
  ConversionGaps,
  ReportCurrencyService,
} from "./report-currency.service";
import { FxAggregate } from "../common/fx-aggregate";
import {
  TaxSummaryResponse,
  RecurringExpensesResponse,
  RecurringExpenseItem,
  BillPaymentHistoryResponse,
  BillPaymentItem,
  MonthlyBillTotal,
} from "./dto";
import {
  DEFAULT_RECURRING_EXPENSE_RANGE,
  type RecurringExpenseFrequency,
  type RecurringExpenseRange,
} from "./dto/recurring-expenses.dto";
import { formatDateYMD } from "../common/date-utils";
import { roundMoney, sumMoney, toMoneyNumber } from "../common/round.util";
import {
  investmentExclusionSql,
  reportableTransactionAmountSql,
} from "../common/investment-filter.util";

/**
 * Investment scope is LINKAGE, never account type (INV-REPORT-001, issue #1257):
 * the cash sleeve of an INVESTMENT account holds ordinary money, while the cash
 * leg a trade generated is not spending or income. Both halves of the predicate,
 * and why the account type cannot express either, live in
 * `common/investment-filter.util.ts`.
 */
const INVESTMENT_EXCLUSION = investmentExclusionSql({
  accountAlias: "a",
  transactionAlias: "t",
  splitAlias: "ts",
});
const INVESTMENT_EXCLUSION_NO_SPLITS = investmentExclusionSql({
  accountAlias: "a",
  transactionAlias: "t",
});

/**
 * Recurrence and bill matching read one row per payment and never join splits,
 * so the embedded investment or transfer part of a split parent comes out of the
 * amount rather than out of the row -- and the amount is derived once, not per
 * joined split line, so one payment stays one occurrence (branch audit
 * F-RPT-001).
 */
const REPORTABLE_TX_AMOUNT = reportableTransactionAmountSql("t");

/**
 * The same two halves of the predicate for the history subquery's own aliases
 * (`h`, `ha`), so the history start the recurring estimate is measured against
 * counts exactly the rows the analysis counts.
 */
const HISTORY_INVESTMENT_EXCLUSION_NO_SPLITS = investmentExclusionSql({
  accountAlias: "ha",
  transactionAlias: "h",
});
const HISTORY_REPORTABLE_TX_AMOUNT = reportableTransactionAmountSql("h");

/** Months each bounded recurring-expense window looks back. */
const RECURRING_RANGE_MONTHS: Record<
  Exclude<RecurringExpenseRange, "all">,
  number
> = {
  "6m": 6,
  "1y": 12,
  "2y": 24,
  "5y": 60,
};

/**
 * Payments per six months for each frequency label. The thresholds were set
 * for the original six-month window; a wider window scales them by its length,
 * so a monthly bill reads MONTHLY over five years too rather than WEEKLY.
 */
const FREQUENCY_PER_SIX_MONTHS: ReadonlyArray<
  [number, RecurringExpenseFrequency]
> = [
  [24, "WEEKLY"],
  [12, "BIWEEKLY"],
  [5, "MONTHLY"],
  [3, "OCCASIONAL"],
];

function classifyFrequency(
  occurrences: number,
  monthCount: number,
): RecurringExpenseFrequency {
  for (const [perSixMonths, frequency] of FREQUENCY_PER_SIX_MONTHS) {
    // occurrences / monthCount >= perSixMonths / 6, in integers.
    if (occurrences * 6 >= perSixMonths * monthCount) return frequency;
  }
  return "IRREGULAR";
}

const DAYS_PER_MONTH = 365.25 / 12;

/** Months from one YYYY-MM-DD date to another, to the nearest month, at least 1. */
function monthsBetween(startYmd: string, endYmd: string): number {
  const toUtc = (ymd: string) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const days = (toUtc(endYmd) - toUtc(startYmd)) / 86_400_000;
  return Math.max(1, Math.round(days / DAYS_PER_MONTH));
}

@Injectable()
export class TaxRecurringReportsService {
  constructor(
    private dataSource: DataSource,
    private currencyService: ReportCurrencyService,
  ) {}

  @ReportingRead("cash")
  async getTaxSummary(
    userId: string,
    year: number,
  ): Promise<TaxSummaryResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const query = `
      SELECT
        COALESCE(ts.category_id, t.category_id) as category_id,
        t.currency_code,
        COALESCE(ts.amount, t.amount) as amount
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date >= $2
        AND t.transaction_date <= $3
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION}
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
    `;

    interface RawTaxRow {
      category_id: string | null;
      currency_code: string;
      amount: string;
    }

    const rawResults: RawTaxRow[] = await withScopedDb(this.dataSource, (m) =>
      m.query(query, [userId, startDate, endDate]),
    );

    const categories = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).find({
        where: { userId },
      }),
    );
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    const taxDeductibleKeywords = [
      "medical",
      "health",
      "dental",
      "vision",
      "prescription",
      "pharmacy",
      "donation",
      "charity",
      "charitable",
      "education",
      "tuition",
      "school",
      "course",
      "training",
      "childcare",
      "daycare",
      "moving",
      "union",
      "professional dues",
      "rrsp",
      "retirement",
    ];

    const matchesKeywords = (name: string): boolean => {
      const lowerName = name.toLowerCase();
      return taxDeductibleKeywords.some((keyword) =>
        lowerName.includes(keyword),
      );
    };

    const incomeBySource = new Map<string, number>();
    const deductibleExpenses = new Map<string, number>();
    const allExpensesByCategory = new Map<string, number>();
    const totalIncome = new FxAggregate();
    const totalExpenses = new FxAggregate();
    // A row with no rate into the reporting currency is unknown, never its
    // unconverted figure (INV-FX-001): it is in no category list and no total,
    // and its currency is named. A tax figure is withheld rather than shown
    // short.
    const gaps = new ConversionGaps();

    rawResults.forEach((row) => {
      const amount = this.currencyService.tryConvertAmount(
        toMoneyNumber(row.amount),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      if (amount === null) {
        gaps.record(row.currency_code);
        return;
      }
      const category = row.category_id
        ? categoryMap.get(row.category_id)
        : null;
      const parentCategory = category?.parentId
        ? categoryMap.get(category.parentId)
        : null;
      const catName = parentCategory?.name || category?.name || "Uncategorized";

      if (amount > 0) {
        totalIncome.addConverted(amount);
        incomeBySource.set(
          catName,
          (incomeBySource.get(catName) || 0) + amount,
        );
      } else {
        const expenseAmt = Math.abs(amount);
        totalExpenses.addConverted(expenseAmt);
        allExpensesByCategory.set(
          catName,
          (allExpensesByCategory.get(catName) || 0) + expenseAmt,
        );

        if (matchesKeywords(catName)) {
          deductibleExpenses.set(
            catName,
            (deductibleExpenses.get(catName) || 0) + expenseAmt,
          );
        }
      }
    });

    const knownIncome = roundMoney(totalIncome.knownSubtotal);
    const knownExpenses = roundMoney(totalExpenses.knownSubtotal);
    const knownDeductible = roundMoney(
      sumMoney(Array.from(deductibleExpenses.values())),
    );

    return {
      incomeBySource: Array.from(incomeBySource.entries())
        .map(([name, total]) => ({
          name,
          total: roundMoney(total),
        }))
        .sort((a, b) => b.total - a.total),
      deductibleExpenses: Array.from(deductibleExpenses.entries())
        .map(([name, total]) => ({
          name,
          total: roundMoney(total),
        }))
        .sort((a, b) => b.total - a.total),
      allExpenses: Array.from(allExpensesByCategory.entries())
        .map(([name, total]) => ({
          name,
          total: roundMoney(total),
        }))
        .sort((a, b) => b.total - a.total),
      totals: {
        income: gaps.headline(knownIncome),
        expenses: gaps.headline(knownExpenses),
        deductible: gaps.headline(knownDeductible),
        knownIncome,
        knownExpenses,
        knownDeductible,
      },
      currency: defaultCurrency,
      missingCurrencies: gaps.missingCurrencies,
      excludedCount: gaps.excludedCount,
    };
  }

  @ReportingRead("cash")
  async getRecurringExpenses(
    userId: string,
    minOccurrences: number = 3,
    range: RecurringExpenseRange = DEFAULT_RECURRING_EXPENSE_RANGE,
  ): Promise<RecurringExpensesResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    const now = new Date();
    const endDate = formatDateYMD(now);
    // `all` has no lower bound: $2 is NULL and the predicate always holds.
    let startDate: string | null = null;
    if (range !== "all") {
      const windowStart = new Date(now);
      windowStart.setMonth(
        windowStart.getMonth() - RECURRING_RANGE_MONTHS[range],
      );
      startDate = formatDateYMD(windowStart);
    }

    const query = `
      SELECT
        t.payee_id,
        LOWER(TRIM(COALESCE(p.name, t.payee_name))) as payee_name_normalized,
        COALESCE(p.name, t.payee_name) as payee_name,
        c.name as category_name,
        t.currency_code,
        COUNT(*)::int as occurrences,
        SUM(ABS(${REPORTABLE_TX_AMOUNT})) as total_amount,
        MAX(t.transaction_date) as last_transaction_date,
        (
          SELECT TO_CHAR(MIN(h.transaction_date), 'YYYY-MM-DD')
          FROM transactions h
          LEFT JOIN accounts ha ON ha.id = h.account_id
          WHERE h.user_id = $1
            AND h.transaction_date <= $3
            AND ${HISTORY_REPORTABLE_TX_AMOUNT} < 0
            AND h.is_transfer = false
            AND (h.status IS NULL OR h.status != 'VOID')
            AND h.parent_transaction_id IS NULL
            AND ${HISTORY_INVESTMENT_EXCLUSION_NO_SPLITS}
        ) as history_start
      FROM transactions t
      LEFT JOIN payees p ON p.id = t.payee_id
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND ($2::date IS NULL OR t.transaction_date >= $2::date)
        AND t.transaction_date <= $3
        AND ${REPORTABLE_TX_AMOUNT} < 0
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION_NO_SPLITS}
        AND (COALESCE(p.name, t.payee_name) IS NOT NULL AND TRIM(COALESCE(p.name, t.payee_name)) != '')
      GROUP BY t.payee_id, LOWER(TRIM(COALESCE(p.name, t.payee_name))), COALESCE(p.name, t.payee_name), c.name, t.currency_code
      HAVING COUNT(*) >= $4
      ORDER BY total_amount DESC
    `;

    interface RawRecurring {
      payee_id: string | null;
      payee_name_normalized: string;
      payee_name: string;
      category_name: string | null;
      currency_code: string;
      occurrences: number;
      total_amount: string;
      last_transaction_date: Date;
      /** The user's first spending row on or before the end date. */
      history_start: string | null;
    }

    const rawResults: RawRecurring[] = await withScopedDb(
      this.dataSource,
      (m) => m.query(query, [userId, startDate, endDate, minOccurrences]),
    );

    const payeeMerged = new Map<
      string,
      {
        payeeName: string;
        payeeId: string | null;
        occurrences: number;
        totalAmount: number;
        lastTransactionDate: Date;
        categoryName: string | null;
      }
    >();

    // A row with no rate into the reporting currency is unknown, never its
    // unconverted figure (INV-FX-001): it is in no payee total and no summary,
    // and its currency is named. A payee that also paid in a converted currency
    // keeps that part only.
    const gaps = new ConversionGaps();

    for (const row of rawResults) {
      const totalAmount = this.currencyService.tryConvertAmount(
        toMoneyNumber(row.total_amount),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      if (totalAmount === null) {
        gaps.record(row.currency_code);
        continue;
      }
      const key = row.payee_name_normalized;
      const existing = payeeMerged.get(key);
      if (existing) {
        existing.occurrences += row.occurrences;
        existing.totalAmount += totalAmount;
        if (
          new Date(row.last_transaction_date) > existing.lastTransactionDate
        ) {
          existing.lastTransactionDate = new Date(row.last_transaction_date);
        }
      } else {
        payeeMerged.set(key, {
          payeeName: row.payee_name,
          payeeId: row.payee_id,
          occurrences: row.occurrences,
          totalAmount,
          lastTransactionDate: new Date(row.last_transaction_date),
          categoryName: row.category_name,
        });
      }
    }

    // The estimate is spread over the months the window actually holds: a
    // preset never claims more months than the user's spending history has
    // (five years over eight months of data would understate it sevenfold),
    // and `all` spans exactly that history.
    const historyStart = rawResults[0]?.history_start ?? null;
    const historyMonths =
      historyStart !== null ? monthsBetween(historyStart, endDate) : null;
    let monthCount: number;
    if (range === "all") {
      monthCount = historyMonths ?? 1;
    } else {
      monthCount = Math.min(
        RECURRING_RANGE_MONTHS[range],
        historyMonths ?? RECURRING_RANGE_MONTHS[range],
      );
    }

    const data: RecurringExpenseItem[] = Array.from(payeeMerged.values()).map(
      (row) => {
        const totalAmount = row.totalAmount;
        const occurrences = row.occurrences;
        const frequency = classifyFrequency(occurrences, monthCount);

        return {
          payeeName: row.payeeName,
          payeeId: row.payeeId,
          occurrences,
          totalAmount: roundMoney(totalAmount),
          averageAmount: roundMoney(totalAmount / occurrences),
          lastTransactionDate: formatDateYMD(row.lastTransactionDate),
          frequency,
          categoryName: row.categoryName,
        };
      },
    );

    const knownTotalRecurring = roundMoney(
      sumMoney(data.map((item) => item.totalAmount)),
    );
    const knownMonthlyEstimate = roundMoney(knownTotalRecurring / monthCount);

    return {
      data,
      summary: {
        totalRecurring: gaps.headline(knownTotalRecurring),
        knownTotalRecurring,
        monthlyEstimate: gaps.headline(knownMonthlyEstimate),
        knownMonthlyEstimate,
        monthCount,
        uniquePayees: data.length,
      },
      currency: defaultCurrency,
      missingCurrencies: gaps.missingCurrencies,
      excludedCount: gaps.excludedCount,
    };
  }

  @ReportingRead("cash")
  async getBillPaymentHistory(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<BillPaymentHistoryResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    const scheduledQuery = `
      SELECT
        st.id,
        st.name,
        st.amount,
        COALESCE(p.name, st.payee_name) as payee_name
      FROM scheduled_transactions st
      LEFT JOIN payees p ON p.id = st.payee_id
      WHERE st.user_id = $1
        AND st.is_transfer = false
    `;

    interface RawScheduled {
      id: string;
      name: string;
      amount: string;
      payee_name: string | null;
    }

    const scheduledTx: RawScheduled[] = await withScopedDb(
      this.dataSource,
      (m) => m.query(scheduledQuery, [userId]),
    );

    if (scheduledTx.length === 0) {
      return {
        billPayments: [],
        monthlyTotals: [],
        summary: {
          totalPaid: 0,
          knownTotalPaid: 0,
          totalPayments: 0,
          uniqueBills: 0,
          monthlyAverage: 0,
          knownMonthlyAverage: 0,
        },
        currency: defaultCurrency,
        missingCurrencies: [],
        excludedCount: 0,
      };
    }

    // Keyed by the NORMALIZED name (lowercased, trimmed) because that is what
    // the transaction query below matches on -- but the value keeps the name
    // as the user wrote it. The key is a match key, never a display value:
    // the report once showed the lowercased key as the payee.
    const payeeToScheduled = new Map<
      string,
      { id: string; name: string; payeeName: string; amount: number }
    >();
    scheduledTx.forEach((st) => {
      if (st.payee_name) {
        payeeToScheduled.set(st.payee_name.toLowerCase().trim(), {
          id: st.id,
          name: st.name,
          payeeName: st.payee_name,
          amount: Math.abs(toMoneyNumber(st.amount)),
        });
      }
    });

    let txQuery = `
      SELECT
        t.id,
        t.transaction_date,
        t.currency_code,
        ABS(${REPORTABLE_TX_AMOUNT}) as amount,
        LOWER(TRIM(COALESCE(p.name, t.payee_name))) as payee_name_normalized
      FROM transactions t
      LEFT JOIN payees p ON p.id = t.payee_id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION_NO_SPLITS}
        AND ${REPORTABLE_TX_AMOUNT} IS NOT NULL
    `;

    const params: (string | undefined)[] = [userId, endDate];

    if (startDate) {
      txQuery += ` AND t.transaction_date >= $3`;
      params.push(startDate);
    }

    interface RawTx {
      id: string;
      transaction_date: Date;
      currency_code: string;
      amount: string;
      payee_name_normalized: string | null;
    }

    const transactions: RawTx[] = await withScopedDb(this.dataSource, (m) =>
      m.query(txQuery, params),
    );

    const billPaymentMap = new Map<
      string,
      {
        id: string;
        name: string;
        payeeName: string;
        payments: { date: Date; amount: number }[];
      }
    >();

    // A payment with no rate into the reporting currency cannot be compared
    // with the bill's amount, so it is neither matched nor missed (INV-FX-001):
    // it is in no bill, month or total, and its currency is named. Only payments
    // to a scheduled payee are counted: any other is not in this report at all.
    const gaps = new ConversionGaps();

    transactions.forEach((tx) => {
      if (!tx.payee_name_normalized) return;
      const scheduled = payeeToScheduled.get(tx.payee_name_normalized);
      if (!scheduled) return;

      const txAmount = this.currencyService.tryConvertAmount(
        toMoneyNumber(tx.amount),
        tx.currency_code,
        defaultCurrency,
        rateMap,
      );
      if (txAmount === null) {
        gaps.record(tx.currency_code);
        return;
      }
      if (
        txAmount >= scheduled.amount * 0.8 &&
        txAmount <= scheduled.amount * 1.2
      ) {
        let payment = billPaymentMap.get(scheduled.id);
        if (!payment) {
          payment = {
            id: scheduled.id,
            name: scheduled.name,
            payeeName: scheduled.payeeName,
            payments: [],
          };
          billPaymentMap.set(scheduled.id, payment);
        }
        payment.payments.push({
          date: new Date(tx.transaction_date),
          amount: txAmount,
        });
      }
    });

    const billPayments: BillPaymentItem[] = Array.from(billPaymentMap.values())
      .filter((bp) => bp.payments.length > 0)
      .map((bp) => {
        const totalPaid = sumMoney(bp.payments.map((p) => p.amount));
        const sortedPayments = [...bp.payments].sort(
          (a, b) => b.date.getTime() - a.date.getTime(),
        );
        return {
          scheduledTransactionId: bp.id,
          scheduledTransactionName: bp.name,
          payeeName: bp.payeeName,
          totalPaid: roundMoney(totalPaid),
          paymentCount: bp.payments.length,
          averagePayment: roundMoney(totalPaid / bp.payments.length),
          lastPaymentDate: sortedPayments[0]
            ? formatDateYMD(sortedPayments[0].date)
            : null,
        };
      })
      .sort((a, b) => b.totalPaid - a.totalPaid);

    // The month is carried as a key only. It used to ship a
    // `toLocaleDateString("en-US", ...)` label beside it, which was English on
    // every locale; the one consumer builds its own localized label from the
    // key, so the label was dead payload waiting for the next consumer to
    // reach for the obvious field name.
    const monthlyMap = new Map<string, number>();
    billPaymentMap.forEach((bp) => {
      bp.payments.forEach((payment) => {
        const monthKey = payment.date.toISOString().slice(0, 7);
        monthlyMap.set(
          monthKey,
          (monthlyMap.get(monthKey) ?? 0) + payment.amount,
        );
      });
    });

    const monthlyTotals: MonthlyBillTotal[] = Array.from(monthlyMap.entries())
      .map(([month, total]) => ({
        month,
        total: roundMoney(total),
      }))
      .sort((a, b) => a.month.localeCompare(b.month));

    const knownTotalPaid = roundMoney(
      sumMoney(billPayments.map((bp) => bp.totalPaid)),
    );
    const totalPayments = billPayments.reduce(
      (sum, bp) => sum + bp.paymentCount,
      0,
    );
    const monthCount = monthlyTotals.length || 1;

    return {
      billPayments,
      monthlyTotals,
      summary: {
        totalPaid: gaps.headline(knownTotalPaid),
        knownTotalPaid,
        totalPayments,
        uniqueBills: billPayments.length,
        monthlyAverage: gaps.headline(roundMoney(knownTotalPaid / monthCount)),
        knownMonthlyAverage: roundMoney(knownTotalPaid / monthCount),
      },
      currency: defaultCurrency,
      missingCurrencies: gaps.missingCurrencies,
      excludedCount: gaps.excludedCount,
    };
  }
}
