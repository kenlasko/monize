import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import {
  ReportCurrencyService,
  RawCategoryAggregate,
  RawMonthlyAggregate,
} from "./report-currency.service";
import {
  IncomeBySourceResponse,
  IncomeSourceItem,
  IncomeVsExpensesResponse,
  MonthlyIncomeExpenseItem,
} from "./dto";

@Injectable()
export class IncomeReportsService {
  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    private currencyService: ReportCurrencyService,
  ) {}

  async getIncomeBySource(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<IncomeBySourceResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    let query = `
      SELECT
        COALESCE(ts.category_id, t.category_id) as category_id,
        t.currency_code,
        SUM(COALESCE(ts.amount, t.amount)) as total
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND COALESCE(ts.amount, t.amount) > 0
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

    query += ` GROUP BY COALESCE(ts.category_id, t.category_id), t.currency_code`;

    const rawResults: RawCategoryAggregate[] =
      await this.transactionsRepository.query(query, params);

    const categories = await this.categoriesRepository.find({
      where: { userId },
    });
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    const parentTotals = new Map<
      string,
      { total: number; category: Category | null }
    >();

    for (const row of rawResults) {
      const total = this.currencyService.convertAmount(
        parseFloat(row.total) || 0,
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const categoryId = row.category_id;

      if (!categoryId) {
        const existing = parentTotals.get("uncategorized");
        if (existing) {
          existing.total += total;
        } else {
          parentTotals.set("uncategorized", { total, category: null });
        }
        continue;
      }

      const category = categoryMap.get(categoryId);
      if (!category) {
        const existing = parentTotals.get("uncategorized");
        if (existing) {
          existing.total += total;
        } else {
          parentTotals.set("uncategorized", { total, category: null });
        }
        continue;
      }

      const parentCategory = category.parentId
        ? categoryMap.get(category.parentId)
        : null;
      const displayCategory = parentCategory || category;
      const displayId = displayCategory.id;

      const existing = parentTotals.get(displayId);
      if (existing) {
        existing.total += total;
      } else {
        parentTotals.set(displayId, { total, category: displayCategory });
      }
    }

    const data: IncomeSourceItem[] = Array.from(parentTotals.entries())
      .map(([id, { total, category }]) => ({
        categoryId: id === "uncategorized" ? null : id,
        categoryName: category?.name || "Uncategorized",
        color: category?.color || null,
        total: Math.round(total * 100) / 100,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 15);

    const totalIncome = data.reduce((sum, item) => sum + item.total, 0);

    return {
      data,
      totalIncome: Math.round(totalIncome * 100) / 100,
    };
  }

  async getIncomeVsExpenses(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<IncomeVsExpensesResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    let query = `
      SELECT
        TO_CHAR(t.transaction_date, 'YYYY-MM') as month,
        t.currency_code,
        SUM(CASE WHEN COALESCE(ts.amount, t.amount) > 0 THEN COALESCE(ts.amount, t.amount) ELSE 0 END) as income,
        SUM(CASE WHEN COALESCE(ts.amount, t.amount) < 0 THEN ABS(COALESCE(ts.amount, t.amount)) ELSE 0 END) as expenses
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
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

    query += `
      GROUP BY TO_CHAR(t.transaction_date, 'YYYY-MM'), t.currency_code
      ORDER BY month
    `;

    const rawResults: RawMonthlyAggregate[] =
      await this.transactionsRepository.query(query, params);

    const monthlyMap = new Map<string, { income: number; expenses: number }>();
    for (const row of rawResults) {
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
      const existing = monthlyMap.get(row.month);
      if (existing) {
        existing.income += income;
        existing.expenses += expenses;
      } else {
        monthlyMap.set(row.month, { income, expenses });
      }
    }

    const data: MonthlyIncomeExpenseItem[] = Array.from(monthlyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, { income, expenses }]) => ({
        month,
        income: Math.round(income * 100) / 100,
        expenses: Math.round(expenses * 100) / 100,
        net: Math.round((income - expenses) * 100) / 100,
      }));

    const totals = data.reduce(
      (acc, item) => ({
        income: acc.income + item.income,
        expenses: acc.expenses + item.expenses,
        net: acc.net + item.net,
      }),
      { income: 0, expenses: 0, net: 0 },
    );

    return {
      data,
      totals: {
        income: Math.round(totals.income * 100) / 100,
        expenses: Math.round(totals.expenses * 100) / 100,
        net: Math.round(totals.net * 100) / 100,
      },
    };
  }
}
