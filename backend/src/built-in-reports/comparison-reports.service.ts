import { Injectable } from "@nestjs/common";
import { categoryTypeIs } from "../categories/category-type.util";
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
import { FxAggregate, shareOf } from "../common/fx-aggregate";
import { MONEY_SCALE, toMoneyNumber } from "../common/round.util";
import { reportFigure } from "../common/report-figure";
import {
  YearOverYearResponse,
  YearData,
  WeekendVsWeekdayResponse,
  DaySpending,
  CategoryWeekendWeekday,
} from "./dto";
import { investmentExclusionSql } from "../common/investment-filter.util";
import { isNetSpending, NET_SPEND_AMOUNT } from "./spending-reports.service";

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

  async getYearOverYear(
    userId: string,
    yearsToCompare: number,
  ): Promise<YearOverYearResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    // Every figure leaves rounded once at the reporting currency's places
    // (docs/specs/report-rounding-and-aggregation.md section 6).
    const places = await this.currencyService.getReportPlaces(defaultCurrency);

    const currentYear = new Date().getFullYear();
    const oldestYear = currentYear - yearsToCompare + 1;

    const query = `
      SELECT
        EXTRACT(YEAR FROM t.transaction_date)::int as year,
        EXTRACT(MONTH FROM t.transaction_date)::int as month,
        t.currency_code,
        ${rateBasisColumnsSql("$4")},
        SUM(CASE
          WHEN ${categoryTypeIs("c", "income")} THEN COALESCE(ts.amount, t.amount)
          WHEN ${categoryTypeIs("c", "expense")} THEN 0
          WHEN ${categoryTypeIs("c", "transfer")} THEN 0
          WHEN COALESCE(ts.amount, t.amount) > 0 THEN COALESCE(ts.amount, t.amount)
          ELSE 0
        END) as income,
        SUM(CASE
          WHEN ${categoryTypeIs("c", "expense")} THEN -1 * COALESCE(ts.amount, t.amount)
          WHEN ${categoryTypeIs("c", "income")} THEN 0
          WHEN ${categoryTypeIs("c", "transfer")} THEN 0
          WHEN COALESCE(ts.amount, t.amount) < 0 THEN ABS(COALESCE(ts.amount, t.amount))
          ELSE 0
        END) as expenses
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN categories c ON c.id = COALESCE(ts.category_id, t.category_id)
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND EXTRACT(YEAR FROM t.transaction_date) >= $2
        AND EXTRACT(YEAR FROM t.transaction_date) <= $3
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION}
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
      GROUP BY EXTRACT(YEAR FROM t.transaction_date), EXTRACT(MONTH FROM t.transaction_date), t.currency_code, ${RATE_BASIS_GROUP_BY}
      ORDER BY year, month
    `;

    interface RawYearMonth extends RawRateBasis {
      year: number;
      month: number;
      income: string;
      expenses: string;
    }

    const rawResults: RawYearMonth[] = await withScopedDb(
      this.dataSource,
      (m) => m.query(query, [userId, oldestYear, currentYear, defaultCurrency]),
    );
    const convert = wholeGroups(
      rawResults,
      await this.currencyService.buildConverter(rawResults, defaultCurrency),
      (row) => `${row.year}|${row.month}|${row.currency_code}`,
      (row) => [
        toMoneyNumber(row.income, MONEY_SCALE),
        toMoneyNumber(row.expenses, MONEY_SCALE),
      ],
    );

    const yearMap = new Map<number, YearData>();
    // Per year: what converted, and whether anything of THAT year did not. A
    // year's total is withheld on its own gap only; another year's JPY row does
    // not blank it.
    const yearAggregates = new Map<
      number,
      {
        income: FxAggregate;
        expenses: FxAggregate;
        months: Array<{ income: FxAggregate; expenses: FxAggregate }>;
        complete: boolean;
      }
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
        months: Array.from({ length: 12 }, () => ({
          income: new FxAggregate(),
          expenses: new FxAggregate(),
        })),
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
        const month = aggregate.months[row.month - 1];
        const income = convert(
          // An aggregate in the row's own currency, read before conversion: a coin's
          // sum keeps its stored 8 places (MONEY_SCALE, lossless; a fiat figure reads
          // the same), so a 2,500-sat total is not rounded to zero before it is
          // converted (INV-MONEY-001).
          toMoneyNumber(row.income, MONEY_SCALE),
          row,
        );
        const expenses = convert(toMoneyNumber(row.expenses, MONEY_SCALE), row);
        if (income === null || expenses === null) {
          gaps.record(
            row.currency_code,
            `${row.year}|${row.month}|${row.currency_code}`,
          );
          aggregate.complete = false;
          return;
        }
        month.income.addConverted(income);
        month.expenses.addConverted(expenses);
        aggregate.income.addConverted(income);
        aggregate.expenses.addConverted(expenses);
      }
    });

    // A month's figures and a year's are each rounded once from their own
    // rows, and savings is income less expenses before either is rounded:
    // a month that rounded its running sum on every row, or savings taken from
    // two four-place readings, could miss its year by a unit
    // (docs/specs/report-rounding-and-aggregation.md rules 2 and 4).
    const savingsOf = (income: FxAggregate, expenses: FxAggregate): number =>
      FxAggregate.difference(income, expenses).knownSubtotalAt(places);
    yearMap.forEach((yearData, year) => {
      const aggregate = yearAggregates.get(year)!;
      aggregate.months.forEach((month, index) => {
        yearData.months[index] = {
          month: index + 1,
          income: month.income.knownSubtotalAt(places),
          expenses: month.expenses.knownSubtotalAt(places),
          savings: savingsOf(month.income, month.expenses),
        };
      });
      const knownIncome = aggregate.income.knownSubtotalAt(places);
      const knownExpenses = aggregate.expenses.knownSubtotalAt(places);
      const knownSavings = savingsOf(aggregate.income, aggregate.expenses);
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

  async getWeekendVsWeekday(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<WeekendVsWeekdayResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const places = await this.currencyService.getReportPlaces(defaultCurrency);

    let query = `
      SELECT
        EXTRACT(DOW FROM t.transaction_date)::int as day_of_week,
        COALESCE(ts.category_id, t.category_id) as category_id,
        t.currency_code,
        ${rateBasisColumnsSql("$3")},
        COUNT(*)::int as tx_count,
        SUM(${NET_SPEND_AMOUNT}) as total
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND COALESCE(ts.amount, t.amount) <> 0
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION}
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
    `;

    const params: (string | undefined)[] = [userId, endDate, defaultCurrency];

    if (startDate) {
      query += ` AND t.transaction_date >= $4`;
      params.push(startDate);
    }

    query += ` GROUP BY EXTRACT(DOW FROM t.transaction_date), COALESCE(ts.category_id, t.category_id), t.currency_code, ${RATE_BASIS_GROUP_BY}`;

    interface RawDayCategory extends RawRateBasis {
      day_of_week: number;
      category_id: string | null;
      tx_count: number;
      total: string;
    }

    const rawResults: RawDayCategory[] = await withScopedDb(
      this.dataSource,
      (m) => m.query(query, params),
    );

    const categories = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).find({
        where: { userId },
      }),
    );
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    // Each figure folds its groups' aggregates and is rounded once (rules 2
    // and 4): a day, a category's weekend or weekday share, and the two totals.
    const dayTotals = Array.from({ length: 7 }, () => new FxAggregate());
    const dayCounts = [0, 0, 0, 0, 0, 0, 0];

    const weekendByCategory = new Map<
      string,
      { name: string; total: FxAggregate }
    >();
    const weekdayByCategory = new Map<
      string,
      { name: string; total: FxAggregate }
    >();

    // A row with no rate into the reporting currency is unknown, never its
    // unconverted figure (INV-FX-001): it is in no day, no category, no count and
    // no total, and its currency is named.
    const gaps = new ConversionGaps();
    const convert = await this.currencyService.buildConverter(
      rawResults,
      defaultCurrency,
    );

    // A foreign row arrives once per day it was struck on, so it converts at
    // that day's rate; the converted parts are folded back into their (day,
    // category, currency) group before the group is judged, so a refund still
    // nets against the debits it always did.
    // A group with a part no rate reaches is left out whole, as the group was
    // before it was split: judging the parts that converted could keep a
    // debit whose refund is the part that did not.
    const groups = new Map<
      string,
      {
        day_of_week: number;
        category_id: string | null;
        tx_count: number;
        total: FxAggregate;
        failed: boolean;
      }
    >();
    rawResults.forEach((row) => {
      const key = `${row.day_of_week}|${row.category_id ?? ""}|${row.currency_code}`;
      const converted = convert(toMoneyNumber(row.total, MONEY_SCALE), row);
      let group = groups.get(key);
      if (!group) {
        group = {
          day_of_week: row.day_of_week,
          category_id: row.category_id,
          tx_count: 0,
          total: new FxAggregate(),
          failed: false,
        };
        groups.set(key, group);
      }
      if (converted === null) {
        gaps.record(row.currency_code, key);
        group.failed = true;
        return;
      }
      group.tx_count += row.tx_count;
      group.total.addConverted(converted);
    });

    groups.forEach((row) => {
      if (row.failed) return;
      const total = row.total;
      // A refund nets against the debits of its own (day, category); a group
      // whose credits meet its debits was not spent in (INV-REPORT-004). Judged
      // on the sign before rounding (rule 5).
      if (!isNetSpending(total.sign)) return;
      const count = row.tx_count;
      const isWeekend = row.day_of_week === 0 || row.day_of_week === 6;

      dayTotals[row.day_of_week].merge(total);
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
      const existing = targetMap.get(displayId) ?? {
        name: displayName,
        total: new FxAggregate(),
      };
      existing.total.merge(total);
      targetMap.set(displayId, existing);
    });

    const sumOfDays = (days: number[]): FxAggregate => {
      const sum = new FxAggregate();
      for (const day of days) sum.merge(dayTotals[day]);
      return sum;
    };
    const weekendSum = sumOfDays([0, 6]);
    const weekdaySum = sumOfDays([1, 2, 3, 4, 5]);
    const knownWeekendTotal = weekendSum.knownSubtotalAt(places);
    const knownWeekdayTotal = weekdaySum.knownSubtotalAt(places);
    // Each side's share of the week's spending, divided from the unrounded
    // sums: a share over the two rounded totals is a ratio of readings, not
    // of the spending (docs/specs/report-rounding-and-aggregation.md rule 8).
    // Withheld with the totals while a row is left out; 0 over no spending.
    const whole = FxAggregate.sum([weekendSum, weekdaySum]);
    const sideShare = (part: FxAggregate): number | null =>
      gaps.isComplete ? shareOf(part, whole) : null;
    const weekendCount = dayCounts[0] + dayCounts[6];
    const weekdayCount =
      dayCounts[1] + dayCounts[2] + dayCounts[3] + dayCounts[4] + dayCounts[5];
    // A side's mean per transaction, and how far the weekend's sits above the
    // weekday's, divided and subtracted before anything is rounded: a mean of
    // a rounded total, or the difference of two rounded means, can sit a unit
    // off (docs/specs/report-rounding-and-aggregation.md rules 4 and 8).
    const meanOf = (sum: FxAggregate, count: number): number =>
      count > 0 ? sum.unroundedSubtotal / count : 0;
    const weekendMean = meanOf(weekendSum, weekendCount);
    const weekdayMean = meanOf(weekdaySum, weekdayCount);
    const averageOf = (mean: number): number | null =>
      gaps.isComplete ? reportFigure(mean, places) : null;

    const byDay: DaySpending[] = dayTotals.map((total, index) => ({
      dayOfWeek: index,
      total: total.knownSubtotalAt(places),
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
          weekendTotal: weekend?.total.knownSubtotalAt(places) ?? 0,
          weekdayTotal: weekday?.total.knownSubtotalAt(places) ?? 0,
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
        weekendShare: sideShare(weekendSum),
        weekdayShare: sideShare(weekdaySum),
        weekendAverage: averageOf(weekendMean),
        weekdayAverage: averageOf(weekdayMean),
        averageDifference: averageOf(weekendMean - weekdayMean),
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
