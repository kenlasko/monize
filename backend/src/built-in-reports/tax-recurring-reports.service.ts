import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Category } from "../categories/entities/category.entity";
import {
  ConversionGaps,
  RATE_BASIS_GROUP_BY,
  RawRateBasis,
  ReportCurrencyService,
  wholeGroups,
  rateBasisColumnsSql,
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
import { isNetSpending } from "./spending-reports.service";
import { formatDateYMD } from "../common/date-utils";
import {
  MONEY_SCALE,
  roundMoney,
  sumMoney,
  toMoneyNumber,
} from "../common/round.util";
import {
  investmentExclusionSql,
  investmentLinkedSplitExclusion,
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
 * A split parent's ordinary lines as JSON (`[{ categoryId, amount }]`), so an
 * estimated bill can be matched on the line in its category, as its estimate
 * reads it (issue #2096). NULL for a plain row.
 */
const SPLIT_CATEGORY_LINES = `CASE WHEN t.is_split = true THEN (
          SELECT json_agg(json_build_object('categoryId', bl.category_id, 'amount', bl.amount))
            FROM transaction_splits bl
           WHERE bl.transaction_id = t.id
             AND bl.transfer_account_id IS NULL
             AND ${investmentLinkedSplitExclusion("bl")}
        ) END`;

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

  async getTaxSummary(
    userId: string,
    year: number,
  ): Promise<TaxSummaryResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);

    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const query = `
      SELECT
        COALESCE(ts.category_id, t.category_id) as category_id,
        t.currency_code,
        ${rateBasisColumnsSql("$4")},
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

    interface RawTaxRow extends RawRateBasis {
      category_id: string | null;
      amount: string;
    }

    const rawResults: RawTaxRow[] = await withScopedDb(this.dataSource, (m) =>
      m.query(query, [userId, startDate, endDate, defaultCurrency]),
    );
    const convert = await this.currencyService.buildConverter(
      rawResults,
      defaultCurrency,
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
    // Netted per actual category (NULL kept apart by sign: it has no
    // direction), so an income child and an expense child under one parent do
    // not cancel; the display name only groups the classified results.
    const netByCategory = new Map<
      string,
      { name: string; leafName: string; net: number }
    >();

    rawResults.forEach((row) => {
      const amount = convert(
        // An aggregate in the row's own currency, read before conversion: a coin's
        // sum keeps its stored 8 places (MONEY_SCALE, lossless; a fiat figure reads
        // the same), so a 2,500-sat total is not rounded to zero before it is
        // converted (INV-MONEY-001).
        toMoneyNumber(row.amount, MONEY_SCALE),
        row,
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

      // Signed, so a refund lowers its category rather than reading as income
      // (INV-REPORT-004).
      const key =
        row.category_id ?? (amount < 0 ? "null:spend" : "null:income");
      netByCategory.set(key, {
        name: catName,
        leafName: category?.name ?? catName,
        net: roundMoney((netByCategory.get(key)?.net ?? 0) + amount),
      });
    });

    // A category is classified once, by its net: spending when its debits
    // exceed its credits (`isNetSpending`), income when its credits do.
    const addTo = (map: Map<string, number>, name: string, value: number) =>
      map.set(name, roundMoney((map.get(name) ?? 0) + value));
    netByCategory.forEach(({ name: catName, leafName, net: rawNet }) => {
      const net = roundMoney(rawNet);
      if (isNetSpending(-net)) {
        totalExpenses.addConverted(-net);
        addTo(allExpensesByCategory, catName, -net);
        if (matchesKeywords(catName) || matchesKeywords(leafName))
          addTo(deductibleExpenses, catName, -net);
      } else if (net > 0) {
        totalIncome.addConverted(net);
        addTo(incomeBySource, catName, net);
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

  async getRecurringExpenses(
    userId: string,
    minOccurrences: number = 3,
    range: RecurringExpenseRange = DEFAULT_RECURRING_EXPENSE_RANGE,
  ): Promise<RecurringExpensesResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);

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

    // A foreign group is split by the day it was struck on so each part
    // converts at that day's rate; the occurrence threshold is still judged
    // over the whole (payee, category, currency) group, by the window sum.
    const query = `
      SELECT * FROM (
      SELECT
        t.payee_id,
        LOWER(TRIM(COALESCE(p.name, t.payee_name))) as payee_name_normalized,
        COALESCE(p.name, t.payee_name) as payee_name,
        c.name as category_name,
        t.currency_code,
        ${rateBasisColumnsSql("$5")},
        COUNT(*)::int as occurrences,
        SUM(COUNT(*)) OVER (
          PARTITION BY t.payee_id, LOWER(TRIM(COALESCE(p.name, t.payee_name))), COALESCE(p.name, t.payee_name), c.name, t.currency_code
        ) as group_occurrences,
        -- The whole group's total, so the payee's rows arrive in the order its
        -- groups always did and the first one seen names it.
        SUM(SUM(ABS(${REPORTABLE_TX_AMOUNT}))) OVER (
          PARTITION BY t.payee_id, LOWER(TRIM(COALESCE(p.name, t.payee_name))), COALESCE(p.name, t.payee_name), c.name, t.currency_code
        ) as group_total,
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
      GROUP BY t.payee_id, LOWER(TRIM(COALESCE(p.name, t.payee_name))), COALESCE(p.name, t.payee_name), c.name, t.currency_code, ${RATE_BASIS_GROUP_BY}
      ) grouped
      WHERE grouped.group_occurrences >= $4
      ORDER BY grouped.group_total DESC, grouped.total_amount DESC
    `;

    interface RawRecurring extends RawRateBasis {
      payee_id: string | null;
      payee_name_normalized: string;
      payee_name: string;
      category_name: string | null;
      occurrences: number;
      total_amount: string;
      last_transaction_date: Date;
      /** The user's first spending row on or before the end date. */
      history_start: string | null;
    }

    const rawResults: RawRecurring[] = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(query, [
          userId,
          startDate,
          endDate,
          minOccurrences,
          defaultCurrency,
        ]),
    );
    const convert = wholeGroups(
      rawResults,
      await this.currencyService.buildConverter(rawResults, defaultCurrency),
      (row) =>
        `${row.payee_id ?? ""}|${row.payee_name_normalized}|${row.payee_name}|${row.category_name ?? ""}|${row.currency_code}`,
      (row) => [toMoneyNumber(row.total_amount, MONEY_SCALE)],
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
      const totalAmount = convert(
        toMoneyNumber(row.total_amount, MONEY_SCALE),
        row,
      );
      if (totalAmount === null) {
        gaps.record(
          row.currency_code,
          `${row.payee_id ?? ""}|${row.payee_name_normalized}|${row.payee_name}|${row.category_name ?? ""}|${row.currency_code}`,
        );
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

    const data: RecurringExpenseItem[] = Array.from(payeeMerged.values())
      .map((row) => {
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
      })
      // Largest first, by the merged total: a foreign payee arrives as one
      // part per day it was paid on (issue #2106), so the statement's order of
      // parts no longer ranks the payees.
      .sort((a, b) => b.totalAmount - a.totalAmount);

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

  async getBillPaymentHistory(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<BillPaymentHistoryResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);

    const scheduledQuery = `
      SELECT
        st.id,
        st.name,
        st.amount,
        st.amount_is_estimated,
        st.category_id,
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
      amount_is_estimated: boolean;
      category_id: string | null;
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
      {
        id: string;
        name: string;
        payeeName: string;
        amount: number;
        estimated: boolean;
        categoryId: string | null;
        /**
         * The bill's direction, -1 or 1, from its snapshot; null while the
         * snapshot is zero (an estimate saved before any history), when no
         * direction is assumed.
         */
        sign: number | null;
      }
    >();
    scheduledTx.forEach((st) => {
      if (st.payee_name) {
        payeeToScheduled.set(st.payee_name.toLowerCase().trim(), {
          id: st.id,
          name: st.name,
          payeeName: st.payee_name,
          amount: Math.abs(toMoneyNumber(st.amount, MONEY_SCALE)),
          estimated: st.amount_is_estimated === true,
          categoryId: st.category_id,
          sign: Math.sign(toMoneyNumber(st.amount, MONEY_SCALE)) || null,
        });
      }
    });

    let txQuery = `
      SELECT
        t.id,
        t.transaction_date,
        t.currency_code,
        ${rateBasisColumnsSql("$3")},
        ABS(${REPORTABLE_TX_AMOUNT}) as amount,
        SIGN(${REPORTABLE_TX_AMOUNT}) as amount_sign,
        t.category_id,
        ${SPLIT_CATEGORY_LINES} as split_lines,
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

    const params: (string | undefined)[] = [userId, endDate, defaultCurrency];

    if (startDate) {
      txQuery += ` AND t.transaction_date >= $4`;
      params.push(startDate);
    }

    interface RawTx extends RawRateBasis {
      id: string;
      transaction_date: Date;
      amount: string;
      amount_sign: string;
      category_id: string | null;
      split_lines:
        { categoryId: string | null; amount: string | number }[] | null;
      payee_name_normalized: string | null;
    }

    const transactions: RawTx[] = await withScopedDb(this.dataSource, (m) =>
      m.query(txQuery, params),
    );
    const convert = await this.currencyService.buildConverter(
      transactions,
      defaultCurrency,
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

      // An estimated bill (issue #2096) varies by month by design, so its
      // stored snapshot is no band to match a payment against. Its payments
      // are the ones its estimate reads: to its payee, in its category (the
      // row's, or a split's line in it), in its direction -- not a refund from
      // the biller, nor another purchase there.
      let paidAmount = toMoneyNumber(tx.amount, MONEY_SCALE);
      if (scheduled.estimated) {
        let signed = Number(tx.amount_sign) * paidAmount;
        if (tx.category_id !== scheduled.categoryId) {
          const lines = (tx.split_lines ?? []).filter(
            (line) => line.categoryId === scheduled.categoryId,
          );
          if (lines.length === 0) return;
          signed = sumMoney(
            lines.map((line) => toMoneyNumber(line.amount, MONEY_SCALE)),
            MONEY_SCALE,
          );
        }
        if (scheduled.sign !== null && Math.sign(signed) !== scheduled.sign) {
          return;
        }
        paidAmount = Math.abs(signed);
      }

      const txAmount = convert(paidAmount, tx);
      if (txAmount === null) {
        gaps.record(tx.currency_code);
        return;
      }
      const matches =
        scheduled.estimated ||
        (txAmount >= scheduled.amount * 0.8 &&
          txAmount <= scheduled.amount * 1.2);
      if (matches) {
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
