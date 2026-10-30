import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { todayInTimezone } from "../../common/date-utils";
import { getEffectiveTimezoneOfUser } from "../../common/users-by-timezone.util";
import { Transaction } from "../../transactions/entities/transaction.entity";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { RecurringCharge } from "../../transactions/recurring-charges.util";
import { Category } from "../../categories/entities/category.entity";
import { FxAggregate } from "../../common/fx-aggregate";
import { roundMoney } from "../../common/round.util";
import { isNetSpending } from "../../built-in-reports/spending-reports.service";
import {
  buildRateIndex,
  convertAtDate,
} from "../../common/time-series/rate-index.util";

export interface CategorySpending {
  categoryName: string;
  categoryId: string | null;
  currentMonthTotal: number;
  previousMonthTotal: number;
  averageMonthlyTotal: number;
  monthCount: number;
  transactionCount: number;
}

export interface MonthlySpending {
  month: string;
  total: number;
  categoryBreakdown: Array<{
    categoryName: string;
    total: number;
  }>;
}

export { RecurringCharge };

export interface SpendingAggregates {
  categorySpending: CategorySpending[];
  monthlySpending: MonthlySpending[];
  recurringCharges: RecurringCharge[];
  totalSpendingCurrentMonth: number;
  totalSpendingPreviousMonth: number;
  averageMonthlySpending: number;
  daysElapsedInMonth: number;
  daysInMonth: number;
  currency: string;
  /**
   * False when a currency had no rate into `currency`: that spending is left
   * out of every figure. Read as `=== false`; the pairs are named beside it.
   */
  fxComplete: boolean;
  missingRatePairs: string[];
}

/** One (month, category, currency) net-spending row, as the query returns it. */
interface SpendingRow {
  month: string;
  categoryId: string;
  categoryName: string;
  currencyCode: string;
  net: string;
  txnCount: string;
}

/** First day of the month `delta` months from `ymd`'s month; pure string arithmetic. */
function firstOfMonthShifted(ymd: string, delta: number): string {
  const total = Number(ymd.slice(0, 4)) * 12 + (Number(ymd.slice(5, 7)) - 1);
  const shifted = total + delta;
  const year = Math.floor(shifted / 12);
  const month = (shifted % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

/** Days in the month of a `YYYY-MM-DD` string (UTC arithmetic on a zoneless date). */
function daysInMonthOf(ymd: string): number {
  return new Date(
    Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)), 0),
  ).getUTCDate();
}

@Injectable()
export class InsightsAggregatorService {
  private readonly logger = new Logger(InsightsAggregatorService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly transactionAnalytics: TransactionAnalyticsService,
  ) {}

  async computeAggregates(
    userId: string,
    currency: string,
  ): Promise<SpendingAggregates> {
    // The user's financial today (A26-L29), never a local-midnight Date read
    // back in UTC: the month a person is in follows their own zone.
    const today = await withScopedDb(this.dataSource, async (manager) => {
      const timezone = await getEffectiveTimezoneOfUser(manager, userId);
      return (todayInTimezone(timezone) ?? todayInTimezone("UTC")) as string;
    });
    const currentMonthStart = `${today.slice(0, 7)}-01`;
    const sixMonthsAgo = firstOfMonthShifted(currentMonthStart, -6);
    const previousMonthStart = firstOfMonthShifted(currentMonthStart, -1);

    const [spending, recurringCharges] = await Promise.all([
      this.getSpending(
        userId,
        sixMonthsAgo,
        today,
        currency,
        currentMonthStart.substring(0, 7),
        previousMonthStart.substring(0, 7),
      ),
      this.transactionAnalytics.getRecurringCharges(
        userId,
        sixMonthsAgo,
        today,
      ),
    ]);
    const { categorySpending, monthlySpending, missingRatePairs } = spending;

    const currentMonth = monthlySpending.find(
      (m) => m.month === currentMonthStart.substring(0, 7),
    );
    const previousMonthKey = previousMonthStart.substring(0, 7);
    const previousMonth = monthlySpending.find(
      (m) => m.month === previousMonthKey,
    );

    const totalSpendingCurrentMonth = currentMonth?.total ?? 0;
    const totalSpendingPreviousMonth = previousMonth?.total ?? 0;

    const completedMonths = monthlySpending.filter(
      (m) => m.month !== currentMonthStart.substring(0, 7),
    );
    const averageMonthlySpending =
      completedMonths.length > 0
        ? completedMonths.reduce((sum, m) => sum + m.total, 0) /
          completedMonths.length
        : 0;

    const daysElapsedInMonth = Number(today.slice(8, 10));
    const daysInMonth = daysInMonthOf(today);

    return {
      categorySpending,
      monthlySpending,
      recurringCharges,
      totalSpendingCurrentMonth,
      totalSpendingPreviousMonth,
      averageMonthlySpending,
      daysElapsedInMonth,
      daysInMonth,
      currency,
      fxComplete: missingRatePairs.length === 0,
      missingRatePairs,
    };
  }

