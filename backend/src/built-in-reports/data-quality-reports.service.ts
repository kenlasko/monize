import { ReportingRead } from "../accruals/reporting-basis";
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import {
  ConversionGaps,
  ReportCurrencyService,
} from "./report-currency.service";
import { FxAggregate } from "../common/fx-aggregate";
import { roundMoney, sumMoney, toMoneyNumber } from "../common/round.util";
import {
  UncategorizedTransactionsResponse,
  UncategorizedTransactionItem,
  DuplicateTransactionsResponse,
  DuplicateGroup,
  DuplicateTransactionItem,
} from "./dto";
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
const INVESTMENT_EXCLUSION_NO_SPLITS = investmentExclusionSql({
  accountAlias: "a",
  transactionAlias: "t",
});

/**
 * "Uncategorized" means ordinary cash the user has not filed, so the figure is
 * the ordinary part of the row and a parent whose only lines are an embedded
 * investment or a transfer represents none: NULL, and the `IS NOT NULL`
 * predicate drops it (branch audit F-RPT-001). Without this a `-500` embedded
 * BUY passthrough was listed as money the user forgot to categorize.
 */
const REPORTABLE_TX_AMOUNT = reportableTransactionAmountSql("t");

@Injectable()
export class DataQualityReportsService {
  constructor(
    private dataSource: DataSource,
    private currencyService: ReportCurrencyService,
  ) {}

  @ReportingRead("cash")
  async getUncategorizedTransactions(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    limit: number = 500,
  ): Promise<UncategorizedTransactionsResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    let query = `
      SELECT
        t.id,
        t.transaction_date,
        t.currency_code,
        ${REPORTABLE_TX_AMOUNT} as amount,
        COALESCE(p.name, t.payee_name) as payee_name,
        t.description,
        a.name as account_name,
        t.account_id
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
        AND t.category_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM transaction_splits ts
          WHERE ts.transaction_id = t.id
          AND ts.category_id IS NOT NULL
        )
    `;

    const params: (string | number)[] = [userId, endDate];
    let paramIndex = 3;

    if (startDate) {
      query += ` AND t.transaction_date >= $${paramIndex}`;
      params.push(startDate);
      paramIndex++;
    }

    query += ` ORDER BY t.transaction_date DESC LIMIT $${paramIndex}`;
    params.push(limit);

    interface RawUncategorizedTx {
      id: string;
      transaction_date: string;
      currency_code: string;
      amount: string;
      payee_name: string | null;
      description: string | null;
      account_name: string | null;
      account_id: string;
    }

    const rows: RawUncategorizedTx[] = await withScopedDb(
      this.dataSource,
      (m) => m.query(query, params),
    );

