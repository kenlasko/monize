import { ReportingRead } from "../accruals/reporting-basis";
import { reportingQuery } from "../accruals/reporting-query";
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Category } from "../categories/entities/category.entity";
import {
  ConversionGaps,
  ReportCurrencyService,
} from "./report-currency.service";
import { FxAggregate } from "../common/fx-aggregate";
import { roundMoney, sumMoney, toMoneyNumber } from "../common/round.util";
import {
  YearOverYearResponse,
  YearData,
  WeekendVsWeekdayResponse,
  DaySpending,
  CategoryWeekendWeekday,
} from "./dto";
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

@Injectable()
export class ComparisonReportsService {
  constructor(
    private dataSource: DataSource,
    private currencyService: ReportCurrencyService,
  ) {}

  @ReportingRead()
  async getYearOverYear(
    userId: string,
    yearsToCompare: number,
  ): Promise<YearOverYearResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    const currentYear = new Date().getFullYear();
    const oldestYear = currentYear - yearsToCompare + 1;

    const query = `
      SELECT
        EXTRACT(YEAR FROM t.transaction_date)::int as year,
        EXTRACT(MONTH FROM t.transaction_date)::int as month,
        t.currency_code, TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS conversion_date, t.original_currency_code, t.exchange_rate,
        SUM(CASE WHEN COALESCE(ts.amount, t.amount) > 0 THEN COALESCE(ts.amount, t.amount) ELSE 0 END) as income,
        SUM(CASE WHEN COALESCE(ts.amount, t.amount) < 0 THEN ABS(COALESCE(ts.amount, t.amount)) ELSE 0 END) as expenses
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND EXTRACT(YEAR FROM t.transaction_date) >= $2
        AND EXTRACT(YEAR FROM t.transaction_date) <= $3
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION}
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
      GROUP BY EXTRACT(YEAR FROM t.transaction_date), EXTRACT(MONTH FROM t.transaction_date), t.currency_code, t.transaction_date, t.original_currency_code, t.exchange_rate, t.id, ts.id
      ORDER BY year, month
    `;

    interface RawYearMonth {
      year: number;
      month: number;
      conversion_date?: string;
      original_currency_code?: string | null;
      exchange_rate?: string | number | null;
      currency_code: string;
      income: string;
      expenses: string;
    }

    const rawResults: RawYearMonth[] = await withScopedDb(
      this.dataSource,
      (m) =>
        reportingQuery(m, userId, query, [userId, oldestYear, currentYear]),
    );

    const yearMap = new Map<number, YearData>();
    // Per year: what converted, and whether anything of THAT year did not. A
    // year's total is withheld on its own gap only; another year's JPY row does
    // not blank it.
    const yearAggregates = new Map<
      number,
      { income: FxAggregate; expenses: FxAggregate; complete: boolean }
    >();
    for (let year = oldestYear; year <= currentYear; year++) {
      yearMap.set(year, {
        year,
        months: Array.from({ length: 12 }, (_, i) => ({
          month: i + 1,
          income: 0,
          expenses: 0,
          savings: 0,
        })),
        totals: {
          income: 0,
          expenses: 0,
          savings: 0,
          knownIncome: 0,
          knownExpenses: 0,
          knownSavings: 0,
        },
      });
      yearAggregates.set(year, {
        income: new FxAggregate(),
        expenses: new FxAggregate(),
        complete: true,
      });
    }

    // A row with no rate into the reporting currency is unknown, never its
    // unconverted figure (INV-FX-001): it is in no month and no year total, and
    // its currency is named.
    const gaps = new ConversionGaps();

    rawResults.forEach((row) => {
      const yearData = yearMap.get(row.year);
      const aggregate = yearAggregates.get(row.year);
      if (yearData && aggregate) {
        const monthData = yearData.months[row.month - 1];
        const income = this.currencyService.tryConvertAmount(
          toMoneyNumber(row.income),
          row.currency_code,
          defaultCurrency,
          rateMap,
          row,
        );
        const expenses = this.currencyService.tryConvertAmount(
          toMoneyNumber(row.expenses),
          row.currency_code,
          defaultCurrency,
          rateMap,
          row,
        );
        if (income === null || expenses === null) {
          gaps.record(row.currency_code);
          aggregate.complete = false;
          return;
        }
        monthData.income = roundMoney(monthData.income + income);
        monthData.expenses = roundMoney(monthData.expenses + expenses);
        monthData.savings = roundMoney(monthData.income - monthData.expenses);

        aggregate.income.addConverted(income);
        aggregate.expenses.addConverted(expenses);
      }
    });

    yearMap.forEach((yearData, year) => {
      const aggregate = yearAggregates.get(year)!;
      const knownIncome = roundMoney(aggregate.income.knownSubtotal);
      const knownExpenses = roundMoney(aggregate.expenses.knownSubtotal);
      const knownSavings = roundMoney(
        aggregate.income.knownSubtotal - aggregate.expenses.knownSubtotal,
      );
      yearData.totals = {
        income: aggregate.complete ? knownIncome : null,
        expenses: aggregate.complete ? knownExpenses : null,
        savings: aggregate.complete ? knownSavings : null,
        knownIncome,
        knownExpenses,
        knownSavings,
      };
    });