  /**
   * Spending per category and per month, read once. A split line is spent in
   * its own category, so the category and amount come from the split when the
   * row has one (the parent's `amount` is the sum of its lines). Spending is
   * the debits net of the credits filed against the category, converted into
   * `currency` at the rate for the row's month; a category that nets to a
   * credit over the window is income, not spending, and is left out.
   */
  private async getSpending(
    userId: string,
    startDate: string,
    endDate: string,
    currency: string,
    currentMonth: string,
    previousMonth: string,
  ): Promise<{
    categorySpending: CategorySpending[];
    monthlySpending: MonthlySpending[];
    missingRatePairs: string[];
  }> {
    const rows: SpendingRow[] = await withScopedDb(this.dataSource, (manager) =>
      manager
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .leftJoin("t.splits", "ts")
        .innerJoin(
          Category,
          "cat",
          "cat.id = COALESCE(ts.categoryId, t.categoryId)",
        )
        .select("TO_CHAR(t.transactionDate, 'YYYY-MM')", "month")
        .addSelect("cat.id", "categoryId")
        .addSelect("cat.name", "categoryName")
        .addSelect("t.currencyCode", "currencyCode")
        .addSelect("SUM(-COALESCE(ts.amount, t.amount))", "net")
        .addSelect("COUNT(DISTINCT t.id)", "txnCount")
        .where("t.userId = :userId", { userId })
        .andWhere("t.transactionDate >= :startDate", { startDate })
        .andWhere("t.transactionDate <= :endDate", { endDate })
        .andWhere("COALESCE(ts.amount, t.amount) <> 0")
        .andWhere("t.status != 'VOID'")
        .andWhere("t.isTransfer = false")
        .andWhere("t.parentTransactionId IS NULL")
        .andWhere("(ts.transferAccountId IS NULL OR ts.id IS NULL)")
        .groupBy("TO_CHAR(t.transactionDate, 'YYYY-MM')")
        .addGroupBy("cat.id")
        .addGroupBy("cat.name")
        .addGroupBy("t.currencyCode")
        .getRawMany(),
    );

    const foreign = new Set(
      rows.map((r) => r.currencyCode).filter((c) => c !== currency),
    );
    const rateIndex =
      foreign.size === 0
        ? new Map()
        : await withScopedDb(this.dataSource, (manager) =>
            buildRateIndex(
              (sql, params) => manager.query(sql, params),
              foreign,
              currency,
              startDate,
              endDate,
            ),
          );

    const categories = new Map<
      string,
      {
        name: string;
        txnCount: number;
        byMonth: Map<string, FxAggregate>;
      }
    >();
    for (const r of rows) {
      const cat = categories.get(r.categoryId) ?? {
        name: r.categoryName,
        txnCount: 0,
        byMonth: new Map<string, FxAggregate>(),
      };
      categories.set(r.categoryId, cat);
      const agg = cat.byMonth.get(r.month) ?? new FxAggregate();
      cat.byMonth.set(r.month, agg);
      cat.txnCount += Number(r.txnCount) || 0;
      const net = Number(r.net) || 0;
      if (r.currencyCode === currency || net === 0) {
        agg.addConverted(net);
      } else {
        const [y, m] = r.month.split("-").map(Number);
        const monthEnd = new Date(Date.UTC(y, m, 0))
          .toISOString()
          .substring(0, 10);
        agg.add(
          convertAtDate(net, r.currencyCode, currency, monthEnd, rateIndex),
          r.currencyCode,
          currency,
        );
      }
    }

    const missing = new Set<string>();
    const categorySpending: CategorySpending[] = [];
    const months = new Map<
      string,
      {
        total: number;
        breakdown: Array<{ categoryName: string; total: number }>;
      }
    >();
    for (const [categoryId, cat] of categories) {
      let overall = 0;
      for (const agg of cat.byMonth.values()) {
        overall += agg.knownSubtotal;
        for (const pair of agg.missingPairs) missing.add(pair);
      }
      if (!isNetSpending(roundMoney(overall))) continue;

      const monthCount = cat.byMonth.size;
      categorySpending.push({
        categoryName: cat.name,
        categoryId,
        currentMonthTotal: cat.byMonth.get(currentMonth)?.knownSubtotal ?? 0,
        previousMonthTotal: cat.byMonth.get(previousMonth)?.knownSubtotal ?? 0,
        averageMonthlyTotal: monthCount > 0 ? overall / monthCount : 0,
        monthCount,
        transactionCount: cat.txnCount,
      });
      for (const [month, agg] of cat.byMonth) {
        const entry = months.get(month) ?? { total: 0, breakdown: [] };
        months.set(month, entry);
        entry.total += agg.knownSubtotal;
        entry.breakdown.push({
          categoryName: cat.name,
          total: agg.knownSubtotal,
        });
      }
    }
    categorySpending.sort(
      (a, b) =>
        b.averageMonthlyTotal * b.monthCount -
        a.averageMonthlyTotal * a.monthCount,
    );

    const monthlySpending: MonthlySpending[] = [...months.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({
        month,
        total: roundMoney(data.total),
        categoryBreakdown: data.breakdown.sort((a, b) => b.total - a.total),
      }));

    return {
      categorySpending,
      monthlySpending,
      missingRatePairs: [...missing].sort(),
    };
  }
}
