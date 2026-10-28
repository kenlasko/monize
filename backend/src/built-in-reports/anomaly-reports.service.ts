import { ReportingRead } from "../accruals/reporting-basis";
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Category } from "../categories/entities/category.entity";
import {
  ConversionGaps,
  ReportCurrencyService,
} from "./report-currency.service";
import { UserPreference } from "../users/entities/user-preference.entity";
import { NumberT, numberFormatterFor } from "../common/number-locale.util";
import {
  SpendingAnomaliesResponse,
  SpendingAnomaly,
  AnomalySeverity,
} from "./dto";
import { formatDateYMD } from "../common/date-utils";
import { roundMoney, sumMoney, toMoneyNumber } from "../common/round.util";
import { investmentExclusionSql } from "../common/investment-filter.util";

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

interface RawExpense {
  id: string;
  transaction_date: string | Date;
  original_currency_code?: string | null;
  exchange_rate?: number | string | null;
  payee_id: string | null;
  payee_name: string | null;
  currency_code: string;
  category_id: string | null;
  amount: string;
}

/** A raw expense with its amount already in the reporting currency. */
interface ConvertedExpense extends RawExpense {
  converted: number;
}

/** The z-score above which a transaction is unusual: the Reports page's default. */
export const SPENDING_ANOMALY_DEFAULT_THRESHOLD = 2;

/** Months of history the analysis reads unless a caller names a window. */
export const SPENDING_ANOMALY_DEFAULT_MONTHS = 6;

@Injectable()
export class AnomalyReportsService {
  constructor(
    private dataSource: DataSource,
    private currencyService: ReportCurrencyService,
  ) {}

  /**
   * @param threshold the z-score a transaction must exceed for its category.
   * @param months the window of history read, ending today. Two numbers of
   *   different meaning in adjacent positions: the AI and MCP adapters once
   *   passed the months as the threshold (audit A26-M34).
   */
  @ReportingRead("cash")
  async getSpendingAnomalies(
    userId: string,
    threshold: number = SPENDING_ANOMALY_DEFAULT_THRESHOLD,
    months: number = SPENDING_ANOMALY_DEFAULT_MONTHS,
  ): Promise<SpendingAnomaliesResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    // The anomaly descriptions are read by this user, so the figures in them
    // follow their number locale (issue #1316).
    const prefs = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    const n = numberFormatterFor(prefs?.numberFormat, prefs?.language);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    const now = new Date();
    const windowStart = new Date(now);
    windowStart.setMonth(windowStart.getMonth() - months);
    const startDate = formatDateYMD(windowStart);
    const endDate = formatDateYMD(now);

    const query = `
      SELECT
        t.id,
        TO_CHAR(t.transaction_date,'YYYY-MM-DD') AS transaction_date,
        t.original_currency_code,t.exchange_rate,
        t.payee_id,
        t.payee_name,
        t.currency_code,
        COALESCE(ts.category_id, t.category_id) as category_id,
        ABS(COALESCE(ts.amount, t.amount)) as amount
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date >= $2
        AND t.transaction_date <= $3
        AND COALESCE(ts.amount, t.amount) < 0
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION}
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
      ORDER BY t.transaction_date
    `;

    const rawResults: RawExpense[] = await withScopedDb(this.dataSource, (m) =>
      m.query(query, [userId, startDate, endDate]),
    );

    // A transaction with no rate into the reporting currency is unknown, never
    // its unconverted figure (INV-FX-001): it takes no part in the mean, the
    // z-scores, a category total or a payee total, and its currency is named.
    // Each row is converted once and the rest of the analysis reads only the
    // rows that converted.
    const gaps = new ConversionGaps();
    const converted: ConvertedExpense[] = [];
    for (const row of rawResults) {
      const amount = this.currencyService.tryConvertAmount(
        toMoneyNumber(row.amount),
        row.currency_code,
        defaultCurrency,
        rateMap,
        {
          conversion_date:
            row.transaction_date instanceof Date
              ? row.transaction_date.toISOString().slice(0, 10)
              : row.transaction_date,
          original_currency_code: row.original_currency_code,
          exchange_rate: row.exchange_rate,
        },
      );
      if (amount === null) {
        gaps.record(row.currency_code);
        continue;
      }
      converted.push({ ...row, converted: amount });
    }
    const gapFields = {
      currency: defaultCurrency,
      missingCurrencies: gaps.missingCurrencies,
      excludedCount: gaps.excludedCount,
    };

    if (converted.length < 10) {
      return {
        statistics: { mean: 0, stdDev: 0 },
        anomalies: [],
        counts: { high: 0, medium: 0, low: 0 },
        ...gapFields,
      };
    }