    // The list is the work queue for filing these rows, so a row whose currency
    // has no rate stays on it. It keeps its ORIGINAL amount under its OWN
    // currency code: an unconverted amount under the reporting currency's name
    // is the defect INV-FX-001 forbids. The summary totals below leave it out.
    const transactions: UncategorizedTransactionItem[] = rows.map((row) => {
      const amount = toMoneyNumber(row.amount);
      const converted = this.currencyService.tryConvertAmount(
        amount,
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      // The amount and its label move together: either both converted, or
      // both the row's own.
      const shown =
        converted === null
          ? { amount, currencyCode: row.currency_code }
          : { amount: converted, currencyCode: defaultCurrency };
      return {
        id: row.id,
        transactionDate: new Date(row.transaction_date)
          .toISOString()
          .split("T")[0],
        ...shown,
        payeeName: row.payee_name,
        description: row.description,
        accountName: row.account_name,
        accountId: row.account_id,
      };
    });

    // The reportable amount is derived ONCE, in a CTE: six of these in one
    // aggregate is six correlated sub-queries per split parent, and the six
    // answers have to be the same number anyway.
    let summarySource = `
      SELECT
        t.currency_code,
        ${REPORTABLE_TX_AMOUNT} as amount
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION_NO_SPLITS}
        AND t.category_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM transaction_splits ts
          WHERE ts.transaction_id = t.id
          AND ts.category_id IS NOT NULL
        )
    `;

    const summaryParams: string[] = [userId, endDate];
    if (startDate) {
      summarySource += ` AND t.transaction_date >= $3`;
      summaryParams.push(startDate);
    }

    // `amount IS NOT NULL` is the same predicate the list applies: a row whose
    // only lines are an embedded investment or a transfer represents no ordinary
    // cash, so it is not something the user forgot to categorize.
    const summaryQuery = `
      WITH reportable AS (${summarySource})
      SELECT
        currency_code,
        COUNT(*) as total_count,
        COUNT(*) FILTER (WHERE amount < 0) as expense_count,
        COALESCE(SUM(ABS(amount)) FILTER (WHERE amount < 0), 0) as expense_total,
        COUNT(*) FILTER (WHERE amount > 0) as income_count,
        COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0) as income_total
      FROM reportable
      WHERE amount IS NOT NULL
      GROUP BY currency_code
    `;

    interface RawSummary {
      currency_code: string;
      total_count: string;
      expense_count: string;
      expense_total: string;
      income_count: string;
      income_total: string;
    }

    const summaryRows: RawSummary[] = await withScopedDb(this.dataSource, (m) =>
      m.query(summaryQuery, summaryParams),
    );

    let totalCount = 0;
    let expenseCount = 0;
    const expenseTotal = new FxAggregate();
    let incomeCount = 0;
    const incomeTotal = new FxAggregate();
    const gaps = new ConversionGaps();
    for (const row of summaryRows) {
      // A count needs no rate: a row in a currency with none still has to be
      // filed, so it is counted. Its amount is in no total.
      totalCount += parseInt(row.total_count, 10);
      expenseCount += parseInt(row.expense_count, 10);
      incomeCount += parseInt(row.income_count, 10);
      const expense = this.currencyService.tryConvertAmount(
        toMoneyNumber(row.expense_total),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const income = this.currencyService.tryConvertAmount(
        toMoneyNumber(row.income_total),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      if (expense === null || income === null) {
        gaps.record(row.currency_code);
        continue;
      }
      expenseTotal.addConverted(expense);
      incomeTotal.addConverted(income);
    }
    const knownExpenseTotal = roundMoney(expenseTotal.knownSubtotal);
    const knownIncomeTotal = roundMoney(incomeTotal.knownSubtotal);

    return {
      transactions,
      summary: {
        totalCount,
        expenseCount,
        expenseTotal: gaps.headline(knownExpenseTotal),
        knownExpenseTotal,
        incomeCount,
        incomeTotal: gaps.headline(knownIncomeTotal),
        knownIncomeTotal,
        currencyCode: defaultCurrency,
      },
      currency: defaultCurrency,
      missingCurrencies: gaps.missingCurrencies,
      excludedCount: gaps.excludedCount,
    };
  }

  @ReportingRead("cash")
  async getDuplicateTransactions(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    sensitivity: "high" | "medium" | "low" = "medium",
  ): Promise<DuplicateTransactionsResponse> {
    const maxDaysDiff =
      sensitivity === "high" ? 3 : sensitivity === "medium" ? 1 : 0;
    const checkPayee = sensitivity !== "low";

    const params: string[] = [userId, endDate];
    const paramIndex = 3;

    let dateFilter = `AND t.transaction_date <= $2`;
    if (startDate) {
      dateFilter = `AND t.transaction_date >= $${paramIndex} AND t.transaction_date <= $2`;
      params.push(startDate);
    }

    const query = `
      SELECT
        t.id,
        t.transaction_date,
        t.amount,
        COALESCE(p.name, t.payee_name) as payee_name,
        t.description,
        a.name as account_name
      FROM transactions t
      LEFT JOIN payees p ON p.id = t.payee_id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        ${dateFilter}
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        -- The cash leg of a trade is owned by its investment transaction and
        -- cannot be edited or deleted from the cash register, so offering two
        -- identical legs (two partial fills at one price) as duplicates points
        -- the user at a row they cannot act on here. Same exclusion as the rest
        -- of this service.
        AND ${INVESTMENT_EXCLUSION_NO_SPLITS}
        -- PARENT-IDENTITY REPORT: this detector's subject is the stored row, not
        -- its cash meaning, so it deliberately compares t.amount rather than the
        -- reportable ordinary amount every other query here derives (branch
        -- audit DR-001). A split parent the user entered twice IS a duplicate,
        -- and the remedy is deleting one whole transaction -- a per-child figure
        -- would name a row nobody can delete. Which is also why it needs no
        -- split-provenance clause: a row it admits is one the user owns.
      ORDER BY t.transaction_date ASC, t.amount ASC
    `;

    interface RawTx {
      id: string;
      transaction_date: string;
      amount: string;
      payee_name: string | null;
      description: string | null;
      account_name: string | null;
    }

    const rows: RawTx[] = await withScopedDb(this.dataSource, (m) =>
      m.query(query, params),
    );

    const transactions: DuplicateTransactionItem[] = rows.map((row) => ({
      id: row.id,
      transactionDate: new Date(row.transaction_date)
        .toISOString()
        .split("T")[0],
      amount: toMoneyNumber(row.amount),
      payeeName: row.payee_name,
      description: row.description,
      accountName: row.account_name,
    }));

    const groups: DuplicateGroup[] = [];
    const processed = new Set<string>();

    // Group transactions by amount in cents so we only compare transactions
    // that could actually be duplicates. Since the duplicate threshold is
    // 0.01, we bucket by Math.floor(amount * 100) and also check the
    // adjacent bucket (key + 1) to handle boundary cases. This reduces
    // comparisons from O(n^2) to O(n * k) where k is the group size.
    const amountBuckets = new Map<number, DuplicateTransactionItem[]>();
    for (const tx of transactions) {
      const key = Math.floor(tx.amount * 100);
      const bucket = amountBuckets.get(key);
      if (bucket) {
        bucket.push(tx);
      } else {
        amountBuckets.set(key, [tx]);
      }
    }

    // Build candidate sets: for each bucket, merge with adjacent bucket
    const visitedBucketKeys = new Set<number>();
    const candidateSets: DuplicateTransactionItem[][] = [];

    for (const [bucketKey] of amountBuckets) {
      if (visitedBucketKeys.has(bucketKey)) continue;
      visitedBucketKeys.add(bucketKey);

      const current = amountBuckets.get(bucketKey) || [];
      const adjacent = amountBuckets.get(bucketKey + 1) || [];

      if (current.length + adjacent.length < 2) continue;

      // Mark the adjacent bucket as visited so we don't process it again
      if (adjacent.length > 0) {
        visitedBucketKeys.add(bucketKey + 1);
      }

      candidateSets.push([...current, ...adjacent]);
    }

    for (const candidateGroup of candidateSets) {
      // Sort by date within each candidate group for the early-break optimisation
      candidateGroup.sort((a, b) =>
        a.transactionDate.localeCompare(b.transactionDate),
      );

      for (let i = 0; i < candidateGroup.length; i++) {
        const tx1 = candidateGroup[i];
        if (processed.has(tx1.id)) continue;

        const date1 = new Date(tx1.transactionDate);
        const payee1 = (tx1.payeeName || "").toLowerCase().trim();

        const matches: DuplicateTransactionItem[] = [tx1];

        for (let j = i + 1; j < candidateGroup.length; j++) {
          const tx2 = candidateGroup[j];
          if (processed.has(tx2.id)) continue;

          const date2 = new Date(tx2.transactionDate);
          const payee2 = (tx2.payeeName || "").toLowerCase().trim();

          const daysDiff = Math.abs(
            Math.floor(
              (date1.getTime() - date2.getTime()) / (1000 * 60 * 60 * 24),
            ),
          );
          if (daysDiff > maxDaysDiff) {
            if (daysDiff > 7) break;
            continue;
          }

          if (Math.abs(tx1.amount - tx2.amount) > 0.01) continue;

          if (checkPayee && payee1 && payee2 && payee1 !== payee2) continue;

          if (tx1.id === tx2.id) continue;

          matches.push(tx2);
        }

        if (matches.length > 1) {
          matches.forEach((m) => processed.add(m.id));

          const allSameDate = matches.every(
            (m) => m.transactionDate === matches[0].transactionDate,
          );
          const allSamePayee = matches.every(
            (m) =>
              (m.payeeName || "").toLowerCase().trim() ===
              (matches[0].payeeName || "").toLowerCase().trim(),
          );

          let confidence: "high" | "medium" | "low" = "low";
          let reason: string;

          if (allSameDate && allSamePayee) {
            confidence = "high";
            reason = "Same date, amount, and payee";
          } else if (allSameDate) {
            confidence = "medium";
            reason = "Same date and amount";
          } else if (allSamePayee) {
            confidence = "medium";
            reason = `Same payee and amount within ${maxDaysDiff} day(s)`;
          } else {
            reason = `Same amount within ${maxDaysDiff} day(s)`;
          }

          groups.push({
            key: `${matches[0].id}-${matches.length}`,
            transactions: matches,
            reason,
            confidence,
          });
        }
      }
    }

    const confidenceOrder: Record<string, number> = {
      high: 0,
      medium: 1,
      low: 2,
    };
    groups.sort((a, b) => {
      const confDiff =
        confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
      if (confDiff !== 0) return confDiff;
      return (
        Math.abs(b.transactions[0].amount) - Math.abs(a.transactions[0].amount)
      );
    });

    const high = groups.filter((g) => g.confidence === "high");
    const medium = groups.filter((g) => g.confidence === "medium");
    const low = groups.filter((g) => g.confidence === "low");

    const potentialSavings = sumMoney(
      groups.map((group) => {
        const duplicateCount = group.transactions.length - 1;
        return Math.abs(group.transactions[0].amount) * duplicateCount;
      }),
    );

    return {
      groups,
      summary: {
        totalGroups: groups.length,
        highCount: high.length,
        mediumCount: medium.length,
        lowCount: low.length,
        potentialSavings: roundMoney(potentialSavings),
      },
    };
  }
}