    return {
      data: Array.from(yearMap.values()).sort((a, b) => a.year - b.year),
      currency: defaultCurrency,
      missingCurrencies: gaps.missingCurrencies,
      excludedCount: gaps.excludedCount,
    };
  }

  @ReportingRead("cash")
  async getWeekendVsWeekday(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<WeekendVsWeekdayResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    let query = `
      SELECT
        EXTRACT(DOW FROM t.transaction_date)::int as day_of_week,
        COALESCE(ts.category_id, t.category_id) as category_id,
        t.currency_code, TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS conversion_date, t.original_currency_code, t.exchange_rate,
        COUNT(*)::int as tx_count,
        SUM(ABS(COALESCE(ts.amount, t.amount))) as total
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND COALESCE(ts.amount, t.amount) < 0
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION}
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
    `;

    const params: (string | undefined)[] = [userId, endDate];

    if (startDate) {
      query += ` AND t.transaction_date >= $3`;
      params.push(startDate);
    }

    query += ` GROUP BY EXTRACT(DOW FROM t.transaction_date), COALESCE(ts.category_id, t.category_id), t.currency_code, t.transaction_date, t.original_currency_code, t.exchange_rate, t.id, ts.id`;

    interface RawDayCategory {
      day_of_week: number;
      category_id: string | null;
      conversion_date?: string;
      original_currency_code?: string | null;
      exchange_rate?: string | number | null;
      currency_code: string;
      tx_count: number;
      total: string;
    }

    const rawResults: RawDayCategory[] = await withScopedDb(
      this.dataSource,
      (m) => reportingQuery(m, userId, query, params),
    );

    const categories = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).find({
        where: { userId },
      }),
    );
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    const dayTotals = [0, 0, 0, 0, 0, 0, 0];
    const dayCounts = [0, 0, 0, 0, 0, 0, 0];

    const weekendByCategory = new Map<
      string,
      { name: string; total: number }
    >();
    const weekdayByCategory = new Map<
      string,
      { name: string; total: number }
    >();

    // A row with no rate into the reporting currency is unknown, never its
    // unconverted figure (INV-FX-001): it is in no day, no category, no count and
    // no total, and its currency is named.
    const gaps = new ConversionGaps();

    rawResults.forEach((row) => {
      const total = this.currencyService.tryConvertAmount(
        toMoneyNumber(row.total),
        row.currency_code,
        defaultCurrency,
        rateMap,
        row,
      );
      if (total === null) {
        gaps.record(row.currency_code);
        return;
      }
      const count = row.tx_count;
      const isWeekend = row.day_of_week === 0 || row.day_of_week === 6;

      dayTotals[row.day_of_week] += total;
      dayCounts[row.day_of_week] += count;

      let displayId = "uncategorized";
      let displayName = "Uncategorized";
      if (row.category_id) {
        const category = categoryMap.get(row.category_id);
        if (category) {
          const parentCategory = category.parentId
            ? categoryMap.get(category.parentId)
            : null;
          const displayCategory = parentCategory || category;
          displayId = displayCategory.id;
          displayName = displayCategory.name;
        }
      }

      const targetMap = isWeekend ? weekendByCategory : weekdayByCategory;
      const existing = targetMap.get(displayId);
      if (existing) {
        existing.total += total;
      } else {
        targetMap.set(displayId, { name: displayName, total });
      }
    });

    const knownWeekendTotal = sumMoney([dayTotals[0], dayTotals[6]]);
    const knownWeekdayTotal = sumMoney([
      dayTotals[1],
      dayTotals[2],
      dayTotals[3],
      dayTotals[4],
      dayTotals[5],
    ]);
    const weekendCount = dayCounts[0] + dayCounts[6];
    const weekdayCount =
      dayCounts[1] + dayCounts[2] + dayCounts[3] + dayCounts[4] + dayCounts[5];

    const byDay: DaySpending[] = dayTotals.map((total, index) => ({
      dayOfWeek: index,
      total: roundMoney(total),
      count: dayCounts[index],
    }));

    const allCategories = new Set([
      ...weekendByCategory.keys(),
      ...weekdayByCategory.keys(),
    ]);
    const byCategory: CategoryWeekendWeekday[] = Array.from(allCategories)
      .map((catId) => {
        const weekend = weekendByCategory.get(catId);
        const weekday = weekdayByCategory.get(catId);
        return {
          categoryId: catId === "uncategorized" ? null : catId,
          categoryName: weekend?.name || weekday?.name || "Unknown",
          weekendTotal: roundMoney(weekend?.total || 0),
          weekdayTotal: roundMoney(weekday?.total || 0),
        };
      })
      .sort(
        (a, b) =>
          b.weekendTotal + b.weekdayTotal - (a.weekendTotal + a.weekdayTotal),
      )
      .slice(0, 10);

    return {
      summary: {
        weekendTotal: gaps.headline(knownWeekendTotal),
        weekdayTotal: gaps.headline(knownWeekdayTotal),
        knownWeekendTotal,
        knownWeekdayTotal,
        weekendCount,
        weekdayCount,
      },
      byDay,
      byCategory,
      currency: defaultCurrency,
      missingCurrencies: gaps.missingCurrencies,
      excludedCount: gaps.excludedCount,
    };
  }
}