    const categories = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).find({
        where: { userId },
      }),
    );
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    const amounts = converted.map((r) => r.converted);
    const mean = sumMoney(amounts) / amounts.length;
    const variance =
      amounts.reduce((sum, a) => sum + Math.pow(a - mean, 2), 0) /
      amounts.length;
    const stdDev = Math.sqrt(variance);

    const anomalies: SpendingAnomaly[] = [];

    // 1. Large single transactions
    converted.forEach((row) => {
      const amount = row.converted;
      const zScore = (amount - mean) / stdDev;

      if (zScore > threshold) {
        const severity: AnomalySeverity =
          zScore > threshold * 2
            ? "high"
            : zScore > threshold * 1.5
              ? "medium"
              : "low";
        const txDate = new Date(row.transaction_date);
        anomalies.push({
          type: "large_transaction",
          severity,
          title: "Unusually large transaction",
          description: `${row.payee_name || "Unknown payee"} - ${txDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
          amount: roundMoney(amount),
          transactionId: row.id,
          transactionDate: row.transaction_date.toString().split("T")[0],
          payeeName: row.payee_name || undefined,
        });
      }
    });

    // 2. Category spending spikes (current month vs previous month)
    this.detectCategorySpikes(converted, now, categoryMap, anomalies, n);

    // 3. New payees with significant spending
    this.detectNewPayees(converted, now, anomalies);

    // Sort by severity and amount
    const severityOrder: Record<AnomalySeverity, number> = {
      high: 0,
      medium: 1,
      low: 2,
    };
    anomalies.sort((a, b) => {
      const severityDiff =
        severityOrder[a.severity] - severityOrder[b.severity];
      if (severityDiff !== 0) return severityDiff;
      return (b.amount || 0) - (a.amount || 0);
    });

    return {
      statistics: {
        mean: roundMoney(mean),
        stdDev: roundMoney(stdDev),
      },
      anomalies,
      counts: {
        high: anomalies.filter((a) => a.severity === "high").length,
        medium: anomalies.filter((a) => a.severity === "medium").length,
        low: anomalies.filter((a) => a.severity === "low").length,
      },
      ...gapFields,
    };
  }

  private detectCategorySpikes(
    rows: {
      transaction_date: string | Date;
      category_id: string | null;
      converted: number;
    }[],
    now: Date,
    categoryMap: Map<string, Category>,
    anomalies: SpendingAnomaly[],
    n: NumberT,
  ): void {
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

    const currentMonthByCategory = new Map<string, number>();
    const previousMonthByCategory = new Map<string, number>();

    rows.forEach((row) => {
      const txDate = new Date(row.transaction_date);
      const amount = row.converted;
      const categoryId = row.category_id || "uncategorized";

      if (txDate >= currentMonthStart) {
        currentMonthByCategory.set(
          categoryId,
          (currentMonthByCategory.get(categoryId) || 0) + amount,
        );
      } else if (txDate >= prevMonthStart && txDate <= prevMonthEnd) {
        previousMonthByCategory.set(
          categoryId,
          (previousMonthByCategory.get(categoryId) || 0) + amount,
        );
      }
    });

    currentMonthByCategory.forEach((currentAmount, categoryId) => {
      const previousAmount = previousMonthByCategory.get(categoryId) || 0;
      if (previousAmount < 50) return;

      const percentChange =
        ((currentAmount - previousAmount) / previousAmount) * 100;

      if (percentChange > 100) {
        const category =
          categoryId === "uncategorized" ? null : categoryMap.get(categoryId);
        const severity: AnomalySeverity =
          percentChange > 300 ? "high" : percentChange > 200 ? "medium" : "low";
        anomalies.push({
          type: "category_spike",
          severity,
          title: `Spending spike in ${category?.name || "Uncategorized"}`,
          description: `${n.formatPercent(Math.round(percentChange), 0)} increase from last month`,
          categoryId: categoryId === "uncategorized" ? undefined : categoryId,
          categoryName: category?.name || "Uncategorized",
          currentPeriodAmount: roundMoney(currentAmount),
          previousPeriodAmount: roundMoney(previousAmount),
          percentChange: Math.round(percentChange),
        });
      }
    });
  }

  private detectNewPayees(
    rows: {
      id: string;
      transaction_date: string | Date;
      payee_name: string | null;
      converted: number;
    }[],
    now: Date,
    anomalies: SpendingAnomaly[],
  ): void {
    const oneMonthAgo = new Date(now);
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    const payeeFirstSeen = new Map<string, Date>();
    const payeeRecentSpending = new Map<
      string,
      { name: string; total: number; count: number; txId: string }
    >();

    rows.forEach((row) => {
      const payeeName = (row.payee_name || "").toLowerCase().trim();
      if (!payeeName) return;

      const txDate = new Date(row.transaction_date);

      if (
        !payeeFirstSeen.has(payeeName) ||
        txDate < payeeFirstSeen.get(payeeName)!
      ) {
        payeeFirstSeen.set(payeeName, txDate);
      }

      if (txDate >= oneMonthAgo) {
        const existing = payeeRecentSpending.get(payeeName);
        if (existing) {
          existing.total += row.converted;
          existing.count++;
        } else {
          payeeRecentSpending.set(payeeName, {
            name: row.payee_name || "Unknown",
            total: row.converted,
            count: 1,
            txId: row.id,
          });
        }
      }
    });

    payeeFirstSeen.forEach((firstSeen, payeeName) => {
      if (firstSeen >= oneMonthAgo) {
        const recent = payeeRecentSpending.get(payeeName);
        if (recent && recent.total > 100) {
          const severity: AnomalySeverity =
            recent.total > 500 ? "high" : recent.total > 200 ? "medium" : "low";
          anomalies.push({
            type: "unusual_payee",
            severity,
            title: "New payee detected",
            description: `${recent.name} - ${recent.count} transaction(s)`,
            amount: roundMoney(recent.total),
            transactionId: recent.txId,
            payeeName: recent.name,
          });
        }
      }
    });
  }
}
