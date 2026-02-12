import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { ReportCurrencyService } from "./report-currency.service";
import {
  YearOverYearResponse,
  YearData,
  WeekendVsWeekdayResponse,
  DaySpending,
  CategoryWeekendWeekday,
} from "./dto";

@Injectable()
export class ComparisonReportsService {
  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    private currencyService: ReportCurrencyService,
  ) {}

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
        t.currency_code,
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
        AND a.account_type != 'INVESTMENT'
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
      GROUP BY EXTRACT(YEAR FROM t.transaction_date), EXTRACT(MONTH FROM t.transaction_date), t.currency_code
      ORDER BY year, month
    `;

    interface RawYearMonth {
      year: number;
      month: number;
      currency_code: string;
      income: string;
      expenses: string;
    }

    const rawResults: RawYearMonth[] = await this.transactionsRepository.query(
      query,
      [userId, oldestYear, currentYear],
    );

    const yearMap = new Map<number, YearData>();
    for (let year = oldestYear; year <= currentYear; year++) {
      yearMap.set(year, {
        year,
        months: Array.from({ length: 12 }, (_, i) => ({
          month: i + 1,
          income: 0,
          expenses: 0,
          savings: 0,
        })),
        totals: { income: 0, expenses: 0, savings: 0 },
      });
    }

    rawResults.forEach((row) => {
      const yearData = yearMap.get(row.year);
      if (yearData) {
        const monthData = yearData.months[row.month - 1];
        const income = this.currencyService.convertAmount(
          parseFloat(row.income) || 0,
          row.currency_code,
          defaultCurrency,
          rateMap,
        );
        const expenses = this.currencyService.convertAmount(
          parseFloat(row.expenses) || 0,
          row.currency_code,
          defaultCurrency,
          rateMap,
        );
        monthData.income += Math.round(income * 100) / 100;
        monthData.expenses += Math.round(expenses * 100) / 100;
        monthData.savings =
          Math.round((monthData.income - monthData.expenses) * 100) / 100;

        yearData.totals.income += income;
        yearData.totals.expenses += expenses;
        yearData.totals.savings += income - expenses;
      }
    });

    yearMap.forEach((yearData) => {
      yearData.totals.income = Math.round(yearData.totals.income * 100) / 100;
      yearData.totals.expenses =
        Math.round(yearData.totals.expenses * 100) / 100;
      yearData.totals.savings =
        Math.round(yearData.totals.savings * 100) / 100;
    });

    return {
      data: Array.from(yearMap.values()).sort((a, b) => a.year - b.year),
    };
  }

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
        t.currency_code,
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
        AND a.account_type != 'INVESTMENT'
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
    `;

    const params: (string | undefined)[] = [userId, endDate];

    if (startDate) {
      query += ` AND t.transaction_date >= $3`;
      params.push(startDate);
    }

    query += ` GROUP BY EXTRACT(DOW FROM t.transaction_date), COALESCE(ts.category_id, t.category_id), t.currency_code`;

    interface RawDayCategory {
      day_of_week: number;
      category_id: string | null;
      currency_code: string;
      tx_count: number;
      total: string;
    }

    const rawResults: RawDayCategory[] =
      await this.transactionsRepository.query(query, params);

    const categories = await this.categoriesRepository.find({
      where: { userId },
    });
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

    rawResults.forEach((row) => {
      const total = this.currencyService.convertAmount(
        parseFloat(row.total) || 0,
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
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

    const weekendTotal = Math.round((dayTotals[0] + dayTotals[6]) * 100) / 100;
    const weekdayTotal =
      Math.round(
        (dayTotals[1] +
          dayTotals[2] +
          dayTotals[3] +
          dayTotals[4] +
          dayTotals[5]) *
          100,
      ) / 100;
    const weekendCount = dayCounts[0] + dayCounts[6];
    const weekdayCount =
      dayCounts[1] + dayCounts[2] + dayCounts[3] + dayCounts[4] + dayCounts[5];

    const byDay: DaySpending[] = dayTotals.map((total, index) => ({
      dayOfWeek: index,
      total: Math.round(total * 100) / 100,
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
          weekendTotal: Math.round((weekend?.total || 0) * 100) / 100,
          weekdayTotal: Math.round((weekday?.total || 0) * 100) / 100,
        };
      })
      .sort(
        (a, b) =>
          b.weekendTotal + b.weekdayTotal - (a.weekendTotal + a.weekdayTotal),
      )
      .slice(0, 10);

    return {
      summary: {
        weekendTotal,
        weekdayTotal,
        weekendCount,
        weekdayCount,
      },
      byDay,
      byCategory,
    };
  }
}
